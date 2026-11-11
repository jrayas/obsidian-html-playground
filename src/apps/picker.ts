import { FuzzySuggestModal, type App } from "obsidian";
import { isExcluded } from "../paths/exclusions";
import { dirname } from "./manifest";
import { VIEW_TYPE_APP } from "./view";

/** Manifest paths under the apps folder, skipping excluded paths. */
export function findManifests(app: App, appsFolder: string, exclusions: readonly string[]): string[] {
  const prefix = appsFolder === "" ? "" : appsFolder + "/";
  return app.vault
    .getFiles()
    .filter((f) => f.name === "manifest.json" && f.path.startsWith(prefix) && !isExcluded(f.path, exclusions))
    .map((f) => f.path)
    .sort((a, b) => a.localeCompare(b));
}

export async function openApp(app: App, manifestPath: string): Promise<void> {
  const leaf = app.workspace.getLeaf("tab");
  await leaf.setViewState({ type: VIEW_TYPE_APP, active: true, state: { manifestPath } });
  void app.workspace.revealLeaf(leaf);
}

export class AppPickerModal extends FuzzySuggestModal<string> {
  constructor(app: App, private manifests: string[]) {
    super(app);
    this.setPlaceholder("Open an app…");
  }

  getItems(): string[] {
    return this.manifests;
  }

  getItemText(item: string): string {
    return dirname(item);
  }

  onChooseItem(item: string): void {
    void openApp(this.app, item);
  }
}
