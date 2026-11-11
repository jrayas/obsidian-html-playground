import { describe, expect, it } from "vitest";
import type { AppManifest } from "../src/apps/manifest";
import { buildContext } from "../src/bridge/context";
import { BridgeHost, type Handler } from "../src/bridge/host";
import { KeyedMutex } from "../src/bridge/locks";
import { AuditLog, cleanLogText } from "../src/bridge/log";
import { filesReadOps } from "../src/bridge/ops/files";
import { miscReadOps } from "../src/bridge/ops/misc";
import { writeOps } from "../src/bridge/ops/writes";
import type { BridgeResponse } from "../src/bridge/protocol";
import { restoreSnapshot } from "../src/bridge/restore";
import { planPrune } from "../src/bridge/retention";
import { SnapshotService } from "../src/bridge/snapshots";
import { MemoryLogStore, MemorySnapshotStore, type SnapshotMeta } from "../src/bridge/store";
import { checkWritableType, checkWriteSize, extensionOf } from "../src/bridge/writeguard";
import { DEFAULT_POLICY, memoryServices, mutableApp } from "./support";

// ---- harness -----------------------------------------------------------------------------------

const manifest = (extra: Partial<AppManifest> = {}): AppManifest => ({
  name: "T", version: "1", description: "", entry: "index.html", permissions: [], trusted: false,
  aiGenerated: false, allowedDomains: [], ...extra,
});

const VAULT = {
  "Sandbox/note.md": "---\nformula: x\n---\n# Title\n\nBody line\n",
  "Notes/outside.md": "outside",
  "Private/Secret.md": "TOP SECRET",
  "Welcome.md": "hi",
  "Apps/T/index.html": "<html>",
  "Apps/T/manifest.json": "{}",
  "Apps/Other/manifest.json": "{}",
  "Apps/Other/index.html": "x",
  "Sandbox/proj/manifest.json": "{}",
  "Sandbox/proj/readme.md": "project",
};

const WRITE_PERMS = ["files.create", "files.edit", "files.createFolder", "frontmatter.update", "storage.write", "files.read", "files.exists", "storage.read"];

