import { describe, expect, it } from "vitest";
import { escapeAttribute, fillMarkers, inlineStyleTag } from "../src/apps/refs";

describe("inlineStyleTag", () => {
  it("wraps CSS in a style element, with fixed attributes", () => {
    expect(inlineStyleTag("a{color:red}")).toBe("<style>a{color:red}</style>");
    expect(inlineStyleTag("a{}", { "data-hp": "theme" })).toBe('<style data-hp="theme">a{}</style>');
  });

  it("CSS cannot close the element early, in any letter case", () => {
    for (const hostile of ["</style><script>x()</script>", "</STYLE><script>x()</script>", "</ style", "a{} </Style >"]) {
      const out = inlineStyleTag(hostile);
      expect(out.slice("<style>".length, -"</style>".length), hostile).not.toMatch(/<\/style/i);
    }
  });

  it("attribute values cannot break out of their quotes", () => {
    const out = inlineStyleTag("a{}", { media: 'screen"onload="x()' });
    expect(out).toBe('<style media="screen&quot;onload=&quot;x()">a{}</style>');
    expect(escapeAttribute(`<&>"`)).toBe("&lt;&amp;&gt;&quot;");
  });
});

describe("fillMarkers", () => {
  const T = "a1b2c3";
  it("swaps each marker for its fragment, in order, in one pass", () => {
    const page = `<head><!--hp-${T}-0--><p></p><!--hp-${T}-1--></head>`;
    expect(fillMarkers(page, T, ["<style>A</style>", "<style>B</style>"])).toBe("<head><style>A</style><p></p><style>B</style></head>");
  });

  it("ignores markers with another token, so an app cannot forge one", () => {
    const forged = "<!--hp-ffffff-0--><!--hp-bootstrap-marker-->";
    expect(fillMarkers(`${forged}<!--hp-${T}-0-->`, T, ["X"])).toBe(`${forged}X`);
  });

  it("characters that mean something in a replacement string are inserted literally", () => {
    const out = fillMarkers(`<!--hp-${T}-0-->`, T, ["a{content:\"$&$1$$\"}"]);
    expect(out).toBe("a{content:\"$&$1$$\"}");
  });

  it("inserted text is not searched again, even if it looks like a marker", () => {
    const out = fillMarkers(`<!--hp-${T}-0--><!--hp-${T}-1-->`, T, [`<!--hp-${T}-1-->`, "second"]);
    expect(out).toBe(`<!--hp-${T}-1-->second`);
  });

  it("an index with no fragment becomes nothing, and a bad token is refused", () => {
    expect(fillMarkers(`a<!--hp-${T}-9-->b`, T, [])).toBe("ab");
    for (const bad of ["", "a.b", "(a|b)", "a-b", ".*"]) expect(() => fillMarkers("x", bad, []), bad).toThrow(/Invalid marker token/);
  });
});
