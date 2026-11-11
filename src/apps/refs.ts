/** Classifying references found in app HTML and CSS (pure). */

export type RefKind =
  /** Leave exactly as written (fragment, data:, blob:, about:). */
  | "keep"
  /** http(s) or protocol-relative. Not proxied; the CSP blocks it unless the domain is allowed. */
  | "remote"
  /** Scripting or other schemes that must never be kept. */
  | "blocked"
  /** A vault path to run through the resolver. */
  | "local";

export function classifyRef(ref: string): RefKind {
  const value = ref.trim();
  if (value === "" || value.startsWith("#")) return "keep";
  const lower = value.toLowerCase();
  if (/^(data|blob|about):/.test(lower)) return "keep";
  if (/^https?:/.test(lower) || value.startsWith("//")) return "remote";
  if (/^[a-z][a-z0-9+.-]*:/.test(lower) && !/^[a-z]:[\\/]/.test(lower)) return "blocked"; // javascript:, file:, mailto: ...
  return "local";
}

const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  bmp: "image/bmp",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  eot: "application/vnd.ms-fontobject",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  m4a: "audio/mp4",
  mp4: "video/mp4",
  webm: "video/webm",
  json: "application/json",
  txt: "text/plain",
};

const FONT_EXTENSIONS = new Set(["woff", "woff2", "ttf", "otf", "eot"]);

export function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const i = name.lastIndexOf(".");
  return i < 0 ? "" : name.slice(i + 1).toLowerCase();
}

export function mimeFor(path: string): string {
  return MIME[extensionOf(path)] ?? "application/octet-stream";
}

/** Fonts are always inlined as data: URIs because blob URLs fail the font CORS check. */
export function isFont(path: string): boolean {
  return FONT_EXTENSIONS.has(extensionOf(path));
}

/** Escape text for inline <script> so it cannot close the tag early or open an HTML comment. */
export function escapeInlineScript(text: string): string {
  return text.replace(/<\/(script)/gi, "<\\/$1").replace(/<!--/g, "<\\!--");
}

export function escapeInlineStyle(text: string): string {
  return text.replace(/<\/(style)/gi, "<\\/$1");
}

/** Cheap detection of relative ES module imports, which cannot work once scripts are inlined. */
export function hasRelativeModuleImport(code: string): boolean {
  return /\bimport\s*(?:[^'"()]*?\bfrom\s*)?['"]\.{0,2}\//.test(code) || /\bimport\s*\(\s*['"]\.{0,2}\//.test(code);
}

export function bytesToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
