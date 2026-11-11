/** The Bridge log screen: every write an app made, and every write it tried and was refused. Paths only, never content. */
import { ItemView, Modal, type App, type WorkspaceLeaf } from "obsidian";
import type { LogEntry } from "../bridge/store";
import type HtmlPlaygroundPlugin from "../main";

export const VIEW_TYPE_LOG = "html-playground-log";
const SHOWN = 500;

class ClearLogModal extends Modal {
  constructor(
    app: App,
    private readonly onConfirm: () => void,
  ) {
    super(app);
  }
  onOpen(): void {
    this.setTitle("Clear the bridge log?");
    this.contentEl.createEl("p", { text: "This removes the record of what apps changed. It does not undo any change." });
    const row = this.contentEl.createDiv({ cls: "modal-button-container" });
    const cancel = row.createEl("button", { text: "Cancel" });
    const clear = row.createEl("button", { text: "Clear log", cls: "mod-warning" });
    cancel.addEventListener("click", () => this.close());
    clear.addEventListener("click", () => {
      this.onConfirm();
      this.close();
    });
    cancel.focus();
  }
  onClose(): void {
    this.contentEl.empty();
  }
}

export class LogView extends ItemView {
  private onlyProblems = false;
  private bodyEl: HTMLElement | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly plugin: HtmlPlaygroundPlugin,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_LOG;
  }
  getDisplayText(): string {
    return "Bridge log";
  }
  getIcon(): string {
    return "scroll-text";
  }

  async onOpen(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("hp-log");
    const bar = contentEl.createDiv({ cls: "hp-bar" });
    const filter = bar.createEl("select", { attr: { "aria-label": "Filter the log" } });
    filter.createEl("option", { value: "all", text: "All writes" });
    filter.createEl("option", { value: "problems", text: "Refused or failed only" });
    filter.addEventListener("change", () => {
      this.onlyProblems = filter.value === "problems";
      void this.refresh();
    });
    bar.createEl("button", { text: "Refresh" }).addEventListener("click", () => void this.refresh());
    bar.createEl("button", { text: "Clear log" }).addEventListener("click", () =>
      new ClearLogModal(this.app, () => void this.plugin.stores.log.clear().then(() => this.refresh())).open(),
    );
    this.bodyEl = contentEl.createDiv({ cls: "hp-log-body" });
    await this.refresh();
  }

  async onClose(): Promise<void> {
    this.contentEl.empty();
  }

  async refresh(): Promise<void> {
    const body = this.bodyEl;
    if (!body) return;
    let entries: LogEntry[];
    try {
      entries = await this.plugin.audit.recent(SHOWN);
    } catch {
      body.empty();
      body.createEl("p", { text: "The log is unavailable on this device.", cls: "hp-error" });
      return;
    }
    if (this.onlyProblems) entries = entries.filter((e) => e.ok !== true);
    body.empty();
    if (entries.length === 0) {
      body.createEl("p", { text: "Nothing logged yet." });
      return;
    }
    const table = body.createEl("table", { cls: "hp-log-table" });
    const head = table.createEl("thead").createEl("tr");
    for (const name of ["When", "App", "Operation", "Result", "Paths"]) head.createEl("th", { text: name });
    const rows = table.createEl("tbody");
    for (const e of entries) {
      const tr = rows.createEl("tr");
      tr.createEl("td", { text: new Date(e.time).toLocaleString() });
      tr.createEl("td", { text: e.app });
      tr.createEl("td", { text: e.op });
      tr.createEl("td", { text: e.ok === true ? "ok" : e.ok === false ? `refused (${e.code ?? "?"})` : "interrupted", cls: e.ok === true ? "" : "hp-bad" });
      tr.createEl("td", { text: e.paths.join(", ") });
    }
  }
}
