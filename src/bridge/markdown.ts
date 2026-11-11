/** Markdown front matter splitting (pure). */

export interface SplitMarkdown {
  hasFrontmatter: boolean;
  /** Raw YAML text between the --- fences, or "" when there is none. */
  frontmatterText: string;
  body: string;
}

/** A front matter block must start on the very first line. */
const FRONTMATTER = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

export function splitMarkdown(text: string): SplitMarkdown {
  const m = FRONTMATTER.exec(text);
  if (!m) return { hasFrontmatter: false, frontmatterText: "", body: text };
  return { hasFrontmatter: true, frontmatterText: m[1] ?? "", body: text.slice(m[0].length) };
}

/** Join YAML text and a body into a note. An empty YAML block is omitted. */
export function joinMarkdown(frontmatterYaml: string, body: string): string {
  const yaml = frontmatterYaml.replace(/\s+$/, "");
  return yaml === "" ? body : `---\n${yaml}\n---\n${body}`;
}
