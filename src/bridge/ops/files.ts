/** files.* read operations. Writes arrive in step 2b. */
import { BridgeError } from "../errors";
import type { Handler } from "../host";
import { optionalBool, optionalInt, optionalString, requireString } from "./args";

export const filesReadOps: Record<string, Handler> = {
  "files.read": async (args, call) => {
    const path = call.readPath(requireString(args, "path"));
    return { result: await call.gateway.readText(path, call.limits.readTextBytes) };
  },

  "files.readBinary": async (args, call) => {
    const path = call.readPath(requireString(args, "path"));
    const result = await call.gateway.readBinary(path, call.limits.readBinaryBytes);
    return { result, transfer: [result.data] };
  },

  /** Missing, excluded and out-of-scope paths all answer { exists: false }, so existence never leaks. */
  "files.exists": async (args, call) => {
    try {
      const path = call.readPath(requireString(args, "path"), true);
      const type = call.gateway.kind(path);
      return { result: type ? { exists: true, type } : { exists: false } };
    } catch (error) {
      if (error instanceof BridgeError && error.code === "NOT_FOUND") return { result: { exists: false } };
      throw error;
    }
  },

  "files.list": async (args, call) => {
    const path = call.readPath(requireString(args, "path"), true);
    const recursive = optionalBool(args, "recursive", false);
    return { result: call.gateway.list(path, recursive, call.visible, call.limits.listEntries) };
  },

  "files.search": async (args, call) => {
    const query = requireString(args, "query", 200);
    if (query.trim() === "") throw new BridgeError("INVALID", "Bad argument: query.");
    const folderArg = optionalString(args, "folder");
    const folder = folderArg === undefined ? null : call.readPath(folderArg, true);
    const limit = optionalInt(args, "limit", 1, call.limits.searchResults, call.limits.searchResults);
    const result = await call.gateway.search(query, folder, call.visible, {
      limit,
      maxFiles: call.limits.searchFiles,
      maxMs: call.limits.searchMs,
      maxContentBytes: call.limits.searchContentBytes,
    });
    return { result };
  },
};
