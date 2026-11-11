import { MarkdownRenderChild, type MarkdownPostProcessorContext } from "obsidian";
import { DEFAULT_EMBED_HEIGHT, paramsObject, parseEmbedBlock } from "./embedBlock";
import { AppRunner } from "./runner";
import type HtmlPlaygroundPlugin from "../main";

/**
 * Optional note embedding. In a note:
 *
 *   App: Formula calculator          <- plain-text fallback, readable without the plugin
 *   ```html-playground
 *   Apps/Calculator
 *   height: 420
 *   ```
 *
 * The first line is the app folder (or a manifest.json path). Further `name: value` lines are
 * parameters the app can read with embed.context (see embedBlock.ts). Without the plugin the fence
 * simply shows that path.
 */
export function registerEmbed(plugin: HtmlPlaygroundPlugin): void {
  plugin.registerMarkdownCodeBlockProcessor("html-playground", (source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) => {
    const parsed = parseEmbedBlock(source);
    if (!parsed.ok) {
      el.createDiv({ cls: "hp-error", text: parsed.error });
      return;
    }
    const { target, height, params } = parsed.block;

    const manifestPath = target.toLowerCase().endsWith(".json") ? target : `${target.replace(/\/+$/, "")}/manifest.json`;
    // "auto" height arrives in a later step; until then it uses the default fixed height.
    const runner = new AppRunner(plugin, el, {
      height: height === "auto" ? DEFAULT_EMBED_HEIGHT : height,
      embed: { sourcePath: ctx.sourcePath, params: paramsObject(params) },
    });
    const child = new MarkdownRenderChild(el);
    child.onunload = () => runner.dispose();
    ctx.addChild(child);
    void runner.load(manifestPath);
  });
}
