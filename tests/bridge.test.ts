import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { parseManifest, type AppManifest } from "../src/apps/manifest";
import { buildBootstrap } from "../src/bootstrap/script";
import { buildContext, canRead } from "../src/bridge/context";
import { BridgeError } from "../src/bridge/errors";
import { VaultGateway } from "../src/bridge/gateway";
import { BridgeHost, type Handler } from "../src/bridge/host";
import { limitsFor, TokenBucket } from "../src/bridge/limits";
import { joinMarkdown, splitMarkdown } from "../src/bridge/markdown";
import { requireString, optionalInt } from "../src/bridge/ops/args";
import { formatsOps } from "../src/bridge/ops/formats";
import { filesReadOps } from "../src/bridge/ops/files";
import { miscReadOps } from "../src/bridge/ops/misc";
import { OPS, isAllowed } from "../src/bridge/permissions";
import { resolveArg } from "../src/bridge/paths";
import { parseRequest, type BridgeResponse } from "../src/bridge/protocol";
import { inScope, resolveScopes, underAny } from "../src/bridge/scopes";
import { memoryServices } from "./support";

// ---- helpers ---------------------------------------------------------------------------------

const manifest = (extra: Partial<AppManifest> = {}): AppManifest => ({
  name: "T",
  version: "1",
  description: "",
  entry: "index.html",
  permissions: [],
  trusted: false,
  aiGenerated: false,
  allowedDomains: [],
  ...extra,
});

const ctxFor = (extra: Partial<AppManifest> = {}, exclusions: string[] = ["Private/", "*.secret.md"]) =>
  buildContext({ appRoot: "Apps/T", manifest: manifest(extra), strictPaths: false, exclusions }).ctx;

/** A tiny in-memory vault behind the real VaultGateway. */
function fakeApp(files: Record<string, string>) {
  const entries = Object.entries(files).map(([p, content]) => ({
    path: p,
    extension: p.split(".").pop() ?? "",
    stat: { size: content.length, mtime: 1 },
    content,
  }));
  const folder = (p: string) => {
    const prefix = p === "" ? "" : p + "/";
    const names = new Map<string, unknown>();
    for (const e of entries) {
      if (!e.path.startsWith(prefix)) continue;
      const rest = e.path.slice(prefix.length);
      const first = rest.split("/")[0];
      if (rest.includes("/")) names.set(prefix + first, { path: prefix + first, children: [] });
      else names.set(e.path, e);
    }
    return { path: p, children: [...names.values()] };
  };
  const hasFolder = (p: string) => p === "" || entries.some((e) => e.path.startsWith(p + "/"));
  return {
    vault: {
      getFileByPath: (p: string) => entries.find((e) => e.path === p) ?? null,
      getFolderByPath: (p: string) => (hasFolder(p) ? folder(p) : null),
      getRoot: () => folder(""),
      getFiles: () => entries,
      read: async (f: { content: string }) => f.content,
      cachedRead: async (f: { content: string }) => f.content,
      readBinary: async (f: { content: string }) => new TextEncoder().encode(f.content).buffer,
    },
    metadataCache: { getFileCache: () => ({ frontmatter: { a: 1, position: {} } }) },
  };
}

function hostFor(
  files: Record<string, string>,
  extra: Partial<AppManifest> = {},
  opts: { now?: () => number; exclusions?: string[] } = {},
) {
  // An advancing clock: requests are never rate limited unless a test passes its own clock.
  let auto = 0;
  const now = opts.now ?? (() => (auto += 1000));
  const ctx = ctxFor(extra, opts.exclusions);
  const gateway = new VaultGateway(fakeApp(files) as never);
  const jsonYaml = { parseYaml: (t: string) => JSON.parse(t) as unknown, stringifyYaml: (v: unknown) => JSON.stringify(v) };
  const handlers = new Map<string, Handler>(
    Object.entries({
      ...filesReadOps,
      ...formatsOps(jsonYaml),
      ...miscReadOps(() => ({ mode: "light" as const, vars: {} })),
    }),
  );
  const sent: BridgeResponse[] = [];
  const host = new BridgeHost(ctx, memoryServices(gateway), handlers, (m) => sent.push(m), now);
  let n = 0;
  const call = async (op: string, args: Record<string, unknown> = {}) => {
    const before = sent.length;
    await host.handle({ v: 1, id: `r${++n}`, type: "request", op, args });
    return sent[before];
  };
  return { call, sent, host };
}

