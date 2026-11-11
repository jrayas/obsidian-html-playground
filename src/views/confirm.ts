/**
 * The confirmation dialog for risky app operations (bulk moves, folder deletes).
 * A host dialog: the app cannot see, click or dismiss it. Deny is the default; no answer in a minute is a deny.
 * App-supplied text (paths) is shown with textContent only.
 */
import { Modal, type App } from "obsidian";
import type { ConfirmRequest } from "../bridge/services";

const TIMEOUT_MS = 60_000;
const MAX_LISTED = 10;

class ConfirmModal extends Modal {
  private decided = false;
  private timer: number | null = null;

  constructor(
    app: App,
    private readonly request: ConfirmRequest,
    private readonly settle: (answer: boolean) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.timer = window.setTimeout(() => this.close(), TIMEOUT_MS); // no answer is a deny
    const { contentEl } = this;
    contentEl.empty();
    this.setTitle(this.request.title);
    contentEl.createEl("p", { text: `The app "${this.request.app}" wants to:` });
    for (const line of this.request.details) contentEl.createEl("p", { text: line, cls: "setting-item-description" });

    const list = contentEl.createEl("ul");
    for (const path of this.request.paths.slice(0, MAX_LISTED)) list.createEl("li", { text: path });
    if (this.request.paths.length > MAX_LISTED) {
      list.createEl("li", { text: `…and ${this.request.paths.length - MAX_LISTED} more` });
    }

    const buttons = contentEl.createDiv({ cls: "modal-button-container" });
    const deny = buttons.createEl("button", { text: "Deny", attr: { "aria-label": "Deny" } });
    const allow = buttons.createEl("button", { text: "Allow", cls: "mod-warning", attr: { "aria-label": "Allow" } });
    deny.addEventListener("click", () => this.decide(false));
    allow.addEventListener("click", () => this.decide(true));
    deny.focus();
  }

  private decide(answer: boolean): void {
    if (this.decided) return;
    this.decided = true;
    this.settle(answer);
    this.close();
  }

  onClose(): void {
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.contentEl.empty();
    if (!this.decided) {
      this.decided = true;
      this.settle(false); // Escape, click outside, or timeout
    }
  }
}

/** One dialog at a time. Later requests queue behind earlier ones. */
export function createConfirmer(app: App): (request: ConfirmRequest) => Promise<boolean> {
  let chain: Promise<unknown> = Promise.resolve();
  const ask = (request: ConfirmRequest) =>
    new Promise<boolean>((resolve) => {
      new ConfirmModal(app, request, resolve).open();
    });
  return (request) => {
    const run = chain.then(() => ask(request));
    chain = run.catch(() => undefined);
    return run;
  };
}
