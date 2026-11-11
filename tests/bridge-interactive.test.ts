import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppManifest } from "../src/apps/manifest";
import { buildContext } from "../src/bridge/context";
import { EventRouter, routeEvent, type OutEvent, type RawEvent, type Subscription } from "../src/bridge/events";
import { BridgeHost, type Handler } from "../src/bridge/host";
import { TokenBucket } from "../src/bridge/limits";
import { eventsOps, linksOps, pickOps } from "../src/bridge/ops/links";
import type { BridgeEvent, BridgeResponse } from "../src/bridge/protocol";
import type { ConfirmRequest } from "../src/bridge/services";
import {
  localStorageBackend, TrustManager, TrustStore, trustHash, trustPayload, trustRequest, type TrustBackend, type TrustRecord,
} from "../src/bridge/trust";
import { memoryServices, mutableApp } from "./support";

// ---- harness -----------------------------------------------------------------------------------

const manifest = (extra: Partial<AppManifest> = {}): AppManifest => ({
  name: "T", version: "1", description: "", entry: "index.html", permissions: [], trusted: false,
  aiGenerated: false, allowedDomains: [], ...extra,
});

const ALL = ["links.resolve", "links.open", "links.backlinks", "links.outgoing", "links.activeNote", "pick.note", "pick.folder", "events.subscribe", "events.unsubscribe"];

const VAULT: Record<string, string> = {
  "Notes/A.md": "links to [[B]] and [[Secret]]",
  "Notes/B.md": "back to [[A]]",
  "Notes/C.md": "also [[B]]",
  "Data/D.md": "about [[B]]",
  "Private/Secret.md": "TOP SECRET [[B]]",
  "Private/Other.md": "x",
  "Welcome.md": "hi",
};

function host(extra: Partial<AppManifest> = {}, opts: { now?: () => number } = {}) {
  let auto = 0;
  const now = opts.now ?? (() => (auto += 1000)); // advancing clock: no throttling unless a test passes its own
  const vault = mutableApp(VAULT);
  const services = memoryServices(vault.gateway);
  const built = buildContext({
    appRoot: "Apps/T", manifest: manifest({ permissions: ALL, ...extra }), strictPaths: false, exclusions: ["Private/", "*.secret.md"],
  });
  const handlers = new Map<string, Handler>(Object.entries({ ...linksOps(), ...eventsOps(), ...pickOps() }));
  const sent: BridgeResponse[] = [];
  const events: BridgeEvent[] = [];
  const h = new BridgeHost(built.ctx, services, handlers, (m) => sent.push(m), now, (e) => events.push(e));
  let n = 0;
  const call = async (op: string, args: Record<string, unknown> = {}) => {
    const before = sent.length;
    await h.handle({ v: 1, id: `i${++n}`, type: "request", op, args });
    return sent[before] as BridgeResponse;
  };
  return { call, host: h, vault, services, events };
}

const code = (r: BridgeResponse) => r.error?.code;
const out = (events: BridgeEvent[]) => events.map((e) => e.payload as OutEvent);

// ---- links -------------------------------------------------------------------------------------

