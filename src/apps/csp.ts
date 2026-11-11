/** Content Security Policy for app pages (pure). Network is blocked unless a domain is in BOTH lists. */
import { HOSTNAME } from "./manifest";

/** Intersection of the manifest's domains and the global allow-list, validated and lower-cased. */
export function effectiveDomains(fromManifest: readonly string[], fromSettings: readonly string[]): string[] {
  const global = new Set(fromSettings.map((d) => d.trim().toLowerCase()));
  const out = new Set<string>();
  for (const d of fromManifest) {
    const host = d.trim().toLowerCase();
    if (HOSTNAME.test(host) && global.has(host)) out.add(host);
  }
  return [...out];
}

/**
 * Allowed domains open connect, img, font and media only. Remote scripts and styles stay blocked.
 * Inline and eval scripts are allowed because frameworks need them; the sandbox and the
 * absence of network access are what contain the app.
 */
export function buildCsp(domains: readonly string[]): string {
  const remote = domains.map((d) => `https://${d}`).join(" ");
  const join = (...parts: string[]) => parts.filter(Boolean).join(" ");
  return [
    "default-src 'none'",
    "script-src 'unsafe-inline' 'unsafe-eval'",
    "style-src 'unsafe-inline'",
    `img-src ${join("data: blob:", remote)}`,
    `font-src ${join("data:", remote)}`,
    `media-src ${join("data: blob:", remote)}`,
    `connect-src ${remote || "'none'"}`,
    "worker-src blob:",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
}
