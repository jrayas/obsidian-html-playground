/** The Snapshots screen: every copy the plugin kept before an app changed a note, with a Restore button. */
import { Modal, Notice, type App } from "obsidian";
import type { SnapshotMeta } from "../bridge/store";
import type HtmlPlaygroundPlugin from "../main";

const MAX_ROWS = 200;

export function formatSize(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export class SnapshotsModal extends Modal {
  private filter = "";
  private listEl: HTMLElement | null = null;

  constructor(
    app: App,
    private readonly plugin: HtmlPlaygroundPlugin,
  ) {
    super(app);
  }

  async onOpen(): Promise<void> {
    this.setTitle("Snapshots");
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("hp-snapshots");
    contentEl.createEl("p", {
      text: "Copies taken before an app edited, moved or deleted a note. Kept on this device only. Restoring first saves the current text, so a restore can be undone.",
      cls: "setting-item-description",
    });
    const search = contentEl.createEl("input", { type: "search", attr: { placeholder: "Filter by path, app or operation", "aria-label": "Filter snapshots" } });
    search.addEventListener("input", () => {
      this.filter = search.value.toLowerCase();
      void this.render();
    });
    this.listEl = contentEl.createDiv({ cls: "hp-snapshot-list" });
    await this.render();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private async render(): Promise<void> {
    const list = this.listEl;
    if (!list) return;
    let metas: SnapshotMeta[];
    try {
      metas = await this.plugin.snapshots.list();
    } catch {
      list.empty();
      list.createEl("p", { text: "Snapshot storage is unavailable on this device.", cls: "hp-error" });
      return;
    }
    const shown = metas.filter((m) => `${m.path} ${m.app} ${m.op}`.toLowerCase().includes(this.filter));
    list.empty();
    if (shown.length === 0) {
      list.createEl("p", { text: metas.length === 0 ? "No snapshots yet." : "Nothing matches that filter." });
      return;
    }
    for (const meta of shown.slice(0, MAX_ROWS)) {
      const row = list.createDiv({ cls: "hp-row" });
      const text = row.createDiv({ cls: "hp-row-text" });
      text.createDiv({ text: meta.path, cls: "hp-row-path" });
      text.createDiv({
        text: `${new Date(meta.time).toLocaleString()} · ${meta.app} · ${meta.op} · ${formatSize(meta.size)}`,
        cls: "setting-item-description",
      });
      const restore = row.createEl("button", { text: "Restore", attr: { "aria-label": `Restore ${meta.path}` } });
      restore.addEventListener("click", () => void this.restore(meta, restore));
    }
    if (shown.length > MAX_ROWS) list.createEl("p", { text: `Showing the newest ${MAX_ROWS} of ${shown.length}. Use the filter to narrow down.` });
  }

  private async restore(meta: SnapshotMeta, button: HTMLButtonElement): Promise<void> {
    button.disabled = true;
    try {
      const result = await this.plugin.restore(meta.id);
      new Notice(result.recreated ? `Recreated ${result.path}` : `Restored ${result.path}`);
    } catch (error) {
      new Notice(`Could not restore: ${error instanceof Error ? error.message : "unknown error"}`);
    }
    await this.render();
  }
}
