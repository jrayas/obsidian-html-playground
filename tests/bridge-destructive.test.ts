import { describe, expect, it } from "vitest";
import type { AppManifest } from "../src/apps/manifest";
import { checkSubtree, planBulk } from "../src/bridge/bulk";
import { buildContext } from "../src/bridge/context";
import { BridgeHost, type Handler } from "../src/bridge/host";
import { limitsFor } from "../src/bridge/limits";
import { destructiveOps } from "../src/bridge/ops/destructive";
import { filesReadOps } from "../src/bridge/ops/files";
import { writeOps } from "../src/bridge/ops/writes";
import type { BridgeResponse } from "../src/bridge/protocol";
import { restoreSnapshot } from "../src/bridge/restore";
import { deletesPermanently } from "../src/bridge/trash";
import { memoryServices, mutableApp } from "./support";

// ---- harness -----------------------------------------------------------------------------------

const manifest = (extra: Partial<AppManifest> = {}): AppManifest => ({
  name: "T", version: "1", description: "", entry: "index.html", permissions: [], trusted: false,
  aiGenerated: false, allowedDomains: [], ...extra,
});

const PERMS = ["files.create", "files.edit", "files.rename", "files.move", "files.delete", "files.read", "files.exists"];

const VAULT: Record<string, string> = {
  "Sandbox/a.md": "a",
  "Sandbox/Move Me.md": "I am moved",
  "Sandbox/sub/inner.md": "inner",
  "Sandbox/bin.png": "PNGDATA",
  "Sandbox/folder/f1.md": "f1",
  "Sandbox/folder/f2.md": "f2",
  "Sandbox/folder/f3.md": "f3",
  "Notes/Linker.md": "see [[Move Me]] and ![[Move Me]]",
  "Private/Links.md": "secret link [[Move Me]] TOP SECRET",
  "Notes/outside.md": "outside",
  "Welcome.md": "hi",
  "Apps/T/manifest.json": "{}",
  "Apps/T/index.html": "<html>",
};

function host(
  extraFiles: Record<string, string> = {},
  opts: { hidden?: string[]; trusted?: boolean; scopes?: string[]; permissions?: string[]; exclusions?: string[] } = {},
) {
  // An advancing clock: requests are never rate limited, so every refusal below comes from a guard.
  let auto = 0;
  const now = () => (auto += 1000);
  const vault = mutableApp({ ...VAULT, ...extraFiles }, opts.hidden);
  const services = memoryServices(vault.gateway, { now });
  const built = buildContext({
    appRoot: "Apps/T",
    manifest: manifest({ permissions: opts.permissions ?? PERMS, writeScopes: opts.scopes ?? ["Sandbox"] }),
    strictPaths: false,
    exclusions: opts.exclusions ?? ["Private/", "*.secret.md"],
  });
  const ctx = opts.trusted ? { ...built.ctx, trusted: true } : built.ctx;
  const handlers = new Map<string, Handler>(Object.entries({ ...filesReadOps, ...writeOps(), ...destructiveOps() }));
  const sent: BridgeResponse[] = [];
  const h = new BridgeHost(ctx, services, handlers, (m) => sent.push(m), now);
  let n = 0;
  const call = async (op: string, args: Record<string, unknown> = {}) => {
    const before = sent.length;
    await h.handle({ v: 1, id: `d${++n}`, type: "request", op, args });
    return sent[before];
  };
  const logs = async () => (await services.logStore.recent(100)).reverse();
  return { call, vault, services, logs, sent };
}

const code = (r: BridgeResponse) => r.error?.code;
const many = (dir: string, n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`${dir}/f${i}.md`, `file ${i}`]));

// ---- pure pieces -------------------------------------------------------------------------------

describe("deletion policy", () => {
  it("only Obsidian's 'none' setting erases permanently; anything else, even an unknown value, ends in a trash", () => {
    expect(deletesPermanently("none")).toBe(true);
    for (const other of ["system", "local", undefined, null, "", "permanent", 0, false, {}]) expect(deletesPermanently(other), String(other)).toBe(false);
  });
});

