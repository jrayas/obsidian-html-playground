/** Snapshot retention planning (pure). Decides which snapshots to delete; deleting is the caller's job. */
import { normaliseForMatch } from "../paths/exclusions";
import type { SnapshotMeta } from "./store";

export interface RetentionPolicy {
  /** Newest snapshots kept per file. */
  perFile: number;
  /** Total size cap across all snapshots, in bytes. */
  maxBytes: number;
  /** Snapshots older than this are dropped, in milliseconds. */
  maxAgeMs: number;
}

const newestFirst = (a: SnapshotMeta, b: SnapshotMeta) => b.time - a.time || (a.id < b.id ? 1 : -1);

/** Returns the ids to delete: too old, beyond the per-file limit, then oldest-first until under the size cap. */
export function planPrune(metas: readonly SnapshotMeta[], policy: RetentionPolicy, now: number): string[] {
  const doomed = new Set<string>();

  const fresh = metas.filter((m) => {
    if (now - m.time > policy.maxAgeMs) {
      doomed.add(m.id);
      return false;
    }
    return true;
  });

  const byPath = new Map<string, SnapshotMeta[]>();
  for (const m of fresh) {
    const key = normaliseForMatch(m.path);
    byPath.set(key, [...(byPath.get(key) ?? []), m]);
  }
  for (const group of byPath.values()) {
    group.sort(newestFirst);
    for (const extra of group.slice(Math.max(policy.perFile, 1))) doomed.add(extra.id);
  }

  const kept = fresh.filter((m) => !doomed.has(m.id)).sort(newestFirst); // newest first
  let total = kept.reduce((sum, m) => sum + m.size, 0);
  for (let i = kept.length - 1; i >= 0 && total > policy.maxBytes; i--) {
    const oldest = kept[i] as SnapshotMeta;
    doomed.add(oldest.id);
    total -= oldest.size;
  }
  return [...doomed];
}