const VAULT = {
  "Welcome.md": "hello world",
  "Notes/Pump sizing.md": "pump text",
  "Data/pumps.json": '{"a":1}',
  "Private/Secret.md": "TOP SECRET",
  "Notes/plan.secret.md": "TOP SECRET plan",
  "Apps/T/index.html": "<html>",
  "Apps/T/data.json": '{"saved":true}',
};
const READ = ["files.read", "files.readBinary", "files.exists", "files.list", "files.search", "storage.read", "frontmatter.read"];

// ---- protocol, permissions, limits ------------------------------------------------------------

describe("parseRequest", () => {
  it("accepts a well-formed request and defaults args", () => {
    expect(parseRequest({ v: 1, id: "a", type: "request", op: "files.read" })).toEqual({
      v: 1, id: "a", type: "request", op: "files.read", args: {},
    });
  });
  it("rejects anything malformed", () => {
    for (const bad of [null, 5, "x", [], {}, { v: 2, id: "a", type: "request", op: "x" },
      { v: 1, id: "", type: "request", op: "x" }, { v: 1, id: "a".repeat(65), type: "request", op: "x" },
      { v: 1, id: "a", type: "response", op: "x" }, { v: 1, id: "a", type: "request", op: "x".repeat(65) },
      { v: 1, id: "a", type: "request", op: "x", args: [] }, { v: 1, id: "a", type: "request", op: "x", args: null },
      { v: 1, id: 7, type: "request", op: "x" }]) {
      expect(parseRequest(bad)).toBeNull();
    }
  });
});

describe("permissions table", () => {
  it("every operation name is an accepted manifest permission", () => {
    const names = [...OPS.keys()];
    const r = parseManifest(JSON.stringify({ name: "x", permissions: names }));
    expect(r.ok && r.manifest.permissions.length).toBe(names.length);
    expect(r.ok && r.warnings).toEqual([]);
  });
  it("requires exact declaration, except theme.get", () => {
    expect(isAllowed("files.read", new Set())).toBe(false);
    expect(isAllowed("files.read", new Set(["files.*"]))).toBe(false);
    expect(isAllowed("files.read", new Set(["files.read"]))).toBe(true);
    expect(isAllowed("theme.get", new Set())).toBe(true);
  });
});

describe("TokenBucket", () => {
  it("empties, then refills over time", () => {
    let t = 0;
    const b = new TokenBucket(3, 1, () => t);
    expect([b.take(), b.take(), b.take(), b.take()]).toEqual([true, true, true, false]);
    t = 1000;
    expect(b.take()).toBe(true);
    expect(b.take()).toBe(false);
  });
  it("trusted apps get higher rates only", () => {
    expect(limitsFor(true).readRate.perSec).toBeGreaterThan(limitsFor(false).readRate.perSec);
    expect(limitsFor(true).readTextBytes).toBe(limitsFor(false).readTextBytes);
  });
});

describe("argument helpers", () => {
  it("validate type and bounds without echoing input", () => {
    expect(() => requireString({ p: 5 }, "p")).toThrow(/Bad argument: p/);
    expect(() => requireString({ p: "x".repeat(10) }, "p", 5)).toThrow(BridgeError);
    expect(() => optionalInt({ n: 1.5 }, "n", 0, 9, 0)).toThrow(BridgeError);
    expect(optionalInt({}, "n", 0, 9, 4)).toBe(4);
  });
});

// ---- paths, scopes, context --------------------------------------------------------------------

