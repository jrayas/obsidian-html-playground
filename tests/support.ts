/** Test helpers: in-memory services and a mutable fake vault that behaves like Obsidian where it matters. */
import { VaultGateway } from "../src/bridge/gateway";
import { KeyedMutex } from "../src/bridge/locks";
import { AuditLog } from "../src/bridge/log";
import type { RetentionPolicy } from "../src/bridge/retention";
import type { BridgeServices, ConfirmRequest } from "../src/bridge/services";
import { SnapshotService } from "../src/bridge/snapshots";
import { MemoryLogStore, MemorySnapshotStore } from "../src/bridge/store";

export const DEFAULT_POLICY: RetentionPolicy = { perFile: 20, maxBytes: 50 * 1024 * 1024, maxAgeMs: 30 * 86_400_000 };

export function memoryServices(
  gateway: VaultGateway,
  opts: { appsFolder?: string; policy?: RetentionPolicy; now?: () => number } = {},
) {
  const snapshotStore = new MemorySnapshotStore();
  const logStore = new MemoryLogStore();
  let counter = 0;
  const confirmations: ConfirmRequest[] = [];
  const state = { answer: true, pick: null as string | null };
  const picks: Array<{ kind: string; app: string }> = [];
  const services: BridgeServices = {
    gateway,
    snapshots: new SnapshotService(snapshotStore, () => opts.policy ?? DEFAULT_POLICY, opts.now, () => `snap-${++counter}`),
    audit: new AuditLog(logStore, () => 5000, opts.now),
    locks: new KeyedMutex(),
    appsFolder: () => opts.appsFolder ?? "Apps",
    confirm: async (request) => {
      confirmations.push(request);
      return state.answer;
    },
    pick: async (request) => {
      picks.push({ kind: request.kind, app: request.app });
      return state.pick;
    },
  };
  return {
    ...services,
    snapshotStore,
    logStore,
    confirmations,
    picks,
    answer: (value: boolean) => void (state.answer = value),
    pickAnswer: (value: string | null) => void (state.pick = value),
  };
}

interface FakeFile {
  path: string;
  extension: string;
  stat: { size: number; mtime: number };
  content: string;
  frontmatter?: Record<string, unknown>;
}

const baseName = (p: string) => (p.split("/").pop() ?? "").replace(/\.[^.]+$/, "");
const parentOfPath = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");

/**
 * A mutable in-memory vault. Like Obsidian: creating a file needs its parent folder; renames rewrite
 * [[links]] when "alwaysUpdateLinks" is on; trash records how it was called; the disk listing (adapter.list)
 * includes hidden entries the vault index never shows.
 */
