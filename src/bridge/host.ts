/**
 * BridgeHost: the request pipeline for ONE app. Order (never skipped, see docs/phases/phase-2-bridge.md):
 *   1. envelope check (malformed messages are ignored)
 *   2. rate limit and in-flight cap
 *   3. known operation?  (unknown -> UNSUPPORTED)
 *   4. permission        (undeclared -> DENIED; denied WRITE attempts are logged)
 *   5. implemented?      (known but not built yet -> UNSUPPORTED)
 *   6. write operations: write the audit entry FIRST (if the log is unavailable the write is refused)
 *   7. handler: argument validation, path resolution (single resolver), exclusions, scopes, guards,
 *      snapshot, work
 *   8. finish the audit entry, respond
 * Handlers are only reachable through this method.
 */
import type { AppContext } from "./context";
import { canRead } from "./context";
import { BridgeError } from "./errors";
import { limitsFor, TokenBucket, type Limits } from "./limits";
import { cleanLogText } from "./log";
import { resolveArg, type VaultPath } from "./paths";
import { isAllowed, isKnownOp, isUiOp, isWriteOp } from "./permissions";
import { EventRouter, type EventKind, type RawEvent } from "./events";
import { errorResponse, eventMessage, okResponse, parseRequest, type BridgeEvent, type BridgeResponse } from "./protocol";
import { inScope } from "./scopes";
import type { BridgeServices, ConfirmRequest } from "./services";
import { checkWriteTarget } from "./writeguard";
import type { Args } from "./ops/args";
import { normaliseForMatch } from "../paths/exclusions";

export interface HandlerResult {
  result: unknown;
  /** Objects to transfer (not copy) to the app, such as an ArrayBuffer. */
  transfer?: Transferable[];
}

/** What a handler is given. Handlers never see raw paths, only these helpers. */
export interface CallContext {
  ctx: AppContext;
  services: BridgeServices;
  /** Shortcut for services.gateway. */
  gateway: BridgeServices["gateway"];
  limits: Limits;
  /** Resolve a path for reading: single resolver, exclusions, then read scope. Throws NOT_FOUND / INVALID. */
  readPath(input: unknown, allowRoot?: boolean): VaultPath;
  /**
   * Resolve a path for writing: everything readPath does, plus the write guards (never an app folder or
   * manifest.json, inside a write scope unless trusted). Records what the app asked for in the audit log.
   */
  writePath(input: unknown): VaultPath;
  /** Add a path to this call's audit entry (for example a folder that was created). */
  touch(path: string): void;
  /** Run work with this path locked, so writes to one file never interleave. */
  lock<T>(path: string, work: () => Promise<T>): Promise<T>;
  /** Lock several paths (always in the same order, so two moves can never deadlock). */
  lockAll<T>(paths: readonly string[], work: () => Promise<T>): Promise<T>;
  /** Ask the user to approve a risky operation. False means denied (or no answer in time). */
  confirm(request: Omit<ConfirmRequest, "app">): Promise<boolean>;
  /** Snapshot a note's current text before changing it. Throws (refusing the write) if that fails. */
  snapshot(path: string, content: string, op: string): Promise<void>;
  /** True when a real vault path may appear in results for this app. */
  visible(path: string): boolean;
  /** Live file events (see events.ts). Subscriptions die with the app. */
  events: {
    subscribe(kinds: readonly EventKind[], folder: string | null): string;
    unsubscribe(id: string): boolean;
  };
  /** Ask the user to choose a note or folder. Null on cancel, timeout or error. */
  pick(kind: "note" | "folder"): Promise<string | null>;
}

export type Handler = (args: Args, call: CallContext) => Promise<HandlerResult>;

export type Send = (message: BridgeResponse, transfer?: Transferable[]) => void;

export class BridgeHost {
  private readonly limits: Limits;
  private readonly readBucket: TokenBucket;
  private readonly writeBucket: TokenBucket;
  private readonly uiBucket: TokenBucket;
  private readonly router: EventRouter;
  private inFlight = 0;

  constructor(
    private readonly ctx: AppContext,
    private readonly services: BridgeServices,
    private readonly handlers: ReadonlyMap<string, Handler>,
    private readonly send: Send,
    now: () => number = Date.now,
    emit?: (event: BridgeEvent) => void,
  ) {
    this.limits = limitsFor(ctx.trusted);
    this.readBucket = new TokenBucket(this.limits.readRate.capacity, this.limits.readRate.perSec, now);
    this.writeBucket = new TokenBucket(this.limits.writeRate.capacity, this.limits.writeRate.perSec, now);
    this.uiBucket = new TokenBucket(this.limits.uiRate.capacity, this.limits.uiRate.perSec, now);
    this.router = new EventRouter(
      (path) => canRead(ctx, path),
      (event) => emit?.(eventMessage("file", event)),
      {
        maxSubscriptions: this.limits.maxSubscriptions,
        throttleMs: 300,
        rate: new TokenBucket(this.limits.eventRate.capacity, this.limits.eventRate.perSec, now),
      },
    );
  }

