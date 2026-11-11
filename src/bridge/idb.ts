/**
 * Device-local storage for snapshots and the write log, in IndexedDB (docs/decisions/0003).
 * Not synced, not visible in the vault, and needs no raw adapter access.
 * If IndexedDB cannot be opened, every store method rejects, so writes are refused (fail closed).
 */
import type { LogEntry, LogStore, SnapshotMeta, SnapshotStore } from "./store";

/** IndexedDB reports failures as DOMException or null; reject with a real Error either way. */
const asError = (e: unknown): Error => (e instanceof Error ? e : new Error("IndexedDB request failed."));

const wrap = <T>(request: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(asError(request.error));
  });

const finished = (tx: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(asError(tx.error));
    tx.onabort = () => reject(asError(tx.error));
  });

export function openDatabase(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore("snapMeta", { keyPath: "id" });
      db.createObjectStore("snapData");
      db.createObjectStore("log", { keyPath: "seq", autoIncrement: true });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(asError(request.error));
  });
}

export class IdbSnapshotStore implements SnapshotStore {
  constructor(private readonly db: IDBDatabase) {}

  async put(meta: SnapshotMeta, content: string): Promise<void> {
    const tx = this.db.transaction(["snapMeta", "snapData"], "readwrite");
    tx.objectStore("snapMeta").put(meta);
    tx.objectStore("snapData").put(content, meta.id);
    await finished(tx);
  }

  metas(): Promise<SnapshotMeta[]> {
    return wrap(this.db.transaction("snapMeta").objectStore("snapMeta").getAll() as IDBRequest<SnapshotMeta[]>);
  }

  async content(id: string): Promise<string | null> {
    const value = await wrap(this.db.transaction("snapData").objectStore("snapData").get(id) as IDBRequest<string | undefined>);
    return value ?? null;
  }

  async remove(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const tx = this.db.transaction(["snapMeta", "snapData"], "readwrite");
    for (const id of ids) {
      tx.objectStore("snapMeta").delete(id);
      tx.objectStore("snapData").delete(id);
    }
    await finished(tx);
  }
}

export class IdbLogStore implements LogStore {
  constructor(private readonly db: IDBDatabase) {}

  async add(entry: LogEntry): Promise<number> {
    const tx = this.db.transaction("log", "readwrite");
    const key = await wrap(tx.objectStore("log").add(entry));
    await finished(tx);
    return key as number;
  }

  async update(seq: number, patch: Partial<LogEntry>): Promise<void> {
    const tx = this.db.transaction("log", "readwrite");
    const store = tx.objectStore("log");
    const existing = (await wrap(store.get(seq))) as LogEntry | undefined;
    if (existing) store.put({ ...existing, ...patch, seq });
    await finished(tx);
  }

  recent(limit: number): Promise<LogEntry[]> {
    return new Promise((resolve, reject) => {
      const out: LogEntry[] = [];
      const request = this.db.transaction("log").objectStore("log").openCursor(null, "prev");
      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor && out.length < limit) {
          out.push(cursor.value as LogEntry);
          cursor.continue();
        } else {
          resolve(out);
        }
      };
      request.onerror = () => reject(asError(request.error));
    });
  }

  count(): Promise<number> {
    return wrap(this.db.transaction("log").objectStore("log").count());
  }

  async trimTo(max: number): Promise<void> {
    const excess = (await this.count()) - max;
    if (excess <= 0) return;
    await new Promise<void>((resolve, reject) => {
      let remaining = excess;
      const tx = this.db.transaction("log", "readwrite");
      const request = tx.objectStore("log").openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor && remaining > 0) {
          cursor.delete();
          remaining--;
          cursor.continue();
        }
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(asError(tx.error));
      tx.onabort = () => reject(asError(tx.error));
    });
  }

  async clear(): Promise<void> {
    const tx = this.db.transaction("log", "readwrite");
    tx.objectStore("log").clear();
    await finished(tx);
  }
}

/** Used when IndexedDB is unavailable: every call rejects, so every write is refused. */
export function unavailableStores(): { snapshots: SnapshotStore; log: LogStore } {
  const fail = (): never => {
    throw new Error("Device storage is unavailable.");
  };
  return {
    snapshots: { put: async () => fail(), metas: async () => fail(), content: async () => fail(), remove: async () => fail() },
    log: {
      add: async () => fail(),
      update: async () => fail(),
      recent: async () => fail(),
      count: async () => fail(),
      trimTo: async () => fail(),
      clear: async () => fail(),
    },
  };
}
