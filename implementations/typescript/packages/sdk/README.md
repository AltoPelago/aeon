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
topology. A node is one `NodeLiteral` record with an intrinsic tag and direct
indexed children. Reference targets retain the same structural path in AEON
and portable AES. The adapter preserves datatype components and derives byte
spans and portable origin from the exact UTF-8 source.

The namespace exposes payload bindings by default; pass
`{ namespace: { scope: 'header' | 'full' } }` to select another document plane.
Full scope exposes explicit `$.header` and `$.body` roots so valid bindings with
the same canonical path in both planes remain independently addressable.
Use `createAeonNamespace(events)` when the source has already been compiled.
Pass its exact UTF-8 artifact as `sourceBytes` when provenance is required;
without those bytes, event bindings deliberately omit `origin` and `span`.

The namespace also exposes declared binding identities to standalone SANSA Resolve:

```ts
import { resolveAddress } from '@altopelago/sansa';

const selected = readAeonNamespace('items=[\\item1\\=1]').namespace;
const result = resolveAddress('$.items.\\item1\\', selected);
// result.bindings[0].address is '$.items[0]'.
```

Identity selection scans direct children in the exposed plane and uses Resolve's
`maxIdentityInspections` and `maxBindings` limits. The selector is non-exact;
returned bindings retain their current structural addresses. A new snapshot can
select a different occurrence with a reused identity, so an identity does not
establish continuity. Query/address activation, mutation, Instruction and AEOS
selector admission remain separate; clone/pointer references remain structural
paths.

#### Experimental standalone property Resolve

The revised node model uses SANSA's checked `&key("...")` and
`&tag("...")` filters through the namespace's `properties` facet.

```ts
const { namespace } = readAeonNamespace('<widget("hello")>');
const selected = resolveAddress('$.widget&tag("widget")', namespace);
// The selected node's address is '$.widget'. Its first child is '$.widget[0]'.
```

Keys come from authored member metadata, including empty member names. Indexed
nodes expose their tag and position. A contextual root hides its incoming key
and retains its intrinsic tag. Attribute-space transitions establish scope
boundaries. Editing a display binding does not change the metadata captured when
the namespace was built.

The property allowance counts each candidate inspection, including misses and
repeated occurrences. It defaults to 10,000 with a maximum of 1,000,000. Namespace
construction and ancestry traversal have separate costs.

Direct read-only Query is also admitted in the coordinated candidate (see below).
Activation, mutation, Instruction and references remain closed to properties.
The separately implemented [portable AEOS profile](../../../../docs/aeos-property-selectors.md)
admits explicit portable AES/Telex selectors; legacy native-event validation
remains closed. Python/native/WASM literal ports and source-playground integration
are delivered, while full profile/cost/platform/registry qualification remains
separate. No release or deployment is authorized by this development support.

#### Semantics and limits

- `candidateAddress` is a locator in the namespace's current structure, not a
  durable identity. Positional addresses can move after edits. A binding's
  `identity`, when present, is separate opaque structural-occurrence metadata;
  SANSA mutation adapters can combine it with observed-state checks to reject
  stale targets.
- The node authored as `<tag("value")>` is at `$.tag` and its first child
  is at `$.tag[0]`. `~tag[0]`, `~>tag[0]` and exact SANSA `$.tag[0]`
  identify the same structural occurrence in the payload scope.
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

`CreateAeonNamespaceOptions` accepts `scope`, `numericMaterialization`, and
optional exact `sourceBytes` for portable provenance.
`numericMaterialization` is `lossless` by default and may be set to `native`
explicitly.

## Notes

- Prefer this package for simple application examples.
- Use `@altopelago/aeon-core` when you only need compile-only behavior.
- Use `@altopelago/aeon-runtime` when you need the full orchestrated runtime pipeline.
- Film is reader-only. Revised tagged nodes use the Telex carrier in this
  TypeScript development slice. Checked Film node reads require the revised
  Film kind and fixture work tracked for the next slice.
- `aeonicLimits` contributes its shared AES structural and processing values to
  Film. Select Film-local byte ceilings separately with `filmLimits`.


#### Experimental property Query

The coordinated local SANSA candidate also admits direct read-only Query with
this namespace's authoritative property facet. `from $.items.*` followed by
`select .name&key("name")` selects each original name binding. Current-row
`.&key("items")` keeps its originating scope; explicit `?&key("items")` starts a
boundary at the row and hides that incoming key. `&tag` compares the current
node’s intrinsic tag. Append `.*` to visit its direct children.

One `resolve.maxPropertyInspections` allowance covers all Query clauses and
projections; complete capability preflight runs even for empty/short-circuited
sources. Errors return no partial records. Mutation, activation (including
trusted) and references remain closed. Portable AEOS uses its separate admitted
APIs; native-event AEOS and the LSP path remain closed. Pure Python has no Query
evaluator. Existing native Pytonic `Document.query()` is separately integrated
through the Rust SDK; no generic Python callback bridge or WASM Query API is added.
This candidate makes no new performance, release or deployment qualification.