  /** A vault change from Obsidian. Delivered only to this app's subscriptions, and only if it may read the path. */
  onVaultEvent(raw: RawEvent): void {
    this.router.handle(raw);
  }

  /** Stop delivering events (the app was closed or reloaded). */
  dispose(): void {
    this.router.dispose();
  }

  async handle(data: unknown): Promise<void> {
    const request = parseRequest(data);
    if (!request) return;
    const { id, op, args } = request;
    const write = isWriteOp(op);

    const bucket = write ? this.writeBucket : this.readBucket;
    if (!bucket.take()) return this.fail(id, "DENIED", "Rate limit exceeded. Slow down and retry.");
    if (this.inFlight >= this.limits.maxInFlight) return this.fail(id, "DENIED", "Too many requests in progress.");

    if (!isKnownOp(op)) return this.fail(id, "UNSUPPORTED");
    if (!isAllowed(op, this.ctx.permissions)) {
      if (write) this.logDeniedAttempt(op, args);
      return this.fail(id, "DENIED");
    }
    const handler = this.handlers.get(op);
    if (!handler) return this.fail(id, "UNSUPPORTED");
    if (isUiOp(op) && !this.uiBucket.take()) return this.fail(id, "DENIED", "Too many requests to open or choose. Wait a moment.");

    this.inFlight++;
    const touched: string[] = [];
    let auditSeq: number | null = null;
    let outcome: { ok: boolean; code?: string } = { ok: false, code: "INTERNAL" };
    try {
      if (write) {
        try {
          auditSeq = await this.services.audit.begin(this.ctx.appRoot, op);
        } catch (error) {
          console.error("HTML Playground: audit log unavailable", error);
          return this.fail(id, "INTERNAL", "Write refused: the audit log is unavailable.");
        }
      }
      const { result, transfer } = await handler(args, this.callContext(touched));
      outcome = { ok: true };
      this.send(okResponse(id, result), transfer);
    } catch (error) {
      if (error instanceof BridgeError) {
        outcome = { ok: false, code: error.code };
        this.fail(id, error.code, error.message);
      } else {
        console.error("HTML Playground: unexpected bridge error", error);
        this.fail(id, "INTERNAL");
      }
    } finally {
      this.inFlight--;
      if (auditSeq !== null) {
        await this.services.audit
          .finish(auditSeq, { paths: touched, ...outcome })
          .catch((error) => console.error("HTML Playground: could not finish audit entry", error));
      }
    }
  }

  private fail(id: string, code: BridgeError["code"], message?: string): void {
    this.send(errorResponse(id, code, message ?? new BridgeError(code).message));
  }

  /** A write the app attempted without permission. Best effort: nothing was written. */
  private logDeniedAttempt(op: string, args: Args): void {
    const raw = typeof args.path === "string" ? [args.path] : [];
    void this.services.audit
      .record({ app: this.ctx.appRoot, op, paths: raw, ok: false, code: "DENIED" })
      .catch((error) => console.error("HTML Playground: could not log denied attempt", error));
  }

  private callContext(touched: string[]): CallContext {
    const { ctx, services } = this;
    const touch = (path: string) => {
      if (!touched.includes(path) && touched.length < 50) touched.push(path);
    };
    const readPath = (input: unknown, allowRoot = false): VaultPath => {
      const path = resolveArg(input, ctx.pathCtx, allowRoot);
      // Out of scope looks exactly like missing.
      if (!inScope(path, ctx.readScopes, [ctx.appRoot])) throw new BridgeError("NOT_FOUND");
      return path;
    };
    return {
      ctx,
      services,
      gateway: services.gateway,
      limits: this.limits,
      readPath,
      writePath: (input) => {
        // Log what the app asked for, even if it is refused below (a security signal).
        if (typeof input === "string") touch(cleanLogText(input));
        const path = readPath(input);
        if (normaliseForMatch(path) !== normaliseForMatch(String(input))) touch(path);
        checkWriteTarget(path, ctx, {
          appsFolder: services.appsFolder(),
          insideAppFolder: services.gateway.insideAppFolder(path),
        });
        return path;
      },
      touch,
      lock: (path, work) => services.locks.run(normaliseForMatch(path), work),
      lockAll: (paths, work) => {
        const keys = [...new Set(paths.map(normaliseForMatch))].sort();
        const next = (i: number): Promise<never> | Promise<any> => (i === keys.length ? work() : services.locks.run(keys[i] as string, () => next(i + 1)));
        return next(0);
      },
      confirm: async (request) => {
        try {
          return await services.confirm({ ...request, app: ctx.appRoot });
        } catch {
          return false;
        }
      },
      snapshot: async (path, content, op) => {
        await services.snapshots.take({ path, content, app: ctx.appRoot, op });
      },
      visible: (path) => canRead(ctx, path),
      events: {
        subscribe: (kinds, folder) => this.router.subscribe(kinds, folder),
        unsubscribe: (id) => this.router.unsubscribe(id),
      },
      pick: async (kind) => {
        try {
          return await services.pick({ kind, app: ctx.appRoot, visible: (path) => canRead(ctx, path) });
        } catch {
          return null;
        }
      },
    };
  }
}
