/**
 * The `trusted` flow (pure parts). A manifest may say "trusted": true. Nothing changes until the user
 * approves it in a host dialog. The approval is stored on THIS DEVICE ONLY (never in synced plugin data) and
 * is tied to a hash of the parts of the manifest that matter, so changing permissions, scopes, domains,
 * entry file or the flag itself asks again.
 */
import type { AppManifest } from "../apps/manifest";
import type { ConfirmRequest } from "./services";

/** What trust covers. Version, description and name are deliberately left out. */
export function trustPayload(manifest: AppManifest): string {
  return JSON.stringify({
    permissions: [...manifest.permissions].sort(),
    readScopes: manifest.readScopes ?? null,
    writeScopes: manifest.writeScopes ?? null,
    allowedDomains: [...manifest.allowedDomains].sort(),
    entry: manifest.entry,
    trusted: manifest.trusted,
  });
}

export async function trustHash(manifest: AppManifest): Promise<string> {
  const bytes = new TextEncoder().encode(trustPayload(manifest));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export interface TrustRecord {
  hash: string;
  time: number;
}

export interface TrustBackend {
  read(): Record<string, TrustRecord>;
  write(value: Record<string, TrustRecord>): void;
}

export class TrustStore {
  constructor(private readonly backend: TrustBackend) {}
  get(appRoot: string): TrustRecord | undefined {
    return Object.prototype.hasOwnProperty.call(this.backend.read(), appRoot) ? this.backend.read()[appRoot] : undefined;
  }
  set(appRoot: string, record: TrustRecord): void {
    this.backend.write({ ...this.backend.read(), [appRoot]: record });
  }
  remove(appRoot: string): void {
    const all = { ...this.backend.read() };
    delete all[appRoot];
    this.backend.write(all);
  }
  list(): Array<[string, TrustRecord]> {
    return Object.entries(this.backend.read()).sort(([a], [b]) => a.localeCompare(b));
  }
}

/** Device-local storage (localStorage). Never throws: a failure just means "not trusted". */
export function localStorageBackend(key: string, storage: Pick<Storage, "getItem" | "setItem"> | undefined = globalThis.localStorage): TrustBackend {
  return {
    read() {
      try {
        const parsed = JSON.parse(storage?.getItem(key) ?? "{}") as unknown;
        return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, TrustRecord>) : {};
      } catch {
        return {};
      }
    },
    write(value) {
      try {
        storage?.setItem(key, JSON.stringify(value));
      } catch {
        /* device storage unavailable: the approval will simply be asked for again */
      }
    },
  };
}

/** The dialog text: says exactly what trusted mode unlocks and what it never does. */
export function trustRequest(appRoot: string, manifest: AppManifest): Omit<ConfirmRequest, "app"> {
  return {
    title: "Trust this app?",
    details: [
      `"${manifest.name}" (${appRoot}) asks to run as a trusted app.`,
      `Permissions it declares: ${manifest.permissions.join(", ") || "none"}.`,
      `Folders it may write without trust: ${(manifest.writeScopes ?? []).join(", ") || "none"}.`,
      "Trusted lets it: write anywhere in the vault (not only its own write folders), use 5 times the request rate, write files up to 25 MB, and change up to 200 files at once (you are still asked first).",
      "Trusted never lets it: touch excluded or hidden paths, apps or any manifest.json, skip snapshots or the log, delete permanently, or reach the network.",
      "This approval is kept on this device only and asks again if the app's permissions or scopes change.",
    ],
    paths: [],
  };
}

export class TrustManager {
  /** Denials are remembered until restart, or until the user presses Reload, so a refusal is not nagged about. */
  private readonly denied = new Map<string, string>();

  constructor(
    readonly store: TrustStore,
    private readonly ask: (request: ConfirmRequest) => Promise<boolean>,
  ) {}

  /** Effective trust for an app being loaded. false when it did not ask, was refused, or the dialog failed. */
  async ensure(appRoot: string, manifest: AppManifest, askAgain = false): Promise<boolean> {
    if (!manifest.trusted) return false;
    const hash = await trustHash(manifest);
    if (this.store.get(appRoot)?.hash === hash) return true;
    if (askAgain) this.denied.delete(appRoot);
    if (this.denied.get(appRoot) === hash) return false;

    let approved = false;
    try {
      approved = await this.ask({ app: appRoot, ...trustRequest(appRoot, manifest) });
    } catch {
      approved = false;
    }
    if (approved) {
      this.store.set(appRoot, { hash, time: Date.now() });
      this.denied.delete(appRoot);
    } else {
      this.denied.set(appRoot, hash);
    }
    return approved;
  }

  revoke(appRoot: string): void {
    this.store.remove(appRoot);
    this.denied.delete(appRoot);
  }
}
