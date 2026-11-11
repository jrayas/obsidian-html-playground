/** Read and write scopes (pure). A scope is a vault folder; a path is in scope when it is that folder or below it. */
import { normaliseForMatch } from "../paths/exclusions";
import { resolvePath } from "../paths/resolver";

export interface ScopeContext {
  appRoot: string;
  strictPaths: boolean;
  exclusions: readonly string[];
}

/**
 * Resolve manifest scope entries to clean vault paths. Invalid or excluded entries are dropped with a
 * warning (fewer scopes is always the safe direction). Returns undefined when no scopes were declared.
 */
export function resolveScopes(
  entries: readonly string[] | undefined,
  label: string,
  ctx: ScopeContext,
): { scopes: string[] | undefined; warnings: string[] } {
  if (entries === undefined) return { scopes: undefined, warnings: [] };
  const warnings: string[] = [];
  const scopes: string[] = [];
  for (const entry of entries) {
    const result = resolvePath(entry, {
      appRoot: ctx.appRoot,
      allowRelativeFallback: !ctx.strictPaths,
      exclusions: ctx.exclusions,
      allowRoot: true,
    });
    if (result.ok) scopes.push(result.path);
    else warnings.push(`Ignored ${label} entry "${entry}".`);
  }
  return { scopes, warnings };
}

/** True when `path` equals or lies below one of the roots. An empty root means the whole vault. */
export function underAny(path: string, roots: readonly string[]): boolean {
  const p = normaliseForMatch(path);
  return roots.some((root) => {
    const r = normaliseForMatch(root);
    return r === "" || p === r || p.startsWith(r + "/");
  });
}

/** Undefined scopes mean the whole vault. `alwaysAllowed` (the app's own folder) is added to any declared scopes. */
export function inScope(path: string, scopes: readonly string[] | undefined, alwaysAllowed: readonly string[]): boolean {
  if (scopes === undefined) return true;
  return underAny(path, [...scopes, ...alwaysAllowed]);
}
