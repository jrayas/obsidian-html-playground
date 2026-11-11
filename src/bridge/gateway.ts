/**
 * VaultGateway: the ONLY module that touches the vault for app requests.
 *
 * Every method that takes a path takes a VaultPath (see paths.ts), so raw strings cannot reach it.
 * Results come from Obsidian's own index, so their paths are real. Visibility (exclusions and scopes)
 * is applied by the caller through the `visible` predicate.
 *
 * Reads only for now. Writes arrive in step 2b and will use app.vault / app.fileManager, never the raw adapter.
 */
import type { App, TFile, TFolder } from "obsidian";
import { BridgeError } from "./errors";
import { normaliseForMatch } from "../paths/exclusions";
import { parentOf, type VaultPath } from "./paths";
import { useSystemTrash } from "./trash";

export interface ReadResult {
  content: string;
  mtime: number;
  size: number;
}

export interface BinaryResult {
  data: ArrayBuffer;
  mtime: number;
  size: number;
}

export interface ListEntry {
  path: string;
  type: "file" | "folder";
  size?: number;
  mtime?: number;
}

export interface SearchHit {
  path: string;
  match: "name" | "content";
  snippet?: string;
}

export interface SearchBudget {
  limit: number;
  maxFiles: number;
  maxMs: number;
  maxContentBytes: number;
}

const TEXT_EXTENSIONS = new Set(["md", "markdown", "txt", "json", "yaml", "yml", "csv", "canvas"]);

const isFolder = (f: TFile | TFolder): f is TFolder => "children" in f;

export class VaultGateway {
  constructor(private readonly app: App) {}

  private file(path: VaultPath): TFile | null {
    return this.app.vault.getFileByPath(path);
  }

  private folder(path: VaultPath): TFolder | null {
    return path === "" ? this.app.vault.getRoot() : this.app.vault.getFolderByPath(path);
  }

  async readText(path: VaultPath, maxBytes: number): Promise<ReadResult> {
    const file = this.file(path);
    if (!file) throw new BridgeError("NOT_FOUND");
    if (file.stat.size > maxBytes) throw new BridgeError("TOO_LARGE");
    const content = await this.app.vault.read(file);
    return { content, mtime: file.stat.mtime, size: file.stat.size };
  }

  async readBinary(path: VaultPath, maxBytes: number): Promise<BinaryResult> {
    const file = this.file(path);
    if (!file) throw new BridgeError("NOT_FOUND");
    if (file.stat.size > maxBytes) throw new BridgeError("TOO_LARGE");
    const data = await this.app.vault.readBinary(file);
    return { data, mtime: file.stat.mtime, size: file.stat.size };
  }

  /** "file", "folder" or null. */
  kind(path: VaultPath): "file" | "folder" | null {
    if (this.file(path)) return "file";
    if (this.folder(path)) return "folder";
    return null;
  }

  list(path: VaultPath, recursive: boolean, visible: (p: string) => boolean, max: number) {
    const root = this.folder(path);
    if (!root) throw new BridgeError("NOT_FOUND");
    const entries: ListEntry[] = [];
    const queue: TFolder[] = [root];
    while (queue.length > 0) {
      const current = queue.shift() as TFolder;
      for (const child of current.children) {
        if (!visible(child.path)) continue;
        const c = child as TFile | TFolder;
        if (isFolder(c)) {
          entries.push({ path: c.path, type: "folder" });
          if (recursive) queue.push(c);
        } else {
          entries.push({ path: c.path, type: "file", size: c.stat.size, mtime: c.stat.mtime });
        }
        if (entries.length >= max) return { entries, truncated: true };
      }
    }
    return { entries, truncated: false };
  }

  /** Case-insensitive substring search over file names and the text of small text files. */
  async search(query: string, folder: VaultPath | null, visible: (p: string) => boolean, budget: SearchBudget) {
    const needle = query.toLowerCase();
    const prefix = folder === null || folder === "" ? "" : folder.toLowerCase() + "/";
    const hits: SearchHit[] = [];
    const started = Date.now();
    let scanned = 0;
    let truncated = false;

    for (const file of this.app.vault.getFiles()) {
      if (prefix !== "" && !file.path.toLowerCase().startsWith(prefix)) continue;
      if (!visible(file.path)) continue;
      if (hits.length >= budget.limit || scanned >= budget.maxFiles || Date.now() - started > budget.maxMs) {
        truncated = true;
        break;
      }
      scanned++;
      if (file.path.toLowerCase().includes(needle)) {
        hits.push({ path: file.path, match: "name" });
        continue;
      }
      if (TEXT_EXTENSIONS.has(file.extension.toLowerCase()) && file.stat.size <= budget.maxContentBytes) {
        const text = await this.app.vault.cachedRead(file);
        const at = text.toLowerCase().indexOf(needle);
        if (at >= 0) {
          const snippet = text.slice(Math.max(0, at - 60), at + needle.length + 60).replace(/\s+/g, " ").trim();
          hits.push({ path: file.path, match: "content", snippet });
        }
      }
    }
    return { hits, truncated };
  }

