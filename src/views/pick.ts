/**
 * The note and folder chooser for pick.note / pick.folder. A host dialog: it lists only paths the app may
 * read (excluded, hidden and out-of-scope paths never appear), the app cannot see or drive it, and choosing
 * something grants no permission. Cancel, Escape or two minutes without a choice answers null.
 */
import { FuzzySuggestModal, type App } from "obsidian";
import type { PickRequest } from "../bridge/services";

const TIMEOUT_MS = 120_000;
const MAX_ITEMS = 5000;

class PickModal extends FuzzySuggestModal<string> {
  private done = false;
  private readonly timer: number;

  constructor(
    app: App,
    private readonly items: string[],
    placeholder: string,
    private readonly settle: (path: string | null) => void,
  ) {
    super(app);
    this.setPlaceholder(placeholder);
    this.timer = window.setTimeout(() => this.close(), TIMEOUT_MS);
  }

  getItems(): string[] {
    return this.items;
  }

  getItemText(item: string): string {
    return item;
  }

  onChooseItem(item: string): void {
    this.finish(item);
  }

  onClose(): void {
    super.onClose();
    window.clearTimeout(this.timer);
    // Obsidian closes a suggest dialog BEFORE it calls onChooseItem, so wait a tick before deciding it was cancelled.
    window.setTimeout(() => this.finish(null), 0);
  }

  private finish(path: string | null): void {
    if (this.done) return;
    this.done = true;
    this.settle(path);
  }
}

function collect(app: App, request: PickRequest): string[] {
  const paths =
    request.kind === "note"
      ? app.vault.getMarkdownFiles().map((f) => f.path)
      : app.vault
          .getAllLoadedFiles()
          .filter((f) => "children" in f && f.path !== "" && f.path !== "/")
          .map((f) => f.path);
  return paths.filter((p) => request.visible(p)).sort((a, b) => a.localeCompare(b)).slice(0, MAX_ITEMS);
}

/** One chooser at a time. */
export function createPicker(app: App): (request: PickRequest) => Promise<string | null> {
  let chain: Promise<unknown> = Promise.resolve();
  const ask = (request: PickRequest) =>
    new Promise<string | null>((resolve) => {
      new PickModal(app, collect(app, request), `Choose a ${request.kind} for "${request.app}"`, resolve).open();
    });
  return (request) => {
    const run = chain.then(() => ask(request));
    chain = run.catch(() => undefined);
    return run;
  };
}
