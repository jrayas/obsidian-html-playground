/** Bulk-operation planning and folder-content checks (pure). See docs/phases/phase-2-bridge.md, Q19. */
import { isExcluded } from "../paths/exclusions";
import { BridgeError } from "./errors";
import type { Limits } from "./limits";

export type BulkVerdict = "ok" | "confirm" | "too_large";

/** Folder deletes always ask; so does touching more than the threshold; past the cap it is refused. */
export function planBulk(
  fileCount: number,
  isFolderDelete: boolean,
  limits: Pick<Limits, "bulkConfirmFiles" | "bulkCapFiles">,
): BulkVerdict {
  if (fileCount > limits.bulkCapFiles) return "too_large";
  if (isFolderDelete || fileCount > limits.bulkConfirmFiles) return "confirm";
  return "ok";
}

export interface SubtreeListing {
  files: string[];
  folders: string[];
}

const basename = (p: string) => p.slice(p.lastIndexOf("/") + 1);

/**
 * A folder operation moves or deletes EVERYTHING inside, including hidden items the vault index never shows.
 * Refuse if any entry is excluded or hidden, or is a manifest.json (an app folder). The message is generic.
 */
export function checkSubtree(listing: SubtreeListing, exclusions: readonly string[]): void {
  for (const entry of [...listing.files, ...listing.folders]) {
    if (isExcluded(entry, exclusions) || basename(entry).toLowerCase() === "manifest.json") {
      throw new BridgeError("DENIED", "This folder contains items the app may not change.");
    }
  }
}
