import { describe, expect, it } from "vitest";
import { DEFAULT_EMBED_HEIGHT, MAX_PARAMS, paramsObject, parseEmbedBlock } from "../src/apps/embedBlock";
import type { AppManifest } from "../src/apps/manifest";
import { buildContext } from "../src/bridge/context";
import { BridgeHost, type Handler } from "../src/bridge/host";
import { miscReadOps } from "../src/bridge/ops/misc";
import { ALWAYS_ALLOWED, isAllowed } from "../src/bridge/permissions";
import type { BridgeResponse } from "../src/bridge/protocol";
import { memoryServices, mutableApp } from "./support";

const ok = (source: string) => {
  const r = parseEmbedBlock(source);
  if (!r.ok) throw new Error(r.error);
  return r.block;
};
const bad = (source: string) => {
  const r = parseEmbedBlock(source);
  return r.ok ? null : r.error;
};

describe("embed block parser", () => {
  it("reads the target, keeps today's defaults and the old height rules", () => {
    expect(ok("Apps/Calculator")).toEqual({ target: "Apps/Calculator", height: DEFAULT_EMBED_HEIGHT, id: null, params: [] });
    expect(ok("Apps/X\nheight: 480").height).toBe(480);
    expect(ok("Apps/X\nheight: 100").height).toBe(120); // clamped, as before
    expect(ok("Apps/X\nheight: 5000").height).toBe(2000);
    expect(ok("Apps/X\nheight: AUTO").height).toBe("auto");
    expect(ok("  Apps/X  \r\n\r\n  height :  300  \r\n").height).toBe(300);
  });

  it("reads id and parameters in the order written", () => {
    const b = ok("Apps/PCB Rulebook\nheight: auto\nid: pump-note\nwidget: microstrip\nlayer: top_1");
    expect(b.id).toBe("pump-note");
    expect(b.params).toEqual([["widget", "microstrip"], ["layer", "top_1"]]);
  });

  it("values may contain colons, quotes and angle brackets, as plain text", () => {
    const b = ok('Apps/X\nsource: Data/a: b.csv\nlabel: <b onclick="x">hi</b>');
    expect(b.params).toEqual([["source", "Data/a: b.csv"], ["label", '<b onclick="x">hi</b>']]);
  });

  it("refuses an empty block and bad targets", () => {
    expect(bad("")).toMatch(/first line/);
    expect(bad("   \n  \n")).toMatch(/first line/);
    expect(bad("a".repeat(301))).toMatch(/not valid/);
    expect(bad("Apps/X\u0000")).toMatch(/not valid/);
  });

  it("refuses lines that are not name: value, bad names, duplicates and bad reserved values", () => {
    expect(bad("Apps/X\nsome stray text")).toMatch(/Line 2/);
    expect(bad("Apps/X\nHeight: 300")).toMatch(/not allowed/);
    expect(bad("Apps/X\nbad name: 1")).toMatch(/not allowed/);
    expect(bad(`Apps/X\n${"k".repeat(33)}: 1`)).toMatch(/not allowed/);
    expect(bad("Apps/X\nwidget: a\nwidget: b")).toMatch(/twice/);
    expect(bad("Apps/X\nheight: tall")).toMatch(/height/);
    expect(bad("Apps/X\nheight: 5")).toMatch(/height/);
    expect(bad("Apps/X\nid: Not Valid")).toMatch(/id must/);
    expect(bad("Apps/X\nid: __proto__")).toMatch(/id must/);
  });

  it("refuses hostile names and too many or too long parameters", () => {
    for (const name of ["__proto__", "constructor", "prototype"]) expect(bad(`Apps/X\n${name}: x`), name).toMatch(/not allowed/);
    expect(bad(`Apps/X\nv: ${"x".repeat(201)}`)).toMatch(/longer than 200/);
    expect(ok(`Apps/X\nv: ${"x".repeat(200)}`).params).toHaveLength(1);
    const many = (n: number) => ["Apps/X", ...Array.from({ length: n }, (_, i) => `p${i}: v`)].join("\n");
    expect(ok(many(MAX_PARAMS)).params).toHaveLength(MAX_PARAMS);
    expect(bad(many(MAX_PARAMS + 1))).toMatch(/No more than 20/);
  });

  it("refuses control characters in values", () => {
    expect(bad("Apps/X\nv: a\u0007b")).toMatch(/control/);
    expect(bad("Apps/X\nv: a\u007fb")).toMatch(/control/);
  });

  it("paramsObject has no prototype, so no inherited names", () => {
    const p = paramsObject([["widget", "microstrip"]]);
    expect(Object.getPrototypeOf(p)).toBeNull();
    expect(p.widget).toBe("microstrip");
    expect((p as Record<string, unknown>).constructor).toBeUndefined();
    expect((p as Record<string, unknown>).toString).toBeUndefined();
  });
});

