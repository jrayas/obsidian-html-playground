/**
 * Restore a snapshot (a USER action, from the Snapshots screen, never an app request).
 * It still goes through the resolver, so a path that is now excluded cannot be restored.
 * The current text is snapshotted first, so a restore can itself be undone.
 */
import { BridgeError } from "./errors";
import type { VaultGateway } from "./gateway";
import { resolveHostPath } from "./paths";
import type { AuditLog } from "./log";
import type { SnapshotService } from "./snapshots";

export interface RestoreDeps {
  gateway: VaultGateway;
  snapshots: SnapshotService;
  audit: AuditLog;
  exclusions: readonly string[];
  maxReadBytes: number;
}

export async function restoreSnapshot(id: string, deps: RestoreDeps): Promise<{ path: string; recreated: boolean }> {
  const meta = (await deps.snapshots.list()).find((m) => m.id === id);
  const content = meta ? await deps.snapshots.content(id) : null;
  if (!meta || content === null) throw new BridgeError("NOT_FOUND", "Snapshot not found.");

  const path = resolveHostPath(meta.path, deps.exclusions);
  const seq = await deps.audit.begin("user", "snapshot.restore");
  let ok = false;
  try {
    const exists = deps.gateway.kind(path) === "file";
    if (exists) {
      const current = await deps.gateway.readText(path, deps.maxReadBytes);
      await deps.snapshots.take({ path, content: current.content, app: "user", op: "snapshot.restore" });
      await deps.gateway.modifyText(path, content);
    } else {
      await deps.gateway.createText(path, content);
    }
    ok = true;
    return { path, recreated: !exists };
  } finally {
    await deps.audit.finish(seq, { paths: [meta.path], ok, code: ok ? undefined : "INTERNAL" });
  }
}