describe("links.*", () => {
  it("resolves link text, including headings and aliases", async () => {
    const h = host();
    for (const link of ["B", "b", "B#Heading", "B|alias", "B^block", "Notes/B", "  B  "]) {
      expect((await h.call("links.resolve", { link })).result, link).toEqual({ path: "Notes/B.md" });
    }
    expect((await h.call("links.resolve", { link: "Nope" })).result).toEqual({ path: null });
    expect((await h.call("links.resolve", { link: "" })).result).toEqual({ path: null });
    expect((await h.call("links.resolve", { link: "B", from: "Notes/A.md" })).result).toEqual({ path: "Notes/B.md" });
  });

  it("a link to an excluded note looks exactly like a link to nothing", async () => {
    const h = host();
    const excluded = await h.call("links.resolve", { link: "Secret" });
    const missing = await h.call("links.resolve", { link: "Nothing" });
    expect(excluded.result).toEqual(missing.result);
    expect(JSON.stringify(excluded)).not.toContain("Private");
    expect(code(await h.call("links.resolve", { link: "B", from: "Private/Secret.md" }))).toBe("NOT_FOUND");
    expect(code(await h.call("links.resolve", { link: "x".repeat(301) }))).toBe("INVALID");
  });

  it("lists backlinks and outgoing links, never revealing excluded or out-of-scope notes", async () => {
    const h = host();
    expect((await h.call("links.backlinks", { path: "Notes/B.md" })).result).toEqual({ paths: ["Data/D.md", "Notes/A.md", "Notes/C.md"] }); // Private/Secret.md omitted
    expect((await h.call("links.outgoing", { path: "Notes/A.md" })).result).toEqual({ paths: ["Notes/B.md"] }); // [[Secret]] omitted

    const scoped = host({ readScopes: ["Notes"] });
    expect((await scoped.call("links.backlinks", { path: "Notes/B.md" })).result).toEqual({ paths: ["Notes/A.md", "Notes/C.md"] });
    expect(code(await scoped.call("links.backlinks", { path: "Data/D.md" }))).toBe("NOT_FOUND");
  });

  it("needs a readable note", async () => {
    const h = host();
    for (const op of ["links.backlinks", "links.outgoing", "links.open"]) {
      expect(code(await h.call(op, { path: "Private/Secret.md" })), op).toBe("NOT_FOUND");
      expect(code(await h.call(op, { path: "Nope.md" })), op).toBe("NOT_FOUND");
      expect(code(await h.call(op, { path: "Notes" })), op).toBe("NOT_FOUND"); // a folder
      expect(code(await h.call(op, { path: "../x.md" })), op).toBe("INVALID");
    }
  });

  it("reports the active note, but null when it is one the app may not read", async () => {
    const h = host();
    expect((await h.call("links.activeNote")).result).toEqual({ path: null });
    h.vault.setActive("Notes/A.md");
    expect((await h.call("links.activeNote")).result).toEqual({ path: "Notes/A.md" });
    h.vault.setActive("Private/Secret.md");
    expect((await h.call("links.activeNote")).result).toEqual({ path: null });
  });

  it("opens a note in a tab, reusing a tab that already shows it", async () => {
    const h = host();
    expect((await h.call("links.open", { path: "Notes/A.md" })).result).toEqual({ opened: true });
    await h.call("links.open", { path: "Notes/A.md" });
    await h.call("links.open", { path: "Notes/B.md" });
    expect(h.vault.opened).toEqual(["Notes/A.md", "Notes/B.md"]);
  });

  it("a sidebar pane that follows the active note is not mistaken for an open note tab", async () => {
    const h = host();
    await h.call("links.open", { path: "Notes/A.md" }); // also leaves a fake Backlinks pane showing Notes/A.md
    await h.call("links.open", { path: "Notes/A.md" });
    expect(h.vault.opened).toEqual(["Notes/A.md"]); // reused the note tab, did not open twice
  });

  it("limits how fast an app can open notes", async () => {
    let t = 0;
    const h = host({}, { now: () => t });
    const codes: (string | undefined)[] = [];
    for (let i = 0; i < 8; i++) codes.push(code(await h.call("links.open", { path: i % 2 ? "Notes/A.md" : "Notes/B.md" })));
    expect(codes.filter((c) => c === "DENIED").length).toBeGreaterThan(0);
    expect((await h.call("links.open", { path: "Notes/C.md" })).error?.message).toContain("Wait a moment");
    t = 60_000;
    expect((await h.call("links.open", { path: "Notes/C.md" })).ok).toBe(true);
  });

  it("needs the permission for every operation", async () => {
    const h = host({ permissions: [] });
    for (const op of ALL) expect(code(await h.call(op, { path: "Notes/A.md", link: "B", id: "s1" })), op).toBe("DENIED");
    expect(h.vault.opened).toEqual([]);
  });
});

// ---- pick --------------------------------------------------------------------------------------

describe("pick.*", () => {
  it("returns what the user chose, and tells the dialog which app is asking and what it may list", async () => {
    const h = host();
    h.services.pickAnswer("Notes/A.md");
    expect((await h.call("pick.note")).result).toEqual({ path: "Notes/A.md" });
    expect(h.services.picks).toEqual([{ kind: "note", app: "Apps/T" }]);
    h.services.pickAnswer("Notes");
    expect((await h.call("pick.folder")).result).toEqual({ path: "Notes" });
  });

  it("answers null when cancelled, when the dialog fails, or if the result is something the app may not read", async () => {
    const h = host();
    h.services.pickAnswer(null);
    expect((await h.call("pick.note")).result).toEqual({ path: null });
    h.services.pickAnswer("Private/Secret.md"); // even if the dialog somehow returned it
    expect((await h.call("pick.note")).result).toEqual({ path: null });
    h.services.pick = async () => {
      throw new Error("dialog crashed");
    };
    expect((await h.call("pick.note")).result).toEqual({ path: null });
  });

  it("is rate limited and needs the permission", async () => {
    let t = 0;
    const h = host({}, { now: () => t });
    h.services.pickAnswer("Notes/A.md");
    const codes = [];
    for (let i = 0; i < 8; i++) codes.push(code(await h.call("pick.note")));
    expect(codes.filter((c) => c === "DENIED").length).toBeGreaterThan(0);
    expect(code(await host({ permissions: [] }).call("pick.note"))).toBe("DENIED");
  });
});

