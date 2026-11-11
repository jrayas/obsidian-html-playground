# Bridge API reference

Every operation below is implemented and tested.

## From an app

The bootstrap script gives every app `window.bridge`:

```js
await bridge.ready;                                    // resolves once the host has connected
const { content } = await bridge.call("files.read", { path: "Notes/Pump sizing.md" });
const off = bridge.on("theme", (t) => { /* t.mode, t.vars */ });
```

`bridge.call` rejects with an `Error` whose `.code` is one of the codes below.

## Envelope (v1)

```
Request:  { v: 1, id: string, type: "request",  op: string, args: object }
Response: { v: 1, id: string, type: "response", ok: boolean, result?: any, error?: { code, message } }
Event:    { v: 1, type: "event", name: string, payload: any }
```

Traffic runs over a private `MessageChannel` port the host transfers after a verified handshake. Malformed messages are ignored, never answered.

## Error codes

| Code | Meaning |
| --- | --- |
| `NOT_FOUND` | Missing, excluded, hidden or outside the app's read scope. The four are indistinguishable by design |
| `DENIED` | Operation not declared, too many subscriptions, write outside `writeScopes`, a write into an app folder or to a `manifest.json`, a folder holding items the app may not change, the user refusing a confirmation, or rate limiting (message says "Rate limit exceeded") |
| `INVALID` | Bad arguments, an unsafe path (`..`, absolute, URL, forbidden characters), a file type that may not be written, "Already exists", a stale `ifUnmodifiedSince`, or a forbidden key |
| `UNSUPPORTED` | Unknown operation, or known but not built yet |
| `TOO_LARGE` | Over a size limit |
| `INTERNAL` | Unexpected error. The message is always generic |

Messages never contain paths or app-supplied text.

## Request pipeline (every request, in order)

1. Envelope check (ignore if malformed)
2. Rate limit and in-flight cap (reads and writes have separate budgets)
3. Known operation? else `UNSUPPORTED`
4. Declared in the manifest `permissions`? else `DENIED` (only `theme.get` and `embed.context` are always allowed)
5. Implemented? else `UNSUPPORTED`
6. Handler: validate arguments, resolve every path with the single resolver (exclusions, `..`, encoding), apply read scope, do the work
7. Respond

## Paths

All paths are vault-root-relative (`Notes/Pump sizing.md`). `./file` resolves from the app's own folder unless **Strict paths** is on. `""` or `/` means the vault root, accepted only where noted. See `path-rule.md`.

## Permissions and scopes

`permissions` in `manifest.json` lists exact operation names (no wildcards). Optional:

- `readScopes`: vault folders the app may read. Omitted means the whole vault (minus exclusions). The app's own folder is always readable. A malformed list means nothing is readable, never everything.
- `writeScopes`: vault folders the app may write. **Required for any write** unless the app is trusted (not active yet). No `writeScopes` means no writes. A write path must also be readable by the app.

Out-of-scope paths behave exactly like missing ones.

## Limits

| Limit | Value (trusted apps: rates x5, nothing else changes) |
| --- | --- |
| Read text file | 5 MB |
| Read binary file | 10 MB |
| Parse text (JSON, Markdown) | 1 MB; YAML 256 KB |
| App storage | 1 MB |
| List entries | 5,000 (`truncated: true` if cut off) |
| Search | 200 results, 5,000 files scanned, 2 s, text files up to 1 MB |
| Rate (reads) | burst 100, 50 per second |
| Rate (writes) | burst 20, 10 per second |
| Write text | 5 MB (UTF-8 bytes); trusted apps 25 MB |
| Front matter patch | 64 KB, depth 10, 5,000 nodes |
| Files per move or delete | confirm above 10; refused above 50 (trusted apps: 200) |
| Open, pick | burst 5, then one every 5 seconds |
| Event subscriptions | 20 per app; 50 events a second |
| Backlinks or outgoing links returned | 1,000 |
| Entries examined in a folder | 1,000 |
| Requests in flight | 20 |

## Operations implemented

### files
| Op | Args | Result |
| --- | --- | --- |
| `files.read` | `path` | `{ content, mtime, size }` |
| `files.readBinary` | `path` | `{ data: ArrayBuffer, mtime, size }` (transferred, not copied) |
| `files.exists` | `path` (root allowed) | `{ exists: false }` or `{ exists: true, type: "file" \| "folder" }`. Missing, excluded and out-of-scope all answer false |
| `files.list` | `path` (root allowed), `recursive?` | `{ entries: [{ path, type, size?, mtime? }], truncated }`. Excluded, hidden and out-of-scope entries are omitted |
| `files.search` | `query` (1 to 200 chars), `folder?`, `limit?` | `{ hits: [{ path, match: "name" \| "content", snippet? }], truncated }` |

