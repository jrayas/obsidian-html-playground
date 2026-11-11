import { describe, expect, it } from "vitest";
import { isExcluded } from "../src/paths/exclusions";
import { addPattern, describePattern, filePattern, folderPattern, removePattern } from "../src/paths/patterns";
import { resolvePath } from "../src/paths/resolver";

describe("patterns made from a picked folder or file", () => {
  it("anchor at the vault root", () => {
    expect(folderPattern("Notes/Private")).toBe("/Notes/Private/");
    expect(folderPattern("Private")).toBe("/Private/");
    expect(folderPattern("Notes\\Private\\")).toBe("/Notes/Private/");
    expect(filePattern("Notes/plan.md")).toBe("/Notes/plan.md");
  });

  it("a picked folder hides that folder and everything in it, and nothing elsewhere", () => {
    const list = [folderPattern("Notes/Private")];
    for (const hidden of ["Notes/Private", "Notes/Private/a.md", "Notes/Private/deep/b.md", "notes/private/A.MD"]) {
      expect(isExcluded(hidden, list), hidden).toBe(true);
    }
    for (const visible of ["Archive/Private/a.md", "Notes/PrivateBlog/a.md", "Notes/a.md", "Private/a.md"]) {
      expect(isExcluded(visible, list), visible).toBe(false);
    }
  });

  it("a picked top-level folder is anchored too (not 'any folder with that name')", () => {
    const list = [folderPattern("Private")];
    expect(isExcluded("Private/x.md", list)).toBe(true);
    expect(isExcluded("Notes/Private/x.md", list)).toBe(false);
  });

  it("a picked file hides only that file", () => {
    const list = [filePattern("Notes/plan.md")];
    expect(isExcluded("Notes/plan.md", list)).toBe(true);
    expect(isExcluded("Notes/plan.md.bak", list)).toBe(false);
    expect(isExcluded("Other/Notes/plan.md", list)).toBe(false);
    expect(isExcluded("Notes/plan2.md", list)).toBe(false);
  });

  it("works through the single resolver, so apps get NOT_FOUND", () => {
    const opts = { allowRelativeFallback: false, exclusions: [folderPattern("Notes/Private")] };
    expect(resolvePath("Notes/Private/a.md", opts)).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(resolvePath("Notes/Private/../Private/a.md", opts)).toMatchObject({ ok: false, code: "INVALID" });
    expect(resolvePath("Notes/Public/a.md", opts)).toMatchObject({ ok: true });
  });

  it("round-trips names with spaces and unicode", () => {
    const list = [folderPattern("My Notes/café")];
    expect(isExcluded("my notes/café/x.md", list)).toBe(true);
  });
});

describe("describePattern", () => {
  it("says what each kind of entry hides", () => {
    expect(describePattern("/Notes/Private/")).toMatchObject({ kind: "folder", label: "Notes/Private" });
    expect(describePattern("/Notes/plan.md")).toMatchObject({ kind: "file", label: "Notes/plan.md" });
    expect(describePattern("Private/")).toMatchObject({ kind: "anywhere", label: "Private/" });
    expect(describePattern("*.secret.md")).toMatchObject({ kind: "glob", label: "*.secret.md" });
    expect(describePattern("Data/hidden")).toMatchObject({ kind: "folder" });
    expect(describePattern("Notes/*/draft.md").kind).toBe("glob");
  });
});

describe("addPattern", () => {
  it("adds a valid pattern and keeps the order", () => {
    const r = addPattern(["a/"], "  *.secret.md  ");
    expect(r).toEqual({ ok: true, list: ["a/", "*.secret.md"] });
  });

  it("refuses blanks, comments and over-long input", () => {
    for (const bad of ["", "   ", "# note", "x".repeat(201)]) expect(addPattern([], bad).ok, bad).toBe(false);
  });

  it("refuses anything that would hide the whole vault", () => {
    for (const bad of ["*", "**", "/", ".", "./", "*/", "**/**", "?", "/*"]) {
      const r = addPattern([], bad);
      expect(r.ok, bad).toBe(false);
      if (!r.ok) expect(r.reason).toContain("everything");
    }
  });

  it("refuses duplicates, ignoring case, Unicode form and slashes style", () => {
    expect(addPattern(["/Notes/Private/"], "/notes/private/")).toMatchObject({ ok: false, reason: "Already in the list." });
    expect(addPattern(["/Notes/Private/"], "\\Notes\\Private\\")).toMatchObject({ ok: false });
    expect(addPattern(["/café/"], "/café/").ok).toBe(false);
  });

  it("refuses to hide the apps folder, which would stop every app loading", () => {
    for (const bad of ["Apps/", "/Apps/", "/Apps", "Apps", "*", "A*s/", "**/index.html", "index.html", "*.html"]) {
      expect(addPattern([], bad, ["Apps"]).ok, bad).toBe(false);
    }
    expect(addPattern([], "/Apps/Calculator/", ["Apps"]).ok).toBe(true); // switching ONE app off is allowed
    expect(addPattern([], "Notes/", ["Apps"]).ok).toBe(true);
    expect(addPattern([], "/AppsArchive/", ["Apps"]).ok).toBe(true);
  });

  it("removes exactly the chosen entry", () => {
    expect(removePattern(["a/", "b/", "c/"], "b/")).toEqual(["a/", "c/"]);
    expect(removePattern(["a/"], "z/")).toEqual(["a/"]);
  });
});