describe("planBulk", () => {
  const limits = limitsFor(false);
  it("asks above the threshold, always for folder deletes, and refuses above the cap", () => {
    expect(planBulk(1, false, limits)).toBe("ok");
    expect(planBulk(10, false, limits)).toBe("ok");
    expect(planBulk(11, false, limits)).toBe("confirm");
    expect(planBulk(0, true, limits)).toBe("confirm");
    expect(planBulk(50, false, limits)).toBe("confirm");
    expect(planBulk(51, false, limits)).toBe("too_large");
    expect(planBulk(51, true, limits)).toBe("too_large");
  });
  it("trusted apps get a higher cap but are still asked", () => {
    const trusted = limitsFor(true);
    expect(planBulk(51, false, trusted)).toBe("confirm");
    expect(planBulk(200, false, trusted)).toBe("confirm");
    expect(planBulk(201, false, trusted)).toBe("too_large");
  });
});

describe("checkSubtree", () => {
  const ok = { files: ["A/x.md", "A/sub/y.md"], folders: ["A/sub"] };
  it("accepts ordinary folders", () => expect(() => checkSubtree(ok, ["Private/"])).not.toThrow());
  it("refuses excluded, hidden and app entries with one generic message", () => {
    const bad = [
      { files: ["A/Private/x.md"], folders: ["A/Private"] },
      { files: ["A/x.secret.md"], folders: [] },
      { files: ["A/.git/config"], folders: ["A/.git"] },
      { files: [], folders: ["A/.hidden"] },
      { files: ["A/app/manifest.json"], folders: [] },
      { files: ["A/MANIFEST.JSON"], folders: [] },
    ];
    const messages = bad.map((l) => {
      try {
        checkSubtree(l, ["Private/", "*.secret.md"]);
        return "none";
      } catch (e) {
        return (e as Error).message;
      }
    });
    expect(new Set(messages)).toEqual(new Set(["This folder contains items the app may not change."]));
  });
});

// ---- rename and move ---------------------------------------------------------------------------

