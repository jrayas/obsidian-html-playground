/**
 * Which trash to use for an app delete (pure).
 *
 * Obsidian's "Deleted files" preference is "system", "local" (the vault's .trash) or "none" (permanent
 * delete). Apps may NEVER cause a permanent delete, so "none" and anything unknown becomes the system trash.
 * We call vault.trash(file, system) directly: fileManager.trashFile would obey "none" and erase the file.
 */
export function useSystemTrash(option: unknown): boolean {
  return option !== "local";
}
