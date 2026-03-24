# AEON CLI Output Contract (v1)

**Status:** Normative for v1 snapshots/tests

This document is the single source of truth for the AEON CLI’s observable behavior. Tests MUST be written against this contract.

## 1) Commands

The CLI MUST support these commands:

- `aeon check <file>`
- `aeon inspect <file>`
- `aeon inspect <file> --json`
- `aeon inspect <file> --json --annotations`
- `aeon inspect <file> --json --annotations-only`
- `aeon inspect <file> --json --annotations-only --sort-annotations`
- `aeon finalize <file>`
- `aeon finalize <file> --json`
- `aeon finalize <file> --map`
- `aeon bind <file> --schema <schema.json> --annotations`
- `--recovery` flag (tooling-only)

## 2) Exit Codes

Exit codes are stable and MUST be:

- `0` — no errors
- `1` — errors present (including when `--recovery` is used)
- `2` — CLI usage error (bad args / missing file / unreadable file)

## 3) Output Streams

- Human-readable output MUST be written to `stdout`.
- Fatal CLI usage errors (exit code `2`) MUST be written to `stderr`.

## 4) Core Semantics

### 4.1 Fail-Closed Default

By default, the CLI MUST behave fail-closed:

- If `compile().errors.length > 0`, the CLI MUST NOT show any events.
- Errors MUST still be shown.

This matches the canonical fail-closed contract of `@aeon/core`.

### 4.2 Recovery Mode (`--recovery`)

When `--recovery` is provided:

- Partial events MAY be shown.
- Errors MUST always be shown.
- The CLI MUST print a visible warning banner in human-readable output.

Recovery mode remains exit code `1` if any errors exist.

### 4.3 Non-goals (MUST NOT)

The CLI MUST NOT (except as explicitly required by `aeon finalize`):

- Default to JSON output
- Implement AEON → JSON conversion semantics outside `aeon finalize`
- Resolve references
- Coerce values
- Perform hidden inference
- Materialize application-level objects

The CLI is an inspection/validation tool that only exposes events + errors.

## 5) `aeon check <file>` (human)

### 5.1 Purpose

Validate the document and report errors.

### 5.2 Output

- Output MUST be plain text on `stdout`.
- If there are no errors, output SHOULD be a single line:
  - `OK`
- If there are errors, output MUST list each error on its own line using the same error line format as in `inspect` (see §6.3).

## 6) `aeon inspect <file>` (default Markdown)

### 6.1 Determinism

Markdown output MUST be deterministic:

- No timestamps
- No absolute file paths (only basename)
- Stable ordering for lists
- Stable span formatting

### 6.2 Section Order and Headings

The output MUST follow this structure.

1. `# AEON Inspect`
2. `## Summary`
3. `## Errors` (only if `Errors > 0`)
4. `## Assignment Events` (only if `Events > 0`)
5. `## References` (OPTIONAL; if present, MUST be last)

### 6.3 Summary Fields (exact order)

In `## Summary`, render bullets in this exact order:

- `File:` `<basename>`
- `Version:` `<value | —>`
- `Mode:` `<transport|strict>`
- `Profile:` `<string | —>`
- `Schema:` `<string | —>`
- `Recovery:` `<true|false>`
- `Events:` `<N>`
- `Errors:` `<M>`

### 6.4 Recovery Banner

If `--recovery` is used, emit this banner immediately after `# AEON Inspect`:

- `> WARNING: recovery mode enabled (tooling-only); output may be partial`

### 6.5 Error List Format (exact)

In `## Errors`, render one bullet per error in this exact shape:

- `- Phase Label: message [CODE] path=$.x.y span=3:5-3:12`

Rules:

- `Phase Label` SHOULD be present when the CLI can determine a stable phase name.
- `CODE` MUST be the error code.
- `path` MUST be a canonical path (or `$` if not applicable).
- `span` MUST be formatted as `line:col-line:col`.
- `message` MUST be the error message (single-line).

Example:

- `- Parsing: Expected '}' to close object [SYNTAX_ERROR] path=$ span=2:1-2:1`

### 6.6 Assignment Event Line Format (exact)

In `## Assignment Events`, render one event per line:

- `- $.contacts.a1.name :s = "John"`

Rules:

- Path first.
- Then a single space.
- Then datatype (if present) as `:<type>`; if absent, omit the datatype segment entirely.
- Then ` = `.
- Then the value rendered in an AST-ish representation:
  - No JS coercion
  - No reference resolution
  - References remain symbolic (e.g., `~x`, `~>x`)

## 7) `aeon inspect <file> --json`

### 7.1 Top-level shape (exact)

Output MUST be exactly:

```json
{ "events": [...], "errors": [...] }
```

### 7.2 Determinism

- No timestamps
- No absolute paths
- Deterministic ordering

### 7.2.1 Diagnostic Metadata

Inspect JSON diagnostics SHOULD preserve:

- stable `code`
- canonical `path`
- `span` when available
- `phaseLabel` when a stable human-readable phase name is available

`phase` MAY be omitted for core compile diagnostics when only the label can be inferred.

### 7.3 Values

Values MUST remain AST-like and MUST NOT be coerced into application-level types.

## 7.4 Annotation Debug Extensions

For inspect-mode debugging, the CLI MAY include annotation stream records.