// ---- embed.context through the real host pipeline -----------------------------------------------------------

const manifest = (extra: Partial<AppManifest> = {}): AppManifest => ({
  name: "T", version: "1", description: "", entry: "index.html", permissions: [], trusted: false, aiGenerated: false, allowedDomains: [], ...extra,
});

function hostFor(opts: { embed?: { sourcePath: string; params: Record<string, string> }; manifest?: Partial<AppManifest>; exclusions?: string[] }) {
  const { ctx } = buildContext({
    appRoot: "Apps/T",
    manifest: manifest(opts.manifest),
    strictPaths: false,
    exclusions: opts.exclusions ?? ["Private/"],
    ...(opts.embed ? { embed: opts.embed } : {}),
  });
  const vault = mutableApp({ "Notes/Pump.md": "x", "Other/Plan.md": "x", "Private/Secret.md": "x", "Apps/T/index.html": "x" });
  const handlers = new Map<string, Handler>(Object.entries(miscReadOps(() => ({ mode: "light" as const, vars: {} }))));
  const sent: BridgeResponse[] = [];
  let auto = 0;
  const host = new BridgeHost(ctx, memoryServices(vault.gateway), handlers, (m) => sent.push(m), () => (auto += 1000));
  let n = 0;
  const call = async (op: string, args: Record<string, unknown> = {}) => {
    const before = sent.length;
    await host.handle({ v: 1, id: `r${++n}`, type: "request", op, args });
    return sent[before] as BridgeResponse;
  };
  return { call };
}

describe("embed.context", () => {
  it("needs no permission, like theme.get, and nothing else was added to the always-allowed set", () => {
    expect(isAllowed("embed.context", new Set())).toBe(true);
    expect([...ALWAYS_ALLOWED].sort()).toEqual(["embed.context", "theme.get"]);
  });

  it("a tab app is not embedded", async () => {
    const r = await hostFor({}).call("embed.context");
    expect(r.ok && r.result).toEqual({ embedded: false, sourcePath: null, params: {} });
  });

  it("a note embed gets its note and parameters", async () => {
    const { call } = hostFor({ embed: { sourcePath: "Notes/Pump.md", params: paramsObject([["widget", "microstrip"]]) } });
    const r = await call("embed.context");
    expect(r.ok && r.result).toEqual({ embedded: true, sourcePath: "Notes/Pump.md", params: { widget: "microstrip" } });
  });

  it("the note's path is hidden (null) when the app could not read that note anyway", async () => {
    const scoped = hostFor({ manifest: { readScopes: ["Notes"] }, embed: { sourcePath: "Other/Plan.md", params: {} } });
    expect(((await scoped.call("embed.context")).result as { sourcePath: unknown }).sourcePath).toBeNull();

    const inside = hostFor({ manifest: { readScopes: ["Notes"] }, embed: { sourcePath: "Notes/Pump.md", params: {} } });
    expect(((await inside.call("embed.context")).result as { sourcePath: unknown }).sourcePath).toBe("Notes/Pump.md");

    const excluded = hostFor({ embed: { sourcePath: "Private/Secret.md", params: {} } });
    const r = await excluded.call("embed.context");
    expect(r.ok).toBe(true);
    expect(JSON.stringify(r)).not.toContain("Secret");
    expect((r.result as { sourcePath: unknown }).sourcePath).toBeNull();
  });

  it("parameters are copied and frozen: the app cannot change the context for later calls", async () => {
    const params = paramsObject([["a", "1"]]);
    const { call } = hostFor({ embed: { sourcePath: "Notes/Pump.md", params } });
    params.a = "changed after loading";
    const r = await call("embed.context");
    expect((r.result as { params: Record<string, string> }).params).toEqual({ a: "1" });
    const again = (await call("embed.context")).result as { params: Record<string, string> };
    again.params.a = "mutated by the caller";
    expect(((await call("embed.context")).result as { params: Record<string, string> }).params.a).toBe("1");
  });

  it("parameters grant nothing: permissions and scopes come only from the manifest", async () => {
    const { call } = hostFor({
      embed: { sourcePath: "Notes/Pump.md", params: paramsObject([["permissions", "files.read files.delete"], ["trusted", "true"], ["readscopes", "/"]]) },
    });
    // frontmatter.read is not declared, so it is refused whatever the note said.
    expect((await call("frontmatter.read", { path: "Notes/Pump.md" })).error?.code).toBe("DENIED");
  });
});
