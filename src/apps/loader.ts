/**
 * App loader: turns an app folder into one self-contained HTML string for the sandboxed iframe.
 *
 * - Every file read goes through resolvePath() (the single resolver).
 * - CSS and JS are inlined; fonts become data: URIs; other binary assets become blob: or data: URLs.
 * - Adds the CSP, theme variables and bootstrap script at the very top of <head>.
 * - Anything that cannot be loaded is reported in `warnings`; nothing is left pointing at the network.
 */
import { buildBootstrap } from "../bootstrap/script";
import { resolvePath, type ResolveOptions } from "../paths/resolver";
import { themeToCss, type ThemeSnapshot } from "../theme/variables";
import { rewriteCss } from "./css";
import { buildCsp, effectiveDomains } from "./csp";
import { substituteAppRoot, type AppManifest } from "./manifest";
import {
  bytesToBase64,
  classifyRef,
  escapeInlineScript,
  escapeInlineStyle,
  hasRelativeModuleImport,
  isFont,
  mimeFor,
} from "./refs";

export interface LoaderIO {
  readText(path: string): Promise<string | null>;
  readBinary(path: string): Promise<ArrayBuffer | null>;
}

export interface LoadOptions {
  appRoot: string;
  manifest: AppManifest;
  io: LoaderIO;
  theme: ThemeSnapshot;
  nonce: string;
  strictPaths: boolean;
  exclusions: readonly string[];
  globalDomains: readonly string[];
  /** "blob" uses blob: URLs for images and media; "inline" uses data: URIs. */
  assetMode: "blob" | "inline";
}

export interface LoadedApp {
  html: string;
  /** Blob URLs created for this load. The caller must revoke them on close. */
  blobUrls: string[];
  warnings: string[];
}

const MAX_ASSET_BYTES = 25 * 1024 * 1024;
const RESOURCE_ATTRS: Array<{ selector: string; attr: string }> = [
  { selector: "img, audio, video, source, track, input[type=image]", attr: "src" },
  { selector: "video[poster]", attr: "poster" },
  { selector: "svg image", attr: "href" },
  { selector: "svg image", attr: "xlink:href" },
];

