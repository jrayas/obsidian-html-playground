import { App, Notice, Platform, PluginSettingTab, Setting } from "obsidian";
import { BUILT_IN_EXCLUSIONS } from "./paths/exclusions";
import { addPattern, describePattern, filePattern, folderPattern, removePattern } from "./paths/patterns";
import { PathPickModal } from "./views/pathSuggest";
import { HOSTNAME } from "./apps/manifest";
import { SnapshotsModal } from "./views/snapshots";
import type HtmlPlaygroundPlugin from "./main";

export type AssetModeSetting = "auto" | "blob" | "inline";

export interface PlaygroundSettings {
  /** Where "Open app" looks for manifest.json files. */
  appsFolder: string;
  /** Extra exclusion patterns. The hidden-folder floor is always applied on top. */
  exclusions: string[];
  /** Disables the "./" fallback for an app's own files. */
  strictPaths: boolean;
  /** Global network allow-list. A domain also needs to be in the app's manifest. Empty by default. */
  allowedDomains: string[];
  assetMode: AssetModeSetting;
  /** Snapshots kept per file. */
  snapshotsPerFile: number;
  /** Total snapshot storage cap, in megabytes. */
  snapshotMaxMB: number;
  /** Snapshots older than this many days are dropped. */
  snapshotMaxAgeDays: number;
  /** Write log entries kept. */
  logMaxEntries: number;
}

export const DEFAULT_SETTINGS: PlaygroundSettings = {
  appsFolder: "Apps",
  exclusions: [],
  strictPaths: false,
  allowedDomains: [],
  assetMode: "auto",
  snapshotsPerFile: 20,
  snapshotMaxMB: 50,
  snapshotMaxAgeDays: 30,
  logMaxEntries: 5000,
};

/** Auto means inline data: URIs on mobile (webview blob quirks) and blob URLs on desktop. */
export function effectiveAssetMode(setting: AssetModeSetting): "blob" | "inline" {
  if (setting === "auto") return Platform.isMobile ? "inline" : "blob";
  return setting;
}

const lines = (text: string): string[] =>
  text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "");

