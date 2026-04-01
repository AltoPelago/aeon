# AEON Diagnostic Alignment

This note tracks implementation-level diagnostic parity work between the
TypeScript and Rust AEON cores.

It is intentionally not a spec or CTS document. The goal here is to keep
implementation diagnostics coherent for users and tools without overloading the
cross-implementation semantic contract with message-format details.

## Scope

This document covers:

- diagnostic `code` parity
- phase parity about where an error is raised
- path/source-path/target-path presence
- line/column/offset span quality
- broad message-shape alignment

This document does not try to force:

- byte-for-byte identical error strings across languages
- identical CLI formatting
- CTS-level requirements for every implementation-specific diagnostic detail

## Current Contract

When TypeScript and Rust both report the same AEON error family, we want them
to align on the following in order of importance:

1. The same error `code`
2. The same fail/pass behavior
3. The same phase boundary where practical
4. The same path ownership model
5. The same span precision target
6. Similar human-readable wording

Practical rule:

- `code`, success/failure, and path/span presence should usually match exactly
- wording should match closely enough that the same failure is recognizable in
  both implementations
- exact punctuation or sentence structure does not need to be identical if the
  message remains equally clear

## Existing Parity Fixtures

The repo already has a small phase-level diagnostic parity fixture at:

- [`stress-tests/snippets/diagnostic-parity.json`](../../stress-tests/snippets/diagnostic-parity.json)

That file is a good home for cases where we want both implementations to agree
on the same surfaced diagnostic family, path, and span.

Implementation-owned contract tests live in:

- TypeScript:
  [`implementations/typescript/packages/core/src/core.test.ts`](../../implementations/typescript/packages/core/src/core.test.ts)
- Rust:
  [`implementations/rust/crates/aeon-core/src/lib.rs`](../../implementations/rust/crates/aeon-core/src/lib.rs)

## Recently Aligned

These areas now have explicit parity work behind them:

- invalid radix literals reject consistently instead of drifting between
  canonicalization and compile
- `HEADER_CONFLICT` now shares message shape, path ownership, and conflict-span
  behavior across implementations
- `DUPLICATE_CANONICAL_PATH` now shares message shape and points at the later
  duplicate binding site
- `UNTERMINATED_STRING` now carries the same delimiter-aware message shape
- temporal literals now align on `INVALID_DATE`, `INVALID_TIME`, and
  `INVALID_DATETIME`, including span attachment
- typed-mode diagnostics now align for `UNTYPED_SWITCH_LITERAL`,
  `CUSTOM_DATATYPE_NOT_ALLOWED`, `INVALID_NODE_HEAD_DATATYPE`, and
  `DATATYPE_LITERAL_MISMATCH`
- missing reference targets now report source ownership and tighter Rust spans
- Rust reference diagnostics now use inner reference spans instead of whole
  binding spans
- implementation tests and shared parity snippets now assert representative
  diagnostic code/message/span behavior across TypeScript, Rust, and Python

## Remaining Alignment Targets

These are the highest-value next families to align.

### 1. Parser Syntax Diagnostics

The parity fixture already carries examples like:

- missing `=`
- unexpected bare identifier value

These are good candidates to extend before broadening into more subtle parser
cases.

Alignment target:

- keep `SYNTAX_ERROR`
- match the same token/construct wording where possible
- match path and span exactly

### 2. Remaining Strict-Mode Coverage

The high-value typed-mode family is mostly aligned now, but a few areas still
need deliberate follow-through.

Remaining targets:

- `UNTYPED_VALUE_IN_STRICT_MODE` should be reviewed alongside the newly aligned
  `UNTYPED_SWITCH_LITERAL` behavior
- attribute-level datatype diagnostics in Rust still do not always carry
  attribute-precise spans because those values do not yet preserve their own
  spans through the model
- richer structured fields, where present, should be checked for parity in the
  same way as `path` and `span`

### 3. Richer Duplicate / Reference Metadata

The primary surfaced diagnostics are aligned, but richer metadata is still
incomplete across implementations.

Remaining targets:

- decide whether `DUPLICATE_CANONICAL_PATH` should carry first-occurrence
  metadata everywhere or nowhere
- review whether source/target structured fields on reference diagnostics should
  be normalized further across implementations
- keep missing-target vs forward-reference classification covered by regression
  tests as reference validation evolves

## Suggested Testing Strategy

Keep the work split into two layers.

### Shared parity snippets

Use [`stress-tests/snippets/diagnostic-parity.json`](../../stress-tests/snippets/diagnostic-parity.json)
for compact cases where both implementations should agree on:

- pass/fail
- code
- path
- span
- a strong message shape

Best candidates for this file:

- `HEADER_CONFLICT`
- `DUPLICATE_CANONICAL_PATH`
- `UNTERMINATED_STRING`
- `MISSING_REFERENCE_TARGET`
- `FORWARD_REFERENCE`
- `UNTYPED_VALUE_IN_STRICT_MODE`

### Implementation contract tests

Use implementation-local tests for assertions that are important but still too
implementation-shaped for shared parity fixtures, such as:

- richer structured fields like `sourcePath` and `targetPath`
- recovery-mode behavior
- exact span ownership decisions in nested cases
- message details that may reasonably vary while the family remains aligned

## Non-Goals

These should stay out of the parity target for now:

- exact ANSI/CLI rendering
- exact CLI section naming
- help/usage wording
- finalize/runtime/tooling diagnostic families outside AEON core

## Recommended Next Pass

If we continue this work, the most useful order is:

1. extend parser-focused parity snippets
2. tighten remaining strict-mode span coverage
3. decide on richer duplicate/reference metadata parity
4. mirror each newly aligned family into implementation tests

That keeps the work grounded in a few high-signal diagnostic families instead of
trying to normalize every error message in one sweep.
