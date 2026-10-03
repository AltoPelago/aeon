# @altopelago/aeon-sdk

Application-facing convenience layer for common AEON read/write flows.

## Quick Start

```ts
import { aeonToTelex, readAeonChecked, readFilmDocument, readTelexDocumentChecked, writeAeon } from '@altopelago/aeon-sdk';

const parsed = readAeonChecked('greeting:string = "Hello"');
console.log(parsed.finalized.document);

const emitted = writeAeon({ app: 'todo', version: 1 });
console.log(emitted.text);

const wire = aeonToTelex('answer = 42').telex!;
const imported = readTelexDocumentChecked(wire);
console.log(imported.finalized.document);

const film = readFilmDocument(filmBytes);
console.log(film.finalized.document);
```

### Query AEON with SANSA

The optional `@altopelago/aeon-sdk/sansa` entry point converts compiled AEON
events into the resolver namespace expected by `@altopelago/sansa`:

```ts
import { readAeonNamespace } from '@altopelago/aeon-sdk/sansa';
import { evaluateQuery } from '@altopelago/sansa';

const { namespace } = readAeonNamespace(`
  inventory = {
    items = [
      { sku = "A-100" active = true }
      { sku = "B-200" active = false }
    ]
  }
`);

const result = evaluateQuery(
  'from $.inventory.items.* where .active == true select { sku = .sku }',
  namespace,
);
```

`readAeonNamespace()` requires successful compilation before returning. It
keeps finalization diagnostics alongside a portable AES-backed namespace, so
AEON values that are not representable in strict JSON remain queryable. Native
assignment events are first projected through the complete portable AES
topology: a node binding is a `NodeLiteral`, its tag is a distinct `NodeHead`
child, and node content appears beneath that head. The adapter uses normative
PascalCase representation kinds, preserves datatype components and provenance,
and translates reference targets into the same portable address domain.

The namespace exposes payload bindings by default; pass
`{ namespace: { scope: 'header' | 'full' } }` to select another document plane.
Full scope exposes explicit `$.header` and `$.body` roots so valid bindings with
the same canonical path in both planes remain independently addressable.
Use `createAeonNamespace(events)` when the source has already been compiled.

#### Semantics and limits

- `candidateAddress` is a locator in the namespace's current structure, not a
  durable identity. Positional addresses can move after edits. A binding's
  `identity`, when present, is separate opaque structural-occurrence metadata;
  SANSA mutation adapters can combine it with observed-state checks to reject
  stale targets.
- Namespace addresses follow complete portable AES event paths. In particular,
  `<tag("value")>` exposes the outer node at its assignment address, its head at
  `[0]`, and its first content value at `[0][0]`. Binding/key metadata remains
  on the outer occurrence; tag metadata remains on the `NodeHead` occurrence.
  References are translated through these levels so their targets stay in the
  same address domain as resolution.
- AES retains the source numeric lexeme. The namespace exposes finite AEON
  numbers as canonical strings by default and supplies the same lexeme to
  SANSA's exact numeric comparator. Pass
  `{ numericMaterialization: 'native' }` to `createAeonNamespace()`, or under
  the `namespace` option of `readAeonNamespace()`, to opt into JavaScript
  numbers while retaining exact comparison metadata.
- AEON `decimal` is the representation-preserving `radix[10]` alias. The
  adapter keeps its radix payload as text; numeric decimal interpretation and
  ordering require an explicit trusted value-semantics profile. Radix-family
  bindings expose their resolved `radixBase` for `decimal`, the reserved radix
  aliases, and `radix[2]` through `radix[64]`, allowing SANSA's explicit
  same-base radix-numeric profile to compare them without host-number coercion.
  They also expose `radixScale`, the represented fractional digit count excluding
  visual `_` separators: `%19.9900` reports 4 and `%19.99` reports 2. Scale is
  representation metadata and does not alter either comparison mode.
- This integration provides bounded, deterministic, in-process resolution and
  query evaluation over compiled events. It does not add persistence, indexes,
  transactions, or a cost-based query optimizer.
- Query projections use AEON assignment syntax (`{ sku = .sku }`). `:` remains
  reserved for datatype annotations.

## What This Package Does

- wraps common read flows around `@altopelago/aeon-core` and `@altopelago/aeon-finalize`
- wraps object emission via `@altopelago/aeon-canonical`
- exposes a canonical-path event index for app code and examples

## API

- `readAeon(input, options?)`
- `readAeonChecked(input, options?)`
- `readAeonStrictCustom(input)`
- `writeAeon(object, options?)`
- `aeonToTelex(input, options?)`
- `readTelex(input, options?)`
- `readTelexChecked(input, options?)`
- `readTelexDocument(input, options?)`
- `readTelexDocumentChecked(input, options?)`
- `writeTelex(records, options?)`
- `readFilm(input, options?)`
- `readFilmDocument(input, options?)`
- `formatPath(path)`
- `indexEventsByPath(events)`
- `createAeonNamespace(events, options?)` from `@altopelago/aeon-sdk/sansa`
- `readAeonNamespace(input, options?)` from `@altopelago/aeon-sdk/sansa`

`CreateAeonNamespaceOptions` accepts `scope` and `numericMaterialization`.
The latter is `lossless` by default and may be set to `native` explicitly.

## Notes

- Prefer this package for simple application examples.
- Use `@altopelago/aeon-core` when you only need compile-only behavior.
- Use `@altopelago/aeon-runtime` when you need the full orchestrated runtime pipeline.
- Film is reader-only. This package deliberately exposes no Film writer or
  AEON-to-Film conversion helper.
- `aeonicLimits` contributes its shared AES structural and processing values to
  Film. Select Film-local byte ceilings separately with `filmLimits`.
