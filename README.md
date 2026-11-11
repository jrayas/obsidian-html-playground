# HTML Playground

Run small apps made of plain HTML, CSS and JavaScript that live in your vault. Each app runs in a sandbox with no network access, and reaches your notes only through a bridge that checks every request.

Other plugins show an HTML file. This one lets an HTML app **work with your notes** (read them, list them, edit front matter, react to changes) while you stay in control of exactly what it may touch.

## What you can do

- Open an app in its own tab, or embed it in a note.
- Give an app only the folders and operations it needs. Anything else is refused.
- See and undo what apps changed: every write is logged, and the old text is saved first.

## Install

**From the community list** (once accepted): *Settings, Community plugins, Browse*, search for "HTML Playground", install and enable.

**Manually:** download `main.js`, `manifest.json` and `styles.css` from the latest [release](https://github.com/jrayas/obsidian-html-playground/releases) into `<vault>/.obsidian/plugins/html-playground/`, then enable the plugin.

**With BRAT:** add `jrayas/obsidian-html-playground`.

Turn on **Settings, Files and links, Automatically update internal links**. Apps that move or rename notes rely on it. If it is off, moving a note that other notes link to is refused, so links cannot silently break.

## Quick start

1. Copy the folder [`examples/hello-app`](examples/hello-app) into your vault as `Apps/Hello` (the default apps folder is `Apps`).
2. Run the command **Open app** and choose *Hello*.
3. To embed it in a note, add:

````
```html-playground
Apps/Hello
height: 300
greeting: Hello from my note
```
````

The first line is the app folder. Extra `name: value` lines are **parameters** the app can read. A line above the block such as `App: Hello` is a plain-text fallback for when the plugin is off.

## Commands

| Command | What it does |
| --- | --- |
| Open app | Choose an app (any folder under your apps folder with a `manifest.json`) and open it in a tab |
| Reload current app | Reload the active app |
| Open app in the active note's folder | Open the app next to the current note |
| Show snapshots | Browse and restore the copies kept before apps changed notes |
| Open bridge log | See every write apps made, and every one they tried and were refused |

## Writing an app

An app is a folder with an `index.html`, any CSS, JavaScript, images and fonts it needs (bundled locally), and a `manifest.json`:

```json
{
  "name": "Calculator",
  "version": "1.0.0",
  "entry": "index.html",
  "permissions": ["files.read", "frontmatter.read", "files.edit"],
  "readScopes": ["Notes", "Data"],
  "writeScopes": ["Notes/Calculations"]
}
```

- `permissions`: exact operation names. Anything not listed returns `DENIED`.
- `readScopes`: folders the app may read (omit for the whole vault, minus your exclusions). Its own folder is always readable.
- `writeScopes`: folders the app may write. **Required for any write** unless you approve the app as trusted.

In the app:

```js
await bridge.ready;
const { content } = await bridge.call("files.read", { path: "Notes/Pump sizing.md" });
await bridge.call("frontmatter.update", { path: "Notes/Pump sizing.md", set: { reviewed: true } });
bridge.on("theme", (t) => { /* t.mode is "light" or "dark" */ });
```

Use the theme variables (`var(--background-primary)`, `var(--text-normal)`, `var(--interactive-accent)` and so on) so the app follows light, dark and community themes. Keep apps light and touch-friendly: the plugin works on mobile.

Reference: [bridge API](docs/bridge-api.md), [path rule](docs/path-rule.md), [safeguards](docs/security.md).

## Settings

| Setting | Meaning |
| --- | --- |
| Apps folder | Where **Open app** looks for `manifest.json` files |
| Strict paths | Turns off the `./` shortcut for an app's own files |
| Excluded paths | What apps can never see. Built-in defaults (`.obsidian`, `.git`, `.trash`, any hidden folder or file) cannot be removed. Add your own folders, files or patterns |
| Allowed network domains | Global allow-list. A domain must also be in the app's manifest. **Empty by default** |
| Asset mode | Auto, blob URLs or inline data |
| Snapshots per file, size cap, age limit | How much is kept (defaults 20, 50 MB, 30 days) |
| Write log entries | How many writes the log remembers (default 5,000) |
| Trusted apps | Apps you approved as trusted on this device, with Revoke |

Exclusions hide things from **apps** only. They do not hide anything in Obsidian itself. An excluded path looks exactly like a missing one to an app.

## How it keeps your notes safe

- Apps run in an iframe with `sandbox="allow-scripts"` only (never same-origin) under a Content Security Policy that blocks all network access by default.
- An app can only send requests over a private channel the plugin sets up. Every request is checked for a declared permission, a valid path, your exclusions, the app's folder scopes and rate limits.
- Writes always go through Obsidian's own file APIs. Before an app edits, moves or deletes a note, the plugin saves a copy. Deletes go to Obsidian's trash, never permanently. Deleting a folder, or touching more than 10 files, asks you first.
- An app cannot write inside the apps folder or to any `manifest.json`, so it cannot rewrite itself.
- Notes cannot give an app extra power. When an app is embedded, the note's parameters are plain text for the app to read, and grant nothing.

Details: [security.md](docs/security.md).

## Privacy and disclosures

- **Network:** the plugin makes no network requests of its own. Apps have none either, unless you add a domain to the global allow-list **and** the app's manifest lists it. Remote scripts and styles are never allowed.
- **No telemetry, no ads, no payments, no account.**
- **Code that runs:** each app's page is built from the app's own files (its HTML, CSS and scripts) plus one fixed bootstrap script that belongs to this plugin. All of it runs only inside the sandboxed iframe. The plugin never downloads code, and remote scripts and styles are never allowed.
- **Listing notes:** an app that you give the file listing or search permissions can see the paths of notes inside its folder scopes (and nothing excluded). It cannot do so without declaring that permission.
- **Verify a release:** the release files carry GitHub build attestations, so you can check they were built from this repository with `gh attestation verify main.js --repo jrayas/obsidian-html-playground`.
- **Files:** the plugin reads and writes vault files only on behalf of an app, within that app's declared permissions and scopes. It does not read or write files outside your vault. For folder moves and deletes it lists a folder's contents from disk (read-only) so that hidden items are not moved or deleted unseen.
- **Stored on your device (not in your vault, not synced):** snapshots and the write log (in the browser database), and which apps you approved as trusted (in local storage).

## Compatibility

Works on desktop and mobile (`isDesktopOnly` is false). Tested on macOS desktop and an Android emulator. Needs Obsidian 1.5.7 or later.

## Development

```
npm ci
npm run build    # typecheck, then bundle to main.js
npm test
npm run lint     # the same checks Obsidian's community plugin scanner runs
```

Copy or symlink the folder to `<vault>/.obsidian/plugins/html-playground/` to try a build.

## Licence

[MIT](LICENSE)
