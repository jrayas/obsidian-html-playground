/** Safe write operations (step 2b): create, edit, createFolder, front matter update, app storage. */
import { BridgeError } from "../errors";
import type { Handler } from "../host";
import { resolveArg } from "../paths";
import { extensionOf, checkWritableType, checkWriteSize } from "../writeguard";
import { utf8Length } from "../snapshots";
import { optionalEnum, optionalInt, requireObjectValue, requireString } from "./args";

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const MAX_DEPTH = 10;
const MAX_NODES = 5000;

/** Reject prototype-pollution keys and absurdly deep or large values anywhere in a value. */
export function assertSafeValue(value: unknown, depth = 0, budget = { nodes: 0 }): void {
  if (depth > MAX_DEPTH) throw new BridgeError("INVALID", "Value is nested too deeply."); // also stops cycles
  if (++budget.nodes > MAX_NODES) throw new BridgeError("TOO_LARGE");
  if (Array.isArray(value)) {
    for (const item of value) assertSafeValue(item, depth + 1, budget);
  } else if (typeof value === "object" && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.has(key)) throw new BridgeError("INVALID", "Forbidden key.");
      assertSafeValue(item, depth + 1, budget);
    }
  }
}

/** JSON round trip: drops anything that is not plain data (functions, Dates become strings, and so on). */
function toPlainJson(value: unknown, maxBytes: number): { clean: unknown; text: string } {
  let text: string | undefined;
  try {
    text = JSON.stringify(value);
  } catch {
    throw new BridgeError("INVALID", "Value cannot be written as JSON.");
  }
  if (text === undefined) throw new BridgeError("INVALID", "Value cannot be written as JSON.");
  if (text.length > maxBytes) throw new BridgeError("TOO_LARGE");
  return { clean: JSON.parse(text) as unknown, text };
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function writeOps(): Record<string, Handler> {
  return {
    "files.create": async (args, call) => {
      const content = requireString(args, "content", Infinity) /* size is checked in bytes below: TOO_LARGE */;
      const path = call.writePath(requireString(args, "path"));
      checkWritableType(path);
      checkWriteSize(content, call.limits.writeTextBytes);
      return call.lock(path, async () => {
        const createdFolders = await call.gateway.createText(path, content);
        for (const folder of createdFolders) call.touch(folder);
        return { result: { path } };
      });
    },

    "files.edit": async (args, call) => {
      const content = requireString(args, "content", Infinity) /* size is checked in bytes below: TOO_LARGE */;
      const mode = optionalEnum(args, "mode", ["overwrite", "append"] as const, "overwrite");
      const ifUnmodifiedSince = optionalInt(args, "ifUnmodifiedSince", 0, Number.MAX_SAFE_INTEGER, -1);
      const path = call.writePath(requireString(args, "path"));
      checkWritableType(path);
      checkWriteSize(content, call.limits.writeTextBytes);

      return call.lock(path, async () => {
        if (call.gateway.kind(path) !== "file") throw new BridgeError("NOT_FOUND");
        const current = await call.gateway.readText(path, call.limits.readTextBytes);
        if (ifUnmodifiedSince >= 0 && current.mtime > ifUnmodifiedSince) {
          throw new BridgeError("INVALID", "The file changed since it was read.");
        }
        if (mode === "append") checkWriteSize(current.content + content, call.limits.writeTextBytes);

        await call.snapshot(path, current.content, "files.edit");
        if (mode === "append") await call.gateway.appendText(path, content);
        else await call.gateway.modifyText(path, content);
        return { result: call.gateway.stat(path) };
      });
    },

    "files.createFolder": async (args, call) => {
      const path = call.writePath(requireString(args, "path"));
      return call.lock(path, async () => {
        const kind = call.gateway.kind(path);
        if (kind === "file") throw new BridgeError("INVALID", "A file is in the way.");
        if (kind === "folder") return { result: { path, created: false } };
        for (const folder of await call.gateway.ensureFolder(path)) call.touch(folder);
        return { result: { path, created: true } };
      });
    },

    "frontmatter.update": async (args, call) => {
      const path = call.writePath(requireString(args, "path"));
      if (extensionOf(path) !== "md") throw new BridgeError("INVALID", "Front matter needs a Markdown note.");

      const set = args.set;
      if (set !== undefined && !isPlainObject(set)) throw new BridgeError("INVALID", "Bad argument: set.");
      const remove = args.remove;
      if (remove !== undefined && !(Array.isArray(remove) && remove.length <= 100 && remove.every((k) => typeof k === "string"))) {
        throw new BridgeError("INVALID", "Bad argument: remove.");
      }
      const toSet = (set ?? {});
      const toRemove = (remove ?? []);
      if (Object.keys(toSet).length === 0 && toRemove.length === 0) throw new BridgeError("INVALID", "Nothing to update.");

      const keys = [...Object.keys(toSet), ...toRemove];
      for (const key of keys) {
        if (key.length === 0 || key.length > 100 || FORBIDDEN_KEYS.has(key)) throw new BridgeError("INVALID", "Bad key.");
        // eslint-disable-next-line no-control-regex -- control characters are the point: names containing them are refused
        if (/[\u0000-\u001f]/.test(key)) throw new BridgeError("INVALID", "Bad key.");
      }
      assertSafeValue(toSet);
      const { clean } = toPlainJson(toSet, call.limits.frontmatterBytes);
      const values = clean as Record<string, unknown>;

      return call.lock(path, async () => {
        if (call.gateway.kind(path) !== "file") throw new BridgeError("NOT_FOUND");
        const current = await call.gateway.readText(path, call.limits.readTextBytes);
        await call.snapshot(path, current.content, "frontmatter.update");
        await call.gateway.updateFrontmatter(path, (fm) => {
          for (const key of toRemove) delete fm[key];
          for (const key of Object.keys(values)) fm[key] = values[key];
        });
        return { result: { updated: Object.keys(values), removed: toRemove } };
      });
    },

    /** The app's own data.json. The only write an app may make inside its own folder. */
    "storage.write": async (args, call) => {
      const value = requireObjectValue(args, "value");
      assertSafeValue(value);
      const { text } = toPlainJson(value, call.limits.storageBytes);
      const path = resolveArg(`${call.ctx.appRoot}/data.json`, call.ctx.pathCtx);
      call.touch(path);
      return call.lock(path, async () => {
        await call.gateway.writeStorage(path, text);
        return { result: { size: utf8Length(text) } };
      });
    },
  };
}