describe("VaultPath brand", () => {
  const pc = { appRoot: "Apps/T", strictPaths: false, exclusions: ["Private/"] };
  it("throws NOT_FOUND for excluded and INVALID for unsafe input", () => {
    expect(() => resolveArg("Private/x.md", pc)).toThrow(expect.objectContaining({ code: "NOT_FOUND" }));
    expect(() => resolveArg("../x", pc)).toThrow(expect.objectContaining({ code: "INVALID" }));
    expect(resolveArg("./data.json", pc)).toBe("Apps/T/data.json");
  });
  it("no source file except paths.ts casts to VaultPath", () => {
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((n) => {
        const p = path.join(dir, n);
        return statSync(p).isDirectory() ? walk(p) : [p];
      });
    const offenders = walk(path.resolve(import.meta.dirname, "../src"))
      .filter((f) => f.endsWith(".ts") && !f.endsWith(path.join("bridge", "paths.ts")))
      .filter((f) => /as\s+VaultPath/.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });
});

describe("scopes", () => {
  it("matches the folder and below, case-insensitively, but not siblings with a shared prefix", () => {
    expect(underAny("Notes/a.md", ["Notes"])).toBe(true);
    expect(underAny("NOTES/a.md", ["notes"])).toBe(true);
    expect(underAny("Notes", ["Notes"])).toBe(true);
    expect(underAny("Notes2/a.md", ["Notes"])).toBe(false);
    expect(underAny("Anything/a.md", [""])).toBe(true);
  });
  it("undefined scopes mean the whole vault; the app folder is always allowed", () => {
    expect(inScope("X/y.md", undefined, ["Apps/T"])).toBe(true);
    expect(inScope("X/y.md", ["Data"], ["Apps/T"])).toBe(false);
    expect(inScope("Apps/T/a.css", ["Data"], ["Apps/T"])).toBe(true);
  });
  it("drops invalid or excluded scope entries with a warning", () => {
    const r = resolveScopes(["Data", "../x", "Private/"], "readScopes", { appRoot: "Apps/T", strictPaths: false, exclusions: ["Private/"] });
    expect(r.scopes).toEqual(["Data"]);
    expect(r.warnings.length).toBe(2);
  });
  it("a malformed manifest scope list becomes empty, never unrestricted", () => {
    const r = parseManifest('{"name":"x","readScopes":"Notes"}');
    expect(r.ok && r.manifest.readScopes).toEqual([]);
  });
});

describe("context", () => {
  it("ignores unknown permissions with a warning", () => {
    const { ctx, warnings } = buildContext({ appRoot: "Apps/T", manifest: manifest({ permissions: ["files.read", "files.hack"] }), strictPaths: false, exclusions: [] });
    expect([...ctx.permissions]).toEqual(["files.read"]);
    expect(warnings.join()).toContain("files.hack");
    expect(ctx.trusted).toBe(false);
  });
  it("canRead combines exclusions and scopes", () => {
    const ctx = ctxFor({ readScopes: ["Notes"] });
    expect(canRead(ctx, "Notes/a.md")).toBe(true);
    expect(canRead(ctx, "Data/a.json")).toBe(false);
    expect(canRead(ctx, "Notes/x.secret.md")).toBe(false);
    expect(canRead(ctx, "Notes/.hidden/a.md")).toBe(false);
    expect(canRead(ctx, "Apps/T/index.html")).toBe(true);
  });
});

describe("markdown", () => {
  it("splits and rejoins front matter", () => {
    const s = splitMarkdown("---\na: 1\n---\n# Body\n");
    expect(s).toEqual({ hasFrontmatter: true, frontmatterText: "a: 1", body: "# Body\n" });
    expect(joinMarkdown("a: 1\n", "# Body\n")).toBe("---\na: 1\n---\n# Body\n");
  });
  it("treats a note without a leading fence as body only", () => {
    expect(splitMarkdown("text\n---\na: 1\n---\n").hasFrontmatter).toBe(false);
    expect(splitMarkdown("---\nunclosed").hasFrontmatter).toBe(false);
    expect(joinMarkdown("", "x")).toBe("x");
  });
  it("handles CRLF", () => {
    expect(splitMarkdown("---\r\na: 1\r\n---\r\nbody").body).toBe("body");
  });
});

// ---- the host pipeline -------------------------------------------------------------------------

describe("BridgeHost pipeline", () => {
  it("ignores malformed messages (no reply)", async () => {
    const { host, sent } = hostFor(VAULT);
    await host.handle({ nope: true });
    await host.handle(null);
    expect(sent).toEqual([]);
  });

  it("undeclared operations are DENIED, whatever the arguments", async () => {
    const { call } = hostFor(VAULT, { permissions: [] });
    for (const op of READ) {
      const r = await call(op, { path: "Welcome.md", query: "x" });
      expect(r.error?.code, op).toBe("DENIED");
    }
  });

  it("unknown operations are UNSUPPORTED; known but unbuilt operations are DENIED or UNSUPPORTED in order", async () => {
    const { call } = hostFor(VAULT, { permissions: ["files.delete"] });
    expect((await call("files.nuke")).error?.code).toBe("UNSUPPORTED");
    expect((await call("__proto__")).error?.code).toBe("UNSUPPORTED");
    expect((await call("files.create", { path: "a.md", content: "x" })).error?.code).toBe("DENIED");
    expect((await call("files.delete", { path: "a.md" })).error?.code).toBe("UNSUPPORTED");
  });

  it("theme.get needs no permission", async () => {
    const { call } = hostFor(VAULT);
    expect((await call("theme.get")).ok).toBe(true);
  });

  it("reads allowed files and returns generic errors for missing and excluded ones", async () => {
    const { call } = hostFor(VAULT, { permissions: ["files.read"] });
    const ok = await call("files.read", { path: "Welcome.md" });
    expect(ok.ok && (ok.result as { content: string }).content).toBe("hello world");

    const missing = await call("files.read", { path: "Nope.md" });
    const excluded = await call("files.read", { path: "Private/Secret.md" });
    const globbed = await call("files.read", { path: "Notes/plan.secret.md" });
    expect(missing.error).toEqual(excluded.error);
    expect(missing.error).toEqual(globbed.error);
    expect(excluded.error?.code).toBe("NOT_FOUND");
    expect(JSON.stringify(excluded)).not.toContain("SECRET");
  });

  it("rejects every traversal and URL trick on every read operation", async () => {
    const attacks = ["../Welcome.md", "..\\Welcome.md", "%2e%2e/Welcome.md", "%252e%252e/Welcome.md", "/etc/passwd",
      "C:\\Windows\\win.ini", "http://example.com", "file:///etc/passwd", ".obsidian/app.json", "%2eobsidian/app.json",
      ".OBSIDIAN/app.json", "Private/Secret.md", "PRIVATE/secret.md", "Notes/plan.secret.md", "Notes/../Private/Secret.md",
      "Notes%2f..%2fPrivate%2fSecret.md", "Apps/T/../../Private/Secret.md", "Private./Secret.md", "a\u0000b"];
    const { call } = hostFor(VAULT, { permissions: READ });
    for (const op of ["files.read", "files.readBinary", "files.list", "frontmatter.read"]) {
      for (const bad of attacks) {
        const r = await call(op, { path: bad });
        expect(r.ok, `${op} ${JSON.stringify(bad)}`).toBe(false);
        expect(r.error?.message).not.toMatch(/Rate limit/); // the guard answered, not the limiter
        expect(["NOT_FOUND", "INVALID"]).toContain(r.error?.code);
        expect(JSON.stringify(r)).not.toContain("SECRET");
      }
    }
    for (const bad of attacks.filter((a) => !a.startsWith("Private") && !a.startsWith("PRIVATE") && !a.includes("secret") && !a.includes("obsidian") && !a.includes("OBSIDIAN"))) {
      const r = await call("files.exists", { path: bad });
      expect(r.ok && (r.result as { exists: boolean }).exists, `exists ${JSON.stringify(bad)}`).not.toBe(true);
    }
  });

  it("files.exists answers false for excluded and missing alike", async () => {
    const { call } = hostFor(VAULT, { permissions: ["files.exists"] });
    expect((await call("files.exists", { path: "Private/Secret.md" })).result).toEqual({ exists: false });
    expect((await call("files.exists", { path: "Nope.md" })).result).toEqual({ exists: false });
    expect((await call("files.exists", { path: "Welcome.md" })).result).toEqual({ exists: true, type: "file" });
  });

  it("list and search silently omit excluded paths", async () => {
    const { call } = hostFor(VAULT, { permissions: ["files.list", "files.search"] });
    const root = await call("files.list", { path: "", recursive: true });
    const paths = (root.result as { entries: { path: string }[] }).entries.map((e) => e.path);
    expect(paths).toContain("Welcome.md");
    expect(paths.some((p) => p.includes("Private") || p.includes("secret"))).toBe(false);

    const hits = await call("files.search", { query: "SECRET" });
    expect((hits.result as { hits: unknown[] }).hits).toEqual([]);
    const name = await call("files.search", { query: "pump" });
    const named = (name.result as { hits: { path: string }[] }).hits.map((h) => h.path).sort();
    expect(named).toEqual(["Data/pumps.json", "Notes/Pump sizing.md"]);
  });

  it("read scopes hide everything else, but the app's own folder stays readable", async () => {
    const { call } = hostFor(VAULT, { permissions: ["files.read", "files.list", "files.exists", "files.search", "storage.read"], readScopes: ["Data"] });
    expect((await call("files.read", { path: "Data/pumps.json" })).ok).toBe(true);
    expect((await call("files.read", { path: "Welcome.md" })).error?.code).toBe("NOT_FOUND");
    expect((await call("files.read", { path: "./index.html" })).ok).toBe(true);
    expect((await call("files.list", { path: "" })).error?.code).toBe("NOT_FOUND");
    expect((await call("files.exists", { path: "Welcome.md" })).result).toEqual({ exists: false });
    const search = await call("files.search", { query: "hello" });
    expect((search.result as { hits: unknown[] }).hits).toEqual([]);
    expect((await call("storage.read")).ok).toBe(true);
  });

  it("storage.read returns the app's own data, or null when missing", async () => {
    const { call } = hostFor(VAULT, { permissions: ["storage.read"] });
    expect((await call("storage.read")).result).toEqual({ value: { saved: true } });
    const empty = hostFor({ "Welcome.md": "x" }, { permissions: ["storage.read"] });
    expect((await empty.call("storage.read")).result).toEqual({ value: null });
  });

  it("frontmatter.read strips the position and needs a file", async () => {
    const { call } = hostFor(VAULT, { permissions: ["frontmatter.read"] });
    expect((await call("frontmatter.read", { path: "Welcome.md" })).result).toEqual({ frontmatter: { a: 1 } });
    expect((await call("frontmatter.read", { path: "Nope.md" })).error?.code).toBe("NOT_FOUND");
  });

  it("enforces the read size limit", async () => {
    const big = { "Big.md": "x".repeat(6 * 1024 * 1024) };
    const { call } = hostFor(big, { permissions: ["files.read"] });
    expect((await call("files.read", { path: "Big.md" })).error?.code).toBe("TOO_LARGE");
  });

  it("rate limits with DENIED and recovers", async () => {
    let t = 0;
    const { call } = hostFor(VAULT, {}, { now: () => t });
    const codes: (string | undefined)[] = [];
    for (let i = 0; i < 150; i++) codes.push((await call("theme.get")).error?.code);
    expect(codes.filter((c) => c === "DENIED").length).toBeGreaterThan(0);
    t = 5000;
    expect((await call("theme.get")).ok).toBe(true);
  });

  it("caps requests in flight", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const ctx = ctxFor({ permissions: ["files.read"] });
    const sent: BridgeResponse[] = [];
    const slow: Handler = async () => {
      await gate;
      return { result: {} };
    };
    const host = new BridgeHost(ctx, memoryServices(new VaultGateway(fakeApp({}) as never)), new Map([["files.read", slow]]), (m) => sent.push(m), () => 0);
    const pending = Array.from({ length: 20 }, (_, i) => host.handle({ v: 1, id: `p${i}`, type: "request", op: "files.read", args: {} }));
    await host.handle({ v: 1, id: "extra", type: "request", op: "files.read", args: {} });
    expect(sent.find((m) => m.id === "extra")?.error?.code).toBe("DENIED");
    release();
    await Promise.all(pending);
    expect(sent.filter((m) => m.ok).length).toBe(20);
  });

  it("turns unexpected handler errors into a generic INTERNAL", async () => {
    const ctx = ctxFor({ permissions: ["files.read"] });
    const sent: BridgeResponse[] = [];
    const boom: Handler = async () => {
      throw new Error("secret path /Users/me/x");
    };
    const quiet = console.error;
    console.error = () => {};
    const host = new BridgeHost(ctx, memoryServices(new VaultGateway(fakeApp({}) as never)), new Map([["files.read", boom]]), (m) => sent.push(m));
    await host.handle({ v: 1, id: "a", type: "request", op: "files.read", args: {} });
    console.error = quiet;
    expect(sent[0]?.error).toEqual({ code: "INTERNAL", message: "Internal error." });
  });
});

