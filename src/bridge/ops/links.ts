/** links.*, events.* and pick.*: the interactive operations (step 2d). Everything returned is filtered to what the app may read. */
import { BridgeError } from "../errors";
import { EVENT_KINDS, type EventKind } from "../events";
import type { Handler } from "../host";
import { requireString, optionalString } from "./args";

export function linksOps(): Record<string, Handler> {
  return {
    /** Resolve link text the way Obsidian does. A target the app cannot read looks the same as no target. */
    "links.resolve": async (args, call) => {
      const link = requireString(args, "link", 300);
      const fromArg = optionalString(args, "from");
      const from = fromArg === undefined ? "" : call.readPath(fromArg);
      const target = call.gateway.resolveLink(link, from);
      return { result: { path: target !== null && call.visible(target) ? target : null } };
    },

    /** Open a note in Obsidian (a new tab, or the tab already showing it). Rate limited. */
    "links.open": async (args, call) => {
      const path = call.readPath(requireString(args, "path"));
      if (call.gateway.kind(path) !== "file") throw new BridgeError("NOT_FOUND");
      await call.gateway.openFile(path);
      return { result: { opened: true } };
    },

    "links.backlinks": async (args, call) => {
      const path = call.readPath(requireString(args, "path"));
      if (call.gateway.kind(path) !== "file") throw new BridgeError("NOT_FOUND");
      return { result: { paths: call.gateway.backlinks(path, call.visible, call.limits.linkResults) } };
    },

    "links.outgoing": async (args, call) => {
      const path = call.readPath(requireString(args, "path"));
      if (call.gateway.kind(path) !== "file") throw new BridgeError("NOT_FOUND");
      return { result: { paths: call.gateway.outgoing(path, call.visible, call.limits.linkResults) } };
    },

    /** The note open in Obsidian, or null (also null when it is one the app may not read). */
    "links.activeNote": async (_args, call) => {
      const path = call.gateway.activePath();
      return { result: { path: path !== null && call.visible(path) ? path : null } };
    },
  };
}

export function eventsOps(): Record<string, Handler> {
  return {
    "events.subscribe": async (args, call) => {
      const kindsArg = args.kinds;
      let kinds: EventKind[] = [...EVENT_KINDS];
      if (kindsArg !== undefined) {
        const valid = Array.isArray(kindsArg) && kindsArg.length > 0 && kindsArg.length <= EVENT_KINDS.length && kindsArg.every((k) => EVENT_KINDS.includes(k as EventKind));
        if (!valid) throw new BridgeError("INVALID", "Bad argument: kinds.");
        kinds = [...new Set(kindsArg as EventKind[])];
      }
      const folderArg = optionalString(args, "folder");
      const folder = folderArg === undefined ? null : call.readPath(folderArg, true);
      return { result: { id: call.events.subscribe(kinds, folder) } };
    },

    "events.unsubscribe": async (args, call) => ({ result: { removed: call.events.unsubscribe(requireString(args, "id", 32)) } }),
  };
}

export function pickOps(): Record<string, Handler> {
  const pick =
    (kind: "note" | "folder"): Handler =>
    async (_args, call) => {
      const path = await call.pick(kind);
      // The dialog only lists readable paths; check again so the result can never be something else.
      return { result: { path: path !== null && call.visible(path) ? path : null } };
    };
  return { "pick.note": pick("note"), "pick.folder": pick("folder") };
}
