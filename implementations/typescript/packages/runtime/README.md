# @aeon/runtime

Phase-ordered runtime orchestration for AEON.

Implementation docs:

- [`docs/implementations/typescript/api/runtime.md`](../../../../docs/implementations/typescript/api/runtime.md)

This package runs a deterministic pipeline:

1. Profile compilation (Phases 1-5)
2. Schema validation (Phase 6)
3. Reference resolution (Phase 7)
4. Finalization (Phase 8)

It enforces `schema -> resolve` ordering by skipping profile-level processors.

## Quick Start

```ts
import { runRuntime } from '@aeon/runtime';

const result = runRuntime('name = "AEON"\ncopy = ~name', {
  mode: 'strict',
  output: 'json',
  schema: {
    rules: [
      { path: '$.copy', constraints: { type: 'CloneReference' } }
    ]
  }
});

if (!result.meta.errors.length) {
  console.log(result.document);
}
```

## When To Use This Package

Use `@aeon/runtime` when you need the full orchestrated pipeline.

If you only need:

- compile-only behavior, use `@aeon/core`
- AEOS validation over AES, use `@aeos/core`

## Common Patterns

### Request JSON finalization output

```ts
const result = runRuntime('name = "AEON"', {
  output: 'json',
});
```

### Request linked JSON pointer aliases

```ts
const result = runRuntime('a = 2\nb = ~>a', {
  output: 'linked-json',
});
```

### Include annotations for tooling

```ts
const result = runRuntime('a = 1', {
  includeAnnotations: true,
});
```

## API

```ts
export interface RuntimeOptions {
  mode?: 'strict' | 'loose';
  preset?: 'rich';
  datatypePolicy?: 'reserved_only' | 'allow_custom';
  profile?: ProfileRef;
  registry?: ProfileRegistry;
  schema?: SchemaV1;
  output?: 'json' | 'linked-json' | 'map' | 'node';
  materialization?: 'all' | 'projected';
  includePaths?: readonly string[];
  includeAnnotations?: boolean;
  maxInputBytes?: number;
  maxAttributeDepth?: number;
  maxSeparatorDepth?: number;
  scope?: 'payload' | 'header' | 'full';
  trailingSeparatorDelimiterPolicy?: 'off' | 'warn' | 'error';
}

export function runRuntime(input: string, options?: RuntimeOptions): RuntimeResult;
```

When `includeAnnotations` is enabled, `RuntimeResult` may include:

```ts
annotations?: readonly AnnotationRecord[];
```

This annotation stream is a parallel metadata channel and does not affect phase ordering,
schema validation, reference resolution, or finalization semantics.

Example (`includeAnnotations: true`):

```json
{
  "aes": [
    {
      "path": { "segments": [{ "type": "root" }, { "type": "member", "key": "a" }] },
      "key": "a",
      "value": { "type": "NumberLiteral", "raw": "1", "value": "1" },
      "span": { "start": { "line": 2, "column": 1, "offset": 9 }, "end": { "line": 2, "column": 6, "offset": 14 } }
    }
  ],
  "annotations": [
    {
      "kind": "doc",
      "form": "line",
      "raw": "//# docs",
      "span": {
        "start": { "line": 1, "column": 1, "offset": 0 },
        "end": { "line": 1, "column": 9, "offset": 8 }
      },
      "target": { "kind": "path", "path": "$.a" }
    }
  ],
  "document": { "a": 1 },
  "meta": {
    "errors": [],
    "warnings": []
  }
}
```

Typed binding API (JSON output):

```ts
export function runTypedRuntime<TDocument>(
  input: string,
  options: TypedRuntimeOptions<TDocument>
): TypedRuntimeResult<TDocument>;

export function createTypedRuntimeBinder<TDocument>(
  schema: SchemaV1,
  options?: TypedBinderOptions<TDocument>
): (input: string) => TypedRuntimeResult<TDocument>;
```

Example:

```ts
import { runTypedRuntime } from '@aeon/runtime';
import type { AppConfig } from './generated-types.js';

const result = runTypedRuntime<AppConfig>('name = "AEON"\\nport = 8080', {
  schema,
});
```

## Notes

- Default profile is `altopelago.core.v1`.
- Strict mode stops at the first phase that emits errors.
- Loose mode continues and aggregates diagnostics.
- Output document format is selected via `output` (`json` default).
- `linked-json` is the opt-in live JSON materialization mode for `~>` pointer aliases.
- Typed binding APIs operate on JSON finalization output and support optional runtime guards.
- `includeAnnotations` opts into annotation-stream passthrough for tooling/debug output.
- Annotations are non-authoritative and non-influencing relative to runtime decisions.
- `maxInputBytes` is available as an input-boundary fail-closed limit.
