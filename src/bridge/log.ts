/**
 * AuditLog: records every bridge WRITE operation (app, operation, paths, time, result), plus denied
 * write attempts. Never records file content.
 *
 * For real operations the entry is written BEFORE the work (begin) and completed after (finish), so if
 * the log cannot be written the write is refused, and an interrupted write still leaves a trace (ok: null).
 */
import type { LogEntry, LogStore } from "./store";

const MAX_PATH_LENGTH = 200;
const MAX_PATHS = 50;

/** App-supplied text goes into the log, so make it printable and bounded. */
export function cleanLogText(value: string): string {
  // eslint-disable-next-line no-control-regex -- control characters are the point: names containing them are refused
  return value.replace(/[\u0000-\u001f\u007f]/g, "?").slice(0, MAX_PATH_LENGTH);
}

export class AuditLog {
  private sinceTrim = 0;

  constructor(
    readonly store: LogStore,
    private readonly maxEntries: () => number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Start an entry. Throws if the log cannot be written, which makes the caller refuse the write. */
  begin(app: string, op: string): Promise<number> {
    return this.store.add({ time: this.now(), app, op, paths: [], ok: null });
  }

  async finish(seq: number, result: { paths: readonly string[]; ok: boolean; code?: string }): Promise<void> {
    await this.store.update(seq, {
      paths: result.paths.slice(0, MAX_PATHS).map(cleanLogText),
      ok: result.ok,
      code: result.code,
    });
    if (++this.sinceTrim >= 50) {
      this.sinceTrim = 0;
      await this.store.trimTo(this.maxEntries());
    }
  }

  /** A complete entry in one go, for attempts that never reached the work (denied). Best effort. */
  async record(entry: Omit<LogEntry, "time" | "seq">): Promise<void> {
    await this.store.add({ ...entry, time: this.now(), paths: entry.paths.slice(0, MAX_PATHS).map(cleanLogText) });
  }

  recent(limit: number): Promise<LogEntry[]> {
    return this.store.recent(limit);
  }
}
