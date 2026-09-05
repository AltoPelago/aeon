# Core API

Informative status: implementation documentation for `@altopelago/aeon-core`.

## Package

- Module: `@altopelago/aeon-core`
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
  Limits clarifier value depth in datatype annotations. Default: `1`.
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

## Telex boundary

`compile()` remains the native in-memory API. For interoperable AES v0 records,
Core also exposes:

```ts
compileToTelex(input, options?)
exportTelex(events, options?)
parseTelex(input, options?)
```

`compileToTelex()` returns the normal `CompileResult`, projected portable
records, and encoded Telex. `exportTelex()` avoids recompilation when the caller
already has assignment events. Both preserve event order and omit headers by
default. `includeHeaders: true` selects the explicit `aeon.document.v0` header
plane.

The package re-exports the AES codec functions `encodeTelex()`,
`canonicalizeTelex()`, `validateTelex()`, and `validateTelexRecords()` for
boundary-oriented consumers.

## Anonymous child heads

Core supports anonymous typed and attributed children inside ordered containers.

Examples:

```aeon
values:list = [:int32 = 3, @{unit:string = "cm"} = 4]
pair:tuple = (:float64 = 10.5, :float64 = 2.0)
page:node = <page(@{role:string = "title"}:string = "Hello")>
```

Supported forms:

- `:type = value`
- `@{...} = value`
- `@{...}:type = value`

These forms are valid only inside:

- list elements
- tuple elements
- node children

They are rejected at the root and inside objects without keys.

There is only one attribute-block slot per binding or anonymous child head, so
repeated heads like `@{a=1}@{b=2}:n = 3` fail closed.

## Indexed child AES paths

Core emits synthetic indexed events for ordered children, including node
children.

For example:

```aeon
page:node = <page({a:n = 1, b:n = 2}, :string = "hello")>
```

can produce AES paths including:

- `$.page`
- `$.page[0]`
- `$.page[0].a`
- `$.page[0].b`
- `$.page[1]`

Legacy in-memory lists, tuples, and node children all use bracket-addressed
canonical paths. The portable AES projection inserts the node head at `[0]`, so
the former first source child becomes `[0][0]`; references are translated with
the same rule during Telex export.

## Attribute metadata namespace

Default finalization and related tooling reserve metadata keys such as:

- `@`
- `@items`

along with hardening-oriented keys like:

- `__proto__`
- `constructor`
- `prototype`

Those keys are rejected in attribute blocks at parse time to avoid collisions
with finalized metadata projection.

## Security note

For production processing, prefer the default fail-closed behavior and treat `recovery` as a tooling-oriented mode.

## Example

```ts
import { compile } from '@altopelago/aeon-core';

const result = compile('aeon:mode = "strict"\nopens:time = 09:30:00Z');

if (result.errors.length === 0) {
  console.log(result.events);
}
```
