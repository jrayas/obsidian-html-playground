/**
 * AppRunner: owns one sandboxed iframe (in a tab view or a note embed).
 *
 * Security notes (docs/decisions/0002):
 *  - The iframe has sandbox="allow-scripts" ONLY. Never add allow-same-origin.
 *  - Its origin is "null", so we never trust origin. We check event.source and a per-load nonce
 *    on the first "hello", then transfer a private MessageChannel port. All bridge traffic uses it.
 *  - Requests arriving on the port go to a per-app BridgeHost (src/bridge/host.ts), which enforces
 *    permissions, exclusions, scopes and limits.
 */
import { setIcon } from "obsidian";
import { buildContext, type EmbedInfo } from "../bridge/context";
import type { RawEvent } from "../bridge/events";
import { BridgeHost } from "../bridge/host";
import { eventMessage } from "../bridge/protocol";
import { effectiveAssetMode } from "../settings";
import { readTheme } from "../theme/variables";
import { resolvePath } from "../paths/resolver";
import { loadApp, type LoaderIO } from "./loader";
import { dirname, parseManifest, type AppManifest } from "./manifest";
import type HtmlPlaygroundPlugin from "../main";

interface Hello {
  hp: "hello";
  nonce: string;
}

const isHello = (d: unknown): d is Hello =>
  typeof d === "object" && d !== null && (d as Hello).hp === "hello" && typeof (d as Hello).nonce === "string";

function randomNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export interface RunnerOptions {
  /** Fixed height for note embeds. Omit to fill the available space. */
  height?: number;
  showBar?: boolean;
  /** Set for note embeds: the note's path and the parameters it gave. Reaches the app only through embed.context. */
  embed?: EmbedInfo;
}

export class AppRunner {
  manifest: AppManifest | null = null;
  private iframe: HTMLIFrameElement | null = null;
  private port: MessagePort | null = null;
  private host: BridgeHost | null = null;
  private nonce = "";
  private blobUrls: string[] = [];
  private root: HTMLElement;
  private barEl: HTMLElement | null = null;
  private manifestPath: string | null = null;
  /** Set by the Reload button: a refused trust request is asked about again. */
  private askTrustAgain = false;
  private themeTimer: number | null = null;

  constructor(
    private plugin: HtmlPlaygroundPlugin,
    private container: HTMLElement,
    private options: RunnerOptions = {},
  ) {
    this.root = container.createDiv({ cls: "hp-app" });
    if (options.height) {
      this.root.addClass("hp-embed");
      this.root.style.height = `${options.height}px`;
    }
    window.addEventListener("message", this.onWindowMessage);
    plugin.runners.add(this);
  }

  /** Vault-backed file access for the loader. Reads only; every path is already resolved. */
  private io(): LoaderIO {
    const vault = this.plugin.app.vault;
    const file = (path: string) => {
      const f = vault.getFileByPath(path);
      return f ?? null;
    };
    return {
      readText: async (path) => {
        const f = file(path);
        return f ? vault.cachedRead(f) : null;
      },
      readBinary: async (path) => {
        const f = file(path);
        return f ? vault.readBinary(f) : null;
      },
    };
  }

  async load(manifestPath: string): Promise<void> {
    this.manifestPath = manifestPath;
    this.teardownFrame();
    this.root.empty();

    const s = this.plugin.settings;
    const resolved = resolvePath(manifestPath, { allowRelativeFallback: false, exclusions: s.exclusions });
    if (!resolved.ok) return this.showError("App not found.");

    const io = this.io();
    const text = await io.readText(resolved.path);
    if (text === null) return this.showError("App not found.");
    const parsed = parseManifest(text);
    if (!parsed.ok) return this.showError(parsed.error);
    this.manifest = parsed.manifest;

    const appRoot = dirname(resolved.path);
    this.nonce = randomNonce();
    let loaded;
    try {
      loaded = await loadApp({
        appRoot,
        manifest: parsed.manifest,
        io,
        theme: readTheme(),
        nonce: this.nonce,
        strictPaths: s.strictPaths,
        exclusions: s.exclusions,
        globalDomains: s.allowedDomains,
        assetMode: effectiveAssetMode(s.assetMode),
      });
    } catch (error) {
      return this.showError(error instanceof Error ? error.message : "The app could not be loaded.");
    }
    this.blobUrls = loaded.blobUrls;

    const trusted = await this.plugin.trust.ensure(appRoot, parsed.manifest, this.askTrustAgain);
    this.askTrustAgain = false;
    const bridge = buildContext({
      appRoot,
      manifest: parsed.manifest,
      strictPaths: s.strictPaths,
      exclusions: s.exclusions,
      trusted,
      ...(this.options.embed ? { embed: this.options.embed } : {}),
    });
    if (parsed.manifest.trusted && !trusted) bridge.warnings.push("Trusted mode was not granted; running with normal permissions and limits.");
    this.host = new BridgeHost(
      bridge.ctx,
      this.plugin.services,
      this.plugin.handlers,
      (message, transfer) => this.port?.postMessage(message, transfer ?? []),
      undefined,
      (event) => this.port?.postMessage(event),
    );

    const warnings = [...parsed.warnings, ...bridge.warnings, ...loaded.warnings];
    if (parsed.manifest.appRoot && parsed.manifest.appRoot !== appRoot) {
      warnings.push(`manifest appRoot is "${parsed.manifest.appRoot}" but the app folder is "${appRoot}". The folder is used.`);
    }
    if (this.options.showBar !== false) this.renderBar(parsed.manifest, warnings, bridge.ctx.trusted);

    const iframe = this.root.createEl("iframe", { cls: "hp-frame" });
    iframe.setAttribute("sandbox", "allow-scripts"); // never add allow-same-origin
    iframe.setAttribute("allow", "");
    iframe.setAttribute("referrerpolicy", "no-referrer");
    iframe.setAttribute("title", parsed.manifest.name);
    iframe.srcdoc = loaded.html;
    this.iframe = iframe;
  }

