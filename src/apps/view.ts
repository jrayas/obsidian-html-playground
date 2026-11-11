import { ItemView, type ViewStateResult, type WorkspaceLeaf } from "obsidian";
import { AppRunner } from "./runner";
import type HtmlPlaygroundPlugin from "../main";

export const VIEW_TYPE_APP = "html-playground-app";

interface AppViewState extends Record<string, unknown> {
  manifestPath?: string;
}

/** An app in its own tab. State is the manifest path, so Obsidian restores it on restart. */
export class AppView extends ItemView {
  private runner: AppRunner | null = null;
  private manifestPath: string | null = null;

  constructor(leaf: WorkspaceLeaf, private plugin: HtmlPlaygroundPlugin) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_APP;
  }

  getDisplayText(): string {
    return this.runner?.manifest?.name ?? "HTML app";
  }

  getIcon(): string {
    return "layout-dashboard";
  }

  getState(): AppViewState {
    return { manifestPath: this.manifestPath ?? undefined };
  }

  async setState(state: AppViewState, result: ViewStateResult): Promise<void> {
    await super.setState(state, result);
    if (typeof state?.manifestPath !== "string") return;
    this.manifestPath = state.manifestPath;
    this.ensureRunner();
    await this.runner?.load(state.manifestPath);
    (this.leaf as unknown as { updateHeader?: () => void }).updateHeader?.();
  }

  async onOpen(): Promise<void> {
    this.contentEl.empty();
    this.contentEl.addClass("hp-view");
    this.contentEl.style.padding = "0";
    this.ensureRunner();
  }

  async onClose(): Promise<void> {
    this.runner?.dispose();
    this.runner = null;
  }

  reload(): Promise<void> {
    return this.runner?.reload() ?? Promise.resolve();
  }

  private ensureRunner(): void {
    if (!this.runner) this.runner = new AppRunner(this.plugin, this.contentEl);
  }
}