export async function loadApp(options: LoadOptions): Promise<LoadedApp> {
  const { appRoot, manifest, io } = options;
  const warnings: string[] = [];
  const blobUrls: string[] = [];
  const assetCache = new Map<string, string | null>();
  const resolveOptions: ResolveOptions = {
    appRoot,
    allowRelativeFallback: !options.strictPaths,
    exclusions: options.exclusions,
  };

  /** Resolve a reference found inside the app to a vault path, or null (with a warning). */
  const resolveRef = (ref: string): string | null => {
    const substituted = substituteAppRoot(ref, appRoot);
    const result = resolvePath(substituted, resolveOptions);
    if (result.ok) return result.path;
    // Same wording for excluded and missing paths so nothing about exclusions leaks.
    warnings.push(`Could not load "${ref}". Use ./ or {{appRoot}}/ for the app's own files.`);
    return null;
  };

  const readText = async (path: string): Promise<string | null> => {
    const text = await io.readText(path);
    return text === null ? null : substituteAppRoot(text, appRoot);
  };

  const assetUrl = async (ref: string): Promise<string | null> => {
    const kind = classifyRef(ref);
    if (kind === "keep" || kind === "remote") return ref;
    if (kind === "blocked") {
      warnings.push(`Blocked "${ref}".`);
      return null;
    }
    const path = resolveRef(ref);
    if (path === null) return null;
    if (assetCache.has(path)) return assetCache.get(path) ?? null;

    let url: string | null = null;
    const bytes = await io.readBinary(path);
    if (bytes === null) {
      warnings.push(`Could not load "${ref}".`);
    } else if (bytes.byteLength > MAX_ASSET_BYTES) {
      warnings.push(`"${ref}" is larger than 25 MB and was skipped.`);
    } else {
      const mime = mimeFor(path);
      if (isFont(path) || options.assetMode === "inline") {
        url = `data:${mime};base64,${bytesToBase64(bytes)}`;
      } else {
        url = URL.createObjectURL(new Blob([bytes], { type: mime }));
        blobUrls.push(url);
      }
    }
    assetCache.set(path, url);
    return url;
  };

  const cssHooks = {
    assetUrl,
    async loadCss(ref: string) {
      const path = resolveRef(ref);
      if (path === null) return null;
      const text = await readText(path);
      return text === null ? null : { id: path, text };
    },
  };
  const rewrite = (css: string) => rewriteCss(css, cssHooks, (m) => warnings.push(m));

  // 1. Entry page.
  const entryRef = substituteAppRoot(manifest.entry, appRoot);
  const entryPath = resolvePath(entryRef.startsWith(appRoot + "/") ? entryRef : `${appRoot}/${entryRef}`, {
    ...resolveOptions,
    allowRelativeFallback: false,
  });
  if (!entryPath.ok) throw new Error("The entry file could not be found.");
  const source = await readText(entryPath.path);
  if (source === null) throw new Error("The entry file could not be found.");

  const doc = new DOMParser().parseFromString(source, "text/html");

  // 2. Remove things that could navigate away or change the base URL.
  doc.querySelectorAll("base, meta[http-equiv]").forEach((el) => el.remove());

  // 3. Stylesheets and other <link> tags.
  for (const link of Array.from(doc.querySelectorAll("link[href]"))) {
    const href = link.getAttribute("href") ?? "";
    const rel = (link.getAttribute("rel") ?? "").toLowerCase();
    if (rel.includes("stylesheet")) {
      const kind = classifyRef(href);
      if (kind === "remote") continue; // CSP decides
      const path = kind === "local" ? resolveRef(href) : null;
      const text = path === null ? null : await readText(path);
      if (text === null) {
        if (path !== null) warnings.push(`Could not load stylesheet "${href}".`);
        link.remove();
        continue;
      }
      const style = doc.createElement("style");
      style.textContent = escapeInlineStyle(await rewriteCss(text, cssHooks, (m) => warnings.push(m), new Set([path!])));
      const media = link.getAttribute("media");
      if (media) style.setAttribute("media", media);
      link.replaceWith(style);
    } else if (rel.includes("icon")) {
      const url = await assetUrl(href);
      if (url) link.setAttribute("href", url);
      else link.remove();
    } else {
      link.remove(); // preload, modulepreload, manifest, etc. are not useful offline
    }
  }

  // 4. Inline <style> and style="" attributes.
  for (const style of Array.from(doc.querySelectorAll("style"))) {
    style.textContent = escapeInlineStyle(await rewrite(substituteAppRoot(style.textContent ?? "", appRoot)));
  }
  for (const el of Array.from(doc.querySelectorAll("[style*='url(']"))) {
    el.setAttribute("style", await rewrite(substituteAppRoot(el.getAttribute("style") ?? "", appRoot)));
  }

  // 5. Scripts. Deferred classic scripts move to the end of <body> to keep their timing once inlined.
  const deferred: HTMLScriptElement[] = [];
  for (const script of Array.from(doc.querySelectorAll("script"))) {
    const src = script.getAttribute("src");
    if (src !== null) {
      const kind = classifyRef(src);
      if (kind === "remote") continue; // CSP decides (script-src never allows remote)
      const path = kind === "local" ? resolveRef(src) : null;
      const text = path === null ? null : await readText(path);
      if (text === null) {
        if (path !== null) warnings.push(`Could not load script "${src}".`);
        script.remove();
        continue;
      }
      script.removeAttribute("src");
      script.textContent = escapeInlineScript(text);
    } else {
      script.textContent = escapeInlineScript(substituteAppRoot(script.textContent ?? "", appRoot));
    }
    if (hasRelativeModuleImport(script.textContent ?? "")) {
      warnings.push("An ES module import of a relative file was found. Bundle the app into a single script.");
    }
    const isModule = (script.getAttribute("type") ?? "").toLowerCase() === "module";
    if (script.hasAttribute("defer") && !isModule && src !== null) deferred.push(script);
    script.removeAttribute("defer");
    script.removeAttribute("async");
    script.removeAttribute("integrity");
    script.removeAttribute("crossorigin");
  }
  for (const script of deferred) doc.body.appendChild(script);

  // 6. Images, media and SVG images.
  for (const { selector, attr } of RESOURCE_ATTRS) {
    for (const el of Array.from(doc.querySelectorAll(selector))) {
      const value = el.getAttribute(attr);
      if (value === null) continue;
      const kind = classifyRef(value);
      if (kind === "keep" || kind === "remote") continue;
      const url = await assetUrl(value);
      if (url) el.setAttribute(attr, url);
      else el.removeAttribute(attr);
    }
  }
  for (const el of Array.from(doc.querySelectorAll("img[srcset], source[srcset]"))) {
    const parts = (el.getAttribute("srcset") ?? "").split(",").map((p) => p.trim()).filter(Boolean);
    const rebuilt: string[] = [];
    for (const part of parts) {
      const [ref = "", descriptor = ""] = part.split(/\s+/, 2);
      const kind = classifyRef(ref);
      const url = kind === "local" ? await assetUrl(ref) : kind === "keep" || kind === "remote" ? ref : null;
      if (url) rebuilt.push(descriptor ? `${url} ${descriptor}` : url);
    }
    if (rebuilt.length > 0) el.setAttribute("srcset", rebuilt.join(", "));
    else el.removeAttribute("srcset");
  }

  // 7. Inject the security header at the very top of <head>, CSP first.
  const csp = doc.createElement("meta");
  csp.setAttribute("http-equiv", "Content-Security-Policy");
  csp.setAttribute(
    "content",
    buildCsp(effectiveDomains(manifest.allowedDomains, options.globalDomains)),
  );
  const theme = doc.createElement("style");
  theme.setAttribute("data-hp", "theme");
  theme.textContent = themeToCss(options.theme);
  const bootstrap = doc.createElement("script");
  bootstrap.textContent = escapeInlineScript(buildBootstrap(options.nonce));
  doc.head.prepend(csp, theme, bootstrap);

  return {
    html: "<!DOCTYPE html>\n" + doc.documentElement.outerHTML,
    blobUrls,
    warnings,
  };
}
