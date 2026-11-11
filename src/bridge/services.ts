import type { VaultGateway } from "./gateway";
import type { KeyedMutex } from "./locks";
import type { AuditLog } from "./log";
import type { SnapshotService } from "./snapshots";

/** A question shown to the user (a host dialog the app cannot see or answer). */
export interface ConfirmRequest {
  app: string;
  title: string;
  details: string[];
  /** Paths to list (the dialog shows the first few). */
  paths: string[];
}

/** Ask the user to choose a note or folder (a host dialog that lists only what the app may read). */
export interface PickRequest {
  kind: "note" | "folder";
  app: string;
  visible(path: string): boolean;
}

/** Shared host services every BridgeHost uses. One instance per plugin. */
export interface BridgeServices {
  gateway: VaultGateway;
  snapshots: SnapshotService;
  audit: AuditLog;
  /** Serialises writes per path across all apps. */
  locks: KeyedMutex;
  /** The configured apps folder (settings), read at call time. */
  appsFolder(): string;
  /** Ask the user to approve a risky operation. Resolves false on deny, timeout or error. */
  confirm(request: ConfirmRequest): Promise<boolean>;
  /** Let the user pick a note or folder. Resolves null on cancel, timeout or error. */
  pick(request: PickRequest): Promise<string | null>;
}
