/**
 * Parser for the text inside an ```html-playground block (pure, no Obsidian imports).
 *
 *   Apps/PCB Rulebook          <- line 1: the app folder or a manifest.json path
 *   height: 400                <- reserved: 120 to 2000, or "auto" (reserved for a later step; fixed height until then)
 *   id: pump-note              <- reserved: names this embed's own storage compartment (a later step)
 *   widget: microstrip         <- anything else is a parameter handed to the app as plain text
 *
 * The note is untrusted text. Everything here is checked strictly and never turned into HTML. Parameters
 * never grant anything: permissions, scopes, trust and network come only from the app's manifest.
 * See docs/phases/phase-5-note-embeds.md (Q26 to Q33).
 */

export const DEFAULT_EMBED_HEIGHT = 360;
export const MIN_EMBED_HEIGHT = 120;
export const MAX_EMBED_HEIGHT = 2000;
export const MAX_PARAMS = 20;
export const MAX_PARAM_VALUE = 200;
export const MAX_TARGET = 300;

export interface EmbedBlock {
  /** The app folder or manifest path, exactly as written (the resolver checks it later). */
  target: string;
  /** Fixed pixels, or "auto" when the note asked for it. */
  height: number | "auto";
  /** The embed's own storage compartment name, or null for the app's shared store. */
  id: string | null;
  /** Parameters in the order written. Keys are unique. */
  params: Array<[string, string]>;
}

export type EmbedParse = { ok: true; block: EmbedBlock } | { ok: false; error: string };

const NAME = /^[a-z0-9_-]{1,32}$/;
const LINE = /^([^:]+?)\s*:\s*(.*)$/;
/** Names that would be dangerous or confusing as object keys in an app. */
const FORBIDDEN = new Set(["__proto__", "constructor", "prototype"]);
// eslint-disable-next-line no-control-regex -- control characters are the point: names containing them are refused
const CONTROL = /[\u0000-\u001f\u007f]/;

export function parseEmbedBlock(source: string): EmbedParse {
  const lines = source.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const target = lines[0];
  if (!target) return { ok: false, error: "Put the app folder on the first line." };
  if (target.length > MAX_TARGET || CONTROL.test(target)) return { ok: false, error: "The app folder on the first line is not valid." };

  let height: number | "auto" = DEFAULT_EMBED_HEIGHT;
  let id: string | null = null;
  const params: Array<[string, string]> = [];
  const seen = new Set<string>();

  for (const [i, line] of lines.slice(1).entries()) {
    const m = LINE.exec(line);
    if (!m) return { ok: false, error: `Line ${i + 2} is not in the form "name: value".` };
    const key = (m[1] ?? "").trim();
    const value = (m[2] ?? "").trim();
    if (!NAME.test(key) || FORBIDDEN.has(key)) {
      return { ok: false, error: `The name "${shorten(key)}" is not allowed. Use lowercase letters, digits, - or _ (up to 32 characters).` };
    }
    if (seen.has(key)) return { ok: false, error: `The name "${key}" appears twice.` };
    seen.add(key);

    if (key === "height") {
      if (value.toLowerCase() === "auto") height = "auto";
      else if (/^\d{2,4}$/.test(value)) height = Math.min(Math.max(parseInt(value, 10), MIN_EMBED_HEIGHT), MAX_EMBED_HEIGHT);
      else return { ok: false, error: `height must be a number of pixels or "auto".` };
    } else if (key === "id") {
      if (!NAME.test(value) || FORBIDDEN.has(value)) return { ok: false, error: `id must use lowercase letters, digits, - or _ (up to 32 characters).` };
      id = value;
    } else {
      if (value.length > MAX_PARAM_VALUE) return { ok: false, error: `The value of "${key}" is longer than ${MAX_PARAM_VALUE} characters.` };
      if (CONTROL.test(value)) return { ok: false, error: `The value of "${key}" contains a control character.` };
      if (params.length >= MAX_PARAMS) return { ok: false, error: `No more than ${MAX_PARAMS} parameters are allowed.` };
      params.push([key, value]);
    }
  }
  return { ok: true, block: { target, height, id, params } };
}

/** Plain object for the app: no prototype, so no inherited names. Keys were already vetted. */
export function paramsObject(params: ReadonlyArray<readonly [string, string]>): Record<string, string> {
  const out = Object.create(null) as Record<string, string>;
  for (const [k, v] of params) out[k] = v;
  return out;
}

function shorten(text: string): string {
  const clean = text.replace(CONTROL, "?");
  return clean.length > 40 ? `${clean.slice(0, 40)}...` : clean;
}
