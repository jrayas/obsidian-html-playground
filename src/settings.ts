import { App, Notice, Platform, PluginSettingTab, type Setting, type SettingDefinitionItem, type SettingGroupItem } from "obsidian";
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

/** Allowed range of each number setting. */
const NUMBER_LIMITS = {
  snapshotsPerFile: { min: 1, max: 200 },
  snapshotMaxMB: { min: 5, max: 1000 },
  snapshotMaxAgeDays: { min: 1, max: 365 },
  logMaxEntries: { min: 100, max: 100000 },
} as const;
type NumberKey = keyof typeof NUMBER_LIMITS;
const isNumberKey = (key: string): key is NumberKey => Object.prototype.hasOwnProperty.call(NUMBER_LIMITS, key);

/** A message for the settings screen when a whole number is out of range, or nothing when it is fine. */
const rangeError = (min: number, max: number) => (value: number): string | undefined =>
  Number.isInteger(value) && value >= min && value <= max ? undefined : `Use a whole number from ${min} to ${max}.`;

/**
 * The settings screen, described declaratively (Obsidian 1.13 and later), so it takes part in Obsidian's settings
 * search. Plain controls are rows with a `key`; the lists and buttons are `render` rows that draw a normal Setting.
 */
export class PlaygroundSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: HtmlPlaygroundPlugin) {
    super(app, plugin);
  }

  getControlValue(key: string): unknown {
    const s = this.plugin.settings;
    if (key === "allowedDomains") return s.allowedDomains.join("\n");
    return (s as unknown as Record<string, unknown>)[key];
  }

  async setControlValue(key: string, value: unknown): Promise<void> {
    const s = this.plugin.settings;
    if (key === "appsFolder") s.appsFolder = String(value).trim().replace(/^\/+|\/+$/g, "") || "Apps";
    else if (key === "strictPaths") s.strictPaths = value === true;
    else if (key === "allowedDomains") s.allowedDomains = lines(String(value).toLowerCase()).filter((d) => HOSTNAME.test(d));
    else if (key === "assetMode" && (value === "auto" || value === "blob" || value === "inline")) s.assetMode = value;
    else if (isNumberKey(key)) {
      const limit = NUMBER_LIMITS[key];
      const n = Math.floor(Number(value));
      if (!Number.isFinite(n) || n < limit.min || n > limit.max) return; // ignore invalid input
      s[key] = n;
    } else return; // an unknown key is never stored
    await this.plugin.saveSettings();
  }

  getSettingDefinitions(): SettingDefinitionItem[] {
    const number = (key: NumberKey, name: string, desc: string): SettingGroupItem => {
      const { min, max } = NUMBER_LIMITS[key];
      return { name, desc, control: { type: "number", key, min, max, step: 1, validate: rangeError(min, max) } };
    };
    return [
      {
        name: "Apps folder",
        desc: "Folder searched for apps (each app has a manifest.json). Vault-root-relative, e.g. Apps.",
        control: { type: "text", key: "appsFolder", placeholder: "Apps" },
      },
      {
        name: "Strict paths",
        desc: 'Turn off the "./" fallback. When off (default), an app\'s own files may be written as ./style.css and resolve from the app folder. Vault notes never use this fallback.',
        control: { type: "toggle", key: "strictPaths" },
      },
      this.exclusionsGroup(),
      {
        name: "Allowed network domains",
        desc: "One hostname per line (no scheme, no wildcards). An app may only reach a domain listed here AND in its own manifest allowedDomains. Empty by default: apps have no network access. Allowed domains open data connections, images, fonts and media, never remote scripts.",
        control: { type: "textarea", key: "allowedDomains", rows: 3 },
      },
      {
        name: "Asset mode",
        desc: "How images and media reach the sandbox. Auto uses inline data for mobile and blob URLs on desktop. Fonts are always inlined.",
        control: { type: "dropdown", key: "assetMode", options: { auto: "Auto", blob: "Blob URLs", inline: "Inline data" } },
      },
      {
        type: "group",
        heading: "Snapshots and log",
        items: [
          { name: "How much is kept", desc: "Before an app edits a note, a copy is kept on this device only (not synced). These limits control how much is kept." },
          number("snapshotsPerFile", "Snapshots per file", "Newest copies kept for each file (1 to 200)."),
          number("snapshotMaxMB", "Snapshot storage cap (MB)", "Oldest copies are dropped when the total passes this (5 to 1000)."),
          number("snapshotMaxAgeDays", "Snapshot age limit (days)", "Copies older than this are dropped (1 to 365)."),
          number("logMaxEntries", "Write log entries", "How many write operations the log remembers (100 to 100000)."),
          {
            name: "Snapshots and bridge log",
            desc: "Browse and restore the copies taken before apps changed notes, or see what apps have written.",
            render: (setting) => {
              setting
                .addButton((b) => b.setButtonText("View snapshots").onClick(() => new SnapshotsModal(this.app, this.plugin).open()))
                .addButton((b) => b.setButtonText("Open bridge log").onClick(() => void this.plugin.openLog()));
            },
          },
        ],
      },
      this.trustedGroup(),
      { name: "Reloading", desc: "Open apps need reloading to pick up changed settings." },
    ];
  }

  /** Re-draws the screen after a list changed. */
  private refresh(): void {
    this.update();
  }

  private trustedGroup(): SettingDefinitionItem {
    const approved = this.plugin.trust.store.list();
    return {
      type: "group",
      heading: "Trusted apps",
      items: [
        { name: "About approvals", desc: "Apps you approved to run as trusted on this device. The approval is not synced and is asked for again if an app's permissions or scopes change." },
        ...(approved.length === 0
          ? [{ name: "None." }]
          : approved.map(([appRoot, record]) => ({
              name: appRoot,
              desc: `Approved ${new Date(record.time).toLocaleString()}`,
              render: (setting: Setting) => {
                setting.addButton((b) =>
                  b.setButtonText("Revoke").onClick(() => {
                    this.plugin.trust.revoke(appRoot);
                    this.refresh();
                  }),
                );
              },
            }))),
      ],
    };
  }

  /**
   * The "Excluded paths" section: the built-in defaults (locked), the user's own list with a remove button on
   * each row, "Add folder" and "Add file" pickers, and a box for patterns such as *.secret.md.
   */
  private exclusionsGroup(): SettingDefinitionItem {
    // The definitions are built once and kept by Obsidian, so the handlers always read the CURRENT settings.
    const live = () => this.plugin.settings;
    const s = live();
    const add = async (input: string) => {
      const now = live();
      const result = addPattern(now.exclusions, input, [now.appsFolder]);
      if (!result.ok) {
        new Notice(result.reason);
        return false;
      }
      now.exclusions = result.list;
      await this.plugin.saveSettings();
      this.refresh();
      return true;
    };
    const taken = (path: string, make: (p: string) => string) => live().exclusions.some((e) => e.trim().toLowerCase() === make(path).toLowerCase());
    let typed = "";

    // Always on, shown so it is clear what is protected by default. The first row is this vault's real config folder.
    const builtIn = [`${this.app.vault.configDir} (this vault's configuration folder)`, ...BUILT_IN_EXCLUSIONS];
    const own = s.exclusions.map((raw) => {
      const info = describePattern(raw);
      return {
        name: info.label,
        desc: info.description,
        render: (setting: Setting) => {
          setting.addExtraButton((b) =>
            b
              .setIcon("trash")
              .setTooltip(`Stop excluding ${info.label}`)
              .onClick(async () => {
                const now = live();
                now.exclusions = removePattern(now.exclusions, raw);
                await this.plugin.saveSettings();
                this.refresh();
              }),
          );
        },
      };
    });

    return {
      type: "group",
      heading: "Excluded paths",
      items: [
        { name: "Hidden from apps", desc: "Apps can never see, read, change or even find out about anything listed here: it looks like it does not exist. This only hides things from apps; it does not hide them in Obsidian." },
        ...builtIn.map((name) => ({
          name,
          desc: "Built in. Always hidden from apps and cannot be removed.",
          render: (setting: Setting) => {
            setting.settingEl.addClass("hp-locked");
            setting.addExtraButton((b) => b.setIcon("lock").setTooltip("Always on").setDisabled(true));
          },
        })),
        ...own,
        ...(own.length === 0 ? [{ name: "Nothing of your own yet." }] : []),
        {
          name: "Add to the list",
          desc: "Choose from your vault. The path is stored from the vault root, so it only matches that exact place.",
          render: (setting: Setting) => {
            setting
              .addButton((b) =>
                b.setButtonText("Add folder").onClick(() => new PathPickModal(this.app, "folder", (p) => taken(p, folderPattern), (p) => void add(folderPattern(p))).open()),
              )
              .addButton((b) =>
                b.setButtonText("Add file").onClick(() => new PathPickModal(this.app, "file", (p) => taken(p, filePattern), (p) => void add(filePattern(p))).open()),
              );
          },
        },
        {
          name: "Add a pattern",
          desc: 'For a name at any depth or a wildcard, for example "Private/" or "*.secret.md". "*" matches within a name, "**" across folders, "?" one character.',
          render: (setting: Setting) => {
            setting
              .addText((t) => {
                t.setPlaceholder("*.secret.md").onChange((v) => (typed = v));
                t.inputEl.addEventListener("keydown", (e) => {
                  if (e.key === "Enter") void add(typed);
                });
              })
              .addButton((b) => b.setButtonText("Add").onClick(() => void add(typed)));
          },
        },
      ],
    };
  }
}
