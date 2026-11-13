/**
 * Destructive operations (step 2c): rename, move, delete.
 *
 * Every one goes through the same write guards as a write (writePath), then adds:
 *  - folder operations inspect the real directory contents first and refuse excluded, hidden or app items
 *  - the notes whose links Obsidian will rewrite are snapshotted first (including excluded ones)
 *  - bulk operations and every folder delete ask the user; past a hard cap they are refused
 *  - a delete that would be permanent always asks, even for one note and even for a trusted app
 *  - delete follows the user's "Deleted files" setting; if that erases permanently the user is asked first (see trash.ts)
 *  - fail closed: if a snapshot cannot be stored, nothing is moved or deleted
 */
import { normaliseForMatch } from "../../paths/exclusions";
import { checkSubtree, planBulk, type SubtreeListing } from "../bulk";
import { BridgeError } from "../errors";
import type { CallContext, Handler } from "../host";
import { parentOf, type VaultPath } from "../paths";
import { checkNotScopeRoot, checkWritableType, extensionOf } from "../writeguard";
import { requireString } from "./args";

const TEXT_TYPES = new Set(["md", "txt", "json", "yaml", "yml", "csv", "canvas"]);
const isTextFile = (path: string) => TEXT_TYPES.has(extensionOf(path));
const unique = (list: readonly string[]) => [...new Set(list)];

/** Asks the user if the operation is bulk or a folder delete. Throws DENIED if refused. */
async function approve(
  call: CallContext,
  verdict: ReturnType<typeof planBulk>,
  title: string,
  details: string[],
  paths: string[],
  alwaysAsk = false,
): Promise<void> {
  if (verdict === "too_large") throw new BridgeError("TOO_LARGE", "Too many files in one operation.");
  if (verdict === "ok" && !alwaysAsk) return;
  if (!(await call.confirm({ title, details, paths }))) {
    throw new BridgeError("DENIED", "The user did not approve this operation.");
  }
}

async function listFolder(call: CallContext, path: VaultPath): Promise<SubtreeListing> {
  const listing = await call.gateway.subtree(path, call.limits.subtreeEntries);
  checkSubtree(listing, call.ctx.pathCtx.exclusions);
  return listing;
}

function moveHandler(op: "files.rename" | "files.move"): Handler {
  return async (args, call) => {
    const from = call.writePath(requireString(args, "from"));
    const to = call.writePath(requireString(args, "to"));
    checkNotScopeRoot(from, call.ctx);
    if (from === to) throw new BridgeError("INVALID", "Nothing to do.");
    const sameFolder = normaliseForMatch(parentOf(from) ?? "") === normaliseForMatch(parentOf(to) ?? "");
    if (op === "files.rename" && !sameFolder) throw new BridgeError("INVALID", "Rename stays in one folder; use files.move.");

    return call.lockAll([from, to], async () => {
      const kind = call.gateway.kind(from);
      if (!kind) throw new BridgeError("NOT_FOUND");
      if (kind === "file") {
        checkWritableType(from);
        checkWritableType(to);
      } else if (normaliseForMatch(to).startsWith(normaliseForMatch(from) + "/")) {
        throw new BridgeError("INVALID", "A folder cannot be moved into itself.");
      }
      if (call.gateway.existsInsensitive(to, from)) throw new BridgeError("INVALID", "Already exists.");

      // 1. Work out exactly what will change.
      const listing = kind === "folder" ? await listFolder(call, from) : { files: [from as string], folders: [] };
      const sources = call.gateway.linkSources(listing.files);
      if (sources.length > 0 && !call.gateway.linksAutoUpdate()) {
        throw new BridgeError(
          "DENIED",
          "Turn on 'Automatically update internal links' in Obsidian (Files and links) to move linked notes.",
        );
      }
      const affected = unique([...listing.files, ...sources]);
      const verdict = planBulk(affected.length, false, call.limits);
      await approve(
        call,
        verdict,
        kind === "folder" ? "Move a folder" : "Move many files",
        [
          `${listing.files.length} file(s) will move.`,
          `${sources.length} other note(s) will have links updated.`,
          `From: ${from}`,
          `To: ${to}`,
        ],
        affected,
      );

      // 2. Snapshot what will be rewritten (linking notes), and the moved text files for folder or bulk moves.
      const moved = kind === "folder" || verdict !== "ok" ? listing.files.filter(isTextFile) : [];
      const texts = await call.gateway.snapshotTexts(unique([...sources, ...moved]), call.limits.readTextBytes);
      for (const text of texts) {
        await call.snapshot(text.path, text.content, op);
        call.touch(text.path);
      }

      // 3. Move.
      for (const folder of await call.gateway.renameItem(from, to)) call.touch(folder);
      return { result: { path: to } };
    });
  };
}

export function destructiveOps(): Record<string, Handler> {
  return {
    "files.rename": moveHandler("files.rename"),
    "files.move": moveHandler("files.move"),

    "files.delete": async (args, call) => {
      const path = call.writePath(requireString(args, "path"));
      checkNotScopeRoot(path, call.ctx);

      return call.lock(path, async () => {
        const kind = call.gateway.kind(path);
        if (!kind) throw new BridgeError("NOT_FOUND");

        let files: string[];
        if (kind === "file") {
          checkWritableType(path);
          files = [path];
        } else {
          files = (await listFolder(call, path)).files;
        }
        const verdict = planBulk(files.length, kind === "folder", call.limits);
        const permanent = call.gateway.deletesPermanently();
        const notNotes = files.filter((f) => !isTextFile(f)).length;
        await approve(
          call,
          verdict,
          permanent ? "Delete permanently" : kind === "folder" ? "Delete a folder" : "Delete many files",
          permanent
            ? [
                `Your Obsidian setting "Deleted files" is "Permanently delete": ${files.length} file(s) will be erased, not moved to a trash.`,
                notNotes > 0
                  ? `${notNotes} of them are not notes, so no copy can be kept of those. A copy of each note is kept in Snapshots (command: Show snapshots).`
                  : "A copy of each note is kept in Snapshots (command: Show snapshots) so you can restore it.",
                `Path: ${path}`,
              ]
            : [`${files.length} file(s) will go to the trash.`, `Path: ${path}`],
          files,
          permanent,
        );

        // Snapshot first: a second way back besides the trash. All or nothing.
        const texts = await call.gateway.snapshotTexts(files.filter(isTextFile), call.limits.readTextBytes);
        for (const text of texts) await call.snapshot(text.path, text.content, "files.delete");

        await call.gateway.deleteItem(path);
        return { result: { trashed: !permanent, deleted: true } };
      });
    },
  };
}
