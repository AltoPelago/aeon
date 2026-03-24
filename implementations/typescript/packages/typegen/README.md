# @aeon/typegen

TypeScript type generation from AEOS schemas.

This package converts schema rules (`path` + `constraints`) into a deterministic
TypeScript interface definition.

## Quick Start

```ts
import { generateTypes } from '@aeon/typegen';

const schema = {
  rules: [
    { path: '$.name', constraints: { type: 'StringLiteral', required: true } },
    { path: '$.port', constraints: { type: 'NumberLiteral' } },
  ],
};

const result = generateTypes(schema, {
  rootName: 'AppConfig',
});

console.log(result.code);
console.log(result.diagnostics);
```

Typical output:

```ts
export interface AppConfig {
  name: string;
  port?: number;
}
```

## What This Package Does

- reads AEOS schema rules by canonical path
- builds a nested TypeScript object shape
- marks fields required when the schema requires them
- emits diagnostics for invalid or conflicting schema shapes

## Common Patterns

### Map datatype labels to custom TypeScript types

```ts
const result = generateTypes(schema, {
  datatypeMap: {
    uuid: 'string & { readonly __brand: "uuid" }',
  },
});
```

### Generate a typed runtime binder

```ts
const result = generateTypes(schema, {
  rootName: 'AppConfig',
  emitRuntimeBinder: true,
});
```

When `emitRuntimeBinder` is enabled, the generated code also includes:

- a `SchemaV1` constant for the schema
- a typed `bind...` helper backed by `createTypedRuntimeBinder(...)`

### Inspect diagnostics

`generateTypes()` always returns both generated code and diagnostics:

```ts
for (const diag of result.diagnostics) {
  console.log(diag.level, diag.code, diag.message);
}
```

Common diagnostic cases include:

- invalid schema paths
- invalid generated identifier names
- scalar/object path conflicts
- unknown constraint types falling back to `unknown`

## Finalization Alignment

- Generated scalar types are intended to match the default typed runtime contract, which operates on JSON finalization output.
- `InfinityLiteral` therefore emits as `'Infinity' | '-Infinity'` rather than `number`, because JSON finalization materializes infinity values as strings to remain JSON-safe.

## API

```ts
export function generateTypes(schema: SchemaV1, options?: TypegenOptions): TypegenResult;
```

`TypegenOptions` highlights:
- `rootName` - interface name (default `AeonDocument`)
- `datatypeMap` - map AEOS datatype labels to TS types
- `emitRuntimeBinder` - emit schema const + typed runtime binder helper
- `schemaConstName` - override emitted schema constant name
- `binderName` - override emitted binder function name
- `runtimeModule` - runtime import path (default `@aeon/runtime`)
- `schemaModule` - schema type import path (default `@aeos/core`)

`TypegenResult`:

- `code` - generated TypeScript source
- `diagnostics` - warnings and errors found during generation

## Notes

- Required fields are derived from `required: true` and required descendants.
- Unsupported/unknown schema paths are reported in diagnostics.
- Unknown constraint types fall back to `unknown` with warnings.
- Datatype labels can be mapped to custom TypeScript types via `datatypeMap`.
