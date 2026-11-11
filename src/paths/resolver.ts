/**
 * The single path resolver (pure, no Obsidian imports).
 *
 * EVERY vault path in this plugin (fetch shim, bridge, app loader) must pass through
 * resolvePath(). No other code may build or normalise vault paths. See docs/path-rule.md.
 */
import { isExcluded } from "./exclusions";

export type ResolveErrorCode = "INVALID" | "NOT_FOUND";

export interface ResolveOptions {
  /** Vault-root-relative folder of the calling app, e.g. "Apps/Calculator". Needed for the "./" fallback. */
  appRoot?: string;
  /** True when the "./" fallback is on (Strict paths off). */
  allowRelativeFallback: boolean;
  /** User exclusion patterns. The hidden-folder floor is always applied on top. */
  exclusions: readonly string[];
  /** Allow "", "/" and "." to mean the vault root (used for listing only). */
  allowRoot?: boolean;
}

export type ResolveResult =
  | { ok: true; path: string }
  | { ok: false; code: ResolveErrorCode; /** For the host's own log only; never show for NOT_FOUND. */ reason: string };

const MAX_LENGTH = 1024;
const MAX_DECODE_PASSES = 5;
/** Characters Obsidian forbids in names, plus control characters. ":" also blocks URL schemes and drive letters. */
// eslint-disable-next-line no-control-regex -- control characters are the point: names containing them are refused
const FORBIDDEN = /[<>:"|?*\u0000-\u001f\u007f]/;

const invalid = (reason: string): ResolveResult => ({ ok: false, code: "INVALID", reason });

/** Decode well-formed %XX runs repeatedly until stable. A lone "%" (e.g. "90%") stays literal. */
function decodeFully(input: string): string | null {
  let current = input;
  for (let pass = 0; pass < MAX_DECODE_PASSES; pass++) {
    let failed = false;
    const next = current.replace(/(?:%[0-9a-fA-F]{2})+/g, (run) => {
      try {
        return decodeURIComponent(run);
      } catch {
        failed = true;
        return run;
      }
    });
    if (failed) return null;
    if (next === current) return current;
    current = next;
  }
  return null; // still changing after the limit: treat as an attack
}

/** Split into clean segments. Returns an error string instead of segments when unsafe. */
function cleanSegments(segments: string[]): string[] | string {
  const out: string[] = [];
  for (const seg of segments) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") return "parent segment";
    if (/[ .]$/.test(seg)) return "segment ends with dot or space"; // Windows strips these
    out.push(seg);
  }
  return out;
}

export function resolvePath(input: unknown, options: ResolveOptions): ResolveResult {
  if (typeof input !== "string") return invalid("not a string");
  if (input.length > MAX_LENGTH) return invalid("too long");

  const decoded = decodeFully(input);
  if (decoded === null) return invalid("bad percent-encoding");

  const text = decoded.replace(/\\/g, "/").trim().normalize("NFC");

  if (options.allowRoot && (text === "" || text === "/" || text === ".")) return { ok: true, path: "" };
  if (text === "") return invalid("empty");
  if (text.startsWith("/")) return invalid("absolute or network path");
  if (FORBIDDEN.test(text)) return invalid("forbidden character");

  let parts = text.split("/");
  let useFallback = false;
  if (parts[0] === ".") {
    if (!options.allowRelativeFallback || !options.appRoot) return invalid("relative fallback disabled");
    useFallback = true;
    parts = parts.slice(1);
  }

  const cleaned = cleanSegments(parts);
  if (typeof cleaned === "string") return invalid(cleaned);
  if (cleaned.length === 0) return invalid("empty");

  let path = cleaned.join("/");
  if (useFallback) {
    const root = resolvePath(options.appRoot, { ...options, appRoot: undefined, allowRelativeFallback: false });
    if (!root.ok) return invalid("bad app root");
    path = root.path + "/" + path;
  }

  if (isExcluded(path, options.exclusions)) return { ok: false, code: "NOT_FOUND", reason: "excluded" };
  return { ok: true, path };
}

/** Generic message safe to show an app. Identical for missing and excluded paths. */
export function publicMessage(code: ResolveErrorCode): string {
  return code === "NOT_FOUND" ? "Not found." : "Invalid path.";
}
