# @aeon/core

The canonical, safe entry point for AEON processing.

## Installation

```bash
pnpm add @aeon/core
```

Implementation docs:

- [`docs/implementations/typescript/api/core.md`](../../../../docs/implementations/typescript/api/core.md)

## Quick Start

```ts
import { compile } from '@aeon/core';

const input = `
config = {
  host = "localhost"
  port:int32 = 8080
}
`;

const result = compile(input);

if (result.errors.length === 0) {
  for (const event of result.events) {
    console.log(event.path, event.value);
  }
} else {
  for (const error of result.errors) {
    console.error(error.message);
  }
}
```

## What You Get

- `events`: Assignment Events emitted from the source document
- `errors`: diagnostics from lexing, parsing, and downstream compile phases

## Common Patterns

### Fail closed by default

`compile()` returns an empty `events` array if any phase reports errors.
That is the production-safe default.

### Recovery mode for tooling

Use recovery mode only when partial output is useful for editors or diagnostics:

```ts
const result = compile(input, { recovery: true });

console.log(result.events); // may be partial
console.log(result.errors); // all known issues
```

> Warning: recovery mode is for tooling only.

### Typical next step

If you need schema validation after compile, pass `result.events` to `@aeos/core`.

### Inspect the file preamble without full parsing

Use `inspectFilePreamble()` to read only the allowed file-header slot for:
- a leading `#!...` shebang
- a `//! format:<id>` host directive on line 1, or line 2 after a shebang

```ts
import { inspectFilePreamble } from '@aeon/core';

const info = inspectFilePreamble('#!/usr/bin/env aeon\n//! format:aeon.test.v1\nvalue = {');
console.log(info.format); // "aeon.test.v1"
```

## API

### `compile(input, options?)`

Compiles an AEON document into Assignment Events.

**Parameters:**
- `input: string` — AEON document source text
- `options?: CompileOptions`
  - `recovery?: boolean` — Enable recovery mode (default: `false`)
  - `maxInputBytes?: number` — Maximum accepted UTF-8 input size before fail-closed rejection
  - `maxAttributeDepth?: number`
  - `maxSeparatorDepth?: number`
  - `emitAnnotations?: boolean`
  - `datatypePolicy?: 'reserved_only' | 'allow_custom'`

**Returns:** `CompileResult`
- `events: AssignmentEvent[]` — Assignment events (empty if errors and not in recovery mode)
- `errors: AEONError[]` — All errors from all phases
- `header` — Parsed header metadata for downstream finalization/runtime projection

### `inspectFilePreamble(input)`

Reads only the file-header preamble slot and returns:
- `shebang`
- `hostDirective`
- `format`
- `span`

## Exported Types

- `CompileResult` — Return type of `compile()`
- `CompileOptions` — Options for `compile()`
- `AssignmentEvent` — Individual binding event
- `CanonicalPath` — Path representation
- `AEONError` — Union of all error types
- `Span`, `Position` — Source location types
- `formatPath()` — Utility to format paths as strings

## Lower-Level Packages

For advanced tooling, lower-level packages are available but considered unstable:

- `@aeon/lexer` — Tokenization
- `@aeon/parser` — AST construction
- `@aeon/aes` — Event emission and validation

These APIs may evolve. Prefer `@aeon/core` for stable usage.

For the implementation-defined option surface and security-oriented controls, see:

- [`docs/implementations/typescript/limits-and-policies.md`](../../../../docs/implementations/typescript/limits-and-policies.md)
