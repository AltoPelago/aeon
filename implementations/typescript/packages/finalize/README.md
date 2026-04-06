# @aeon/finalize

Minimal finalization utilities for AEON.

This package consumes Assignment Events (AES) and produces deterministic
finalized document maps. It does not interpret values or apply runtime
semantics. It only aggregates AES into a canonical, path-indexed structure.

## Quick Start

```ts
import { finalizeMap } from '@aeon/finalize';

const { document, meta } = finalizeMap(aes, { mode: 'strict' });
if (!meta?.errors?.length) {
  console.log(document.entries.get('$.config.host'));
}
```

## Common Outputs

### JSON output

```ts
import { finalizeJson } from '@aeon/finalize';

const { document, meta } = finalizeJson(aes, { mode: 'strict' });
if (!meta?.errors?.length) {
  console.log(document);
}
```

### Linked JSON output

```ts
import { finalizeLinkedJson } from '@aeon/finalize';

const { document, meta } = finalizeLinkedJson(aes, { mode: 'strict' });
if (!meta?.errors?.length) {
  document.alias = 3;
}
```

### Node output

```ts
import { finalizeNode } from '@aeon/finalize';

const { document } = finalizeNode(aes, { mode: 'strict' });
console.log(document.root);
```

## Common Patterns

### Project only selected paths

```ts
const { document } = finalizeJson(aes, {
  mode: 'strict',
  materialization: 'projected',
  includePaths: ['$.app.name'],
});
```

### Transform a finalized node document

```ts
import { transformDocument } from '@aeon/finalize';

const next = transformDocument(nodeDocument, {
  leave(node) {
    if (node.type === 'String') {
      return { ...node, value: node.value.toUpperCase() };
    }
  },
});
```

## API

- `finalizeMap(aes, options)`
- `finalizeJson(aes, options)`
- `finalizeLinkedJson(aes, options)`
- `finalizeNode(aes, options)`
- `finalizeWithProfile(aes, options)`

Type contract:

```ts
export interface FinalizeOptions {
  readonly mode?: 'strict' | 'loose';
  readonly materialization?: 'all' | 'projected';
  readonly includePaths?: readonly string[];
  readonly scope?: 'payload' | 'header' | 'full';
  readonly header?: { readonly fields: ReadonlyMap<string, Value> };
  readonly maxMaterializedWeight?: number;
}

export interface FinalizeResult {
  readonly document: FinalizedMap;
  readonly meta?: FinalizeMeta;
}

export interface FinalizedMap {
  readonly entries: ReadonlyMap<string, FinalizedEntry>;
}

export interface FinalizedEntry {
  readonly path: string;
  readonly value: Value;
  readonly span: Span;
  readonly datatype?: string;
  readonly annotations?: ReadonlyMap<string, { value: Value; datatype?: string }>;
}
```

## Notes

- Strict mode records duplicate paths as errors.
- Loose mode records duplicate paths as warnings and keeps the first entry.
- Map/node finalization preserves symbolic references; JSON finalization may materialize clone references and linked JSON may materialize pointer aliases.
- JSON output converts AEON values into JSON-compatible primitives and containers.
- References (`~` / `~>`) emit diagnostics and are preserved as string tokens.
- `finalizeJson(...)` materializes clone references into concrete JSON values and can enforce `maxMaterializedWeight` to fail closed on clone-amplification growth.
- `finalizeLinkedJson(...)` is the opt-in live materialization variant for `~>` pointer aliases.
- `maxMaterializedWeight` is an implementation-facing budget control, not a Core or AEOS conformance surface.
- Binding attributes project under reserved `@` objects in JSON output.
- Exact keys `@`, `$`, `$node`, and `$children` are reserved in JSON/node materialization and produce deterministic errors on collision.
- Node values project with reserved `$node`, optional `@`, and `$children` members.
- `materialization: 'projected'` keeps only the requested `includePaths` and the ancestors needed to reach them.
- `scope: 'header' | 'full'` requires parsed header metadata and can emit header-only or `{ header, payload }` views.

## Output Profiles

Built-in output profiles:
- `json` → `finalizeJson`
- `linked-json` → `finalizeLinkedJson`
- `map` → `finalizeMap`
- `node` → `finalizeNode`

Use `finalizeWithProfile(...)` or register your own in a custom registry.