// ---- events ------------------------------------------------------------------------------------

describe("routeEvent (pure)", () => {
  const visible = (p: string) => !p.startsWith("Private/") && !p.startsWith("Data/");
  const sub = (id: string, kinds: string[] = ["created", "modified", "renamed", "deleted"], folder: string | null = null): Subscription => ({
    id, kinds: new Set(kinds) as Subscription["kinds"], folder,
  });

  it("delivers events for readable paths and drops the rest", () => {
    expect(routeEvent({ kind: "created", type: "file", path: "Notes/a.md" }, [sub("s1")], visible)).toEqual([{ id: "s1", kind: "created", type: "file", path: "Notes/a.md" }]);
    expect(routeEvent({ kind: "created", type: "file", path: "Private/a.md" }, [sub("s1")], visible)).toEqual([]);
    expect(routeEvent({ kind: "modified", type: "file", path: "Data/a.md" }, [sub("s1")], visible)).toEqual([]);
  });

  it("describes renames across the visibility boundary as creates and deletes", () => {
    const rename = (oldPath: string, path: string): RawEvent => ({ kind: "renamed", type: "file", path, oldPath });
    expect(routeEvent(rename("Notes/a.md", "Notes/b.md"), [sub("s")], visible)).toEqual([{ id: "s", kind: "renamed", type: "file", path: "Notes/b.md", oldPath: "Notes/a.md" }]);
    expect(routeEvent(rename("Notes/a.md", "Private/a.md"), [sub("s")], visible)).toEqual([{ id: "s", kind: "deleted", type: "file", path: "Notes/a.md" }]);
    expect(routeEvent(rename("Private/a.md", "Notes/a.md"), [sub("s")], visible)).toEqual([{ id: "s", kind: "created", type: "file", path: "Notes/a.md" }]);
    expect(routeEvent(rename("Private/a.md", "Private/b.md"), [sub("s")], visible)).toEqual([]);
    // A hidden path never appears in anything delivered.
    expect(JSON.stringify(routeEvent(rename("Notes/a.md", "Private/secret.md"), [sub("s")], visible))).not.toContain("Private");
  });

  it("filters by kind and folder", () => {
    const e: RawEvent = { kind: "modified", type: "file", path: "Notes/sub/a.md" };
    expect(routeEvent(e, [sub("s", ["created"])], visible)).toEqual([]);
    expect(routeEvent(e, [sub("s", ["modified"], "Notes")], visible)).toHaveLength(1);
    expect(routeEvent(e, [sub("s", ["modified"], "Other")], visible)).toEqual([]);
    expect(routeEvent(e, [sub("a"), sub("b", ["modified"], "Notes/sub"), sub("c", ["deleted"])], visible).map((x) => x.id)).toEqual(["a", "b"]);
  });
});