  // ---- writes (always through app.vault / app.fileManager, never the raw adapter) ----------------

  /** True if the path, or any folder above it (below the vault root), directly contains a manifest.json. */
  insideAppFolder(path: VaultPath): boolean {
    const parts = path.split("/");
    let current = "";
    for (const part of parts) {
      current = current === "" ? part : `${current}/${part}`;
      if (this.app.vault.getFileByPath(`${current}/manifest.json`)) return true;
    }
    return false;
  }

  /** Creates the folder and any missing parents. Returns the folders it created. */
  async ensureFolder(path: VaultPath): Promise<string[]> {
    const created: string[] = [];
    let current = "";
    for (const part of path.split("/")) {
      current = current === "" ? part : `${current}/${part}`;
      const existing = this.app.vault.getAbstractFileByPath(current);
      if (existing) {
        if (!("children" in existing)) throw new BridgeError("INVALID", "A file is in the way.");
        continue;
      }
      try {
        await this.app.vault.createFolder(current);
      } catch {
        throw new BridgeError("INVALID", "Could not create the folder.");
      }
      created.push(current);
    }
    return created;
  }

  /** Creates a new file (never overwrites). Returns the folders it had to create. */
  async createText(path: VaultPath, content: string): Promise<string[]> {
    if (this.app.vault.getAbstractFileByPath(path) || this.existsInsensitive(path)) throw new BridgeError("INVALID", "Already exists.");
    const parent = parentOf(path);
    const created = parent ? await this.ensureFolder(parent) : [];
    try {
      await this.app.vault.create(path, content);
    } catch {
      throw new BridgeError("INVALID", "Could not create the file.");
    }
    return created;
  }

  async modifyText(path: VaultPath, content: string): Promise<void> {
    const file = this.file(path);
    if (!file) throw new BridgeError("NOT_FOUND");
    await this.app.vault.modify(file, content);
  }

  /** Atomic read-modify-write, so text typed in an open editor a moment ago is not lost. */
  async appendText(path: VaultPath, text: string): Promise<void> {
    const file = this.file(path);
    if (!file) throw new BridgeError("NOT_FOUND");
    await this.app.vault.process(file, (data) => data + text);
  }

  /** Obsidian's own front matter editor: rewrites only the YAML block, never the body. */
  async updateFrontmatter(path: VaultPath, mutate: (frontmatter: Record<string, unknown>) => void): Promise<void> {
    const file = this.file(path);
    if (!file) throw new BridgeError("NOT_FOUND");
    try {
      await this.app.fileManager.processFrontMatter(file, mutate);
    } catch {
      throw new BridgeError("INVALID", "Could not update the front matter.");
    }
  }

  stat(path: VaultPath): { mtime: number; size: number } {
    const file = this.file(path);
    if (!file) throw new BridgeError("NOT_FOUND");
    return { mtime: file.stat.mtime, size: file.stat.size };
  }

  // ---- moving and deleting ------------------------------------------------------------------------

  private config(key: string): unknown {
    return (this.app.vault as unknown as { getConfig?: (k: string) => unknown }).getConfig?.(key);
  }

  /** Obsidian's "Automatically update internal links". When off, moving a note leaves links pointing nowhere. */
  linksAutoUpdate(): boolean {
    return this.config("alwaysUpdateLinks") === true;
  }

  /**
   * True if a sibling already has this name, ignoring case and Unicode form. A plain exists check is not
   * enough on case-insensitive disks (macOS, Windows): renaming a.md to B.md would overwrite b.md.
   * `except` is the item being renamed (so a case-only rename of itself is allowed).
   */
  existsInsensitive(path: VaultPath, except?: VaultPath): boolean {
    const parent = parentOf(path);
    const folder = parent === null ? this.app.vault.getRoot() : this.app.vault.getFolderByPath(parent);
    if (!folder) return false;
    const wanted = normaliseForMatch(path);
    return folder.children.some((c) => c.path !== except && normaliseForMatch(c.path) === wanted);
  }

  /**
   * Everything under a folder as the disk sees it, INCLUDING hidden items the vault index never lists
   * (a folder operation moves or deletes those too). Read-only use of the adapter, bounded in size.
   */
  async subtree(path: VaultPath, maxEntries: number): Promise<{ files: string[]; folders: string[] }> {
    const files: string[] = [];
    const folders: string[] = [];
    const queue: string[] = [path];
    while (queue.length > 0) {
      const listing = await this.app.vault.adapter.list(queue.shift() as string);
      files.push(...listing.files);
      for (const folder of listing.folders) {
        folders.push(folder);
        queue.push(folder);
      }
      if (files.length + folders.length > maxEntries) throw new BridgeError("TOO_LARGE");
    }
    return { files, folders };
  }

