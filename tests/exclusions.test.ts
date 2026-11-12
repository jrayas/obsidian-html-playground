import { describe, expect, it } from "vitest";
import { resolvePath } from "../src/paths/resolver";
import { configDirPattern, isExcluded, withConfigDir } from "../src/paths/exclusions";

describe("isExcluded", () => {
  it("always excludes hidden segments, even with no user patterns", () => {
    for (const p of [".obsidian", ".obsidian/x", ".git/HEAD", ".trash/a.md", "a/.b/c", ".env", "a/./b", "a/../b"]) {
      expect(isExcluded(p, [])).toBe(true);
    }
  });
  it("allows ordinary paths", () => {
    expect(isExcluded("Notes/a.md", [])).toBe(false);
    expect(isExcluded("Apps/Calc/index.html", ["Private/"])).toBe(false);
  });
  it("ignores blank and comment patterns", () => {
    expect(isExcluded("Notes/a.md", ["", "   ", "# Notes"])).toBe(false);
  });
  it("supports ?, * and **", () => {
    expect(isExcluded("a/b1.md", ["b?.md"])).toBe(true);
    expect(isExcluded("a/b12.md", ["b?.md"])).toBe(false);
    expect(isExcluded("Data/x/y/z.json", ["Data/**/z.json"])).toBe(true);
    expect(isExcluded("Data/x/z.json", ["Data/*/z.json"])).toBe(true);
    expect(isExcluded("Data/x/y/z.json", ["Data/*/z.json"])).toBe(false);
  });
  it("treats regex characters in patterns literally", () => {
    expect(isExcluded("a/b(1).md", ["b(1).md"])).toBe(true);
    expect(isExcluded("a/bX.md", ["b.md"])).toBe(false);
    expect(isExcluded("a/b+c.md", ["b+c.md"])).toBe(true);
  });
  it("supports a leading slash to anchor at the root", () => {
    expect(isExcluded("Secret/x.md", ["/Secret"])).toBe(true);
    expect(isExcluded("Notes/Secret/x.md", ["/Secret"])).toBe(false);
  });
  it("is case-insensitive", () => {
    expect(isExcluded("PRIVATE/x.md", ["private/"])).toBe(true);
  });
});

describe("the vault configuration folder", () => {
  it("makes a root-anchored pattern, and nothing for an empty name", () => {
    expect(configDirPattern(".obsidian")).toBe("/.obsidian/");
    expect(configDirPattern("Config")).toBe("/Config/");
    expect(configDirPattern("  /Settings\\Obsidian/  ")).toBe("/Settings/Obsidian/");
    for (const empty of ["", "   ", "/", "//", undefined]) expect(configDirPattern(empty), String(empty)).toBeNull();
  });

  it("hides a renamed, non-hidden config folder at any case, and everything inside it", () => {
    const list = withConfigDir([], "Config");
    for (const p of ["Config", "Config/app.json", "config/APP.json", "CONFIG/plugins/x/main.js"]) expect(isExcluded(p, list), p).toBe(true);
  });

  it("is anchored at the vault root: similar names elsewhere are not hidden", () => {
    const list = withConfigDir([], "Config");
    for (const p of ["Notes/Config/x.md", "Configuration/x.md", "Config2/x.md", "Mycon/Config.md"]) expect(isExcluded(p, list), p).toBe(false);
  });

  it("handles a config folder that is itself nested", () => {
    const list = withConfigDir([], "Settings/Obsidian");
    expect(isExcluded("Settings/Obsidian/plugins/a/main.js", list)).toBe(true);
    expect(isExcluded("Settings/other.md", list)).toBe(false);
    expect(isExcluded("Settings", list)).toBe(false);
  });

  it("keeps the user's patterns first and unchanged, and never removes anything", () => {
    const user = ["Private/", "*.secret.md"];
    expect(withConfigDir(user, "Config")).toEqual(["Private/", "*.secret.md", "/Config/"]);
    expect(withConfigDir(user, "")).toEqual(user);
    expect(withConfigDir(user, undefined)).toEqual(user);
    expect(user).toEqual(["Private/", "*.secret.md"]); // the input is not modified
    expect(isExcluded("Private/a.md", withConfigDir(user, "Config"))).toBe(true);
  });

  it("the resolver then answers the same generic NOT_FOUND as for any other hidden path", () => {
    const list = withConfigDir([], "Config");
    const hidden = resolvePath("Config/app.json", { appRoot: "Apps/T", allowRelativeFallback: false, exclusions: list });
    const builtIn = resolvePath(".obsidian/app.json", { appRoot: "Apps/T", allowRelativeFallback: false, exclusions: list });
    expect(hidden.ok).toBe(false);
    expect(hidden.ok === false && hidden.code).toBe("NOT_FOUND");
    expect(hidden).toEqual(builtIn); // indistinguishable from a built-in hidden path
  });
});
