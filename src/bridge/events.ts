/**
 * Live file events for apps (pure). An app subscribes with a kind list and an optional folder, and gets
 * `file` events over the bridge. Events only ever describe paths the app is allowed to read:
 *   - a rename from visible to hidden looks like a delete, hidden to visible looks like a create
 *   - modify events are throttled per path, and the total rate is capped
 */
import { BridgeError } from "./errors";
import type { TokenBucket } from "./limits";
import { underAny } from "./scopes";

export type EventKind = "created" | "modified" | "renamed" | "deleted";
export const EVENT_KINDS: readonly EventKind[] = ["created", "modified", "renamed", "deleted"];

export interface RawEvent {
  kind: EventKind;
  type: "file" | "folder";
  path: string;
  /** Renames only: where it was. */
  oldPath?: string;
}

export interface Subscription {
  id: string;
  kinds: ReadonlySet<EventKind>;
  /** null means anywhere the app can read. */
  folder: string | null;
}

export interface OutEvent {
  id: string;
  kind: EventKind;
  type: "file" | "folder";
  path: string;
  oldPath?: string;
}

type Form = Omit<OutEvent, "id">;

/** What the app is allowed to learn about this event, given what it can read. */
function visibleForms(raw: RawEvent, visible: (path: string) => boolean): Form[] {
  if (raw.kind !== "renamed") return visible(raw.path) ? [{ kind: raw.kind, type: raw.type, path: raw.path }] : [];
  const oldPath = raw.oldPath ?? "";
  const from = oldPath !== "" && visible(oldPath);
  const to = visible(raw.path);
  if (from && to) return [{ kind: "renamed", type: raw.type, path: raw.path, oldPath }];
  if (from) return [{ kind: "deleted", type: raw.type, path: oldPath }];
  if (to) return [{ kind: "created", type: raw.type, path: raw.path }];
  return [];
}

export function routeEvent(raw: RawEvent, subs: readonly Subscription[], visible: (path: string) => boolean): OutEvent[] {
  const out: OutEvent[] = [];
  for (const form of visibleForms(raw, visible)) {
    for (const sub of subs) {
      if (!sub.kinds.has(form.kind)) continue;
      if (sub.folder !== null) {
        const inside = underAny(form.path, [sub.folder]) || (form.oldPath !== undefined && underAny(form.oldPath, [sub.folder]));
        if (!inside) continue;
      }
      out.push({ id: sub.id, ...form });
    }
  }
  return out;
}

export interface RouterOptions {
  maxSubscriptions: number;
  throttleMs: number;
  /** Caps the total number of events delivered per second. Excess events are dropped. */
  rate: TokenBucket;
}

export class EventRouter {
  private readonly subs = new Map<string, Subscription>();
  private readonly pending = new Map<string, ReturnType<typeof setTimeout>>();
  private counter = 0;

  constructor(
    private readonly visible: (path: string) => boolean,
    private readonly emit: (event: OutEvent) => void,
    private readonly options: RouterOptions,
  ) {}

  subscribe(kinds: readonly EventKind[], folder: string | null): string {
    if (this.subs.size >= this.options.maxSubscriptions) throw new BridgeError("DENIED", "Too many subscriptions.");
    const id = `s${++this.counter}`;
    this.subs.set(id, { id, kinds: new Set(kinds), folder });
    return id;
  }

  unsubscribe(id: string): boolean {
    for (const [key, timer] of this.pending) {
      if (key.startsWith(id + "\0")) {
        clearTimeout(timer);
        this.pending.delete(key);
      }
    }
    return this.subs.delete(id);
  }

  size(): number {
    return this.subs.size;
  }

  handle(raw: RawEvent): void {
    if (this.subs.size === 0) return;
    // A modify notice still waiting for its throttle window would arrive AFTER the rename or delete, naming a
    // path that no longer exists. Drop it.
    if (raw.kind === "deleted") this.cancelPending(raw.path);
    if (raw.kind === "renamed" && raw.oldPath !== undefined) this.cancelPending(raw.oldPath);
    for (const out of routeEvent(raw, [...this.subs.values()], this.visible)) {
      if (out.kind === "modified") this.throttled(out);
      else this.send(out);
    }
  }

  dispose(): void {
    for (const timer of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
    this.subs.clear();
  }

  private cancelPending(path: string): void {
    for (const [key, timer] of this.pending) {
      if (key.endsWith("\0" + path)) {
        clearTimeout(timer);
        this.pending.delete(key);
      }
    }
  }

  /** A file being typed in saves every second or two; send one notice per window. */
  private throttled(out: OutEvent): void {
    const key = `${out.id}\0${out.path}`;
    if (this.pending.has(key)) return;
    this.pending.set(
      key,
      setTimeout(() => {
        this.pending.delete(key);
        this.send(out);
      }, this.options.throttleMs),
    );
  }

  private send(out: OutEvent): void {
    if (this.options.rate.take()) this.emit(out);
  }
}
