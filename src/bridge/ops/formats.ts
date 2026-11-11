/** formats.*: pure helpers on strings and values. No vault access. */
import { BridgeError } from "../errors";
import type { Handler } from "../host";
import { joinMarkdown, splitMarkdown } from "../markdown";
import { optionalInt, requireObjectValue, requireString } from "./args";

/** Injected so this module stays free of the obsidian runtime (and unit-testable). */
export interface YamlDeps {
  parseYaml(text: string): unknown;
  stringifyYaml(value: unknown): string;
}

function parseYamlSafely(yaml: YamlDeps, text: string): unknown {
  try {
    return yaml.parseYaml(text);
  } catch {
    throw new BridgeError("INVALID", "Invalid YAML.");
  }
}

function stringifyJsonSafely(value: unknown, indent: number, maxBytes: number): string {
  let text: string | undefined;
  try {
    text = JSON.stringify(value, null, indent);
  } catch {
    throw new BridgeError("INVALID", "Value cannot be written as JSON.");
  }
  if (text === undefined) throw new BridgeError("INVALID", "Value cannot be written as JSON.");
  if (text.length > maxBytes) throw new BridgeError("TOO_LARGE");
  return text;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function formatsOps(yaml: YamlDeps): Record<string, Handler> {
  return {
    "formats.parseYaml": async (args, call) => {
      const text = requireString(args, "text", call.limits.yamlBytes);
      return { result: { value: parseYamlSafely(yaml, text) ?? null } };
    },

    "formats.stringifyYaml": async (args, call) => {
      const value = requireObjectValue(args, "value");
      stringifyJsonSafely(value, 0, call.limits.parseTextBytes); // rejects cycles and oversize values
      return { result: { text: yaml.stringifyYaml(value) } };
    },

    "formats.parseJson": async (args, call) => {
      const text = requireString(args, "text", call.limits.parseTextBytes);
      try {
        return { result: { value: JSON.parse(text) as unknown } };
      } catch {
        throw new BridgeError("INVALID", "Invalid JSON.");
      }
    },

    "formats.stringifyJson": async (args, call) => {
      const value = requireObjectValue(args, "value");
      const indent = optionalInt(args, "indent", 0, 8, 2);
      return { result: { text: stringifyJsonSafely(value, indent, call.limits.parseTextBytes) } };
    },

    "formats.parseMarkdown": async (args, call) => {
      const text = requireString(args, "text", call.limits.parseTextBytes);
      const split = splitMarkdown(text);
      if (!split.hasFrontmatter) return { result: { hasFrontmatter: false, frontmatter: null, body: split.body } };
      if (split.frontmatterText.length > call.limits.yamlBytes) throw new BridgeError("TOO_LARGE");
      const parsed = parseYamlSafely(yaml, split.frontmatterText);
      return {
        result: { hasFrontmatter: true, frontmatter: isPlainObject(parsed) ? parsed : {}, body: split.body },
      };
    },

    "formats.writeMarkdown": async (args, call) => {
      const body = requireString(args, "body", call.limits.parseTextBytes);
      const fm = args.frontmatter;
      if (fm !== undefined && fm !== null && !isPlainObject(fm)) throw new BridgeError("INVALID", "Bad argument: frontmatter.");
      let yamlText = "";
      if (isPlainObject(fm) && Object.keys(fm).length > 0) {
        stringifyJsonSafely(fm, 0, call.limits.parseTextBytes);
        yamlText = yaml.stringifyYaml(fm);
      }
      return { result: { text: joinMarkdown(yamlText, body) } };
    },
  };
}