export function mutableApp(initial: Record<string, string>, hiddenOnDisk: string[] = []) {
  const files = new Map<string, FakeFile>();
  const folders = new Set<string>();
  const hidden = new Set(hiddenOnDisk);
  const config: Record<string, unknown> = { alwaysUpdateLinks: true, trashOption: "local" };
  const trashed: Array<{ path: string; system: boolean }> = [];
  let active: string | null = null;
  const opened: string[] = [];
  const leaves: Array<{ getViewState: () => { type: string; state: { file: string } } }> = [];
  let clock = 1000;

  const addFolderChain = (path: string) => {
    let current = "";
    for (const part of path.split("/").filter(Boolean)) {
      current = current === "" ? part : `${current}/${part}`;
      folders.add(current);
    }
  };
  const put = (path: string, content: string) => {
    const existing = files.get(path);
    const file: FakeFile = existing ?? { path, extension: path.split(".").pop() ?? "", stat: { size: 0, mtime: 0 }, content: "" };
    file.content = content;
    file.stat = { size: new TextEncoder().encode(content).length, mtime: ++clock };
    files.set(path, file);
    return file;
  };
  for (const [path, content] of Object.entries(initial)) {
    addFolderChain(parentOfPath(path));
    put(path, content);
  }

  const isFolder = (p: string) => p === "" || folders.has(p);
  const childrenOf = (p: string) => {
    const prefix = p === "" ? "" : p + "/";
    const out = new Map<string, unknown>();
    for (const f of files.values()) {
      if (!f.path.startsWith(prefix)) continue;
      const rest = f.path.slice(prefix.length);
      if (rest.includes("/")) {
        const name = prefix + rest.split("/")[0];
        out.set(name, { path: name, children: [] });
      } else out.set(f.path, f);
    }
    for (const dir of folders) {
      if (dir.startsWith(prefix) && dir !== p && !dir.slice(prefix.length).includes("/")) out.set(dir, { path: dir, children: [] });
    }
    return [...out.values()];
  };

  /** source path -> { target path -> count }, found by scanning [[wiki links]] in notes. */
  const resolvedLinks = (): Record<string, Record<string, number>> => {
    const byName = new Map<string, string>();
    for (const f of files.values()) byName.set(baseName(f.path).toLowerCase(), f.path);
    const out: Record<string, Record<string, number>> = {};
    for (const f of files.values()) {
      if (f.extension !== "md") continue;
      out[f.path] = {};
      for (const m of f.content.matchAll(/\[\[([^\]|#]+)/g)) {
        const target = byName.get((m[1] ?? "").trim().toLowerCase());
        if (target) out[f.path]![target] = (out[f.path]![target] ?? 0) + 1;
      }
    }
    return out;
  };

  const removeSubtree = (p: string) => {
    for (const path of [...files.keys()]) if (path === p || path.startsWith(p + "/")) files.delete(path);
    for (const dir of [...folders]) if (dir === p || dir.startsWith(p + "/")) folders.delete(dir);
  };

  const app = {
    vault: {
      getFileByPath: (p: string) => files.get(p) ?? null,
      getFolderByPath: (p: string) => (isFolder(p) ? { path: p, children: childrenOf(p) } : null),
      getAbstractFileByPath: (p: string) => files.get(p) ?? (isFolder(p) && p !== "" ? { path: p, children: childrenOf(p) } : null),
      getRoot: () => ({ path: "", children: childrenOf("") }),
      getFiles: () => [...files.values()],
      getConfig: (k: string) => config[k],
      read: async (f: FakeFile) => f.content,
      cachedRead: async (f: FakeFile) => f.content,
      readBinary: async (f: FakeFile) => new TextEncoder().encode(f.content).buffer,
      create: async (p: string, content: string) => {
        if (!isFolder(parentOfPath(p))) throw new Error("parent folder missing");
        if (files.has(p) || isFolder(p)) throw new Error("exists");
        return put(p, content);
      },
      createFolder: async (p: string) => {
        if (files.has(p)) throw new Error("file in the way");
        addFolderChain(p);
      },
      modify: async (f: FakeFile, content: string) => void put(f.path, content),
      process: async (f: FakeFile, fn: (d: string) => string) => void put(f.path, fn(f.content)),
      trash: async (item: { path: string }, system: boolean) => {
        trashed.push({ path: item.path, system });
        removeSubtree(item.path);
      },
      delete: async () => {
        throw new Error("vault.delete must never be called by the bridge");
      },
      adapter: {
        list: async (folder: string) => {
          const prefix = folder === "" ? "" : folder + "/";
          const listedFiles = new Set<string>();
          const listedFolders = new Set<string>();
          const consider = (path: string, isDir: boolean) => {
            if (!path.startsWith(prefix) || path === folder) return;
            const rest = path.slice(prefix.length);
            if (rest.includes("/")) return;
            (isDir ? listedFolders : listedFiles).add(path);
          };
          for (const f of files.keys()) consider(f, false);
          for (const d of folders) consider(d, true);
          for (const h of hidden) {
            // Hidden entries: every ancestor folder directly under `folder`, or the file itself.
            let current = "";
            const parts = h.split("/");
            for (let i = 0; i < parts.length; i++) {
              current = current === "" ? (parts[i] as string) : `${current}/${parts[i]}`;
              consider(current, i < parts.length - 1);
            }
          }
          return { files: [...listedFiles], folders: [...listedFolders] };
        },
      },
    },
    fileManager: {
      processFrontMatter: async (f: FakeFile, fn: (fm: Record<string, unknown>) => void) => {
        const fm = (f.frontmatter ??= {});
        fn(fm);
        const body = f.content.replace(/^---\n[\s\S]*?\n---\n/, "");
        put(f.path, `---\n${JSON.stringify(fm)}\n---\n${body}`);
      },
      renameFile: async (item: { path: string }, newPath: string) => {
        if (files.has(newPath) || isFolder(newPath)) throw new Error("destination exists");
        const links = resolvedLinks();
        const moving = files.has(item.path) ? [item.path] : [...files.keys()].filter((p) => p.startsWith(item.path + "/"));
        const sources = new Set<string>();
        for (const [source, targets] of Object.entries(links)) for (const t of moving) if (targets[t]) sources.add(source);

        const mapPath = (p: string) => (p === item.path ? newPath : newPath + p.slice(item.path.length));
        const renamedLinks: Array<[string, string]> = [];
        for (const p of moving) {
          const file = files.get(p) as FakeFile;
          files.delete(p);
          file.path = mapPath(p);
          file.extension = file.path.split(".").pop() ?? "";
          files.set(file.path, file);
          renamedLinks.push([baseName(p), baseName(file.path)]);
        }
        if (!files.has(newPath)) {
          for (const dir of [...folders]) if (dir === item.path || dir.startsWith(item.path + "/")) {
            folders.delete(dir);
            folders.add(mapPath(dir));
          }
          addFolderChain(newPath);
        }
        if (config.alwaysUpdateLinks === true) {
          for (const source of sources) {
            const moved = source === item.path || source.startsWith(item.path + "/");
            const file = files.get(moved ? mapPath(source) : source);
            if (!file) continue;
            let text = file.content;
            for (const [oldName, newName] of renamedLinks) if (oldName !== newName) text = text.split(`[[${oldName}`).join(`[[${newName}`);
            put(file.path, text);
          }
        }
      },
    },
    workspace: {
      getActiveFile: () => (active ? (files.get(active) ?? null) : null),
      iterateAllLeaves: (cb: (leaf: (typeof leaves)[number]) => void) => leaves.forEach(cb),
      getLeaf: () => ({
        openFile: async (f: FakeFile) => {
          opened.push(f.path);
          leaves.push({ getViewState: () => ({ type: "markdown", state: { file: f.path } }) });
          // Sidebar panes follow the active note too; the gateway must not mistake them for a note tab.
          leaves.push({ getViewState: () => ({ type: "backlink", state: { file: f.path } }) });
        },
      }),
      revealLeaf: async () => undefined,
    },
    metadataCache: {
      getFirstLinkpathDest: (link: string) => {
        const name = link.replace(/\.md$/i, "").toLowerCase();
        for (const f of files.values()) if (f.path.toLowerCase() === `${name}.md` || baseName(f.path).toLowerCase() === name) return f;
        return null;
      },
      getFileCache: (f: FakeFile) => ({ frontmatter: f.frontmatter }),
      get resolvedLinks() {
        return resolvedLinks();
      },
    },
  };

  return {
    app,
    gateway: new VaultGateway(app as never),
    /** path -> content, for comparing before and after. */
    state: () => Object.fromEntries([...files.values()].map((f) => [f.path, f.content])),
    folders: () => [...folders].sort(),
    remove: (p: string) => void files.delete(p),
    trashed,
    opened,
    setActive: (path: string | null) => void (active = path),
    setConfig: (key: string, value: unknown) => void (config[key] = value),
  };
}
