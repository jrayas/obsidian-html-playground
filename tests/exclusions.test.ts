import { describe, expect, it } from "vitest";
import { isExcluded } from "../src/paths/exclusions";

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
