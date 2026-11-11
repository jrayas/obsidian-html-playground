/**
 * Storage interfaces for snapshots and the write log, plus in-memory implementations (used by tests).
 * The real, device-local implementation is in idb.ts (IndexedDB). See docs/decisions/0003.
 */

export interface SnapshotMeta {
  id: string;
  /** Vault path the snapshot was taken of. */
  path: string;
  time: number;
  /** App folder, or "user" for host-initiated actions such as a restore. */
  app: string;
  op: string;
  size: number;
}

export interface SnapshotStore {
  put(meta: SnapshotMeta, content: string): Promise<void>;
  metas(): Promise<SnapshotMeta[]>;
  content(id: string): Promise<string | null>;
  remove(ids: string[]): Promise<void>;
}

export interface LogEntry {
  seq?: number;
  time: number;
  app: string;
  op: string;
  /** Paths the app asked for or touched. Never file content. */
  paths: string[];
  /** null while the operation is in progress (or if it was interrupted). */
  ok: boolean | null;
  code?: string;
}

export interface LogStore {
  add(entry: LogEntry): Promise<number>;
  update(seq: number, patch: Partial<LogEntry>): Promise<void>;
  /** Newest first. */
  recent(limit: number): Promise<LogEntry[]>;
  count(): Promise<number>;
  /** Delete the oldest entries until at most `max` remain. */
  trimTo(max: number): Promise<void>;
  clear(): Promise<void>;
}

export class MemorySnapshotStore implements SnapshotStore {
  private readonly meta = new Map<string, SnapshotMeta>();
  private readonly data = new Map<string, string>();
  async put(meta: SnapshotMeta, content: string): Promise<void> {
    this.meta.set(meta.id, meta);
    this.data.set(meta.id, content);
  }
  async metas(): Promise<SnapshotMeta[]> {
    return [...this.meta.values()];
  }
  async content(id: string): Promise<string | null> {
    return this.data.get(id) ?? null;
  }
  async remove(ids: string[]): Promise<void> {
    for (const id of ids) {
      this.meta.delete(id);
      this.data.delete(id);
    }
  }
}

export class MemoryLogStore implements LogStore {
  private entries: LogEntry[] = [];
  private seq = 0;
  async add(entry: LogEntry): Promise<number> {
    const seq = ++this.seq;
    this.entries.push({ ...entry, seq });
    return seq;
  }
  async update(seq: number, patch: Partial<LogEntry>): Promise<void> {
    const i = this.entries.findIndex((e) => e.seq === seq);
    if (i >= 0) this.entries[i] = { ...(this.entries[i] as LogEntry), ...patch };
  }
  async recent(limit: number): Promise<LogEntry[]> {
    return this.entries.slice(-limit).reverse();
  }
  async count(): Promise<number> {
    return this.entries.length;
  }
  async trimTo(max: number): Promise<void> {
    if (this.entries.length > max) this.entries = this.entries.slice(this.entries.length - max);
  }
  async clear(): Promise<void> {
    this.entries = [];
  }
}
