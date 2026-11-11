# Path rule and resolver contract

Status: implemented as pure functions with unit tests.

## Rule

All paths are vault-root-relative, as given by Obsidian's "Copy path from vault folder": `Notes/Pump sizing.md`, `Data/pumps.json`, `Apps/Calculator/style.css`.

Apps never use `..`, absolute system paths (`C:\...`, `/Users/...`) or URLs for vault access.

## Single resolver

One function owns all path handling. The fetch shim, bridge and app loader all call it; no other code builds vault paths.

Pipeline, in order:

1. Reject non-strings and empty input.
2. Reject URL schemes (`http:`, `https:`, `file:`, `data:`, `blob:`, and any `scheme:`) and `//` network-path forms.
3. Percent-decode (repeat until stable, bounded; reject malformed escapes and decoded NUL or control characters).
4. Convert `\` to `/`.
5. Trim stray whitespace.
6. Reject absolute paths (leading `/`, drive letters such as `C:`, UNC `//`).
7. Apply the `./` fallback only if the caller is an app's own-file request and Strict paths is off; resolve from `appRoot`.
8. Normalise (collapse `//`, drop `.` segments); reject any `..` segment, including ones revealed by decoding.
9. Reject results that are empty or escape the vault root.
10. Check the exclusion list on the cleaned path.

Failure on any excluded path returns the same generic not-found error as a missing file.

## Outputs

`resolve(input, context) -> { ok: true, path } | { ok: false, code }` where `code` is `INVALID` or `NOT_FOUND` (excluded paths map to `NOT_FOUND`).

## `appRoot` and `{{appRoot}}`

The manifest field `appRoot` (e.g. `Apps/Calculator`) is substituted for `{{appRoot}}` by the host when loading, so renaming the folder does not break the app.

## Strict paths

Setting that disables the `./` fallback (default: off, meaning the fallback is on). Vault notes never use the fallback.

## Test matrix (minimum)

`../x`, `..\x`, `%2e%2e/x`, `%252e%252e/x`, `a/../../x`, `/abs`, `C:\x`, `\\server\share`, `http://x`, `javascript:x`, `a%00b`, trailing spaces, mixed separators, `.obsidian/x`, `Private/x.md`, `x.secret.md`, case variants on case-insensitive filesystems (Mac and Windows), Unicode normalisation (NFC and NFD).