describe("files.rename and files.move", () => {
  it("renames a note, updates links, and snapshots every note that links to it (even excluded ones)", async () => {
    const h = host();
    const r = await h.call("files.rename", { from: "Sandbox/Move Me.md", to: "Sandbox/Moved Note.md" });
    expect(r.result).toEqual({ path: "Sandbox/Moved Note.md" });
    const state = h.vault.state();
    expect(state["Sandbox/Moved Note.md"]).toBe("I am moved");
    expect(state["Sandbox/Move Me.md"]).toBeUndefined();
    expect(state["Notes/Linker.md"]).toBe("see [[Moved Note]] and ![[Moved Note]]");
    expect(state["Private/Links.md"]).toContain("[[Moved Note]]"); // Obsidian rewrote the excluded note too

    const snaps = await h.services.snapshots.list();
    expect(snaps.map((s) => s.path).sort()).toEqual(["Notes/Linker.md", "Private/Links.md"]);
    const linker = snaps.find((s) => s.path === "Notes/Linker.md")!;
    expect(await h.services.snapshots.content(linker.id)).toBe(VAULT["Notes/Linker.md"]);
    // The app is told nothing about notes it cannot see.
    expect(JSON.stringify(r)).not.toContain("Private");
    expect(JSON.stringify(r)).not.toContain("Links");
  });

  it("an old link can be restored from its snapshot", async () => {
    const h = host();
    await h.call("files.rename", { from: "Sandbox/Move Me.md", to: "Sandbox/Moved Note.md" });
    const linker = (await h.services.snapshots.list("Notes/Linker.md"))[0];
    await restoreSnapshot(linker.id, {
      gateway: h.vault.gateway, snapshots: h.services.snapshots, audit: h.services.audit, exclusions: ["Private/"], maxReadBytes: 1e6,
    });
    expect(h.vault.state()["Notes/Linker.md"]).toBe(VAULT["Notes/Linker.md"]);
  });

  it("logs the move with the notes that were snapshotted", async () => {
    const h = host();
    await h.call("files.move", { from: "Sandbox/Move Me.md", to: "Sandbox/sub/Moved.md" });
    const entry = (await h.logs()).at(-1)!;
    expect(entry).toMatchObject({ op: "files.move", ok: true });
    expect(entry.paths).toEqual(expect.arrayContaining(["Sandbox/Move Me.md", "Sandbox/sub/Moved.md", "Notes/Linker.md"]));
  });

  it("rename stays in one folder; move may change folder and creates parents", async () => {
    const h = host();
    expect(code(await h.call("files.rename", { from: "Sandbox/a.md", to: "Sandbox/sub/a.md" }))).toBe("INVALID");
    expect((await h.call("files.rename", { from: "Sandbox/a.md", to: "Sandbox/renamed.md" })).ok).toBe(true);
    expect((await h.call("files.move", { from: "Sandbox/renamed.md", to: "Sandbox/new/deeper/a.md" })).ok).toBe(true);
    expect(h.vault.state()["Sandbox/new/deeper/a.md"]).toBe("a");
    expect(h.vault.folders()).toEqual(expect.arrayContaining(["Sandbox/new", "Sandbox/new/deeper"]));
  });

  it("both ends must be inside the write scope and visible", async () => {
    const h = host();
    const before = h.vault.state();
    expect(code(await h.call("files.move", { from: "Sandbox/a.md", to: "Notes/a.md" }))).toBe("DENIED");
    expect(code(await h.call("files.move", { from: "Notes/outside.md", to: "Sandbox/outside.md" }))).toBe("DENIED");
    expect(code(await h.call("files.move", { from: "Sandbox/a.md", to: "Private/a.md" }))).toBe("NOT_FOUND");
    expect(code(await h.call("files.move", { from: "Private/Links.md", to: "Sandbox/x.md" }))).toBe("NOT_FOUND");
    expect(code(await h.call("files.move", { from: "Sandbox/a.md", to: "Apps/T/a.md" }))).toBe("DENIED");
    expect(code(await h.call("files.move", { from: "Apps/T/manifest.json", to: "Sandbox/m.md" }))).toBe("DENIED");
    expect(code(await h.call("files.move", { from: "Sandbox/a.md", to: "../a.md" }))).toBe("INVALID");
    expect(h.vault.state()).toEqual(before);
  });

  it("never overwrites, including on a case-insensitive disk", async () => {
    const h = host();
    expect(code(await h.call("files.move", { from: "Sandbox/a.md", to: "Sandbox/Move Me.md" }))).toBe("INVALID");
    expect(code(await h.call("files.move", { from: "Sandbox/a.md", to: "Sandbox/MOVE ME.MD" }))).toBe("INVALID");
    expect(code(await h.call("files.move", { from: "Sandbox/a.md", to: "Sandbox/a.md" }))).toBe("INVALID");
    expect(h.vault.state()["Sandbox/Move Me.md"]).toBe("I am moved");
    expect(h.vault.state()["Sandbox/a.md"]).toBe("a");
    // A case-only rename of the same note is allowed.
    expect((await h.call("files.rename", { from: "Sandbox/a.md", to: "Sandbox/A.md" })).ok).toBe(true);
  });

  it("only moves text files, and cannot change a file's type", async () => {
    const h = host();
    expect(code(await h.call("files.move", { from: "Sandbox/a.md", to: "Sandbox/a.js" }))).toBe("INVALID");
    expect(code(await h.call("files.move", { from: "Sandbox/a.md", to: "Sandbox/a.html" }))).toBe("INVALID");
    expect(code(await h.call("files.move", { from: "Sandbox/bin.png", to: "Sandbox/bin2.png" }))).toBe("INVALID");
    expect(code(await h.call("files.move", { from: "Sandbox/missing.md", to: "Sandbox/x.md" }))).toBe("NOT_FOUND");
  });

  it("refuses to move a note that has incoming links when Obsidian will not update them", async () => {
    const h = host();
    h.vault.setConfig("alwaysUpdateLinks", false);
    const before = h.vault.state();
    const r = await h.call("files.move", { from: "Sandbox/Move Me.md", to: "Sandbox/Gone.md" });
    expect(code(r)).toBe("DENIED");
    expect(r.error?.message).toContain("Automatically update internal links");
    expect(h.vault.state()).toEqual(before);
    expect((await h.call("files.move", { from: "Sandbox/a.md", to: "Sandbox/b.md" })).ok).toBe(true); // unlinked notes are fine
  });

  it("moves a folder, snapshotting its text files, without asking when it is small", async () => {
    const h = host();
    const r = await h.call("files.move", { from: "Sandbox/folder", to: "Sandbox/folder2" });
    expect(r.ok).toBe(true);
    expect(Object.keys(h.vault.state()).filter((p) => p.startsWith("Sandbox/folder2/")).sort()).toEqual([
      "Sandbox/folder2/f1.md", "Sandbox/folder2/f2.md", "Sandbox/folder2/f3.md",
    ]);
    expect((await h.services.snapshots.list()).map((s) => s.path).sort()).toEqual(["Sandbox/folder/f1.md", "Sandbox/folder/f2.md", "Sandbox/folder/f3.md"]);
    expect(h.services.confirmations).toEqual([]);
  });

  it("refuses a folder that contains excluded, hidden or app items, and a folder moved into itself", async () => {
    const h = host(
      { "Sandbox/ex/Private/x.md": "x", "Sandbox/ex/ok.md": "ok", "Sandbox/group/appy/manifest.json": "{}", "Sandbox/group/appy/i.md": "i", "Sandbox/gitproj/n.md": "n" },
      { hidden: ["Sandbox/gitproj/.git/config"] },
    );
    const before = h.vault.state();
    for (const from of ["Sandbox/ex", "Sandbox/group", "Sandbox/gitproj"]) {
      const r = await h.call("files.move", { from, to: `${from}-moved` });
      expect(code(r), from).toBe("DENIED");
      expect(r.error?.message).toBe("This folder contains items the app may not change.");
    }
    expect(code(await h.call("files.move", { from: "Sandbox/folder", to: "Sandbox/folder/inner" }))).toBe("INVALID");
    expect(h.vault.state()).toEqual(before);
    expect(await h.services.snapshots.list()).toEqual([]);
  });

  it("will not move the scope folder itself", async () => {
    const h = host();
    expect(code(await h.call("files.move", { from: "Sandbox", to: "Sandbox2" }))).toBe("DENIED");
    expect(code(await h.call("files.rename", { from: "Sandbox", to: "SandboxRenamed" }))).toBe("DENIED");
  });
});

