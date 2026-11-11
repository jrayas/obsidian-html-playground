// Mirrors the Obsidian community plugin scanner (eslint-plugin-obsidianmd). Run `npm run lint` from the project root.
import { defineConfig, globalIgnores } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
  { languageOptions: { parserOptions: { projectService: { allowDefaultProject: ["eslint.config.*", "vitest.config.mts"] }, tsconfigRootDir: import.meta.dirname } } },
  ...obsidianmd.configs.recommended,
  {
    files: ["**/*.{ts,cts,mts,tsx,js,cjs,mjs,jsx}"],
    rules: {
      // Security: keep as errors.
      "no-eval": "error",
      "no-unsanitized/method": "error",
      "no-unsanitized/property": "error",
      "obsidianmd/regex-lookbehind": "error",
      "obsidianmd/no-forbidden-elements": "error",
      // Covered by TypeScript or too noisy (as the scanner does).
      "no-undef": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/restrict-template-expressions": "off",
      "@typescript-eslint/no-base-to-string": "off",
      "import/no-unresolved": "off",
      "obsidianmd/commands/no-command-in-command-id": "off",
      "obsidianmd/commands/no-plugin-id-in-command-id": "off",
    },
  },
  { files: ["manifest.json"], rules: { "obsidianmd/validate-manifest": "off" } },
  { files: ["LICENSE"], rules: { "obsidianmd/validate-license": "off" } },
  { linterOptions: { reportUnusedDisableDirectives: "off", reportUnusedInlineConfigs: "off" } },
  globalIgnores([
    "node_modules", "dist", "main.js", "esbuild.config.mjs", "examples",
  ]),
]);
