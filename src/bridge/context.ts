/** Per-app context, captured once at load. The app cannot change it. (pure) */
import type { AppManifest } from "../apps/manifest";
import { isExcluded } from "../paths/exclusions";
import { isKnownOp } from "./permissions";
import type { PathContext } from "./paths";
import { inScope, resolveScopes } from "./scopes";

/** What the note around an embedded app says about it. Present only for note embeds. Never grants anything. */
export interface EmbedInfo {
  /** The note the app is embedded in, as Obsidian reports it. Checked against exclusions and scopes before an app sees it. */
  sourcePath: string;
  /** Plain-text parameters from the note, vetted by parseEmbedBlock. */
  params: Readonly<Record<string, string>>;
}

export interface AppContext {
  appRoot: string;
  manifest: AppManifest;
  pathCtx: PathContext;
  /** Declared permissions, restricted to known operation names. */
  permissions: ReadonlySet<string>;
  /** undefined = whole vault (minus exclusions). */
  readScopes: readonly string[] | undefined;
  writeScopes: readonly string[] | undefined;
  /** Effective trust: the manifest asks for it AND the user approved it on this device. */
  trusted: boolean;
  /** Set for note embeds only (see embed.context). */
  embed?: EmbedInfo;
}

export interface ContextInput {
  appRoot: string;
  manifest: AppManifest;
  strictPaths: boolean;
  exclusions: readonly string[];
  /** The user approved this app's trusted request (see trust.ts). Only counts if the manifest asks for it. */
  trusted?: boolean;
  /** Set when the app is embedded in a note. */
  embed?: EmbedInfo;
}

export function buildContext(input: ContextInput): { ctx: AppContext; warnings: string[] } {
  const warnings: string[] = [];
  const pathCtx: PathContext = { appRoot: input.appRoot, strictPaths: input.strictPaths, exclusions: input.exclusions };

  const permissions = new Set<string>();
  for (const name of input.manifest.permissions) {
    if (isKnownOp(name)) permissions.add(name);
    else warnings.push(`Unknown permission "${name}" ignored.`);
  }

  const read = resolveScopes(input.manifest.readScopes, "readScopes", pathCtx);
  const write = resolveScopes(input.manifest.writeScopes, "writeScopes", pathCtx);
  warnings.push(...read.warnings, ...write.warnings);

  return {
    warnings,
    ctx: {
      appRoot: input.appRoot,
      manifest: input.manifest,
      pathCtx,
      permissions,
      readScopes: read.scopes,
      writeScopes: write.scopes,
      trusted: input.trusted === true && input.manifest.trusted,
      ...(input.embed ? { embed: { sourcePath: input.embed.sourcePath, params: Object.freeze({ ...input.embed.params }) } } : {}),
    },
  };
}

/** Whether a vault path may appear in results or be read by this app. */
export function canRead(ctx: AppContext, path: string): boolean {
  return !isExcluded(path, ctx.pathCtx.exclusions) && inScope(path, ctx.readScopes, [ctx.appRoot]);
}
