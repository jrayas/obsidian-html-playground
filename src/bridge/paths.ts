/**
 * VaultPath: a branded string that only this module can create, by calling the single resolver.
 * The vault gateway accepts nothing else, so the compiler refuses any raw path string.
 *
 * Do NOT write `as VaultPath` anywhere else (a unit test greps for it).
 */
import { resolvePath } from "../paths/resolver";
import { BridgeError } from "./errors";

export type VaultPath = string & { readonly __brand: "VaultPath" };

export interface PathContext {
  /** Vault-root-relative folder of the calling app. */
  appRoot: string;
  strictPaths: boolean;
  exclusions: readonly string[];
}

/** Resolve an app-supplied path or throw a BridgeError. Excluded paths throw NOT_FOUND. */
export function resolveArg(input: unknown, ctx: PathContext, allowRoot = false): VaultPath {
  const result = resolvePath(input, {
    appRoot: ctx.appRoot,
    allowRelativeFallback: !ctx.strictPaths,
    exclusions: ctx.exclusions,
    allowRoot,
  });
  if (!result.ok) throw new BridgeError(result.code, result.code === "NOT_FOUND" ? "Not found." : "Invalid path.");
  return result.path as VaultPath;
}

/**
 * Resolve a path that comes from the HOST (for example a stored snapshot), not from an app. It still goes
 * through the single resolver, so exclusions apply: a path that is now excluded cannot be restored.
 */
export function resolveHostPath(input: string, exclusions: readonly string[]): VaultPath {
  return resolveArg(input, { appRoot: "", strictPaths: true, exclusions });
}

/** The folder above a validated path, or null at the vault root. A prefix of a clean path is itself clean. */
export function parentOf(path: VaultPath): VaultPath | null {
  const i = path.lastIndexOf("/");
  return i < 0 ? null : (path.slice(0, i) as VaultPath);
}
