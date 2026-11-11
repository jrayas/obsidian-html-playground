/**
 * Helpers for the "Excluded paths" list in settings (pure, no Obsidian imports).
 *
 * A folder or file picked from the list is stored anchored at the vault root, so excluding "Notes/Private"
 * does not also hide an unrelated "Archive/Private". Typed patterns are stored exactly as typed.
 * Pattern semantics live in exclusions.ts.
 */
import { isExcluded, normaliseForMatch } from "./exclusions";

const MAX_LENGTH = 200;

/** "Notes/Private" -> "/Notes/Private/" (this folder and everything in it, from the vault root). */
export function folderPattern(path: string): string {
  return `/${clean(path)}/`;
}

/** "Notes/plan.md" -> "/Notes/plan.md" (this one file, from the vault root). */
export function filePattern(path: string): string {
  return `/${clean(path)}`;
}

function clean(path: string): string {
  return path.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

export type PatternKind = "folder" | "file" | "anywhere" | "glob";

export interface PatternInfo {
  /** What to show in the list. */
  label: string;
  kind: PatternKind;
  /** One short sentence saying what it hides. */
  description: string;
}

const hasGlob = (s: string) => /[*?]/.test(s);

export function describePattern(raw: string): PatternInfo {
  const p = raw.trim();
  const body = p.replace(/^\/+|\/+$/g, "");
  if (hasGlob(p)) return { label: p, kind: "glob", description: "Pattern: hides every match" };
  if (p.startsWith("/") && p.endsWith("/")) return { label: body, kind: "folder", description: "Folder and everything in it" };
  if (p.startsWith("/")) return { label: body, kind: "file", description: "Folder or file at this exact path" };
  if (!body.includes("/")) return { label: p, kind: "anywhere", description: "Any folder or file with this name, at any depth" };
  return { label: p, kind: "folder", description: "Folder or file at this path from the vault root" };
}

export type AddResult = { ok: true; list: string[] } | { ok: false; reason: string };

/** A pattern made only of wildcards, dots and slashes would hide the whole vault. */
const CATCH_ALL = /^[*?./\\]*$/;

/**
 * Validate and add a pattern. Refuses blanks, duplicates, catch-alls, and anything that would hide a path in
 * `protectedPaths` (for example the apps folder, which would stop every app loading).
 */
export function addPattern(list: readonly string[], input: string, protectedPaths: readonly string[] = []): AddResult {
  const raw = input.trim().replace(/\\/g, "/");
  if (raw === "") return { ok: false, reason: "Type or choose something to exclude." };
  if (raw.startsWith("#")) return { ok: false, reason: "A pattern cannot start with #." };
  if (raw.length > MAX_LENGTH) return { ok: false, reason: "That pattern is too long." };
  if (CATCH_ALL.test(raw)) return { ok: false, reason: "That would hide everything in the vault." };
  const key = normaliseForMatch(raw);
  if (list.some((existing) => normaliseForMatch(existing.trim()) === key)) return { ok: false, reason: "Already in the list." };
  for (const path of protectedPaths) {
    if (path !== "" && isExcluded(`${path}/index.html`, [raw])) {
      return { ok: false, reason: `That would hide your apps folder (${path}), so no app could load.` };
    }
  }
  return { ok: true, list: [...list, raw] };
}

export function removePattern(list: readonly string[], raw: string): string[] {
  return list.filter((p) => p !== raw);
}
