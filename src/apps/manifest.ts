/** App manifest parsing and validation (pure). Invalid optional fields are dropped, never widened. */

export interface AppManifest {
  name: string;
  version: string;
  description: string;
  /** Entry file, relative to the app folder. */
  entry: string;
  /** Informational only. The real app root is always the folder holding manifest.json. */
  appRoot?: string;
  /** Bridge operations the app may use, e.g. "files.read". Enforced in Phase 2. */
  permissions: string[];
  /** Vault folders the app may read. Omitted = whole vault (minus exclusions). The app's own folder is always readable. */
  readScopes?: string[];
  /** Vault folders the app may write. Required for write operations unless the app is trusted (enforced from step 2b). */
  writeScopes?: string[];
  /** Extra power for reviewed apps. Unlocks nothing in Phase 1; see docs/security.md. */
  trusted: boolean;
  aiGenerated: boolean;
  /** Hostnames the app asks to reach. Only those also in the global allow-list are used. */
  allowedDomains: string[];
}

export type ManifestResult =
  | { ok: true; manifest: AppManifest; warnings: string[] }
  | { ok: false; error: string };

const PERMISSION = /^[a-z][a-zA-Z]*(\.[a-zA-Z]+)?$/;
export const HOSTNAME = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringList(value: unknown, label: string, test: (s: string) => boolean, warnings: string[]): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    warnings.push(`"${label}" must be a list; ignored.`);
    return [];
  }
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === "string" && test(item)) out.push(item);
    else warnings.push(`Ignored invalid ${label} entry: ${JSON.stringify(item)}.`);
  }
  return out;
}

const MAX_SCOPES = 20;

/** A bad scope list becomes an empty list (nothing allowed), never "no scopes" (everything allowed). */
function scopeList(value: unknown, label: string, warnings: string[]): string[] {
  const list = stringList(value, label, (s) => s.length > 0 && s.length <= 200, warnings);
  if (!Array.isArray(value)) return [];
  if (list.length > MAX_SCOPES) {
    warnings.push(`Too many ${label} entries; only the first ${MAX_SCOPES} are used.`);
    return list.slice(0, MAX_SCOPES);
  }
  return list;
}

export function parseManifest(raw: string): ManifestResult {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ok: false, error: "manifest.json is not valid JSON." };
  }
  if (!isRecord(data)) return { ok: false, error: "manifest.json must be a JSON object." };

  const warnings: string[] = [];
  const name = data.name;
  if (typeof name !== "string" || name.trim() === "" || name.length > 100) {
    return { ok: false, error: 'manifest.json needs a "name" (1 to 100 characters).' };
  }

  const entry = typeof data.entry === "string" && data.entry.trim() !== "" ? data.entry.trim() : "index.html";
  const booleanField = (key: string): boolean => {
    if (data[key] === undefined) return false;
    if (typeof data[key] === "boolean") return data[key];
    warnings.push(`"${key}" must be true or false; treated as false.`);
    return false;
  };

  return {
    ok: true,
    warnings,
    manifest: {
      name: name.trim(),
      version: typeof data.version === "string" ? data.version : "0.0.0",
      description: typeof data.description === "string" ? data.description : "",
      entry,
      appRoot: typeof data.appRoot === "string" ? data.appRoot : undefined,
      permissions: stringList(data.permissions, "permissions", (s) => PERMISSION.test(s), warnings),
      readScopes: data.readScopes === undefined ? undefined : scopeList(data.readScopes, "readScopes", warnings),
      writeScopes: data.writeScopes === undefined ? undefined : scopeList(data.writeScopes, "writeScopes", warnings),
      trusted: booleanField("trusted"),
      aiGenerated: booleanField("aiGenerated"),
      allowedDomains: stringList(
        data.allowedDomains,
        "allowedDomains",
        (s) => HOSTNAME.test(s.toLowerCase()),
        warnings,
      ).map((s) => s.toLowerCase()),
    },
  };
}

/** Replace {{appRoot}} (spaces allowed inside the braces) with the real app folder. */
export function substituteAppRoot(text: string, appRoot: string): string {
  return text.replace(/\{\{\s*appRoot\s*\}\}/g, appRoot);
}

/** Folder part of a vault path ("Apps/Calc/manifest.json" -> "Apps/Calc"). */
export function dirname(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}