describe("bulk operations ask the user", () => {
  it("asks when more than 10 files are touched, and honours a refusal", async () => {
    const h = host(many("Sandbox/big", 12));
    h.services.answer(false);
    const before = h.vault.state();
    const r = await h.call("files.move", { from: "Sandbox/big", to: "Sandbox/big2" });
    expect(code(r)).toBe("DENIED");
    expect(r.error?.message).toBe("The user did not approve this operation.");
    expect(h.vault.state()).toEqual(before);
    expect(h.services.confirmations).toHaveLength(1);
    expect(h.services.confirmations[0]).toMatchObject({ app: "Apps/T", title: "Move a folder" });
    expect(h.services.confirmations[0].paths).toHaveLength(12);
    expect(await h.services.snapshots.list()).toEqual([]); // nothing snapshotted before approval

    h.services.answer(true);
    expect((await h.call("files.move", { from: "Sandbox/big", to: "Sandbox/big2" })).ok).toBe(true);
    expect(Object.keys(h.vault.state()).filter((p) => p.startsWith("Sandbox/big2/"))).toHaveLength(12);
  });

  it("counts linking notes: one note with 12 links in is a bulk move", async () => {
    const linkers = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`Notes/L${i}.md`, "[[Move Me]]"]));
    const h = host(linkers);
    h.services.answer(false);
    expect(code(await h.call("files.move", { from: "Sandbox/Move Me.md", to: "Sandbox/Elsewhere.md" }))).toBe("DENIED");
    expect(h.services.confirmations[0].details.join(" ")).toContain("14 other note(s)"); // 12 + Notes/Linker + Private/Links
  });

  it("refuses past the hard cap without asking; trusted apps have a higher cap but are still asked", async () => {
    const h = host(many("Sandbox/huge", 60));
    expect(code(await h.call("files.move", { from: "Sandbox/huge", to: "Sandbox/huge2" }))).toBe("TOO_LARGE");
    expect(h.services.confirmations).toEqual([]);

    const t = host(many("Sandbox/huge", 60), { trusted: true });
    expect((await t.call("files.move", { from: "Sandbox/huge", to: "Sandbox/huge2" })).ok).toBe(true);
    expect(t.services.confirmations).toHaveLength(1);
    const over = host(many("Sandbox/gigantic", 201), { trusted: true });
    expect(code(await over.call("files.move", { from: "Sandbox/gigantic", to: "Sandbox/g2" }))).toBe("TOO_LARGE");
  });

  it("treats a dialog that fails as a refusal", async () => {
    const h = host(many("Sandbox/big", 12));
    h.services.confirm = async () => {
      throw new Error("modal crashed");
    };
    expect(code(await h.call("files.move", { from: "Sandbox/big", to: "Sandbox/big2" }))).toBe("DENIED");
  });
});