describe("formats operations", () => {
  const perms = ["formats.parseYaml", "formats.stringifyYaml", "formats.parseJson", "formats.stringifyJson", "formats.parseMarkdown", "formats.writeMarkdown"];
  it("parse and write JSON and Markdown", async () => {
    const { call } = hostFor(VAULT, { permissions: perms });
    expect((await call("formats.parseJson", { text: '{"a":[1,2]}' })).result).toEqual({ value: { a: [1, 2] } });
    expect((await call("formats.parseJson", { text: "{" })).error?.code).toBe("INVALID");
    expect((await call("formats.stringifyJson", { value: { a: 1 }, indent: 0 })).result).toEqual({ text: '{"a":1}' });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect((await call("formats.stringifyJson", { value: cyclic })).error?.code).toBe("INVALID");
    const md = await call("formats.parseMarkdown", { text: '---\n{"a":1}\n---\nbody' });
    expect(md.result).toEqual({ hasFrontmatter: true, frontmatter: { a: 1 }, body: "body" });
    const plain = await call("formats.parseMarkdown", { text: "just text" });
    expect(plain.result).toEqual({ hasFrontmatter: false, frontmatter: null, body: "just text" });
    const out = await call("formats.writeMarkdown", { frontmatter: { a: 1 }, body: "b" });
    expect(out.result).toEqual({ text: '---\n{"a":1}\n---\nb' });
    expect((await call("formats.writeMarkdown", { frontmatter: "no", body: "b" })).error?.code).toBe("INVALID");
  });
});