describe("EventRouter", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const make = (visible: (p: string) => boolean = () => true, maxSubscriptions = 20, capacity = 100) => {
    const emitted: OutEvent[] = [];
    const router = new EventRouter(visible, (e) => emitted.push(e), {
      maxSubscriptions, throttleMs: 300, rate: new TokenBucket(capacity, 1000),
    });
    return { router, emitted };
  };
  const modify = (path = "a.md"): RawEvent => ({ kind: "modified", type: "file", path });

  it("caps subscriptions and frees a slot on unsubscribe", () => {
    const { router } = make(() => true, 2);
    const a = router.subscribe(["created"], null);
    router.subscribe(["created"], null);
    expect(() => router.subscribe(["created"], null)).toThrow(expect.objectContaining({ code: "DENIED" }));
    expect(router.unsubscribe(a)).toBe(true);
    expect(router.unsubscribe(a)).toBe(false);
    expect(() => router.subscribe(["created"], null)).not.toThrow();
  });

  it("gives each subscription its own id", () => {
    const { router } = make();
    expect(new Set([router.subscribe(["created"], null), router.subscribe(["created"], null)]).size).toBe(2);
  });

  it("throttles modify events per path and delivers the rest at once", () => {
    const { router, emitted } = make();
    router.subscribe(["modified", "created"], null);
    for (let i = 0; i < 20; i++) router.handle(modify());
    router.handle(modify("b.md"));
    router.handle({ kind: "created", type: "file", path: "c.md" });
    expect(emitted.map((e) => e.kind)).toEqual(["created"]); // modifies are waiting
    vi.advanceTimersByTime(300);
    expect(emitted.filter((e) => e.kind === "modified").map((e) => e.path).sort()).toEqual(["a.md", "b.md"]);
    router.handle(modify());
    vi.advanceTimersByTime(300);
    expect(emitted.filter((e) => e.path === "a.md")).toHaveLength(2);
  });

  it("a rename or delete cancels the modify notice that is still waiting, so it never names a vanished path", () => {
    const { router, emitted } = make();
    router.subscribe(["modified", "renamed", "deleted"], null);
    router.handle(modify("a.md"));
    router.handle(modify("b.md"));
    router.handle(modify("c.md"));
    router.handle({ kind: "renamed", type: "file", path: "a2.md", oldPath: "a.md" });
    router.handle({ kind: "deleted", type: "file", path: "b.md" });
    vi.advanceTimersByTime(1000);
    expect(emitted.map((e) => [e.kind, e.path])).toEqual([["renamed", "a2.md"], ["deleted", "b.md"], ["modified", "c.md"]]);
  });

  it("drops events beyond the delivery rate instead of flooding the app", () => {
    const emitted: OutEvent[] = [];
    let t = 0;
    const router = new EventRouter(() => true, (e) => emitted.push(e), { maxSubscriptions: 5, throttleMs: 300, rate: new TokenBucket(3, 1, () => t) });
    router.subscribe(["created"], null);
    for (let i = 0; i < 10; i++) router.handle({ kind: "created", type: "file", path: `f${i}.md` });
    expect(emitted).toHaveLength(3);
  });

  it("stops everything on unsubscribe and dispose, including pending modify notices", () => {
    const { router, emitted } = make();
    const id = router.subscribe(["modified"], null);
    router.handle(modify());
    router.unsubscribe(id);
    vi.advanceTimersByTime(1000);
    expect(emitted).toEqual([]);

    router.subscribe(["created", "modified"], null);
    router.handle(modify());
    router.dispose();
    vi.advanceTimersByTime(1000);
    router.handle({ kind: "created", type: "file", path: "x.md" });
    expect(emitted).toEqual([]);
    expect(router.size()).toBe(0);
  });

  it("does nothing, cheaply, with no subscriptions", () => {
    const { router, emitted } = make(() => {
      throw new Error("visibility should not even be checked");
    });
    router.handle(modify());
    expect(emitted).toEqual([]);
  });
});

