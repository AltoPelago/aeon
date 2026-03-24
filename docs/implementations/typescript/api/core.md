# Core API

Informative status: implementation documentation for `@aeon/core`.

## Package

- Module: `@aeon/core`
- Entry point: [`implementations/typescript/packages/core/src/index.ts`](../../../../implementations/typescript/packages/core/src/index.ts)

## Primary entry point

```ts
compile(input, options?)
```

`compile()` is the canonical TypeScript entry point for AEON processing. It runs the current phase chain:

1. lex
2. parse
3. path resolution
4. AES emission
5. reference validation
6. mode enforcement

## Signature

```ts
interface CompileOptions {
  readonly recovery?: boolean;
  readonly maxInputBytes?: number;
  readonly maxAttributeDepth?: number;
  readonly maxSeparatorDepth?: number;
  readonly emitAnnotations?: boolean;
  readonly datatypePolicy?: 'reserved_only' | 'allow_custom';
}
```

## Options

- `recovery`
  Enables partial results when errors exist. Default: `false`.
- `maxInputBytes`
  Maximum UTF-8 input size accepted by the compiler. Processing fails closed when exceeded.
- `maxAttributeDepth`
  Limits reference/attribute path depth. Default: `1`.
- `maxSeparatorDepth`
  Limits separator-spec depth in datatype annotations. Default: `1`.
- `emitAnnotations`
  Includes structured annotation records in the result. Default: `true`.
- `datatypePolicy`
  Controls strict-mode datatype handling. Default: `reserved_only`.

## Return shape

```ts
interface CompileResult {
  readonly events: readonly AssignmentEvent[];
  readonly errors: readonly AEONError[];
  readonly header?: {
    readonly fields: ReadonlyMap<string, Value>;
    readonly form: 'structured' | 'shorthand';
  };
  readonly annotations?: readonly AnnotationRecord[];
}
```

## Processing behavior

- Default behavior is fail-closed.
- If any phase reports errors and `recovery` is not enabled, `events` is returned as an empty array.
- `header` exposes parsed header metadata for downstream projection/finalization.
- `annotations` are emitted only when `emitAnnotations` is enabled.

## Security note

For production processing, prefer the default fail-closed behavior and treat `recovery` as a tooling-oriented mode.

## Example

```ts
import { compile } from '@aeon/core';

const result = compile('aeon:mode = "strict"\nopens:time = 09:30:00Z');

if (result.errors.length === 0) {
  console.log(result.events);
}
```