describe("move: failure and concurrency", () => {
  it("fails closed when the snapshot cannot be stored", async () => {
    const h = host();
    h.services.snapshotStore.put = async () => {
      throw new Error("disk full");
    };
    const quiet = console.error;
    console.error = () => {};
    const before = h.vault.state();
    expect(code(await h.call("files.move", { from: "Sandbox/Move Me.md", to: "Sandbox/Moved.md" }))).toBe("INTERNAL");
    console.error = quiet;
    expect(h.vault.state()).toEqual(before);
  });

  it("opposite moves at the same time cannot deadlock, and only one can win", async () => {
    const h = host();
    const race = Promise.all([
      h.call("files.move", { from: "Sandbox/a.md", to: "Sandbox/z.md" }),
      h.call("files.move", { from: "Sandbox/z.md", to: "Sandbox/a.md" }),
      h.call("files.move", { from: "Sandbox/a.md", to: "Sandbox/y.md" }),
    ]);
    const done = await Promise.race([race, new Promise<null>((r) => setTimeout(() => r(null), 2000))]);
    expect(done).not.toBeNull();
    const state = h.vault.state();
    expect(Object.keys(state).filter((p) => ["Sandbox/a.md", "Sandbox/z.md", "Sandbox/y.md"].includes(p))).toHaveLength(1);
    expect(Object.values(state).filter((c) => c === "a").length).toBe(1);
  });
});

// ---- delete ------------------------------------------------------------------------------------