export class PlaygroundSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: HtmlPlaygroundPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const s = this.plugin.settings;

    new Setting(containerEl)
      .setName("Apps folder")
      .setDesc("Folder searched for apps (each app has a manifest.json). Vault-root-relative, e.g. Apps.")
      .addText((t) =>
        t.setValue(s.appsFolder).onChange(async (v) => {
          s.appsFolder = v.trim().replace(/^\/+|\/+$/g, "") || "Apps";
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Strict paths")
      .setDesc(
        'Turn off the "./" fallback. When off (default), an app\'s own files may be written as ./style.css and resolve from the app folder. Vault notes never use this fallback.',
      )
      .addToggle((t) =>
        t.setValue(s.strictPaths).onChange(async (v) => {
          s.strictPaths = v;
          await this.plugin.saveSettings();
        }),
      );

    this.renderExclusions(containerEl);

    new Setting(containerEl)
      .setName("Allowed network domains")
      .setDesc(
        "One hostname per line (no scheme, no wildcards). An app may only reach a domain listed here AND in its own manifest allowedDomains. Empty by default: apps have no network access. Allowed domains open data connections, images, fonts and media, never remote scripts.",
      )
      .addTextArea((t) => {
        t.setValue(s.allowedDomains.join("\n")).onChange(async (v) => {
          s.allowedDomains = lines(v.toLowerCase()).filter((d) => HOSTNAME.test(d));
          await this.plugin.saveSettings();
        });
        t.inputEl.rows = 3;
      });

    new Setting(containerEl)
      .setName("Asset mode")
      .setDesc(
        "How images and media reach the sandbox. Auto uses inline data for mobile and blob URLs on desktop. Fonts are always inlined.",
      )
      .addDropdown((d) =>
        d
          .addOptions({ auto: "Auto", blob: "Blob URLs", inline: "Inline data" })
          .setValue(s.assetMode)
          .onChange(async (v) => {
            s.assetMode = v as AssetModeSetting;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl).setName("Snapshots and log").setHeading();
    containerEl.createEl("p", {
      text: "Before an app edits a note, a copy is kept on this device only (not synced). These limits control how much is kept.",
      cls: "setting-item-description",
    });
    const number = (name: string, desc: string, get: () => number, set: (n: number) => void, min: number, max: number) =>
      new Setting(containerEl)
        .setName(name)
        .setDesc(desc)
        .addText((t) =>
          t.setValue(String(get())).onChange(async (v) => {
            const n = Math.floor(Number(v));
            if (!Number.isFinite(n) || n < min || n > max) return; // ignore invalid input
            set(n);
            await this.plugin.saveSettings();
          }),
        );
    number("Snapshots per file", "Newest copies kept for each file (1 to 200).", () => s.snapshotsPerFile, (n) => (s.snapshotsPerFile = n), 1, 200);
    number("Snapshot storage cap (MB)", "Oldest copies are dropped when the total passes this (5 to 1000).", () => s.snapshotMaxMB, (n) => (s.snapshotMaxMB = n), 5, 1000);
    number("Snapshot age limit (days)", "Copies older than this are dropped (1 to 365).", () => s.snapshotMaxAgeDays, (n) => (s.snapshotMaxAgeDays = n), 1, 365);
    number("Write log entries", "How many write operations the log remembers (100 to 100000).", () => s.logMaxEntries, (n) => (s.logMaxEntries = n), 100, 100000);

    new Setting(containerEl)
      .setName("Snapshots and bridge log")
      .setDesc("Browse and restore the copies taken before apps changed notes, or see what apps have written.")
      .addButton((b) => b.setButtonText("View snapshots").onClick(() => new SnapshotsModal(this.app, this.plugin).open()))
      .addButton((b) => b.setButtonText("Open bridge log").onClick(() => void this.plugin.openLog()));

    new Setting(containerEl).setName("Trusted apps").setHeading();
    containerEl.createEl("p", {
      text: "Apps you approved to run as trusted on this device. The approval is not synced and is asked for again if an app's permissions or scopes change.",
      cls: "setting-item-description",
    });
    const approved = this.plugin.trust.store.list();
    if (approved.length === 0) containerEl.createEl("p", { text: "None." });
    for (const [appRoot, record] of approved) {
      new Setting(containerEl)
        .setName(appRoot)
        .setDesc(`Approved ${new Date(record.time).toLocaleString()}`)
        .addButton((b) =>
          b.setButtonText("Revoke").onClick(() => {
            this.plugin.trust.revoke(appRoot);
            this.display();
          }),
        );
    }

    containerEl.createEl("p", {
      text: "Open apps need reloading to pick up changed settings.",
      cls: "setting-item-description",
    });
  }

  /**
   * The "Excluded paths" section: the built-in defaults (locked), the user's own list with a remove button on
   * each row, "Add folder" and "Add file" pickers, and a box for patterns such as *.secret.md.
   */
  private renderExclusions(containerEl: HTMLElement): void {
    const s = this.plugin.settings;
    new Setting(containerEl).setName("Excluded paths").setHeading();
    containerEl.createEl("p", {
      text: "Apps can never see, read, change or even find out about anything listed here: it looks like it does not exist. This only hides things from apps; it does not hide them in Obsidian.",
      cls: "setting-item-description",
    });

    // Always on, shown so it is clear what is protected by default.
    for (const name of BUILT_IN_EXCLUSIONS) {
      const row = new Setting(containerEl).setName(name).setDesc("Built in. Always hidden from apps and cannot be removed.");
      row.settingEl.addClass("hp-locked");
      row.addExtraButton((b) => b.setIcon("lock").setTooltip("Always on").setDisabled(true));
    }

    // Your own list.
    for (const raw of s.exclusions) {
      const info = describePattern(raw);
      new Setting(containerEl)
        .setName(info.label)
        .setDesc(info.description)
        .addExtraButton((b) =>
          b
            .setIcon("trash")
            .setTooltip(`Stop excluding ${info.label}`)
            .onClick(async () => {
              s.exclusions = removePattern(s.exclusions, raw);
              await this.plugin.saveSettings();
              this.display();
            }),
        );
    }
    if (s.exclusions.length === 0) containerEl.createEl("p", { text: "Nothing of your own yet.", cls: "setting-item-description" });

    const add = async (input: string) => {
      const result = addPattern(s.exclusions, input, [s.appsFolder]);
      if (!result.ok) {
        new Notice(result.reason);
        return false;
      }
      s.exclusions = result.list;
      await this.plugin.saveSettings();
      this.display();
      return true;
    };
    const taken = (path: string, make: (p: string) => string) => s.exclusions.some((e) => e.trim().toLowerCase() === make(path).toLowerCase());

    new Setting(containerEl)
      .setName("Add to the list")
      .setDesc("Choose from your vault. The path is stored from the vault root, so it only matches that exact place.")
      .addButton((b) =>
        b
          .setButtonText("Add folder")
          .onClick(() => new PathPickModal(this.app, "folder", (p) => taken(p, folderPattern), (p) => void add(folderPattern(p))).open()),
      )
      .addButton((b) =>
        b
          .setButtonText("Add file")
          .onClick(() => new PathPickModal(this.app, "file", (p) => taken(p, filePattern), (p) => void add(filePattern(p))).open()),
      );

    let typed = "";
    new Setting(containerEl)
      .setName("Add a pattern")
      .setDesc('For a name at any depth or a wildcard, for example "Private/" or "*.secret.md". "*" matches within a name, "**" across folders, "?" one character.')
      .addText((t) => {
        t.setPlaceholder("*.secret.md").onChange((v) => (typed = v));
        t.inputEl.addEventListener("keydown", (e) => {
          if (e.key === "Enter") void add(typed);
        });
      })
      .addButton((b) => b.setButtonText("Add").onClick(() => void add(typed)));
  }
}