describe("events through the bridge", () => {
  it("delivers only what the app subscribed to and may read", async () => {
    const h = host({ readScopes: ["Notes"] });
    const sub = await h.call("events.subscribe", { kinds: ["created", "deleted"], folder: "Notes" });
    expect(sub.result).toEqual({ id: expect.stringMatching(/^s\d+$/) });
    h.host.onVaultEvent({ kind: "created", type: "file", path: "Notes/new.md" });
    h.host.onVaultEvent({ kind: "created", type: "file", path: "Private/new.md" }); // excluded
    h.host.onVaultEvent({ kind: "created", type: "file", path: "Data/new.md" }); // out of read scope
    h.host.onVaultEvent({ kind: "modified", type: "file", path: "Notes/new.md" }); // kind not subscribed
    h.host.onVaultEvent({ kind: "deleted", type: "file", path: "Notes/old.md" });
    expect(h.events.every((e) => e.type === "event" && e.name === "file")).toBe(true);
    expect(out(h.events).map((e) => [e.kind, e.path])).toEqual([["created", "Notes/new.md"], ["deleted", "Notes/old.md"]]);
    expect(JSON.stringify(h.events)).not.toMatch(/Private|Data/);
  });

  it("validates arguments and respects scopes", async () => {
    const h = host({ readScopes: ["Notes"] });
    for (const kinds of [[], ["nope"], "created", ["created", 5], Array(5).fill("created")]) {
      expect(code(await h.call("events.subscribe", { kinds })), JSON.stringify(kinds)).toBe("INVALID");
    }
    expect(code(await h.call("events.subscribe", { folder: "Private" }))).toBe("NOT_FOUND");
    expect(code(await h.call("events.subscribe", { folder: "Data" }))).toBe("NOT_FOUND"); // outside the read scope
    expect(code(await h.call("events.subscribe", { folder: "../x" }))).toBe("INVALID");
    expect((await h.call("events.subscribe", { folder: "Notes" })).ok).toBe(true);
  });

  it("limits subscriptions, and unsubscribing stops delivery", async () => {
    const h = host();
    const ids: string[] = [];
    for (let i = 0; i < 20; i++) ids.push(((await h.call("events.subscribe", {})).result as { id: string }).id);
    expect(code(await h.call("events.subscribe", {}))).toBe("DENIED");
    expect((await h.call("events.unsubscribe", { id: ids[0] })).result).toEqual({ removed: true });
    expect((await h.call("events.unsubscribe", { id: ids[0] })).result).toEqual({ removed: false });
    expect(code(await h.call("events.unsubscribe", { id: 5 }))).toBe("INVALID");
    h.host.onVaultEvent({ kind: "created", type: "file", path: "Notes/x.md" });
    expect(h.events).toHaveLength(19); // one per remaining subscription
  });

  it("is silent after the app is closed", async () => {
    const h = host();
    await h.call("events.subscribe", {});
    h.host.dispose();
    h.host.onVaultEvent({ kind: "created", type: "file", path: "Notes/x.md" });
    expect(h.events).toEqual([]);
  });

  it("needs the permission and cannot be used to learn about hidden paths", async () => {
    const none = host({ permissions: [] });
    expect(code(await none.call("events.subscribe", {}))).toBe("DENIED");
    none.host.onVaultEvent({ kind: "created", type: "file", path: "Notes/x.md" });
    expect(none.events).toEqual([]);
  });
});

// ---- trust -------------------------------------------------------------------------------------