  reload(): Promise<void> {
    return this.manifestPath ? this.load(this.manifestPath) : Promise.resolve();
  }

  /** A vault change from Obsidian; the bridge host decides whether this app may hear about it. */
  onVaultEvent(raw: RawEvent): void {
    this.host?.onVaultEvent(raw);
  }

  /** Called (debounced) when Obsidian's theme or light/dark mode changes. */
  refreshTheme(): void {
    if (this.themeTimer !== null) window.clearTimeout(this.themeTimer);
    this.themeTimer = window.setTimeout(() => {
      this.themeTimer = null;
      this.sendEvent("theme", readTheme());
    }, 60);
  }

  dispose(): void {
    window.removeEventListener("message", this.onWindowMessage);
    if (this.themeTimer !== null) window.clearTimeout(this.themeTimer);
    this.teardownFrame();
    this.plugin.runners.delete(this);
    this.root.remove();
  }

  // ---- internals -------------------------------------------------------------------------

  private teardownFrame(): void {
    this.port?.close();
    this.port = null;
    this.host?.dispose();
    this.host = null;
    this.iframe?.remove();
    this.iframe = null;
    this.barEl?.remove();
    this.barEl = null;
    for (const url of this.blobUrls) URL.revokeObjectURL(url);
    this.blobUrls = [];
  }

  private showError(message: string): void {
    this.root.empty();
    this.root.createDiv({ cls: "hp-error", text: message });
  }

  private renderBar(manifest: AppManifest, warnings: string[], trusted: boolean): void {
    const bar = this.root.createDiv({ cls: "hp-bar" });
    bar.createSpan({ cls: "hp-bar-title", text: manifest.name });
    bar.createSpan({ cls: "hp-badge", text: `v${manifest.version}` });
    if (manifest.aiGenerated) bar.createSpan({ cls: "hp-badge hp-badge-ai", text: "AI generated" });
    if (trusted) bar.createSpan({ cls: "hp-badge", text: "Trusted" });

    const reload = bar.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "Reload app" } });
    setIcon(reload, "refresh-cw");
    reload.addEventListener("click", () => {
      this.askTrustAgain = true;
      void this.reload();
    });

    if (warnings.length > 0) {
      const details = bar.createEl("details", { cls: "hp-warnings" });
      details.createEl("summary", { text: `${warnings.length} warning${warnings.length === 1 ? "" : "s"}` });
      const list = details.createEl("ul");
      for (const w of warnings) list.createEl("li", { text: w });
    }
    this.barEl = bar;
  }

  private onWindowMessage = (event: MessageEvent): void => {
    const win = this.iframe?.contentWindow;
    if (!win || event.source !== win) return; // ignore everything not from our iframe
    if (!isHello(event.data) || event.data.nonce !== this.nonce || this.port) return;

    const channel = new MessageChannel();
    channel.port1.onmessage = this.onPortMessage;
    this.port = channel.port1;
    win.postMessage({ hp: "port" }, "*", [channel.port2]); // "*" is required for an opaque origin
    this.sendEvent("theme", readTheme());
  };

  private onPortMessage = (event: MessageEvent): void => {
    void this.host?.handle(event.data); // malformed messages are ignored inside handle()
  };

  private sendEvent(name: string, payload: unknown): void {
    this.port?.postMessage(eventMessage(name, payload));
  }
}
