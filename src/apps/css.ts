/**
 * CSS rewriting (pure, async via hooks). Inlines @import and swaps url() references for
 * data:/blob: URLs supplied by the host. Depth-limited and cycle-safe.
 */
import { classifyRef } from "./refs";

export interface CssHooks {
  /** Return a data:/blob: URL for a local asset, or null if it cannot be used. */
  assetUrl(ref: string): Promise<string | null>;
  /** Return the (already substituted) CSS text of a local stylesheet, or null. Also returns its identity for cycle checks. */
  loadCss(ref: string): Promise<{ id: string; text: string } | null>;
}

const MAX_DEPTH = 5;
const IMPORT_RE = /@import\s+(?:url\(\s*)?(['"]?)([^'")\s;]+)\1\s*\)?[^;]*;/gi;
const URL_RE = /url\(\s*(['"]?)(.*?)\1\s*\)/gi;

async function replaceAsync(
  text: string,
  re: RegExp,
  replacer: (match: RegExpExecArray) => Promise<string>,
): Promise<string> {
  const pieces: Promise<string>[] = [];
  const gaps: string[] = [];
  let last = 0;
  re.lastIndex = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    gaps.push(text.slice(last, m.index));
    pieces.push(replacer(m));
    last = m.index + m[0].length;
  }
  gaps.push(text.slice(last));
  const resolved = await Promise.all(pieces);
  return gaps.reduce((acc, gap, i) => acc + gap + (resolved[i] ?? ""), "");
}

export async function rewriteCss(
  css: string,
  hooks: CssHooks,
  warn: (message: string) => void,
  seen: ReadonlySet<string> = new Set(),
  depth = 0,
): Promise<string> {
  let out = await replaceAsync(css, new RegExp(IMPORT_RE.source, "gi"), async (m) => {
    const ref = m[2] ?? "";
    const kind = classifyRef(ref);
    if (kind === "keep" || kind === "remote") return m[0];
    if (kind === "blocked" || depth >= MAX_DEPTH) {
      warn(`Skipped @import "${ref}".`);
      return "";
    }
    const loaded = await hooks.loadCss(ref);
    if (!loaded) {
      warn(`Could not load @import "${ref}".`);
      return "";
    }
    if (seen.has(loaded.id)) return ""; // cycle
    const next = new Set(seen).add(loaded.id);
    return rewriteCss(loaded.text, hooks, warn, next, depth + 1);
  });

  out = await replaceAsync(out, new RegExp(URL_RE.source, "gi"), async (m) => {
    const ref = m[2] ?? "";
    const kind = classifyRef(ref);
    if (kind === "keep" || kind === "remote") return m[0];
    if (kind === "blocked") {
      warn(`Blocked url("${ref}").`);
      return 'url("")';
    }
    const url = await hooks.assetUrl(ref);
    return url ? `url("${url}")` : 'url("")';
  });

  return out;
}