  /**
   * Notes outside the moved item whose links Obsidian will rewrite, from the link index. This includes
   * excluded notes: they are rewritten too, so they must be snapshotted even though the app cannot see them.
   */
  linkSources(moved: readonly string[]): string[] {
    const targets = new Set(moved);
    const sources: string[] = [];
    for (const [source, links] of Object.entries(this.app.metadataCache.resolvedLinks)) {
      if (targets.has(source)) continue;
      if (moved.some((t) => (links[t] ?? 0) > 0)) sources.push(source);
    }
    return sources;
  }

  /** Current text of indexed text files, for snapshots. Throws TOO_LARGE rather than skip, so a snapshot is never partial. */
  async snapshotTexts(paths: readonly string[], maxBytes: number): Promise<Array<{ path: string; content: string }>> {
    const out: Array<{ path: string; content: string }> = [];
    for (const path of paths) {
      const file = this.app.vault.getFileByPath(path);
      if (!file || !TEXT_EXTENSIONS.has(file.extension.toLowerCase())) continue;
      if (file.stat.size > maxBytes) throw new BridgeError("TOO_LARGE", "Too large to snapshot; operation refused.");
      out.push({ path, content: await this.app.vault.read(file) });
    }
    return out;
  }

  /** Move or rename through Obsidian, so links are updated per the user's preference. Returns folders it created. */
  async renameItem(from: VaultPath, to: VaultPath): Promise<string[]> {
    const item = this.app.vault.getAbstractFileByPath(from);
    if (!item) throw new BridgeError("NOT_FOUND");
    const parent = parentOf(to);
    const created = parent ? await this.ensureFolder(parent) : [];
    try {
      await this.app.fileManager.renameFile(item, to);
    } catch {
      throw new BridgeError("INVALID", "Could not move.");
    }
    return created;
  }

  /** Always to a trash, never a permanent delete. See trash.ts. */
  async trashItem(path: VaultPath): Promise<void> {
    const item = this.app.vault.getAbstractFileByPath(path);
    if (!item) throw new BridgeError("NOT_FOUND");
    await this.app.vault.trash(item, useSystemTrash(this.config("trashOption")));
  }

  /** Writes an app's own data.json, creating it on first use. */
  async writeStorage(path: VaultPath, text: string): Promise<void> {
    if (this.file(path)) return this.modifyText(path, text);
    await this.createText(path, text);
  }

  // ---- links and the workspace -------------------------------------------------------------------

  /** Resolve link text such as "Pump sizing#Heading|alias" the way Obsidian does, relative to a source note. */
  resolveLink(link: string, from: string): string | null {
    const linkpath = (link.split(/[#|^]/)[0] ?? "").trim();
    if (linkpath === "") return null;
    return this.app.metadataCache.getFirstLinkpathDest(linkpath, from)?.path ?? null;
  }

  /** Notes that link to this one, from Obsidian's link index. Only paths for which `visible` is true. */
  backlinks(path: VaultPath, visible: (p: string) => boolean, max: number): string[] {
    const out: string[] = [];
    for (const [source, links] of Object.entries(this.app.metadataCache.resolvedLinks)) {
      if (source !== path && (links[path] ?? 0) > 0 && visible(source)) out.push(source);
    }
    return out.sort().slice(0, max);
  }

  outgoing(path: VaultPath, visible: (p: string) => boolean, max: number): string[] {
    const links = this.app.metadataCache.resolvedLinks[path] ?? {};
    return Object.keys(links).filter(visible).sort().slice(0, max);
  }

  /** The note open in the workspace, if any. */
  activePath(): string | null {
    return this.app.workspace.getActiveFile()?.path ?? null;
  }

  /** Opens a note in a tab: reuses a tab that already shows it, otherwise makes a new one (never replaces the app's own tab). */
  async openFile(path: VaultPath): Promise<void> {
    const file = this.file(path);
    if (!file) throw new BridgeError("NOT_FOUND");
    let existing: ReturnType<App["workspace"]["getLeaf"]> | null = null;
    this.app.workspace.iterateAllLeaves((leaf) => {
      // Only note tabs count. Sidebar panes (Backlinks, Outgoing links, Outline) also carry the active file, and
      // the leaf's own state is reliable even for a tab Obsidian has not loaded yet.
      const viewState = leaf.getViewState();
      if (!existing && viewState.type === "markdown" && (viewState.state as { file?: string } | undefined)?.file === path) existing = leaf;
    });
    if (existing) {
      this.app.workspace.setActiveLeaf(existing, { focus: true });
      return;
    }
    await this.app.workspace.getLeaf("tab").openFile(file);
  }

  /** Front matter from Obsidian's metadata cache (may lag a moment behind a fresh edit). */
  frontmatter(path: VaultPath): Record<string, unknown> {
    const file = this.file(path);
    if (!file) throw new BridgeError("NOT_FOUND");
    const raw = this.app.metadataCache.getFileCache(file)?.frontmatter;
    if (!raw) return {};
    const clone = JSON.parse(JSON.stringify(raw)) as Record<string, unknown>;
    delete clone.position;
    return clone;
  }
}