function writerHost(
  files: Record<string, string> = VAULT,
  extra: Partial<AppManifest> = { permissions: WRITE_PERMS, writeScopes: ["Sandbox"] },
  opts: { exclusions?: string[]; trusted?: boolean; now?: () => number; policy?: typeof DEFAULT_POLICY; appsFolder?: string } = {},
) {
  // An advancing clock: requests are never rate limited unless a test passes its own clock.
  let auto = 0;
  const now = opts.now ?? (() => (auto += 1000));
  const vault = mutableApp(files);
  const services = memoryServices(vault.gateway, { appsFolder: opts.appsFolder, policy: opts.policy, now });
  const built = buildContext({
    appRoot: "Apps/T", manifest: manifest(extra), strictPaths: false, exclusions: opts.exclusions ?? ["Private/", "*.secret.md"],
  });
  const ctx = opts.trusted ? { ...built.ctx, trusted: true } : built.ctx;
  const handlers = new Map<string, Handler>(
    Object.entries({ ...filesReadOps, ...miscReadOps(() => ({ mode: "light" as const, vars: {} })), ...writeOps() }),
  );
  const sent: BridgeResponse[] = [];
  const host = new BridgeHost(ctx, services, handlers, (m) => sent.push(m), now);
  let n = 0;
  const call = async (op: string, args: Record<string, unknown> = {}) => {
    const before = sent.length;
    await host.handle({ v: 1, id: `w${++n}`, type: "request", op, args });
    return sent[before];
  };
  const logs = async () => (await services.logStore.recent(100)).reverse();
  return { call, vault, services, logs, sent };
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const code = (r: BridgeResponse) => r.error?.code;

// ---- pure pieces -------------------------------------------------------------------------------

describe("write guards (pure)", () => {
  it("allows only text types", () => {
    for (const ok of ["a.md", "A.MD", "x/y.json", "a.yaml", "a.yml", "a.csv", "a.canvas", "a.svg", "a.txt"]) {
      expect(() => checkWritableType(ok), ok).not.toThrow();
    }
    for (const bad of ["a.js", "a.html", "a.css", "a", ".md", "a.md.exe", "a.png", "a.mjs", "a.htm", "a."]) {
      expect(() => checkWritableType(bad), bad).toThrow(expect.objectContaining({ code: "INVALID" }));
    }
    expect(extensionOf("dir.v2/file")).toBe("");
  });
  it("measures size in bytes, not characters", () => {
    expect(() => checkWriteSize("é".repeat(60), 100)).toThrow(expect.objectContaining({ code: "TOO_LARGE" }));
    expect(() => checkWriteSize("a".repeat(100), 100)).not.toThrow();
    expect(() => checkWriteSize("a".repeat(101), 100)).toThrow(expect.objectContaining({ code: "TOO_LARGE" }));
  });
});

describe("planPrune", () => {
  const meta = (id: string, path: string, time: number, size = 10): SnapshotMeta => ({ id, path, time, app: "a", op: "o", size });
  const policy = { perFile: 2, maxBytes: 1000, maxAgeMs: 1000 };
  it("drops snapshots older than the age limit", () => {
    expect(planPrune([meta("a", "x", 0), meta("b", "x", 900)], policy, 1500).sort()).toEqual(["a"]);
  });
  it("keeps the newest N per file, case-insensitively", () => {
    const ids = planPrune([meta("1", "X.md", 1), meta("2", "x.md", 2), meta("3", "X.md", 3)], policy, 4);
    expect(ids).toEqual(["1"]);
  });
  it("drops oldest first until under the size cap", () => {
    const ids = planPrune([meta("a", "p", 1, 600), meta("b", "q", 2, 600), meta("c", "r", 3, 600)], { ...policy, maxBytes: 1000 }, 4);
    expect(ids.sort()).toEqual(["a", "b"]);
  });
  it("deletes nothing when everything fits", () => {
    expect(planPrune([meta("a", "x", 1), meta("b", "y", 2)], policy, 3)).toEqual([]);
  });
});

describe("KeyedMutex", () => {
  it("runs work for one key in order and lets other keys run freely", async () => {
    const m = new KeyedMutex();
    const order: string[] = [];
    const slow = m.run("a", async () => { await new Promise((r) => setTimeout(r, 20)); order.push("a1"); });
    const next = m.run("a", async () => void order.push("a2"));
    const other = m.run("b", async () => void order.push("b"));
    await Promise.all([slow, next, other]);
    expect(order).toEqual(["b", "a1", "a2"]);
  });
  it("keeps going after a failure", async () => {
    const m = new KeyedMutex();
    await expect(m.run("a", async () => { throw new Error("x"); })).rejects.toThrow("x");
    expect(await m.run("a", async () => 5)).toBe(5);
  });
});

describe("AuditLog", () => {
  it("cleans app-supplied text and bounds it", () => {
    expect(cleanLogText("a\u0000b\nc")).toBe("a?b?c");
    expect(cleanLogText("x".repeat(500)).length).toBe(200);
  });
  it("begin then finish completes the entry; trims old entries", async () => {
    const store = new MemoryLogStore();
    const log = new AuditLog(store, () => 3);
    for (let i = 0; i < 60; i++) {
      const seq = await log.begin("app", "files.create");
      await log.finish(seq, { paths: [`p${i}`], ok: true });
    }
    expect((await store.count())).toBeLessThanOrEqual(60);
    await log.finish(await log.begin("app", "x"), { paths: [], ok: false, code: "DENIED" });
    for (let i = 0; i < 60; i++) await log.finish(await log.begin("app", "x"), { paths: [], ok: true });
    expect(await store.count()).toBeLessThanOrEqual(3 + 50);
  });
});

describe("SnapshotService", () => {
  it("keeps only the newest per file and applies the age and size limits", async () => {
    let t = 1000;
    const store = new MemorySnapshotStore();
    let n = 0;
    const svc = new SnapshotService(store, () => ({ perFile: 3, maxBytes: 1000, maxAgeMs: 10_000 }), () => ++t, () => `s${++n}`);
    for (let i = 0; i < 5; i++) await svc.take({ path: "a.md", content: `v${i}`, app: "x", op: "files.edit" });
    expect((await svc.list("a.md")).map((m) => m.size)).toHaveLength(3);
    expect(await svc.content((await svc.list("a.md"))[0].id)).toBe("v4");
    t += 20_000; // everything is now too old
    await svc.take({ path: "b.md", content: "new", app: "x", op: "o" });
    expect((await svc.list()).map((m) => m.path)).toEqual(["b.md"]);
  });
  it("reuses the newest snapshot when the content is identical", async () => {
    const svc = new SnapshotService(new MemorySnapshotStore(), () => DEFAULT_POLICY);
    const a = await svc.take({ path: "a.md", content: "same", app: "x", op: "o" });
    const b = await svc.take({ path: "a.md", content: "same", app: "x", op: "o" });
    expect(b).toBe(a);
    expect(await svc.list()).toHaveLength(1);
  });
  it("refuses content bigger than the whole cap, and fails closed when the store breaks", async () => {
    const svc = new SnapshotService(new MemorySnapshotStore(), () => ({ perFile: 3, maxBytes: 10, maxAgeMs: 1e9 }));
    await expect(svc.take({ path: "a", content: "x".repeat(11), app: "x", op: "o" })).rejects.toMatchObject({ code: "TOO_LARGE" });
    const broken = new MemorySnapshotStore();
    broken.put = async () => { throw new Error("disk full"); };
    const quiet = console.error; console.error = () => {};
    await expect(new SnapshotService(broken, () => DEFAULT_POLICY).take({ path: "a", content: "x", app: "x", op: "o" })).rejects.toMatchObject({ code: "INTERNAL" });
    console.error = quiet;
  });
});

// ---- the write pipeline ------------------------------------------------------------------------

describe("files.create", () => {
  it("creates a note inside the write scope and logs it without content", async () => {
    const h = writerHost();
    const r = await h.call("files.create", { path: "Sandbox/new.md", content: "SECRET-BODY-TEXT" });
    expect(r.ok).toBe(true);
    expect(h.vault.state()["Sandbox/new.md"]).toBe("SECRET-BODY-TEXT");
    const log = await h.logs();
    expect(log.at(-1)).toMatchObject({ app: "Apps/T", op: "files.create", ok: true, paths: ["Sandbox/new.md"] });
    expect(JSON.stringify(log)).not.toContain("SECRET-BODY-TEXT");
  });

  it("creates missing parent folders and logs them", async () => {
    const h = writerHost();
    expect((await h.call("files.create", { path: "Sandbox/deep/er/x.md", content: "x" })).ok).toBe(true);
    expect(h.vault.folders()).toEqual(expect.arrayContaining(["Sandbox/deep", "Sandbox/deep/er"]));
    expect((await h.logs()).at(-1)?.paths).toEqual(["Sandbox/deep/er/x.md", "Sandbox/deep", "Sandbox/deep/er"]);
  });

  it("never overwrites an existing file", async () => {
    const h = writerHost();
    const r = await h.call("files.create", { path: "Sandbox/note.md", content: "clobber" });
    expect(code(r)).toBe("INVALID");
    expect(h.vault.state()["Sandbox/note.md"]).toBe(VAULT["Sandbox/note.md"]);
  });

  it("refuses everything outside the declared write scope, and everything if none is declared", async () => {
    const h = writerHost();
    for (const p of ["Notes/new.md", "Welcome2.md", "Sandbox2/x.md", "Notes/Sandbox/x.md"]) {
      expect(code(await h.call("files.create", { path: p, content: "x" })), p).toBe("DENIED");
    }
    const none = writerHost(VAULT, { permissions: WRITE_PERMS });
    expect(code(await none.call("files.create", { path: "Sandbox/new.md", content: "x" }))).toBe("DENIED");
    expect(none.vault.state()).toEqual(VAULT);
  });

  it("treats excluded, hidden and unsafe paths as not found or invalid, never DENIED or OK", async () => {
    const h = writerHost(VAULT, { permissions: WRITE_PERMS, writeScopes: ["Sandbox", "Private", "Notes", ""] });
    for (const p of ["Private/x.md", "Sandbox/x.secret.md", "Sandbox/.hidden/x.md", ".obsidian/x.md", "PRIVATE/x.md"]) {
      expect(code(await h.call("files.create", { path: p, content: "x" })), p).toBe("NOT_FOUND");
    }
    for (const p of ["../x.md", "Sandbox/../../x.md", "/abs.md", "C:\\x.md", "http://a/b.md", "%2e%2e/x.md", "Sandbox./x.md", ""]) {
      expect(code(await h.call("files.create", { path: p, content: "x" })), p).toBe("INVALID");
    }
    expect(h.vault.state()).toEqual(VAULT);
  });

  it("allows only text file types", async () => {
    const h = writerHost();
    for (const p of ["Sandbox/x.js", "Sandbox/x.html", "Sandbox/x.css", "Sandbox/noext", "Sandbox/x.md.js"]) {
      expect(code(await h.call("files.create", { path: p, content: "x" })), p).toBe("INVALID");
    }
    expect(Object.keys(h.vault.state()).sort()).toEqual(Object.keys(VAULT).sort());
  });

  it("limits write size in bytes", async () => {
    const h = writerHost();
    expect(code(await h.call("files.create", { path: "Sandbox/big.md", content: "é".repeat(3_000_000) }))).toBe("TOO_LARGE");
    expect(code(await h.call("files.create", { path: "Sandbox/big.md", content: "x".repeat(6_000_000) }))).toBe("TOO_LARGE");
  });
});

describe("apps cannot rewrite apps (Q16)", () => {
  it("blocks the apps folder, the app's own folder, manifest.json anywhere, and folders that hold a manifest", async () => {
    const h = writerHost(VAULT, { permissions: WRITE_PERMS, writeScopes: ["Sandbox", "Apps", ""] });
    const targets = [
      "Apps/T/data.json", "Apps/T/x.md", "Apps/Other/x.md", "Apps/NewApp/x.md", "Apps/T/manifest.json",
      "Sandbox/manifest.json", "Sandbox/MANIFEST.JSON", "Sandbox/proj/x.md", "Sandbox/proj/readme.md", "Sandbox/proj/sub/x.md",
    ];
    for (const p of targets) {
      for (const op of ["files.create", "files.edit"]) {
        expect(code(await h.call(op, { path: p, content: "x" })), `${op} ${p}`).toBe("DENIED");
      }
    }
    expect(code(await h.call("files.createFolder", { path: "Apps/NewApp" }))).toBe("DENIED");
    expect(code(await h.call("files.createFolder", { path: "Apps" }))).toBe("DENIED");
    expect(code(await h.call("frontmatter.update", { path: "Sandbox/proj/readme.md", set: { a: 1 } }))).toBe("DENIED");
    expect(h.vault.state()).toEqual(VAULT);
  });

  it("respects a custom apps folder setting", async () => {
    const h = writerHost({ "Tools/A/index.html": "x", "Notes/a.md": "x" }, { permissions: WRITE_PERMS, writeScopes: ["Tools", "Notes"] }, { appsFolder: "Tools" });
    expect(code(await h.call("files.create", { path: "Tools/A/x.md", content: "x" }))).toBe("DENIED");
    expect(code(await h.call("files.create", { path: "Tools/new.md", content: "x" }))).toBe("DENIED");
    expect((await h.call("files.create", { path: "Notes/ok.md", content: "x" })).ok).toBe(true);
  });
});

describe("files.edit", () => {
  it("snapshots the original text before overwriting, and the log records it", async () => {
    const h = writerHost();
    const r = await h.call("files.edit", { path: "Sandbox/note.md", content: "replaced" });
    expect(r.ok).toBe(true);
    expect(h.vault.state()["Sandbox/note.md"]).toBe("replaced");
    const snaps = await h.services.snapshots.list("Sandbox/note.md");
    expect(snaps).toHaveLength(1);
    expect(await h.services.snapshots.content(snaps[0].id)).toBe(VAULT["Sandbox/note.md"]);
    expect(snaps[0]).toMatchObject({ app: "Apps/T", op: "files.edit" });
    expect((await h.logs()).at(-1)).toMatchObject({ op: "files.edit", ok: true });
  });

  it("appends", async () => {
    const h = writerHost();
    await h.call("files.edit", { path: "Sandbox/note.md", content: "\nmore", mode: "append" });
    expect(h.vault.state()["Sandbox/note.md"]).toBe(VAULT["Sandbox/note.md"] + "\nmore");
    expect(await h.services.snapshots.list("Sandbox/note.md")).toHaveLength(1);
  });

  it("applies several appends at once without losing any", async () => {
    const h = writerHost();
    await Promise.all(Array.from({ length: 10 }, (_, i) => h.call("files.edit", { path: "Sandbox/note.md", content: `|${i}`, mode: "append" })));
    const text = h.vault.state()["Sandbox/note.md"];
    for (let i = 0; i < 10; i++) expect(text).toContain(`|${i}`);
  });

  it("refuses a stale write when ifUnmodifiedSince is given", async () => {
    const h = writerHost();
    const read = await h.call("files.read", { path: "Sandbox/note.md" });
    const mtime = (read.result as { mtime: number }).mtime;
    await h.vault.app.vault.modify(h.vault.app.vault.getFileByPath("Sandbox/note.md") as never, "changed by the user");
    const r = await h.call("files.edit", { path: "Sandbox/note.md", content: "mine", ifUnmodifiedSince: mtime });
    expect(code(r)).toBe("INVALID");
    expect(h.vault.state()["Sandbox/note.md"]).toBe("changed by the user");
  });

  it("needs an existing file", async () => {
    const h = writerHost();
    expect(code(await h.call("files.edit", { path: "Sandbox/missing.md", content: "x" }))).toBe("NOT_FOUND");
    expect(code(await h.call("files.edit", { path: "Sandbox/proj2", content: "x" }))).toBe("INVALID"); // no text extension
  });

  it("rejects bad modes", async () => {
    const h = writerHost();
    expect(code(await h.call("files.edit", { path: "Sandbox/note.md", content: "x", mode: "truncate" }))).toBe("INVALID");
  });

  it("fails closed: no snapshot, no write", async () => {
    const h = writerHost();
    h.services.snapshotStore.put = async () => { throw new Error("disk full"); };
    const quiet = console.error; console.error = () => {};
    const r = await h.call("files.edit", { path: "Sandbox/note.md", content: "lost?" });
    console.error = quiet;
    expect(code(r)).toBe("INTERNAL");
    expect(h.vault.state()["Sandbox/note.md"]).toBe(VAULT["Sandbox/note.md"]);
    expect((await h.logs()).at(-1)).toMatchObject({ ok: false, code: "INTERNAL" });
  });

  it("refuses to edit a file too large to snapshot", async () => {
    const big = writerHost(VAULT, { permissions: WRITE_PERMS, writeScopes: ["Sandbox"] }, { policy: { perFile: 5, maxBytes: 10, maxAgeMs: 1e9 } });
    expect(code(await big.call("files.edit", { path: "Sandbox/note.md", content: "x" }))).toBe("TOO_LARGE");
    expect(big.vault.state()["Sandbox/note.md"]).toBe(VAULT["Sandbox/note.md"]);
  });
});

describe("audit log is required for writes", () => {
  it("refuses the write when the log cannot be written", async () => {
    const h = writerHost();
    h.services.logStore.add = async () => { throw new Error("db closed"); };
    const quiet = console.error; console.error = () => {};
    const r = await h.call("files.create", { path: "Sandbox/new.md", content: "x" });
    console.error = quiet;
    expect(code(r)).toBe("INTERNAL");
    expect(h.vault.state()).toEqual(VAULT);
    expect((await h.call("files.read", { path: "Sandbox/note.md" })).ok).toBe(true); // reads unaffected
  });

  it("logs denied write attempts, including the raw path the app asked for", async () => {
    const h = writerHost();
    await h.call("files.create", { path: "Private/Secret.md", content: "x" });
    await h.call("files.create", { path: "../escape.md", content: "x" });
    const undeclared = writerHost(VAULT, { permissions: [] });
    await undeclared.call("files.create", { path: "Sandbox/a.md", content: "x" });
    await flush();
    const mine = await h.logs();
    expect(mine.map((e) => [e.ok, e.code, e.paths[0]])).toEqual([[false, "NOT_FOUND", "Private/Secret.md"], [false, "INVALID", "../escape.md"]]);
    expect((await undeclared.logs())[0]).toMatchObject({ ok: false, code: "DENIED", paths: ["Sandbox/a.md"] });
  });

  it("does not log reads", async () => {
    const h = writerHost();
    await h.call("files.read", { path: "Sandbox/note.md" });
    await h.call("files.exists", { path: "Welcome.md" });
    expect(await h.logs()).toEqual([]);
  });
});

describe("files.createFolder", () => {
  it("creates folders and parents, is idempotent, and refuses a file in the way", async () => {
    const h = writerHost();
    expect((await h.call("files.createFolder", { path: "Sandbox/a/b" })).result).toEqual({ path: "Sandbox/a/b", created: true });
    expect(h.vault.folders()).toEqual(expect.arrayContaining(["Sandbox/a", "Sandbox/a/b"]));
    expect((await h.call("files.createFolder", { path: "Sandbox/a/b" })).result).toEqual({ path: "Sandbox/a/b", created: false });
    expect(code(await h.call("files.createFolder", { path: "Sandbox/note.md" }))).toBe("INVALID");
    expect(code(await h.call("files.createFolder", { path: "Notes/new" }))).toBe("DENIED");
    expect(code(await h.call("files.createFolder", { path: "Private/new" }))).toBe("NOT_FOUND");
  });
});

describe("frontmatter.update", () => {
  it("sets and removes keys after snapshotting the whole note, leaving the body alone", async () => {
    const h = writerHost();
    const r = await h.call("frontmatter.update", { path: "Sandbox/note.md", set: { formula: "y", unit: "W", nested: { a: [1, 2] } }, remove: ["old"] });
    expect(r.result).toEqual({ updated: ["formula", "unit", "nested"], removed: ["old"] });
    const text = h.vault.state()["Sandbox/note.md"];
    expect(text.endsWith("---\n# Title\n\nBody line\n")).toBe(true);
    expect(text).toContain('"unit":"W"');
    const snaps = await h.services.snapshots.list("Sandbox/note.md");
    expect(await h.services.snapshots.content(snaps[0].id)).toBe(VAULT["Sandbox/note.md"]);
    expect((await h.logs()).at(-1)).toMatchObject({ op: "frontmatter.update", ok: true });
  });

  it("rejects prototype-pollution keys at any depth, bad shapes, and non-Markdown files", async () => {
    const h = writerHost();
    const evil = [JSON.parse('{"__proto__":{"x":1}}'), { constructor: 1 }, { prototype: 1 }, { a: JSON.parse('{"__proto__":1}') }, { a: [JSON.parse('{"constructor":1}')] }, { "": 1 }, { ["x".repeat(101)]: 1 }];
    for (const set of evil) expect(code(await h.call("frontmatter.update", { path: "Sandbox/note.md", set })), JSON.stringify(set)).toBe("INVALID");
    for (const args of [{ set: "x" }, { set: [1] }, { remove: "x" }, { remove: [1] }, {}, { set: {}, remove: [] }, { remove: ["__proto__"] }]) {
      expect(code(await h.call("frontmatter.update", { path: "Sandbox/note.md", ...args })), JSON.stringify(args)).toBe("INVALID");
    }
    expect(code(await h.call("frontmatter.update", { path: "Sandbox/x.json", set: { a: 1 } }))).toBe("INVALID");
    expect(code(await h.call("frontmatter.update", { path: "Sandbox/note.md", set: { k: "x".repeat(70_000) } }))).toBe("TOO_LARGE");
    expect(h.vault.state()).toEqual(VAULT);
  });

  it("fails closed when the snapshot cannot be stored", async () => {
    const h = writerHost();
    h.services.snapshotStore.put = async () => { throw new Error("x"); };
    const quiet = console.error; console.error = () => {};
    expect(code(await h.call("frontmatter.update", { path: "Sandbox/note.md", set: { a: 1 } }))).toBe("INTERNAL");
    console.error = quiet;
    expect(h.vault.state()).toEqual(VAULT);
  });
});

describe("storage.write", () => {
  it("round-trips the app's own data.json", async () => {
    const h = writerHost();
    expect((await h.call("storage.write", { value: { a: 1, list: [1, 2] } })).ok).toBe(true);
    expect(h.vault.state()["Apps/T/data.json"]).toBe('{"a":1,"list":[1,2]}');
    expect((await h.call("storage.read")).result).toEqual({ value: { a: 1, list: [1, 2] } });
    await h.call("storage.write", { value: "second" });
    expect((await h.call("storage.read")).result).toEqual({ value: "second" });
    expect((await h.logs()).map((e) => e.op)).toEqual(["storage.write", "storage.write"]);
  });
  it("rejects unsafe, huge and unserialisable values", async () => {
    const h = writerHost();
    expect(code(await h.call("storage.write", { value: JSON.parse('{"__proto__":1}') }))).toBe("INVALID");
    expect(code(await h.call("storage.write", { value: "x".repeat(2_000_000) }))).toBe("TOO_LARGE");
    const cyclic: Record<string, unknown> = {};
    cyclic.me = cyclic;
    expect(code(await h.call("storage.write", { value: cyclic }))).toBe("INVALID");
    expect(code(await h.call("storage.write", { value: undefined }))).toBe("INVALID");
    expect(code(await h.call("storage.write", {}))).toBe("INVALID");
  });
  it("cannot be used to write anywhere but the app's own data.json", async () => {
    const h = writerHost();
    await h.call("storage.write", { value: 1, path: "Welcome.md" });
    expect(h.vault.state()["Welcome.md"]).toBe("hi");
  });
});

describe("rate limiting of writes", () => {
  it("throttles bursts and recovers", async () => {
    let t = 0;
    const h = writerHost(VAULT, { permissions: WRITE_PERMS, writeScopes: ["Sandbox"] }, { now: () => t });
    const codes: (string | undefined)[] = [];
    for (let i = 0; i < 30; i++) codes.push(code(await h.call("files.create", { path: `Sandbox/n${i}.md`, content: "x" })));
    expect(codes.filter((c) => c === "DENIED").length).toBeGreaterThan(0);
    t = 5000;
    expect((await h.call("files.create", { path: "Sandbox/after.md", content: "x" })).ok).toBe(true);
  });
});

describe("trusted apps", () => {
  it("may write vault-wide, but never bypass exclusions, apps or manifests", async () => {
    const h = writerHost(VAULT, { permissions: WRITE_PERMS }, { trusted: true });
    expect((await h.call("files.create", { path: "Notes/trusted.md", content: "x" })).ok).toBe(true);
    for (const p of ["Apps/x.md", "Apps/T/x.md", "Sandbox/manifest.json", "Sandbox/proj/x.md"]) {
      expect(code(await h.call("files.create", { path: p, content: "x" })), p).toBe("DENIED");
    }
    for (const p of ["Private/x.md", ".obsidian/x.md", "Notes/x.secret.md"]) {
      expect(code(await h.call("files.create", { path: p, content: "x" })), p).toBe("NOT_FOUND");
    }
  });
});

describe("write attack matrix", () => {
  const attacks = [
    "../Welcome.md", "..\\Welcome.md", "%2e%2e/Welcome.md", "%252e%252e/Welcome.md", "/etc/passwd", "C:\\Windows\\x.md",
    "\\\\server\\share\\x.md", "http://example.com/x.md", "file:///etc/passwd", "javascript:alert(1).md", ".obsidian/app.json",
    ".obsidian/plugins/html-playground/data.json", "%2eobsidian/app.json", ".OBSIDIAN/app.json", "Private/Secret.md", "PRIVATE/Secret.md",
    "Sandbox/x.secret.md", "Sandbox/../Private/Secret.md", "Sandbox%2f..%2fPrivate%2fSecret.md", "Private./Secret.md", "Private /Secret.md",
    "Apps/T/manifest.json", "Apps/Other/manifest.json", "Apps/T/data.json", "Sandbox/proj/readme.md", "Notes/outside.md", "Welcome.md", "a\u0000b.md",
  ];
  it("no write operation ever changes the vault through any of them", async () => {
    const h = writerHost(VAULT, { permissions: WRITE_PERMS, writeScopes: ["Sandbox"] });
    const before = h.vault.state();
    const foldersBefore = h.vault.folders();
    for (const bad of attacks) {
      for (const [op, args] of [
        ["files.create", { path: bad, content: "pwned" }],
        ["files.edit", { path: bad, content: "pwned" }],
        ["files.edit", { path: bad, content: "pwned", mode: "append" }],
        ["files.createFolder", { path: bad }],
        ["frontmatter.update", { path: bad, set: { pwned: true } }],
      ] as const) {
        const r = await h.call(op, args);
        expect(r.ok, `${op} ${JSON.stringify(bad)}`).toBe(false);
        expect(r.error?.message).not.toMatch(/Rate limit/); // the guard answered, not the limiter
        expect(["NOT_FOUND", "INVALID", "DENIED"]).toContain(code(r));
        expect(JSON.stringify(r)).not.toContain("SECRET");
      }
    }
    expect(h.vault.state()).toEqual(before);
    expect(h.vault.folders()).toEqual(foldersBefore);
    expect(await h.services.snapshots.list()).toEqual([]); // refused writes take no snapshots
  });
});

describe("restoreSnapshot (a user action)", () => {
  const deps = (h: ReturnType<typeof writerHost>, exclusions: string[] = ["Private/"]) => ({
    gateway: h.vault.gateway, snapshots: h.services.snapshots, audit: h.services.audit, exclusions, maxReadBytes: 5_000_000,
  });

  it("puts the old text back and snapshots the current text first, so the restore can be undone", async () => {
    const h = writerHost();
    await h.call("files.edit", { path: "Sandbox/note.md", content: "edited" });
    const original = (await h.services.snapshots.list("Sandbox/note.md"))[0];
    const r = await restoreSnapshot(original.id, deps(h));
    expect(r).toEqual({ path: "Sandbox/note.md", recreated: false });
    expect(h.vault.state()["Sandbox/note.md"]).toBe(VAULT["Sandbox/note.md"]);
    const all = await h.services.snapshots.list("Sandbox/note.md");
    expect(all.map((s) => s.op)).toContain("snapshot.restore");
    const undo = all.find((s) => s.op === "snapshot.restore")!;
    expect(await h.services.snapshots.content(undo.id)).toBe("edited");
    expect((await h.logs()).at(-1)).toMatchObject({ app: "user", op: "snapshot.restore", ok: true });
  });

  it("recreates a deleted file", async () => {
    const h = writerHost();
    await h.call("files.edit", { path: "Sandbox/note.md", content: "edited" });
    h.vault.remove("Sandbox/note.md");
    const id = (await h.services.snapshots.list("Sandbox/note.md"))[0].id;
    expect(await restoreSnapshot(id, deps(h))).toEqual({ path: "Sandbox/note.md", recreated: true });
    expect(h.vault.state()["Sandbox/note.md"]).toBe(VAULT["Sandbox/note.md"]);
  });

  it("refuses unknown ids and paths that are excluded now", async () => {
    const h = writerHost();
    await expect(restoreSnapshot("nope", deps(h))).rejects.toMatchObject({ code: "NOT_FOUND" });
    await h.call("files.edit", { path: "Sandbox/note.md", content: "edited" });
    const id = (await h.services.snapshots.list("Sandbox/note.md"))[0].id;
    await expect(restoreSnapshot(id, deps(h, ["Sandbox/"]))).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(h.vault.state()["Sandbox/note.md"]).toBe("edited");
  });
});
