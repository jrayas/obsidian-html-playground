/** Small read operations: front matter read, app storage read, theme. */
import { BridgeError } from "../errors";
import type { Handler } from "../host";
import { resolveArg } from "../paths";
import { requireString } from "./args";
import type { ThemeSnapshot } from "../../theme/variables";

export function miscReadOps(getTheme: () => ThemeSnapshot): Record<string, Handler> {
  return {
    "frontmatter.read": async (args, call) => {
      const path = call.readPath(requireString(args, "path"));
      return { result: { frontmatter: call.gateway.frontmatter(path) } };
    },

    /** The app's own data.json. A missing file reads as { value: null }. */
    "storage.read": async (_args, call) => {
      const path = resolveArg(`${call.ctx.appRoot}/data.json`, call.ctx.pathCtx);
      if (call.gateway.kind(path) !== "file") return { result: { value: null } };
      const { content } = await call.gateway.readText(path, call.limits.storageBytes);
      try {
        return { result: { value: JSON.parse(content) as unknown } };
      } catch {
        throw new BridgeError("INVALID", "Stored data is not valid JSON.");
      }
    },

    "theme.get": async () => ({ result: getTheme() }),

    /**
     * Where the app is and what the note asked of it. Always allowed, read-only. The note's path is returned
     * only if this app could read that note anyway (single resolver, exclusions, read scope); otherwise null,
     * which looks the same as "not embedded in a readable note". Parameters are plain text from the note.
     */
    "embed.context": async (_args, call) => {
      const embed = call.ctx.embed;
      if (!embed) return { result: { embedded: false, sourcePath: null, params: {} } };
      let sourcePath: string | null = null;
      try {
        sourcePath = call.readPath(embed.sourcePath);
      } catch {
        sourcePath = null;
      }
      return { result: { embedded: true, sourcePath, params: { ...embed.params } } };
    },
  };
}