- `--annotations` adds an `annotations` array to the standard inspect JSON shape.
- `--annotations-only` emits only `{ "annotations": [...] }`.
- `--sort-annotations` applies deterministic record sorting before emitting annotations.

When `--annotations` or `--annotations-only` is used, implementation SHOULD compile in core v1 mode to surface annotation records.

### 7.4.1 Deterministic Annotation Sort

When `--sort-annotations` is present, annotation records MUST be sorted by:

1. `span.start.offset` (ascending)
2. `span.end.offset` (ascending)
3. `kind` (lexicographic)
4. `form` (lexicographic)
5. `raw` (lexicographic)
6. original source order (stable tie-break)

### 7.4.2 Snapshot-Recommended Commands

For stable snapshot workflows, prefer one of:

- `aeon inspect <file> --json --annotations-only --sort-annotations`
- `aeon inspect <file> --annotations-only --sort-annotations`

## 8) `aeon finalize <file>` (JSON)

### 8.1 Purpose

Finalize AES into a JSON-compatible document shape for tooling.

### 8.2 Top-level shape (exact)

Output MUST be exactly:

```json
{ "document": { ... }, "meta": { "errors": [...], "warnings": [...] } }
```

`meta` MAY be omitted when empty.

### 8.3 Determinism

- No timestamps
- No absolute paths
- Deterministic ordering based on source order

### 8.4 Diagnostics

- Errors MUST include compiler errors and finalization diagnostics.
- Warnings MUST include finalization warnings.
- If any errors are present, exit code MUST be `1`.

### 8.5 Map Output (`--map`)

When `--map` is provided, the output MUST be:

```json
{ "document": { "entries": [ ... ] }, "meta": { "errors": [...], "warnings": [...] } }
```

Each entry MUST include `path`, `value`, and `span`, with optional `datatype` and `annotations`.

## 9) `aeon bind <file> --schema <schema.json> --annotations`

When `--annotations` is provided for `bind`, the CLI MAY include:

```json
{ "document": { ... }, "annotations": [ ... ], "meta": { ... } }
```

Rules:
- `annotations` MUST be omitted when the flag is not supplied.
- `annotations` order follows runtime annotation stream order.
- Including annotations MUST NOT alter runtime phase behavior or diagnostics.

## 10) `aeon integrity <...> --json`

### 10.1 Top-level Shape

Integrity JSON output MUST start from:

```json
{ "ok": true, "errors": [], "warnings": [] }
```

`receipt` and `verification` MAY be added depending on the subcommand.

### 10.2 `integrity validate --json`

Validation JSON MUST be exactly:

```json
{ "ok": true|false, "errors": [...], "warnings": [...] }
```

No `receipt` or `verification` object is required for validate.

### 10.3 `integrity sign --json`

Signing JSON MUST include:

```json
{
  "ok": true,
  "receipt": { ... },
  "envelope": { ... }
}
```

When `--write` is used, implementations MAY additionally include:

- `written`
- `replaced`
- `conventionsApplied`

Future sidecar-oriented signing behavior SHOULD follow:

- default receipt sidecar path: `<file>.receipt.json`
- explicit override flag: `--receipt <path>`
- sibling sidecar discovery only for v1

### 10.4 `integrity verify --json`

Verification JSON MUST include:

```json
{
  "ok": true|false,
  "errors": [...],
  "warnings": [...],
  "receipt": { ... },
  "verification": { ... }
}
```

Future sidecar-oriented verification behavior SHOULD follow:

- default receipt sidecar path: `<file>.receipt.json`
- explicit override flag: `--receipt <path>`
- if no sidecar is present, normal envelope verification remains valid unless a
  receipt is explicitly required by the command mode

### 10.5 Receipt Shape

When present, `receipt` MUST include:

- `source.mediaType = "text/aeon"`
- `source.encoding = "utf-8"`
- `source.digestAlgorithm = "sha-256"`
- `source.digest`
- `canonical.format = "aeon.canonical"`
- `canonical.spec = "AEON Core"`
- `canonical.specRelease = "v1"`
- `canonical.mode`
- `canonical.profile`
- `canonical.outputEncoding = "utf-8"`
- `canonical.digestAlgorithm = "sha-256"`
- `canonical.digest`
- `canonical.length`
- `producer.implementation`
- `producer.version`
- `generated.at`

Rules:

- `generated.at` MUST be an RFC 3339 / ISO 8601 UTC timestamp.
- `canonical.payload` SHOULD be included for `integrity sign --json`.
- `canonical.payload` SHOULD be omitted for `integrity verify --json`.
- `producer.implementation` MUST use a stable runtime identifier such as
  `aeon-cli-ts` or `aeon-cli-rs`.

### 10.6 Verification Shape

When present, `verification` MUST include:

- `canonical`
- `bytes`
- `checksum`
- `signature`
- `replay`
- `canonicalStream`

Rules:

- `canonicalStream.length` MUST be the canonical payload length.
- `replay.performed` MUST be boolean.
- `replay.status` MUST be one of `match`, `divergent`, or `unavailable`.
- `replay` status MUST remain separate from signature success/failure.

### 10.7 Receipt Storage Rules

Recommended v1 receipt storage rules:

- receipt storage SHOULD use detached sibling JSON sidecars
- the canonical sibling filename is `<document-path>.receipt.json`
- sidecar discovery SHOULD be filename-based only
- manifest/index discovery is out of scope for v1
- envelope pointer fields are out of scope for v1
