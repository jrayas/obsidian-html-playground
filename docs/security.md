# Security notes

Status: skeleton. Updated as each safeguard is built.

## Trust model

Apps are untrusted (they may be AI-written or buggy). The host enforces every rule; an app cannot opt out.

## Safeguards

| Safeguard | Phase | Notes |
| --- | --- | --- |
| iframe `sandbox="allow-scripts"` only | 1 | Never `allow-same-origin` |
| CSP blocks all network by default | 1 | Domains need manifest `allowedDomains` AND global allow-list |
| Single path resolver | 1 | See [path-rule.md](path-rule.md) |
| Exclusion list (hidden folders, `.obsidian`, `.git`, `.trash`, the vault's configuration folder even if renamed to something not hidden, user globs) | 1 | Generic not-found; omitted from list and search |
| Message validation, rate and size limits | 2 (done: 2a, 2b) | Source window and nonce checked; private port |
| Per-app permissions | 2 (done: 2a, 2b) | Undeclared returns `DENIED`; denied write attempts are logged |
| Delete to trash | 2 (done: 2c) | `vault.trash` only; never `vault.delete`; "permanent" overridden to system trash |
| Bulk and folder confirmation | 2 (done: 2c) | Host dialog; deny by default; 60 s timeout |
| Snapshots and restore | 2 (done: 2b; restore UI in 2d) | Device-local IndexedDB; 20 per file, 50 MB, 30 days; fail closed |
| Write log | 2 (done: 2b; view in 2d) | App, action, path, time, result; written before the work; fail closed |
| `trusted` flag | 2 (done: 2d) | Off by default; user approval dialog; device-local; tied to a manifest hash; revocable in settings |
| Links, pickers, events | 2 (done: 2d) | Filtered to what the app may read; open and pick rate limited; events capped |
| API keys in local storage only | 3 | Never logged or shown |
| AI-generated badge and pre-live test case | 3 | |

## Write protection (step 2b)

- An app can only write inside folders listed in its own `writeScopes`; none declared means no writes.
- Apps can never write into the apps folder, their own folder, a folder holding a `manifest.json`, or any `manifest.json`. This blocks an app from granting itself permissions or editing another app.
- Writes are limited to text file types (no scripts, pages, styles or binaries).
- A write is refused if its snapshot or its audit entry cannot be stored.

## Destructive operations (step 2c)

- Deletes only ever go to a trash. The plugin never calls a permanent delete, whatever Obsidian's "Deleted files" setting says.
- Folder operations list the real directory first and refuse anything excluded, hidden or an app inside. Hidden folders such as `.git` cannot travel with a moved or deleted folder.
- Notes whose links Obsidian will rewrite are snapshotted first, including excluded ones. Case-insensitive name collisions are detected, so nothing is silently overwritten on macOS or Windows.
- Folder deletes and bulk moves need the user's approval in a dialog the app cannot reach.

## `trusted` flag: what it unlocks (active)

Only: writing outside `writeScopes` (vault-wide), 5x request rates, a 25 MB write size, and larger bulk operations. It never unlocks: exclusions, trash-only delete, snapshots, logging, the apps-folder and manifest write block, network access or the sandbox. Approval is stored on this device only (never synced) and tied to a hash of the manifest's permissions, scopes, domains, entry file and flag, so any change to them asks again. It is listed in Settings with a Revoke button.

## Known limitations

- Symlinks inside the vault that point outside it cannot be detected through Obsidian's API. Exclude such folders.
- Snapshots and the log live in this device's browser storage: they are not synced or backed up, and clearing Obsidian's site data deletes them.
- A snapshot of an excluded note cannot be restored through the Snapshots screen while the exclusion stands.
- If Obsidian's "Automatically update internal links" is off, moving a note that has incoming links is refused.
- Message size can only be checked after receipt, so a very large message is still received before it is rejected.
- `XMLHttpRequest` is not shimmed; use `fetch`.
- The `trusted` approval and the write log trust the local device. Anyone with access to your Obsidian profile can edit them.

## The Python worker (Python Rulebook)

The Python Rulebook runs code from vault notes and from the reader as real Python (Pyodide) in a Web Worker made from a blob inside the sandboxed iframe. What contains it:

- **No bridge, page or vault.** A worker has no `window`, `document`, `localStorage` or `window.bridge`, and the worker glue never forwards a bridge call. Python's own file system is in memory and cannot see the vault (tested).
- **No network.** Python can reach `XMLHttpRequest`, `WebSocket`, `importScripts` and `fetch` through the `js` module, because every worker has them. They are blocked by the page's content security policy, which a blob worker inherits (`connect-src 'none'`, no remote scripts). The end-to-end test tries all of them for real and checks each one failed as "csp" with no response. **If the CSP is ever loosened for an app (allowed domains), Python code in that app could use those domains.** The worker's own `fetch` only serves Pyodide's files from memory and refuses everything else.
- **Time limit.** A run is stopped by terminating the worker (5 seconds by default, or Stop). Memory is not limited.
- **Output.** Python's output is shown as text only, capped at 20,000 characters.
- **Supply chain.** Pyodide is vendored from a pinned npm version and checked file for file by a test.
