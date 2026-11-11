import { Notice, parseYaml, Plugin, stringifyYaml } from "obsidian";
import { VaultGateway } from "./bridge/gateway";
import { openDatabase, IdbLogStore, IdbSnapshotStore, unavailableStores } from "./bridge/idb";
import { KeyedMutex } from "./bridge/locks";
import { AuditLog } from "./bridge/log";
import type { LogStore, SnapshotStore } from "./bridge/store";
import type { BridgeServices } from "./bridge/services";
import { restoreSnapshot } from "./bridge/restore";
import { SnapshotService } from "./bridge/snapshots";
import type { Handler } from "./bridge/host";
import { buildHandlers } from "./bridge/registry";
import { readTheme } from "./theme/variables";
import { createConfirmer } from "./views/confirm";
import { LogView, VIEW_TYPE_LOG } from "./views/log";
import { createPicker } from "./views/pick";
import { SnapshotsModal } from "./views/snapshots";
import type { RawEvent } from "./bridge/events";
import { localStorageBackend, TrustManager, TrustStore } from "./bridge/trust";
import { registerEmbed } from "./apps/embed";
import { AppPickerModal, findManifests, openApp } from "./apps/picker";
import type { AppRunner } from "./apps/runner";
import { AppView, VIEW_TYPE_APP } from "./apps/view";
import { DEFAULT_SETTINGS, PlaygroundSettingTab, type PlaygroundSettings } from "./settings";

export default class HtmlPlaygroundPlugin extends Plugin {
  settings: PlaygroundSettings = { ...DEFAULT_SETTINGS };
  /** Every live runner (tab views and note embeds), so theme changes reach all of them. */
  readonly runners = new Set<AppRunner>();
  /** The only door to the vault for apps (see src/bridge/gateway.ts). */
  gateway!: VaultGateway;
  handlers!: ReadonlyMap<string, Handler>;
  /** Device-local stores (IndexedDB). Never synced, never visible in the vault. */
  stores!: { snapshots: SnapshotStore; log: LogStore };
  snapshots!: SnapshotService;
  audit!: AuditLog;
  services!: BridgeServices;
  /** The user's approvals of trusted apps. Device-local (localStorage), never synced. */
  trust!: TrustManager;
  private db: IDBDatabase | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.gateway = new VaultGateway(this.app);
    try {
      this.db = await openDatabase(`html-playground:${this.app.vault.getName()}`);
      this.stores = { snapshots: new IdbSnapshotStore(this.db), log: new IdbLogStore(this.db) };
    } catch (error) {
      // Fail closed: with no device storage every app write is refused.
      console.error("HTML Playground: device storage unavailable; app writes are disabled.", error);
      new Notice("HTML Playground: device storage is unavailable, so apps cannot write to your vault.");
      this.stores = unavailableStores();
    }
    this.snapshots = new SnapshotService(this.stores.snapshots, () => ({
      perFile: this.settings.snapshotsPerFile,
      maxBytes: this.settings.snapshotMaxMB * 1024 * 1024,
      maxAgeMs: this.settings.snapshotMaxAgeDays * 24 * 60 * 60 * 1000,
    }));
    this.audit = new AuditLog(this.stores.log, () => this.settings.logMaxEntries);
    this.services = {
      gateway: this.gateway,
      snapshots: this.snapshots,
      audit: this.audit,
      locks: new KeyedMutex(),
      appsFolder: () => this.settings.appsFolder,
      confirm: createConfirmer(this.app),
      pick: createPicker(this.app),
    };
    this.trust = new TrustManager(
      new TrustStore(localStorageBackend(`html-playground:trust:${this.app.vault.getName()}`)),
      (request) => this.services.confirm(request),
    );
    this.handlers = buildHandlers({ yaml: { parseYaml, stringifyYaml }, getTheme: readTheme });

    this.registerView(VIEW_TYPE_APP, (leaf) => new AppView(leaf, this));
    this.registerView(VIEW_TYPE_LOG, (leaf) => new LogView(leaf, this));
    registerEmbed(this);
    this.addSettingTab(new PlaygroundSettingTab(this.app, this));

    this.addCommand({
      id: "open-app",
      name: "Open app",
      callback: () => {
        const manifests = findManifests(this.app, this.settings.appsFolder, this.settings.exclusions);
        if (manifests.length === 0) {
          new Notice(`No apps found in "${this.settings.appsFolder}". Each app needs a manifest.json.`);
          return;
        }
        new AppPickerModal(this.app, manifests).open();
      },
    });

    this.addCommand({
      id: "reload-app",
      name: "Reload current app",
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(AppView);
        if (!view) return false;
        if (!checking) void view.reload();
        return true;
      },
    });

    this.addCommand({
      id: "open-app-from-active-note-folder",
      name: "Open app in the active note's folder",
      checkCallback: (checking) => {
        const folder = this.app.workspace.getActiveFile()?.parent?.path;
        if (!folder) return false;
        const manifest = folder === "/" ? "manifest.json" : `${folder}/manifest.json`;
        if (!this.app.vault.getFileByPath(manifest)) return false;
        if (!checking) void openApp(this.app, manifest);
        return true;
      },
    });

    this.addCommand({
      id: "show-snapshots",
      name: "Show snapshots",
      callback: () => new SnapshotsModal(this.app, this).open(),
    });

    this.addCommand({
      id: "open-bridge-log",
      name: "Open bridge log",
      callback: () => void this.openLog(),
    });

    // Live file events for apps that subscribed (each app only hears about paths it may read).
    const dispatch = (raw: RawEvent) => {
      for (const runner of this.runners) runner.onVaultEvent(raw);
    };
    const typeOf = (file: object): "file" | "folder" => ("children" in file ? "folder" : "file");
    this.registerEvent(this.app.vault.on("create", (f) => dispatch({ kind: "created", type: typeOf(f), path: f.path })));
    this.registerEvent(this.app.vault.on("modify", (f) => dispatch({ kind: "modified", type: typeOf(f), path: f.path })));
    this.registerEvent(this.app.vault.on("delete", (f) => dispatch({ kind: "deleted", type: typeOf(f), path: f.path })));
    this.registerEvent(this.app.vault.on("rename", (f, oldPath) => dispatch({ kind: "renamed", type: typeOf(f), path: f.path, oldPath })));

    // Light/dark switch or theme change: push new colours into every open app.
    this.registerEvent(this.app.workspace.on("css-change", () => this.refreshThemes()));
  }

  onunload(): void {
    for (const runner of [...this.runners]) runner.dispose();
    this.db?.close();
  }

  async openLog(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_LOG)[0];
    const leaf = existing ?? this.app.workspace.getLeaf("tab");
    if (!existing) await leaf.setViewState({ type: VIEW_TYPE_LOG, active: true });
    this.app.workspace.setActiveLeaf(leaf, { focus: true });
  }

  /** Restore a snapshot (a user action). Used by the Snapshots screen. */
  restore(id: string) {
    return restoreSnapshot(id, {
      gateway: this.gateway,
      snapshots: this.snapshots,
      audit: this.audit,
      exclusions: this.settings.exclusions,
      maxReadBytes: 5 * 1024 * 1024,
    });
  }

  private refreshThemes(): void {
    for (const runner of this.runners) runner.refreshTheme();
  }

  async loadSettings(): Promise<void> {
    const saved = (await this.loadData()) as Partial<PlaygroundSettings> | null;
    this.settings = { ...DEFAULT_SETTINGS, ...saved };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}