describe("files.delete", () => {
  it("sends a note to the trash (never a permanent delete) after snapshotting it", async () => {
    const h = host();
    const r = await h.call("files.delete", { path: "Sandbox/a.md" });
    expect(r.result).toEqual({ trashed: true, deleted: true });
    expect(h.vault.state()["Sandbox/a.md"]).toBeUndefined();
    expect(h.vault.trashed).toEqual([{ path: "Sandbox/a.md", mode: "local" }]); // trashOption "local"
    const snap = (await h.services.snapshots.list("Sandbox/a.md"))[0];
    expect(await h.services.snapshots.content(snap.id)).toBe("a");
    expect((await h.logs()).at(-1)).toMatchObject({ op: "files.delete", ok: true, paths: ["Sandbox/a.md"] });
    expect(h.services.confirmations).toEqual([]); // a single file does not ask
  });

  it("follows the user's 'Deleted files' setting, and asks nobody when that setting is a trash", async () => {
    for (const [option, mode] of [["system", "system"], ["local", "local"], [undefined, "system"]] as const) {
      const h = host();
      h.vault.setConfig("trashOption", option);
      const r = await h.call("files.delete", { path: "Sandbox/a.md" });
      expect(r.result, String(option)).toEqual({ trashed: true, deleted: true });
      expect(h.vault.trashed, String(option)).toEqual([{ path: "Sandbox/a.md", mode }]);
      expect(h.services.confirmations, String(option)).toEqual([]);
    }
  });

  it("when the setting is 'permanently delete', even one note asks first, and Deny changes nothing", async () => {
    const h = host();
    h.vault.setConfig("trashOption", "none");
    h.services.answer(false);
    const before = h.vault.state();
    expect(code(await h.call("files.delete", { path: "Sandbox/a.md" }))).toBe("DENIED");
    expect(h.vault.state()).toEqual(before);
    expect(h.vault.trashed).toEqual([]);
    expect(await h.services.snapshots.list()).toEqual([]); // refused before anything was copied or removed
    expect(h.services.confirmations).toHaveLength(1);
    expect(h.services.confirmations[0]).toMatchObject({ title: "Delete permanently", app: "Apps/T", paths: ["Sandbox/a.md"] });
    expect(h.services.confirmations[0]?.details.join(" ")).toMatch(/Permanently delete/);
    expect(h.services.confirmations[0]?.details.join(" ")).toMatch(/Snapshots/);
  });

  it("when the user allows it, the note is erased after a snapshot, and the snapshot restores it", async () => {
    const h = host();
    h.vault.setConfig("trashOption", "none");
    h.services.answer(true);
    const r = await h.call("files.delete", { path: "Sandbox/a.md" });
    expect(r.result).toEqual({ trashed: false, deleted: true });
    expect(h.vault.state()["Sandbox/a.md"]).toBeUndefined();
    expect(h.vault.trashed).toEqual([{ path: "Sandbox/a.md", mode: "permanent" }]);
    const snap = (await h.services.snapshots.list("Sandbox/a.md"))[0];
    expect(await h.services.snapshots.content(snap.id)).toBe("a");
    const back = await restoreSnapshot(snap.id, {
      gateway: h.vault.gateway, snapshots: h.services.snapshots, audit: h.services.audit, exclusions: ["Private/"], maxReadBytes: 1e6,
    });
    expect(back).toEqual({ path: "Sandbox/a.md", recreated: true });
    expect(h.vault.state()["Sandbox/a.md"]).toBe("a");
  });

  it("a trusted app is asked too: trust never allows a permanent delete without the user's answer", async () => {
    const h = host({}, { trusted: true });
    h.vault.setConfig("trashOption", "none");
    h.services.answer(false);
    expect(code(await h.call("files.delete", { path: "Sandbox/a.md" }))).toBe("DENIED");
    expect(h.services.confirmations).toHaveLength(1);
    expect(h.vault.trashed).toEqual([]);
  });

  it("a permanent folder delete shows one pop-up that says which files cannot be copied", async () => {
    const h = host({ "Sandbox/folder/pic.png": "PNG" });
    h.vault.setConfig("trashOption", "none");
    h.services.answer(true);
    expect((await h.call("files.delete", { path: "Sandbox/folder" })).ok).toBe(true);
    expect(h.services.confirmations).toHaveLength(1); // not one for the folder and another for 'permanent'
    expect(h.services.confirmations[0]?.title).toBe("Delete permanently");
    expect(h.services.confirmations[0]?.details.join(" ")).toMatch(/1 of them are not notes/);
    expect(h.vault.trashed).toEqual([{ path: "Sandbox/folder", mode: "permanent" }]);
  });

  it("never calls vault.trash or vault.delete: the fake vault throws if the bridge does", async () => {
    for (const option of ["system", "local", "none"]) {
      const h = host();
      h.vault.setConfig("trashOption", option);
      h.services.answer(true);
      expect((await h.call("files.delete", { path: "Sandbox/a.md" })).ok, option).toBe(true);
    }
  });

  it("can be undone: restoring the snapshot recreates the note", async () => {
    const h = host();
    await h.call("files.delete", { path: "Sandbox/a.md" });
    const snap = (await h.services.snapshots.list("Sandbox/a.md"))[0];
    const r = await restoreSnapshot(snap.id, {
      gateway: h.vault.gateway, snapshots: h.services.snapshots, audit: h.services.audit, exclusions: ["Private/"], maxReadBytes: 1e6,
    });
    expect(r).toEqual({ path: "Sandbox/a.md", recreated: true });
    expect(h.vault.state()["Sandbox/a.md"]).toBe("a");
  });

  it("applies every write guard", async () => {
    const h = host();
    const before = h.vault.state();
    expect(code(await h.call("files.delete", { path: "Sandbox/missing.md" }))).toBe("NOT_FOUND");
    expect(code(await h.call("files.delete", { path: "Private/Links.md" }))).toBe("NOT_FOUND");
    expect(code(await h.call("files.delete", { path: ".obsidian/app.json" }))).toBe("NOT_FOUND");
    expect(code(await h.call("files.delete", { path: "Notes/outside.md" }))).toBe("DENIED");
    expect(code(await h.call("files.delete", { path: "Welcome.md" }))).toBe("DENIED");
    expect(code(await h.call("files.delete", { path: "Apps/T/manifest.json" }))).toBe("DENIED");
    expect(code(await h.call("files.delete", { path: "Apps/T/index.html" }))).toBe("DENIED");
    expect(code(await h.call("files.delete", { path: "Sandbox/bin.png" }))).toBe("INVALID");
    expect(code(await h.call("files.delete", { path: "Sandbox" }))).toBe("DENIED"); // the scope folder itself
    expect(code(await h.call("files.delete", { path: "../x.md" }))).toBe("INVALID");
    expect(h.vault.state()).toEqual(before);
    expect(h.vault.trashed).toEqual([]);
  });

  it("a folder delete always asks, and a refusal changes nothing", async () => {
    const h = host();
    h.services.answer(false);
    const before = h.vault.state();
    expect(code(await h.call("files.delete", { path: "Sandbox/folder" }))).toBe("DENIED");
    expect(h.vault.state()).toEqual(before);
    expect(h.vault.trashed).toEqual([]);
    expect(h.services.confirmations[0]).toMatchObject({ title: "Delete a folder", app: "Apps/T" });
    expect(await h.services.snapshots.list()).toEqual([]);

    h.services.answer(true);
    expect((await h.call("files.delete", { path: "Sandbox/folder" })).ok).toBe(true);
    expect(h.vault.trashed).toEqual([{ path: "Sandbox/folder", mode: "local" }]);
    expect((await h.services.snapshots.list()).map((s) => s.path).sort()).toEqual(["Sandbox/folder/f1.md", "Sandbox/folder/f2.md", "Sandbox/folder/f3.md"]);
  });

  it("refuses folders holding excluded, hidden or app items, and oversized folders", async () => {
    const h = host(
      { "Sandbox/ex/Private/x.md": "x", "Sandbox/group/appy/manifest.json": "{}", "Sandbox/gitproj/n.md": "n", ...many("Sandbox/big", 60) },
      { hidden: ["Sandbox/gitproj/.git/config"] },
    );
    const before = h.vault.state();
    for (const path of ["Sandbox/ex", "Sandbox/group", "Sandbox/gitproj"]) expect(code(await h.call("files.delete", { path })), path).toBe("DENIED");
    expect(code(await h.call("files.delete", { path: "Sandbox/big" }))).toBe("TOO_LARGE");
    expect(h.vault.state()).toEqual(before);
    expect(h.vault.trashed).toEqual([]);
    expect(h.services.confirmations).toEqual([]); // refused before asking
  });

  it("fails closed when the snapshot cannot be stored: nothing is deleted", async () => {
    const h = host();
    h.services.snapshotStore.put = async () => {
      throw new Error("disk full");
    };
    const quiet = console.error;
    console.error = () => {};
    expect(code(await h.call("files.delete", { path: "Sandbox/a.md" }))).toBe("INTERNAL");
    console.error = quiet;
    expect(h.vault.state()["Sandbox/a.md"]).toBe("a");
    expect(h.vault.trashed).toEqual([]);
  });

  it("is refused without the permission", async () => {
    const h = host({}, { permissions: ["files.read"] });
    expect(code(await h.call("files.delete", { path: "Sandbox/a.md" }))).toBe("DENIED");
    expect(code(await h.call("files.move", { from: "Sandbox/a.md", to: "Sandbox/b.md" }))).toBe("DENIED");
    expect(h.vault.state()["Sandbox/a.md"]).toBe("a");
  });
});

