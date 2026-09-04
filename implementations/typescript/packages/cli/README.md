# @altopelago/aeon-cli

Command-line tools for parsing, checking, formatting, finalizing, and inspecting
AEON documents.

## Installation

```bash
pnpm add -D @altopelago/aeon-cli
```

Or run a pinned release directly:

```bash
npx @altopelago/aeon-cli@0.12.1 check ./document.aeon
```

## Quick Start

```bash
aeon check ./document.aeon
aeon inspect ./document.aeon --json
aeon finalize ./document.aeon --json
aeon fmt ./document.aeon --write
```

## Commands

- `aeon version` - show the CLI version
- `aeon check <file>` - validate an AEON document with CI-friendly exit codes
- `aeon doctor` - check environment and contract registry wiring
- `aeon fmt [file]` - format AEON source, writing to stdout unless `--write` is used
- `aeon inspect <file>` - inspect Assignment Events, diagnostics, and optional annotations
- `aeon finalize <file>` - materialize AEON into JSON, map, header, or full views
- `aeon bind <file>` - run the typed runtime binding pipeline with a schema
- `aeon integrity validate|verify|sign <file>` - work with integrity envelopes

## Common Options

- `--json` - emit machine-readable JSON where supported
- `--annotations` - include annotation stream records
- `--annotations-only` - inspect only annotation stream records
- `--sort-annotations` - sort annotations deterministically
- `--scope payload|header|full` - choose finalization scope
- `--projected` and `--include-path <path>` - materialize selected canonical paths
- `--recovery` - emit partial tooling output while still reporting errors
- `--max-input-bytes <n>` - fail closed on oversized UTF-8 input
- `--datatype-policy reserved_only|allow_custom` - control custom datatype acceptance
- `--rich` - shortcut for `--datatype-policy allow_custom`

## Exit Codes

- `0` - no errors
- `1` - AEON diagnostics or validation errors were present
- `2` - CLI usage error, missing file, bad option, or unreadable input

## Output Contract

The CLI is designed for stable automation. Its observable command behavior is
tracked in [`OUTPUT_CONTRACT.md`](./OUTPUT_CONTRACT.md).

## Notes

- The default processing path is fail-closed.
- `--recovery` is intended for editors and diagnostics, not production loading.
- The CLI does not execute AEON documents or coerce values into application
  semantics.
