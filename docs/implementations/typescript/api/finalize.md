# Finalize API

Informative status: implementation documentation for `@aeon/finalize`.

## Package

- Module: `@aeon/finalize`
- Entry point: [`implementations/typescript/packages/finalize/src/index.ts`](../../../../implementations/typescript/packages/finalize/src/index.ts)

## Primary entry points

- `finalizeJson(aes, options?)`
- `finalizeLinkedJson(aes, options?)`
- `finalizeMap(aes, options?)`
- `finalizeNode(aes, options?)`

These functions transform AES into deterministic downstream document shapes.

## Options

```ts
interface FinalizeOptions {
  readonly mode?: 'strict' | 'loose';
  readonly materialization?: 'all' | 'projected';
  readonly includePaths?: readonly string[];
  readonly scope?: 'payload' | 'header' | 'full';
  readonly header?: {
    readonly fields: ReadonlyMap<string, AssignmentEvent['value']>;
  };
}
```

## Behavior

- `mode`
  Controls strict vs loose finalization behavior.
- `materialization`
  `all` materializes the full document. `projected` restricts output to included paths.
- `includePaths`
  Canonical paths used when `materialization` is `projected`.
- `scope`
  Selects whether finalization returns payload only, header only, or `{ header, payload }`.
- `header`
  Optional parsed header metadata used by `header` and `full` scopes.

## Output shapes

- `finalizeJson()`
  Produces a JSON-compatible object graph.
- `finalizeLinkedJson()`
  Produces a JSON-compatible object graph with live `~>` pointer aliases linked as getters/setters.
- `finalizeMap()`
  Produces a canonical path keyed map representation.
- `finalizeNode()`
  Produces a typed finalized node tree.

Each result may include `meta.errors` and `meta.warnings`.

## Notes

- `@aeon/finalize` consumes AES. It is downstream of parsing and emission.
- Finalization options are implementation controls, not AEON document syntax.

## Example

```ts
import { compile } from '@aeon/core';
import { finalizeJson } from '@aeon/finalize';

const compiled = compile('app = { name = "aeon" }');
const finalized = finalizeJson(compiled.events, {
  mode: 'strict',
  scope: 'payload',
  ...(compiled.header ? { header: compiled.header } : {}),
});
```