### formats (pure helpers, no vault access; each still needs declaring)
`formats.parseYaml {text}`, `formats.stringifyYaml {value}`, `formats.parseJson {text}`, `formats.stringifyJson {value, indent?}`, `formats.parseMarkdown {text}` returning `{ hasFrontmatter, frontmatter, body }`, `formats.writeMarkdown {frontmatter?, body}` returning `{ text }`. Bad YAML or JSON gives `INVALID`.

### frontmatter
`frontmatter.read {path}` returns `{ frontmatter }` from Obsidian's metadata cache (it can lag a moment behind a fresh edit).

### storage
`storage.read {}` returns `{ value }`, the parsed content of the app's own `data.json`, or `{ value: null }` if it has none.

### theme
`theme.get {}` returns `{ mode: "light" | "dark", vars }`. No permission needed. The `theme` event is pushed on connection and on every theme change.

### embed.context
`embed.context {}` returns `{ embedded, sourcePath, params }`. No permission needed, read-only, and it grants nothing.

- In a tab: `{ embedded: false, sourcePath: null, params: {} }`.
- In a note embed: `embedded` is `true`; `params` holds the `name: value` lines the note gave the app (plain text, see below); `sourcePath` is the note's vault path **only if this app could read that note anyway** (single resolver, exclusions, read scope), otherwise `null`. An excluded or out-of-scope note is indistinguishable from "no readable note".
- The context is fixed when the app loads. The note can only describe the app's placement; it cannot grant permissions, scopes, trust or network, which come only from the manifest and your device-local approval.
- Treat `params` as untrusted data: show it with `textContent`, never `innerHTML`. Names are `a-z`, digits, `-`, `_` (up to 32 characters), values up to 200 characters, at most 20 parameters, and `__proto__`, `constructor` and `prototype` are refused.

```
App: PCB Rulebook, microstrip calculator
```html-playground
Apps/PCB Rulebook
height: 400
widget: microstrip
```
```

`height` (fixed pixels, 120 to 2000) is reserved. `height: auto` and `id` are accepted and checked now, and take effect in a later release.

### Write operations (step 2b)

Every write is logged (app, operation, paths, time, result; never content), takes a snapshot first where it changes an existing note, and is refused if the snapshot or the log cannot be stored.

| Op | Args | Result | Notes |
| --- | --- | --- | --- |
| `files.create` | `path`, `content` | `{ path }` | Never overwrites (`INVALID` if it exists). Creates missing parent folders. Text types only: `md txt json yaml yml csv canvas svg` |
| `files.edit` | `path`, `content`, `mode?` (`overwrite` default, or `append`), `ifUnmodifiedSince?` (ms) | `{ mtime, size }` | Snapshots the old text first. `append` is an atomic read-modify-write. `ifUnmodifiedSince` refuses the write if the file changed after that time |
| `files.createFolder` | `path` | `{ path, created }` | Idempotent. Creates parents |
| `frontmatter.update` | `path` (a `.md` note), `set?` (object), `remove?` (list of keys) | `{ updated, removed }` | Snapshots the note, then edits only the YAML block via Obsidian. The body is left byte-identical. Keys `__proto__`, `constructor`, `prototype` are rejected at any depth |
| `storage.write` | `value` (any JSON) | `{ size }` | Writes the app's own `data.json` (up to 1 MB). The only write an app may make inside its own folder |

Writes are never allowed into the apps folder, the app's own folder, any folder holding a `manifest.json`, or to any file named `manifest.json`.

### Destructive operations (step 2c)

Same checks as writes, plus the rules below.

| Op | Args | Result | Notes |
| --- | --- | --- | --- |
| `files.rename` | `from`, `to` | `{ path }` | `to` must be in the same folder as `from` |
| `files.move` | `from`, `to` | `{ path }` | May change folder; creates missing parents |
| `files.delete` | `path` | `{ trashed: true }` | Always to a trash, never permanent. A snapshot is taken first |

Details every app author should know:

