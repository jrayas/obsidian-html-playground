import { describe, expect, it } from "vitest";
import { resolvePath, type ResolveOptions } from "../src/paths/resolver";

const base: ResolveOptions = {
  appRoot: "Apps/Calc",
  allowRelativeFallback: true,
  exclusions: ["Private/", "*.secret.md", "Data/hidden"],
};

const ok = (input: unknown, opts: ResolveOptions = base) => {
  const r = resolvePath(input, opts);
  if (!r.ok) throw new Error(`expected ok for ${String(input)}, got ${r.code} (${r.reason})`);
  return r.path;
};
const code = (input: unknown, opts: ResolveOptions = base) => {
  const r = resolvePath(input, opts);
  return r.ok ? "OK" : r.code;
};

describe("valid paths", () => {
  it("accepts vault-root-relative paths", () => {
    expect(ok("Notes/Pump sizing.md")).toBe("Notes/Pump sizing.md");
    expect(ok("Data/pumps.json")).toBe("Data/pumps.json");
  });
  it("decodes %20 and trims stray spaces", () => {
    expect(ok("Notes/Pump%20sizing.md")).toBe("Notes/Pump sizing.md");
    expect(ok("  Notes/x.md  ")).toBe("Notes/x.md");
  });
  it("converts backslashes and collapses separators and dots", () => {
    expect(ok("Notes\\Sub\\x.md")).toBe("Notes/Sub/x.md");
    expect(ok("Notes//x.md")).toBe("Notes/x.md");
    expect(ok("Notes/./x.md")).toBe("Notes/x.md");
  });
  it("keeps a literal percent sign in names", () => {
    expect(ok("Notes/Efficiency 90% done.md")).toBe("Notes/Efficiency 90% done.md");
    expect(ok("Notes/100%.md")).toBe("Notes/100%.md");
  });
  it("normalises Unicode to NFC", () => {
    expect(ok("Notes/cafe\u0301.md")).toBe("Notes/caf\u00e9.md");
  });
  it("allows the vault root only when asked", () => {
    expect(code("/")).toBe("INVALID");
    expect(ok("/", { ...base, allowRoot: true })).toBe("");
  });
});

describe("traversal and escape attempts", () => {
  const attacks = [
    "../x",
    "..\\x",
    "a/../../x",
    "a/..",
    "%2e%2e/x",
    "%2E%2E%2Fx",
    "%252e%252e/x",
    "%25252e%25252e/x",
    "..%5cx",
    "Notes/%2e%2e/%2e%2e/x",
    "/etc/passwd",
    "/Users/me/vault/x.md",
    "C:\\Windows\\x",
    "C:/x",
    "\\\\server\\share\\x",
    "//server/share",
    "http://example.com/x",
    "https%3A//example.com",
    "javascript:alert(1)",
    "file:///etc/passwd",
    "data:text/plain,hi",
    "blob:abc",
    "a%00b",
    "a\u0000b",
    "style.css?v=1",
    "Notes /x.md",
    "Notes./x.md",
    "Notes/x.",
    "",
    "   ",
    "%e0%a4%a",
    "%C3%28",
  ];
  for (const attack of attacks) {
    it(`rejects ${JSON.stringify(attack)}`, () => {
      expect(["INVALID", "NOT_FOUND"]).toContain(code(attack));
      expect(code(attack)).not.toBe("OK");
    });
  }
  it("rejects non-strings", () => {
    for (const v of [null, undefined, 5, {}, [], true]) expect(code(v)).toBe("INVALID");
  });
  it("rejects over-long input", () => {
    expect(code("a/".repeat(600))).toBe("INVALID");
  });
});

describe("exclusions return NOT_FOUND", () => {
  it("built-in hidden folders", () => {
    for (const p of [".obsidian/plugins/x/data.json", ".git/config", ".trash/x.md", "Notes/.hidden/x.md", ".env"]) {
      expect(code(p)).toBe("NOT_FOUND");
    }
  });
  it("cannot be bypassed by encoding, separators or case", () => {
    expect(code("%2eobsidian/app.json")).toBe("NOT_FOUND");
    expect(code(".obsidian\\app.json")).toBe("NOT_FOUND");
    expect(code(".OBSIDIAN/app.json")).toBe("NOT_FOUND");
    expect(code("%252eobsidian/app.json")).toBe("NOT_FOUND");
  });
  it("user folder pattern matches at any depth, case-insensitively", () => {
    expect(code("Private/x.md")).toBe("NOT_FOUND");
    expect(code("Notes/Private/x.md")).toBe("NOT_FOUND");
    expect(code("PRIVATE/x.md")).toBe("NOT_FOUND");
    expect(code("Notes/private-ok.md")).toBe("OK");
  });
  it("user glob pattern", () => {
    expect(code("a/b/plan.secret.md")).toBe("NOT_FOUND");
    expect(code("a/b/plan.md")).toBe("OK");
  });
  it("anchored pattern only matches from the root", () => {
    expect(code("Data/hidden/x.json")).toBe("NOT_FOUND");
    expect(code("Data/hidden")).toBe("NOT_FOUND");
    expect(code("Other/Data/hidden/x.json")).toBe("OK");
  });
  it("matches regardless of Unicode form", () => {
    const opts = { ...base, exclusions: ["Caf\u00e9/"] };
    expect(code("cafe\u0301/x.md", opts)).toBe("NOT_FOUND");
  });
  it("gives the same code for excluded and missing-style failures", () => {
    const r = resolvePath("Private/x.md", base);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("NOT_FOUND");
  });
});

describe("./ fallback for an app's own files", () => {
  it("resolves from the app folder", () => {
    expect(ok("./style.css")).toBe("Apps/Calc/style.css");
    expect(ok(".\\js\\app.js")).toBe("Apps/Calc/js/app.js");
    expect(ok("./sub/./x.png")).toBe("Apps/Calc/sub/x.png");
  });
  it("is disabled by Strict paths", () => {
    const strict = { ...base, allowRelativeFallback: false };
    expect(code("./style.css", strict)).toBe("INVALID");
  });
  it("needs an app root", () => {
    expect(code("./style.css", { ...base, appRoot: undefined })).toBe("INVALID");
  });
  it("cannot climb out of the app folder", () => {
    expect(code("./../Other/x.md")).toBe("INVALID");
    expect(code("./%2e%2e/x")).toBe("INVALID");
  });
  it("still applies exclusions to the result", () => {
    expect(code("./.hidden/x")).toBe("NOT_FOUND");
    expect(code("./x.secret.md")).toBe("NOT_FOUND");
    expect(code("./style.css", { ...base, appRoot: ".obsidian/plugins" })).toBe("INVALID");
  });
  it("does not change plain root-relative paths", () => {
    expect(ok("style.css")).toBe("style.css");
  });
});
