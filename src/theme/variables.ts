/** Obsidian theme colours as CSS variables for apps. Read from the host's computed styles so community themes work. */

export const THEME_VAR_NAMES: readonly string[] = [
  "--background-primary",
  "--background-primary-alt",
  "--background-secondary",
  "--background-secondary-alt",
  "--background-modifier-border",
  "--background-modifier-hover",
  "--background-modifier-form-field",
  "--background-modifier-error",
  "--text-normal",
  "--text-muted",
  "--text-faint",
  "--text-on-accent",
  "--text-accent",
  "--text-accent-hover",
  "--text-error",
  "--text-success",
  "--text-warning",
  "--interactive-normal",
  "--interactive-hover",
  "--interactive-accent",
  "--interactive-accent-hover",
  "--color-red",
  "--color-orange",
  "--color-yellow",
  "--color-green",
  "--color-cyan",
  "--color-blue",
  "--color-purple",
  "--font-text",
  "--font-interface",
  "--font-monospace",
  "--font-text-size",
  "--radius-s",
  "--radius-m",
  "--radius-l",
];

export interface ThemeSnapshot {
  mode: "light" | "dark";
  vars: Record<string, string>;
}

/** Values are inserted into a <style> element, so refuse anything that could break out of it. */
const SAFE_VALUE = /^[^<>{};]*$/;

export function readTheme(): ThemeSnapshot {
  const style = getComputedStyle(document.body);
  const vars: Record<string, string> = {};
  for (const name of THEME_VAR_NAMES) {
    const value = style.getPropertyValue(name).trim();
    if (value !== "" && SAFE_VALUE.test(value)) vars[name] = value;
  }
  return { mode: document.body.classList.contains("theme-dark") ? "dark" : "light", vars };
}

/** CSS text applied before the app runs, so there is no flash of the wrong colours. */
export function themeToCss(theme: ThemeSnapshot): string {
  const lines = Object.entries(theme.vars).map(([k, v]) => `  ${k}: ${v};`);
  return `:root {\n  color-scheme: ${theme.mode};\n${lines.join("\n")}\n}\nbody { background: var(--background-primary); color: var(--text-normal); font-family: var(--font-text, sans-serif); }`;
}
