/**
 * What an app's delete will do (pure).
 *
 * Obsidian's "Deleted files" preference is "system", "local" (the vault's .trash) or "none" (erase permanently).
 * An app's delete follows that preference through FileManager.trashFile. Only "none" erases, so only "none"
 * needs the extra pop-up: everything else, including an unknown value, ends in a trash that can be emptied back.
 */
export function deletesPermanently(option: unknown): boolean {
  return option === "none";
}