- Both ends must be inside `writeScopes`. The scope folder itself cannot be moved or deleted.
- Nothing is overwritten. A destination that exists, in any letter case, gives `INVALID`.
- A single file must be a text type, and a move cannot change its type.
- A folder is refused (`DENIED`, "This folder contains items the app may not change.") if it holds anything excluded, hidden or named `manifest.json`.
- Notes that link to a moved item are rewritten by Obsidian. If Obsidian's "Automatically update internal links" is off, moving a note that has incoming links is refused (`DENIED`).
- Deleting a folder, or touching more than 10 files, shows the user a confirmation dialog. A refusal or no answer within 60 seconds gives `DENIED` ("The user did not approve this operation."). More than 50 files (200 for trusted apps) gives `TOO_LARGE` without asking.

### Links, pick and events (step 2d)

Everything returned is filtered to what the app may read. A target the app cannot read looks exactly like no target.

| Op | Args | Result | Notes |
| --- | --- | --- | --- |
| `links.resolve` | `link` (text such as `Note#Heading\|alias`), `from?` | `{ path }` or `{ path: null }` | Resolved the way Obsidian does. Excluded and out-of-scope targets give `null` |
| `links.backlinks` | `path` | `{ paths }` | Notes linking to it that the app may read (up to 1,000) |
| `links.outgoing` | `path` | `{ paths }` | Notes it links to that the app may read |
| `links.activeNote` | none | `{ path }` | The note open in Obsidian, or `null` (also `null` for one the app may not read) |
| `links.open` | `path` | `{ opened: true }` | Opens the note in a tab (reusing a tab already showing it; never replaces the app's own tab). Rate limited |
| `pick.note`, `pick.folder` | none | `{ path }` or `{ path: null }` | A host dialog listing only paths the app may read. `null` on cancel, Escape or after two minutes. Choosing grants no permission. Rate limited |
| `events.subscribe` | `kinds?` (any of `created modified renamed deleted`, default all), `folder?` | `{ id }` | Up to 20 per app |
| `events.unsubscribe` | `id` | `{ removed }` | |

`links.open`, `pick.note` and `pick.folder` share a small budget (a burst of 5, then one every 5 seconds) so an app cannot flood the screen.

**Events.** After `events.subscribe` the app receives `file` events:

```js
bridge.on("file", (e) => { /* e = { id, kind, type, path, oldPath? } */ });
```

- `kind` is `created`, `modified`, `renamed` (with `oldPath`) or `deleted`; `type` is `file` or `folder`.
- Only paths the app may read ever appear. A rename from readable to hidden is reported as a `deleted`; hidden to readable as a `created`.
- `modified` notices are throttled per path (one per 300 ms), and a rename or delete cancels a pending one. Delivery is capped at 50 events a second; excess events are dropped, so treat events as a hint to re-read.
- Events caused by the app's own writes are delivered too.
- Subscriptions end when the app closes or reloads.

### The `trusted` flag

`"trusted": true` in a manifest only **asks**. Nothing changes until the user approves it in a dialog the app cannot reach. The approval is kept on this device only (never synced), is tied to the app's folder and to a hash of its permissions, scopes, domains, entry file and the flag itself (so changing any of them asks again), and is listed in Settings with a Revoke button. A refusal is not repeated on every load; the app's Reload button asks again.

Trusted lets an app: write anywhere in the vault (not only inside `writeScopes`), use 5 times the request rate, write files up to 25 MB, and change up to 200 files in one operation (the user is still asked above 10).

Trusted never lets an app: touch excluded or hidden paths, write to an app folder or any `manifest.json`, skip snapshots or the log, delete permanently, or reach the network.

## Fetch shim

`fetch(path)` for a string without a scheme becomes a bridge read: text types use `files.read`, everything else `files.readBinary`. Needs those permissions declared; otherwise the response is 403.

| Result | Status |
| --- | --- |
| Success | 200 with a content type from the extension |
| `NOT_FOUND` (incl. excluded) | 404 |
| `DENIED` | 403 |
| `INVALID` | 400 |
| `TOO_LARGE` | 413 |
| Other method than GET or HEAD | 405 |

Strings with a scheme (`https:`, `file:`, `data:`, even `C:`) and `//` URLs go to the real `fetch` and are blocked by the Content Security Policy. `Request` objects and `URL` objects are passed to the real `fetch` too. `XMLHttpRequest` is not shimmed. The shim is only a convenience: the host enforces every rule whether or not an app uses it.
