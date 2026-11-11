/**
 * Write guards (pure): which paths and files an app may write. See docs/phases/phase-2-bridge.md (Q16, Q17).
 *
 * Order matters and is fixed:
 *   1. the path must be visible to the app (not excluded, inside its read scope), else NOT_FOUND
 *   2. never an app folder or a manifest.json, else DENIED (stops an app rewriting its own permissions)
 *   3. inside a declared write scope (unless trusted), else DENIED
 */
import { normaliseForMatch } from "../paths/exclusions";
import { canRead, type AppContext } from "./context";
import { BridgeError } from "./errors";
import { underAny } from "./scopes";
import { utf8Length } from "./snapshots";

/** Text types apps may write. No scripts, pages or styles, and no binary files. */
export const WRITABLE_EXTENSIONS: ReadonlySet<string> = new Set(["md", "txt", "json", "yaml", "yml", "csv", "canvas", "svg"]);

const basename = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

export function extensionOf(path: string): string {
  const name = basename(path);
  const i = name.lastIndexOf(".");
  return i <= 0 ? "" : name.slice(i + 1).toLowerCase();
}

export function checkWritableType(path: string): void {
  if (!WRITABLE_EXTENSIONS.has(extensionOf(path))) throw new BridgeError("INVALID", "File type not allowed.");
}

export function checkWriteSize(content: string, maxBytes: number): void {
  if (content.length * 3 <= maxBytes) return; // cannot exceed the limit in UTF-8
  if (utf8Length(content) > maxBytes) throw new BridgeError("TOO_LARGE");
}

export interface WriteTarget {
  /** Settings: the folder that holds apps, e.g. "Apps". */
  appsFolder: string;
  /** True when the path or one of its parent folders directly contains a manifest.json (an app folder). */
  insideAppFolder: boolean;
}

export function checkWriteTarget(path: string, ctx: AppContext, target: WriteTarget): void {
  if (!canRead(ctx, path)) throw new BridgeError("NOT_FOUND");

  const denied = new BridgeError("DENIED", "Writing here is not permitted.");
  if (normaliseForMatch(basename(path)) === "manifest.json") throw denied;
  if (target.insideAppFolder) throw denied;
  if (underAny(path, [target.appsFolder, ctx.appRoot])) throw denied;

  if (!ctx.trusted) {
    const scopes = ctx.writeScopes;
    if (!scopes || scopes.length === 0 || !underAny(path, scopes)) throw denied;
  }
}

/** An untrusted app may not delete, move or rename the very folder it was given as a write scope. */
export function checkNotScopeRoot(path: string, ctx: AppContext): void {
  if (ctx.trusted) return;
  const p = normaliseForMatch(path);
  if ((ctx.writeScopes ?? []).some((s) => normaliseForMatch(s) === p)) {
    throw new BridgeError("DENIED", "Writing here is not permitted.");
  }
}