describe("trust hash", () => {
  const base = manifest({ trusted: true, permissions: ["files.read", "files.edit"], writeScopes: ["Notes"] });
  it("ignores things that do not affect power, and the order of lists", async () => {
    const h = await trustHash(base);
    expect(await trustHash({ ...base, version: "9.9", description: "changed", name: "Renamed", aiGenerated: true })).toBe(h);
    expect(await trustHash({ ...base, permissions: ["files.edit", "files.read"] })).toBe(h);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
  it("changes with anything that does", async () => {
    const h = await trustHash(base);
    for (const change of [
      { permissions: ["files.read", "files.edit", "files.delete"] }, { permissions: ["files.read"] }, { writeScopes: ["Notes", "Data"] },
      { writeScopes: [""] }, { writeScopes: undefined }, { readScopes: ["Notes"] }, { entry: "other.html" }, { allowedDomains: ["example.com"] }, { trusted: false },
    ] as Partial<AppManifest>[]) {
      expect(await trustHash({ ...base, ...change }), JSON.stringify(change)).not.toBe(h);
    }
    expect(trustPayload(base)).toContain('"writeScopes":["Notes"]');
  });
});

describe("TrustStore", () => {
  const memory = (): TrustBackend & { data: Record<string, TrustRecord> } => {
    const b = { data: {} as Record<string, TrustRecord>, read: () => b.data, write: (v: Record<string, TrustRecord>) => void (b.data = v) };
    return b;
  };
  it("stores, lists and removes approvals", () => {
    const s = new TrustStore(memory());
    s.set("Apps/B", { hash: "h2", time: 2 });
    s.set("Apps/A", { hash: "h1", time: 1 });
    expect(s.list().map(([k]) => k)).toEqual(["Apps/A", "Apps/B"]);
    expect(s.get("Apps/A")).toEqual({ hash: "h1", time: 1 });
    s.remove("Apps/A");
    expect(s.get("Apps/A")).toBeUndefined();
  });
  it("is not fooled by prototype keys", () => {
    const s = new TrustStore(memory());
    for (const key of ["__proto__", "constructor", "toString", "hasOwnProperty"]) expect(s.get(key)).toBeUndefined();
  });
  it("survives broken storage", () => {
    const bad = { getItem: () => "{not json", setItem: () => { throw new Error("quota"); } };
    const backend = localStorageBackend("k", bad);
    expect(backend.read()).toEqual({});
    expect(() => backend.write({ a: { hash: "h", time: 1 } })).not.toThrow();
    expect(localStorageBackend("k", { getItem: () => "[1,2]", setItem: () => undefined }).read()).toEqual({});
    expect(localStorageBackend("k", undefined).read()).toEqual({});
  });
  it("round-trips through a real storage object", () => {
    const store: Record<string, string> = {};
    const backend = localStorageBackend("k", { getItem: (k) => store[k] ?? null, setItem: (k, v) => void (store[k] = v) });
    new TrustStore(backend).set("Apps/A", { hash: "h", time: 1 });
    expect(new TrustStore(backend).get("Apps/A")).toEqual({ hash: "h", time: 1 });
  });
});

describe("TrustManager", () => {
  const trustedManifest = manifest({ trusted: true, permissions: ["files.create"] });
  const setup = (answers: Array<boolean | Error> = [true]) => {
    const data: Record<string, TrustRecord> = {};
    const store = new TrustStore({
      read: () => data,
      write: (v) => {
        for (const key of Object.keys(data)) delete data[key]; // a real store REPLACES its contents
        Object.assign(data, v);
      },
    });
    const asked: ConfirmRequest[] = [];
    const manager = new TrustManager(store, async (request) => {
      asked.push(request);
      const answer = answers.shift() ?? false;
      if (answer instanceof Error) throw answer;
      return answer;
    });
    return { manager, store, asked, data };
  };

  it("does not ask about apps that did not ask for trust", async () => {
    const { manager, asked } = setup();
    expect(await manager.ensure("Apps/T", manifest())).toBe(false);
    expect(asked).toEqual([]);
  });

  it("asks once, remembers an approval, and asks again if the manifest's power changes", async () => {
    const { manager, asked, store } = setup([true, true]);
    expect(await manager.ensure("Apps/T", trustedManifest)).toBe(true);
    expect(await manager.ensure("Apps/T", trustedManifest)).toBe(true);
    expect(asked).toHaveLength(1);
    expect(store.get("Apps/T")).toBeDefined();
    expect(await manager.ensure("Apps/T", { ...trustedManifest, permissions: ["files.create", "files.delete"] })).toBe(true);
    expect(asked).toHaveLength(2); // different permissions, so asked again
  });

  it("the dialog names the app and spells out what trust does and never does", async () => {
    const { manager, asked } = setup([false]);
    await manager.ensure("Apps/T", manifest({ trusted: true, name: "Calc", permissions: ["files.create"], writeScopes: ["Notes"] }));
    const text = asked[0]!.details.join("\n");
    expect(asked[0]).toMatchObject({ app: "Apps/T", title: "Trust this app?" });
    for (const needle of ["Calc", "files.create", "Notes", "write anywhere", "never lets it", "excluded or hidden", "manifest.json", "snapshots", "network", "this device only"]) {
      expect(text, needle).toContain(needle);
    }
    expect(trustRequest("Apps/T", trustedManifest).paths).toEqual([]);
  });

  it("a refusal is remembered (no nagging) until the user reloads", async () => {
    const { manager, asked } = setup([false, true]);
    expect(await manager.ensure("Apps/T", trustedManifest)).toBe(false);
    expect(await manager.ensure("Apps/T", trustedManifest)).toBe(false);
    expect(asked).toHaveLength(1);
    expect(await manager.ensure("Apps/T", trustedManifest, true)).toBe(true); // Reload asks again
    expect(asked).toHaveLength(2);
  });

  it("a failing dialog means not trusted, and nothing is stored", async () => {
    const { manager, store } = setup([new Error("modal crashed")]);
    expect(await manager.ensure("Apps/T", trustedManifest)).toBe(false);
    expect(store.list()).toEqual([]);
  });

  it("revoking asks again next time", async () => {
    const { manager, asked } = setup([true, true]);
    await manager.ensure("Apps/T", trustedManifest);
    manager.revoke("Apps/T");
    await manager.ensure("Apps/T", trustedManifest);
    expect(asked).toHaveLength(2);
  });

  it("approval for one app folder does not carry over to another", async () => {
    const { manager, asked } = setup([true, true]);
    await manager.ensure("Apps/A", trustedManifest);
    await manager.ensure("Apps/B", trustedManifest);
    expect(asked).toHaveLength(2);
  });

  it("effective trust needs BOTH the manifest flag and the user's approval", () => {
    const ask = (trusted: boolean | undefined, flag: boolean) =>
      buildContext({ appRoot: "Apps/T", manifest: manifest({ trusted: flag }), strictPaths: false, exclusions: [], trusted }).ctx.trusted;
    expect([ask(true, true), ask(true, false), ask(false, true), ask(undefined, true)]).toEqual([true, false, false, false]);
  });
});
