import { describe, expect, it } from "vitest";
import { buildCsp, effectiveDomains } from "../src/apps/csp";
import { dirname, parseManifest, substituteAppRoot } from "../src/apps/manifest";
import { classifyRef, escapeInlineScript, hasRelativeModuleImport, isFont, mimeFor } from "../src/apps/refs";
import { rewriteCss } from "../src/apps/css";

describe("parseManifest", () => {
  it("applies defaults", () => {
    const r = parseManifest('{"name":"Calc"}');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.manifest).toMatchObject({
        name: "Calc",
        version: "0.0.0",
        entry: "index.html",
        permissions: [],
        trusted: false,
        aiGenerated: false,
        allowedDomains: [],
      });
    }
  });
  it("rejects bad JSON, non-objects and missing names", () => {
    expect(parseManifest("{").ok).toBe(false);
    expect(parseManifest("[]").ok).toBe(false);
    expect(parseManifest('{"name":""}').ok).toBe(false);
    expect(parseManifest('{"version":"1"}').ok).toBe(false);
  });
  it("drops invalid permissions and domains with warnings (never widens)", () => {
    const r = parseManifest('{"name":"A","permissions":["files.read","../x",5],"allowedDomains":["API.Example.com","*.evil.com","http://x.com"]}');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.manifest.permissions).toEqual(["files.read"]);
      expect(r.manifest.allowedDomains).toEqual(["api.example.com"]);
      expect(r.warnings.length).toBe(4);
    }
  });
  it("treats a non-boolean trusted flag as false", () => {
    const r = parseManifest('{"name":"A","trusted":"yes"}');
    expect(r.ok && r.manifest.trusted).toBe(false);
  });
});

describe("appRoot helpers", () => {
  it("substitutes the placeholder", () => {
    expect(substituteAppRoot("{{appRoot}}/a.css and {{ appRoot }}/b.js", "Apps/X")).toBe("Apps/X/a.css and Apps/X/b.js");
  });
  it("finds the folder", () => {
    expect(dirname("Apps/Calc/manifest.json")).toBe("Apps/Calc");
    expect(dirname("manifest.json")).toBe("");
  });
});

describe("CSP", () => {
  it("blocks the network by default", () => {
    const csp = buildCsp([]);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).not.toMatch(/https?:/);
  });
  it("opens only domains present in both lists", () => {
    expect(effectiveDomains(["a.com", "b.com"], ["b.com", "c.com"])).toEqual(["b.com"]);
    expect(effectiveDomains(["a.com"], [])).toEqual([]);
    expect(effectiveDomains(["*.a.com", "a.com/x"], ["*.a.com", "a.com/x"])).toEqual([]);
  });
  it("never allows remote scripts or styles", () => {
    const csp = buildCsp(["api.example.com"]);
    expect(csp).toContain("connect-src https://api.example.com");
    expect(csp).toMatch(/script-src 'unsafe-inline' 'unsafe-eval'(;|$)/);
    expect(csp).toMatch(/style-src 'unsafe-inline'(;|$)/);
  });
});

describe("refs", () => {
  it("classifies references", () => {
    expect(classifyRef("#top")).toBe("keep");
    expect(classifyRef("data:image/png;base64,xx")).toBe("keep");
    expect(classifyRef("https://x.com/a.js")).toBe("remote");
    expect(classifyRef("//cdn.x.com/a.js")).toBe("remote");
    expect(classifyRef("javascript:alert(1)")).toBe("blocked");
    expect(classifyRef("file:///etc/passwd")).toBe("blocked");
    expect(classifyRef("./a.css")).toBe("local");
    expect(classifyRef("{{appRoot}}/a.css")).toBe("local");
  });
  it("detects fonts and mime types", () => {
    expect(isFont("a/b.WOFF2")).toBe(true);
    expect(isFont("a/b.png")).toBe(false);
    expect(mimeFor("x.svg")).toBe("image/svg+xml");
  });
  it("escapes script terminators", () => {
    expect(escapeInlineScript("a</script>b<!--c")).toBe("a<\\/script>b<\\!--c");
  });
  it("detects relative module imports", () => {
    expect(hasRelativeModuleImport("import { a } from './a.js';")).toBe(true);
    expect(hasRelativeModuleImport("import './a.js'")).toBe(true);
    expect(hasRelativeModuleImport("const m = await import('./a.js')")).toBe(true);
    expect(hasRelativeModuleImport("const x = 1; // important stuff")).toBe(false);
  });
});

describe("rewriteCss", () => {
  const files: Record<string, string> = {
    "a.css": "@import './b.css'; .a { background: url(./img.png); }",
    "b.css": "@import './a.css'; .b { src: url('./f.woff2'); }",
  };
  const hooks = {
    assetUrl: async (ref: string) => (ref.includes("missing") ? null : `data:x/${ref.replace(/\W/g, "")}`),
    loadCss: async (ref: string) => {
      const id = ref.replace("./", "");
      return files[id] ? { id, text: files[id] } : null;
    },
  };

  it("replaces url() and inlines @import, surviving cycles", async () => {
    const warnings: string[] = [];
    const out = await rewriteCss(files["a.css"], hooks, (m) => warnings.push(m), new Set(["a.css"]));
    expect(out).toContain('url("data:x/imgpng")');
    expect(out).toContain('url("data:x/fwoff2")');
    expect(out).not.toContain("@import");
    expect(warnings).toEqual([]);
  });
  it("leaves remote and data urls, blanks unresolved and blocked ones", async () => {
    const warnings: string[] = [];
    const css = ".x{background:url(https://a.com/x.png)} .y{background:url(data:image/png;base64,AA)} .z{background:url(./missing.png)} .w{background:url(javascript:1)}";
    const out = await rewriteCss(css, hooks, (m) => warnings.push(m));
    expect(out).toContain("url(https://a.com/x.png)");
    expect(out).toContain("url(data:image/png;base64,AA)");
    expect(out).toContain('.z{background:url("")}');
    expect(out).toContain('.w{background:url("")}');
    expect(warnings.length).toBe(1);
  });
});
