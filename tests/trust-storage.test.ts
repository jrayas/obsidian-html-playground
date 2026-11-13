import { describe, expect, it } from "vitest";
import { appLocalStorage, localStorageBackend, TrustStore, type TrustRecord } from "../src/bridge/trust";

/** A stand-in for Obsidian's vault-scoped App#loadLocalStorage and #saveLocalStorage (it stores JSON). */
function fakeApp(opts: { throwOnSave?: boolean; throwOnLoad?: boolean } = {}) {
  const data = new Map<string, string>();
  return {
    data,
    loadLocalStorage: (key: string): unknown => {
      if (opts.throwOnLoad) throw new Error("storage unavailable");
      const raw = data.get(key);
      return raw === undefined ? null : (JSON.parse(raw) as unknown);
    },
    saveLocalStorage: (key: string, value: unknown): void => {
      if (opts.throwOnSave) throw new Error("storage unavailable");
      if (value === null) data.delete(key);
      else data.set(key, JSON.stringify(value));
    },
  };
}

const record: TrustRecord = { hash: "abc", time: 1 };

describe("trust approvals in Obsidian's vault-scoped storage", () => {
  it("a string goes in and the same string comes out; nothing stored reads as null", () => {
    const storage = appLocalStorage(fakeApp());
    expect(storage.getItem("k")).toBeNull();
    storage.setItem("k", '{"a":1}');
    expect(storage.getItem("k")).toBe('{"a":1}');
  });

  it("anything that is not a string (an old or foreign value) reads as null, never as an approval", () => {
    const app = fakeApp();
    app.data.set("k", JSON.stringify({ not: "a string" }));
    expect(appLocalStorage(app).getItem("k")).toBeNull();
  });

  it("approvals round-trip through the real TrustStore", () => {
    const app = fakeApp();
    const store = new TrustStore(localStorageBackend("html-playground:trust", appLocalStorage(app)));
    expect(store.list()).toEqual([]);
    store.set("Apps/Calc", record);
    expect(store.get("Apps/Calc")).toEqual(record);
    // A second store on the same app sees the same approvals (as after a restart).
    expect(new TrustStore(localStorageBackend("html-playground:trust", appLocalStorage(app))).get("Apps/Calc")).toEqual(record);
    store.remove("Apps/Calc");
    expect(store.get("Apps/Calc")).toBeUndefined();
  });

  it("failing storage never throws: an approval is simply asked for again", () => {
    const store = new TrustStore(localStorageBackend("k", appLocalStorage(fakeApp({ throwOnSave: true, throwOnLoad: true }))));
    expect(store.get("Apps/Calc")).toBeUndefined();
    expect(() => store.set("Apps/Calc", record)).not.toThrow();
    expect(store.list()).toEqual([]);
  });

  it("hostile stored values cannot become approvals", () => {
    const app = fakeApp();
    for (const hostile of ['{"__proto__":{"x":1}}', "[1,2]", "null", "42", "not json"]) {
      app.data.set("k", JSON.stringify(hostile));
      const store = new TrustStore(localStorageBackend("k", appLocalStorage(app)));
      expect(store.get("__proto__"), hostile).toBeUndefined();
      expect(store.get("constructor"), hostile).toBeUndefined();
    }
  });
});