// ---- the gateway -------------------------------------------------------------------------------

describe("VaultGateway", () => {
  it("truncates large listings and reports it", () => {
    const files = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`F/${i}.md`, "x"]));
    const g = new VaultGateway(fakeApp(files) as never);
    const r = g.list("F" as never, false, () => true, 10);
    expect(r.entries.length).toBe(10);
    expect(r.truncated).toBe(true);
  });
  it("search respects the result limit and reports truncation", async () => {
    const files = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`F/${i}.md`, "needle"]));
    const g = new VaultGateway(fakeApp(files) as never);
    const r = await g.search("needle", null, () => true, { limit: 5, maxFiles: 100, maxMs: 1000, maxContentBytes: 1000 });
    expect(r.hits.length).toBe(5);
    expect(r.truncated).toBe(true);
  });
});

// ---- the bootstrap script and fetch shim, run in a sandboxed vm --------------------------------

class FakeResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  constructor(public body: unknown, init: { status?: number; statusText?: string; headers?: Record<string, string> } = {}) {
    this.status = init.status ?? 200;
    this.statusText = init.statusText ?? "";
    this.headers = init.headers ?? {};
  }
}

function shimHarness() {
  const listeners: Record<string, Array<(e: unknown) => void>> = {};
  const posted: Array<{ id: string; op: string; args: { path?: string } }> = [];
  const realFetchCalls: unknown[][] = [];
  const parent = { postMessage: () => {} };
  const win: Record<string, unknown> = {
    parent,
    addEventListener: (t: string, f: (e: unknown) => void) => (listeners[t] ??= []).push(f),
    fetch: (...a: unknown[]) => {
      realFetchCalls.push(a);
      return Promise.resolve("real");
    },
  };
  const docListeners: Record<string, Array<(e: unknown) => void>> = {};
  const elements: Record<string, unknown> = {};
  const scrolled: string[] = [];
  win.scrollTo = (x: number, y: number) => scrolled.push(`${x},${y}`);
  const doc = {
    documentElement: { style: { setProperty() {} }, setAttribute() {} },
    addEventListener: (t: string, f: (e: unknown) => void) => (docListeners[t] ??= []).push(f),
    getElementById: (id: string) => (Object.prototype.hasOwnProperty.call(elements, id) ? elements[id] : null),
  };
  const sandbox = vm.createContext({ window: win, document: doc, Promise, Object, Error, String, TypeError, console, Response: FakeResponse });
  new vm.Script(buildBootstrap("nonce")).runInContext(sandbox);
  const port: { postMessage(m: never): void; onmessage: ((e: unknown) => void) | null } = {
    postMessage: (m) => posted.push(m),
    onmessage: null,
  };
  listeners.message?.[0]?.({ source: parent, data: { hp: "port" }, ports: [port] });
  const reply = (id: string, ok: boolean, payload: unknown) =>
    port.onmessage?.({ data: ok ? { v: 1, id, type: "response", ok, result: payload } : { v: 1, id, type: "response", ok, error: payload } });
  /** Click a link with the given href. Returns whether the browser's own navigation was prevented. */
  const click = (href: string | null) => {
    let prevented = false;
    const link = href === null ? null : { getAttribute: (n: string) => (n === "href" ? href : null) };
    const event = { target: { closest: (sel: string) => (sel === "a[href]" ? link : null) }, preventDefault: () => (prevented = true) };
    for (const f of docListeners.click ?? []) f(event);
    return prevented;
  };
  return { fetch: win.fetch as (i: unknown, init?: unknown) => Promise<FakeResponse>, posted, realFetchCalls, reply, click, elements, scrolled };
}

