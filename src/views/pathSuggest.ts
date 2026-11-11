/** A searchable list of the vault's folders or files, used by the "Add folder" and "Add file" buttons in settings. */
import { FuzzySuggestModal, type App } from "obsidian";

export type PathKind = "folder" | "file";

const isHidden = (path: string) => path.split("/").some((segment) => segment.startsWith("."));

export class PathPickModal extends FuzzySuggestModal<string> {
  private readonly items: string[];

  constructor(
    app: App,
    kind: PathKind,
    /** Paths already in the list are left out. */
    private readonly skip: (path: string) => boolean,
    private readonly onPick: (path: string) => void,
  ) {
    super(app);
    this.setPlaceholder(kind === "folder" ? "Choose a folder to hide from apps" : "Choose a file to hide from apps");
    const all =
      kind === "folder"
        ? app.vault.getAllLoadedFiles().filter((f) => "children" in f && f.path !== "" && f.path !== "/").map((f) => f.path)
        : app.vault.getFiles().map((f) => f.path);
    // Hidden paths are always excluded already, so offering them would be noise.
    this.items = all.filter((p) => !isHidden(p) && !skip(p)).sort((a, b) => a.localeCompare(b));
  }

  getItems(): string[] {
    return this.items;
  }

  getItemText(item: string): string {
    return item;
  }

  onChooseItem(item: string): void {
    this.onPick(item);
  }
}
