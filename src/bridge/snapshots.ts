/**
 * SnapshotService: copies a note's text before an app changes it, and applies retention.
 * Fail closed: if a snapshot cannot be stored, the caller's write is refused (BridgeError).
 */
import { BridgeError } from "./errors";
import { planPrune, type RetentionPolicy } from "./retention";
import type { SnapshotMeta, SnapshotStore } from "./store";

export const utf8Length = (text: string): number => new TextEncoder().encode(text).length;

export interface SnapshotInput {
  path: string;
  content: string;
  app: string;
  op: string;
}

export class SnapshotService {
  constructor(
    readonly store: SnapshotStore,
    private readonly policy: () => RetentionPolicy,
    private readonly now: () => number = Date.now,
    private readonly newId: () => string = () => crypto.randomUUID(),
  ) {}

  /** Returns the snapshot id. Identical consecutive content for a path reuses the newest snapshot. */
  async take(input: SnapshotInput): Promise<string> {
    const policy = this.policy();
    const size = utf8Length(input.content);
    if (size > policy.maxBytes) throw new BridgeError("TOO_LARGE", "Too large to snapshot; write refused.");

    try {
      const metas = await this.store.metas();
      const newest = metas
        .filter((m) => m.path === input.path)
        .sort((a, b) => b.time - a.time)[0];
      if (newest && newest.size === size && (await this.store.content(newest.id)) === input.content) return newest.id;

      const meta: SnapshotMeta = {
        id: this.newId(),
        path: input.path,
        time: this.now(),
        app: input.app,
        op: input.op,
        size,
      };
      await this.store.put(meta, input.content);
      const doomed = planPrune([...metas, meta], policy, this.now());
      if (doomed.length > 0) await this.store.remove(doomed.filter((id) => id !== meta.id));
      return meta.id;
    } catch (error) {
      if (error instanceof BridgeError) throw error;
      console.error("HTML Playground: snapshot failed", error);
      throw new BridgeError("INTERNAL", "Snapshot failed; write refused.");
    }
  }

  /** Newest first. */
  async list(path?: string): Promise<SnapshotMeta[]> {
    const metas = await this.store.metas();
    return metas
      .filter((m) => path === undefined || m.path === path)
      .sort((a, b) => b.time - a.time || (a.id < b.id ? 1 : -1));
  }

  content(id: string): Promise<string | null> {
    return this.store.content(id);
  }

  async totalBytes(): Promise<number> {
    return (await this.store.metas()).reduce((sum, m) => sum + m.size, 0);
  }
}
