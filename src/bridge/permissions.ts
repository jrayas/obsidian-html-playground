/**
 * The operation table (pure). The operation name IS the permission name an app declares in its
 * manifest. Everything except ALWAYS_ALLOWED needs an exact declaration; there are no wildcards.
 */

export interface OpInfo {
  /** Write operations use the stricter rate limit, are logged, and (where relevant) snapshotted. */
  write: boolean;
  /** Operations that open a note or a dialog in Obsidian share a small separate budget. */
  ui?: boolean;
}

const read = { write: false } as const;
const write = { write: true } as const;
const ui = { write: false, ui: true } as const;

export const OPS: ReadonlyMap<string, OpInfo> = new Map<string, OpInfo>([
  ["files.read", read],
  ["files.readBinary", read],
  ["files.exists", read],
  ["files.list", read],
  ["files.search", read],
  ["files.create", write],
  ["files.edit", write],
  ["files.rename", write],
  ["files.move", write],
  ["files.delete", write],
  ["files.createFolder", write],
  ["formats.parseYaml", read],
  ["formats.stringifyYaml", read],
  ["formats.parseJson", read],
  ["formats.stringifyJson", read],
  ["formats.parseMarkdown", read],
  ["formats.writeMarkdown", read],
  ["frontmatter.read", read],
  ["frontmatter.update", write],
  ["links.resolve", read],
  ["links.open", ui],
  ["links.backlinks", read],
  ["links.outgoing", read],
  ["links.activeNote", read],
  ["pick.note", ui],
  ["pick.folder", ui],
  ["events.subscribe", read],
  ["events.unsubscribe", read],
  ["storage.read", read],
  ["storage.write", write],
  ["theme.get", read],
  ["embed.context", read],
]);

/**
 * theme.get is display-only (the theme event is already pushed to every app).
 * embed.context only tells an app facts about its own placement: it grants nothing and reads no vault content.
 */
export const ALWAYS_ALLOWED: ReadonlySet<string> = new Set(["theme.get", "embed.context"]);

export function isKnownOp(op: string): boolean {
  return OPS.has(op);
}

export function isUiOp(op: string): boolean {
  return OPS.get(op)?.ui === true;
}

export function isWriteOp(op: string): boolean {
  return OPS.get(op)?.write === true;
}

export function isAllowed(op: string, declared: ReadonlySet<string>): boolean {
  return ALWAYS_ALLOWED.has(op) || declared.has(op);
}
