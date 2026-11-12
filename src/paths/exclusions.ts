/**
 * Exclusion matching (pure, no Obsidian imports).
 *
 * A path is excluded when:
 *  1. any segment starts with "." (hidden: .obsidian, .git, .trash, ...). This is a
 *     built-in floor and cannot be switched off; or
 *  2. it matches one of the user's patterns.
 *
 * Pattern rules (see docs/decisions/0002):
 *  - "Folder/"        a folder of that name at ANY depth.
 *  - "*.secret.md"    a name at ANY depth (no slash).
 *  - "Data/secret"    contains an inner slash, so anchored at the vault root.
 *  - "*" matches within one segment, "**" across segments, "?" one character.
 *  - Matching is case-insensitive and Unicode NFC-normalised.
 */

/** Shown in settings so the user can see what is always excluded. */
export const BUILT_IN_EXCLUSIONS: readonly string[] = [".obsidian", ".git", ".trash", "(any hidden folder or file)"];

const MAX_PATTERN_LENGTH = 200;

/**
 * The pattern that hides the vault's configuration folder, whatever the user called it (Obsidian lets the
 * folder be renamed; the hidden-folder floor only covers names that start with a dot). It is anchored at the
 * vault root, so "Notes/config" is not affected. Null when the name is empty. The result only ever hides more.
 */
export function configDirPattern(configDir: string | undefined): string | null {
  const name = (configDir ?? "").trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  return name === "" ? null : `/${name}/`;
}

/** The user's patterns plus the configuration folder. This is the list every part of the plugin must use. */
export function withConfigDir(userPatterns: readonly string[], configDir: string | undefined): string[] {
  const extra = configDirPattern(configDir);
  return extra === null ? [...userPatterns] : [...userPatterns, extra];
}

interface CompiledPattern {
  anchored: boolean;
  regex: RegExp;
}

const cache = new Map<string, CompiledPattern | null>();

/** Lower-case and NFC-normalise for comparison. Never use the result as a real path. */
export function normaliseForMatch(value: string): string {
  return value.normalize("NFC").toLowerCase();
}

function escapeRegex(char: string): string {
  return /[\\^$.*+?()[\]{}|/]/.test(char) ? "\\" + char : char;
}

function globToRegex(glob: string): RegExp {
  let source = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob.charAt(i);
    if (ch === "*") {
      if (glob.charAt(i + 1) === "*") {
        source += ".*";
        i++;
      } else {
        source += "[^/]*";
      }
    } else if (ch === "?") {
      source += "[^/]";
    } else {
      source += escapeRegex(ch);
    }
  }
  return new RegExp("^" + source + "$");
}

/** Compile one user pattern. Returns null for blank, comment or over-long patterns. */
function compile(raw: string): CompiledPattern | null {
  const cached = cache.get(raw);
  if (cached !== undefined) return cached;

  let result: CompiledPattern | null = null;
  let pattern = normaliseForMatch(raw.trim()).replace(/\\/g, "/");
  if (pattern !== "" && !pattern.startsWith("#") && pattern.length <= MAX_PATTERN_LENGTH) {
    const leadingSlash = pattern.startsWith("/");
    pattern = pattern.replace(/^(\.\/|\/)+/, "").replace(/\/+$/, "");
    if (pattern !== "") {
      result = { anchored: leadingSlash || pattern.includes("/"), regex: globToRegex(pattern) };
    }
  }
  cache.set(raw, result);
  return result;
}

/** True when the (already cleaned, vault-relative) path must be treated as not found. */
export function isExcluded(path: string, userPatterns: readonly string[]): boolean {
  const segments = normaliseForMatch(path)
    .replace(/\\/g, "/")
    .split("/")
    .filter((s) => s !== "");

  // Built-in floor: hidden segments (this includes ".", ".." defensively).
  if (segments.some((s) => s.startsWith("."))) return true;

  for (const raw of userPatterns) {
    const pattern = compile(raw);
    if (!pattern) continue;
    if (pattern.anchored) {
      for (let k = 1; k <= segments.length; k++) {
        if (pattern.regex.test(segments.slice(0, k).join("/"))) return true;
      }
    } else if (segments.some((s) => pattern.regex.test(s))) {
      return true;
    }
  }
  return false;
}