describe("bootstrap script and fetch shim", () => {
  it("is syntactically valid JavaScript", () => {
    expect(() => new vm.Script(buildBootstrap("abc"))).not.toThrow();
  });

  it("sends URLs with a scheme and // URLs to the real fetch (the CSP blocks them)", async () => {
    const h = shimHarness();
    for (const url of ["https://example.com/x", "http://x", "file:///etc/passwd", "data:text/plain,hi", "//cdn.example.com/a.js", "C:/x", "javascript:1"]) {
      await h.fetch(url);
    }
    expect(h.realFetchCalls.length).toBe(7);
    expect(h.posted).toEqual([]);
  });

  it("turns vault paths into bridge reads and maps errors to HTTP statuses", async () => {
    const h = shimHarness();
    const p = h.fetch("Notes/x.md");
    expect(h.posted[0]).toMatchObject({ op: "files.read", args: { path: "Notes/x.md" } });
    h.reply((h.posted[0] as { id: string }).id, true, { content: "hello", mtime: 1, size: 5 });
    const res = await p;
    expect([res.status, res.body, res.headers["Content-Type"]]).toEqual([200, "hello", "text/markdown"]);

    for (const [code, status] of [["NOT_FOUND", 404], ["DENIED", 403], ["INVALID", 400], ["TOO_LARGE", 413]] as const) {
      const q = h.fetch("Private/x.md");
      h.reply((h.posted.at(-1) as { id: string }).id, false, { code, message: "x" });
      expect((await q).status).toBe(status);
    }
  });

  it("uses a binary read for non-text files and rejects writes with 405", async () => {
    const h = shimHarness();
    void h.fetch("img/dot.png");
    expect(h.posted[0]?.op).toBe("files.readBinary");
    const post = await h.fetch("Notes/x.md", { method: "POST", body: "x" });
    expect(post.status).toBe(405);
    expect(h.posted.length).toBe(1);
  });

  it("never lets a link navigate the frame, and scrolls to and focuses the target of a fragment link itself", () => {
    const h = shimHarness();
    const calls: string[] = [];
    const attrs: Record<string, string> = {};
    h.elements.main = {
      tabIndex: -1,
      hasAttribute: (n: string) => n in attrs,
      setAttribute: (n: string, v: string) => (attrs[n] = v),
      scrollIntoView: () => calls.push("scroll"),
      focus: (o: unknown) => calls.push(`focus ${JSON.stringify(o)}`),
    };
    // Every kind of link is stopped from navigating, including "#main": the browser would resolve it against Obsidian's own address.
    for (const href of ["#main", "#", "#top", "#missing", "#%E0%A4%A", "Notes/x.md", "https://example.com", "javascript:1", "//evil.example/"]) {
      expect(h.click(href), href).toBe(true);
    }
    expect(calls).toEqual(["scroll", 'focus {"preventScroll":true}']);
    expect(attrs.tabindex).toBe("-1"); // made focusable so focus() works
    expect(h.scrolled).toEqual(["0,0", "0,0"]); // "#" and "#top" (no such element) scroll to the top
  });

  it("clicks that are not on a link are left alone", () => {
    const h = shimHarness();
    expect(h.click(null)).toBe(false); // a click on a button or the page itself is not interfered with
    expect(h.click("#main")).toBe(true);
  });

  it("does not let odd extensions reach prototype properties", async () => {
    const h = shimHarness();
    void h.fetch("a.constructor");
    expect(h.posted[0]?.op).toBe("files.readBinary");
  });
});