// ---- the attack matrix, for the destructive operations -----------------------------------------

describe("destructive attack matrix", () => {
  const attacks = [
    "../Welcome.md", "..\\Welcome.md", "%2e%2e/Welcome.md", "%252e%252e/Welcome.md", "/etc/passwd", "C:\\Windows\\x.md",
    "\\\\server\\share\\x.md", "http://example.com/x.md", "file:///etc/passwd", ".obsidian/app.json", "%2eobsidian/app.json",
    ".OBSIDIAN/app.json", "Private/Links.md", "PRIVATE/Links.md", "Sandbox/x.secret.md", "Sandbox/../Private/Links.md",
    "Sandbox%2f..%2fPrivate%2fLinks.md", "Private./Links.md", "Apps/T/manifest.json", "Apps/T/index.html", "Notes/outside.md",
    "Welcome.md", "Notes/Linker.md", "a\u0000b.md", "",
  ];
  it("no destructive operation reaches anything outside what it may change", async () => {
    const h = host();
    const before = h.vault.state();
    const foldersBefore = h.vault.folders();
    for (const bad of attacks) {
      for (const [op, args] of [
        ["files.delete", { path: bad }],
        ["files.move", { from: bad, to: "Sandbox/dest.md" }],
        ["files.move", { from: "Sandbox/a.md", to: bad }],
        ["files.rename", { from: bad, to: "Sandbox/dest.md" }],
        ["files.rename", { from: "Sandbox/a.md", to: bad }],
      ] as const) {
        const r = await h.call(op, args);
        expect(r.ok, `${op} ${JSON.stringify(args)}`).toBe(false);
        expect(r.error?.message).not.toMatch(/Rate limit/); // the guard answered, not the limiter
        expect(["NOT_FOUND", "INVALID", "DENIED"]).toContain(code(r));
        expect(JSON.stringify(r)).not.toContain("SECRET");
      }
    }
    expect(h.vault.state()).toEqual(before);
    expect(h.vault.folders()).toEqual(foldersBefore);
    expect(h.vault.trashed).toEqual([]);
    expect(h.services.confirmations).toEqual([]);
    expect(await h.services.snapshots.list()).toEqual([]);
  });
});

// ---- 2b hardening found while designing 2c -----------------------------------------------------

describe("create cannot overwrite through a different-case name", () => {
  it("refuses Sandbox/NOTE.md when Sandbox/note.md exists", async () => {
    const h = host({ "Sandbox/note.md": "original" });
    const r = await h.call("files.create", { path: "Sandbox/NOTE.md", content: "clobber" });
    expect(code(r)).toBe("INVALID");
    expect(h.vault.state()["Sandbox/note.md"]).toBe("original");
    expect(h.vault.state()["Sandbox/NOTE.md"]).toBeUndefined();
  });
});
