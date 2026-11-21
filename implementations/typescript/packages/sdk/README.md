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
PascalCase representation kinds, preserves datatype components, translates
reference targets into the same portable address domain, and derives portable
origin and UTF-8 byte spans from the exact source text.

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

The coordinated unreleased SANSA candidate supports literal `&key("...")`,
`&tag("...")` and `&headTag("...")` filters through this namespace's explicit
`properties` facet. See the [provider/host matrix](../../../../docs/property-selector-support.md):

```ts
const { namespace: document } = readAeonNamespace('item = <widget("hello")>');
const selected = resolveAddress('$.*&key("item")&tag("widget")', document, {
  maxPropertyInspections: 1000,
});
// The original item container is returned; its address remains '$.item'.
```

Keys come from authored member metadata, including an empty member name, and
indices do not become keys. Tag inspection uses directly owned `NodeHead`
occurrences, never ordinary `tag` fields or a cached container tag. A contextual
root hides its incoming key while retaining intrinsic node tags. Attribute-space
transitions establish boundaries; inspecting a binding outside its boundary or
from another namespace fails without exposing foreign metadata.

The adapter captures authoritative topology/metadata when it builds the namespace;
editing public display fields cannot change that authority. This adds linear
construction storage; scope checks follow graph ancestry and have depth-dependent
cost. Head enumeration streams the captured direct heads without making an
inspection-time array copy. Resolve's logical allowance is separate from those
adapter costs: it defaults to 10,000, has portable maximum 1,000,000, and counts
candidates and yielded direct heads, including misses and repeated occurrences.

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

`CreateAeonNamespaceOptions` accepts `scope`, `numericMaterialization`, and
optional exact `sourceBytes` for portable provenance.
`numericMaterialization` is `lossless` by default and may be set to `native`
explicitly.

## Notes

- Prefer this package for simple application examples.
- Use `@altopelago/aeon-core` when you only need compile-only behavior.
- Use `@altopelago/aeon-runtime` when you need the full orchestrated runtime pipeline.
- Film is reader-only. This package deliberately exposes no Film writer or
  AEON-to-Film conversion helper.
- `aeonicLimits` contributes its shared AES structural and processing values to
  Film. Select Film-local byte ceilings separately with `filmLimits`.


#### Experimental property Query

The coordinated local SANSA candidate also admits direct read-only Query with
this namespace's authoritative property facet. `from $.items.*` followed by
`select .name&key("name")` selects each original name binding. Current-row
`.&key("items")` keeps its originating scope; explicit `?&key("items")` starts a
boundary at the row and hides that incoming key. `&tag` matches node containers;
`&headTag` matches heads, with explicit child navigation when needed.

One `resolve.maxPropertyInspections` allowance covers all Query clauses and
projections; complete capability preflight runs even for empty/short-circuited
sources. Errors return no partial records. Mutation, activation (including
trusted) and references remain closed. Portable AEOS uses its separate admitted
APIs; native-event AEOS and the LSP path remain closed. Pure Python has no Query
evaluator. Existing native Pytonic `Document.query()` is separately integrated
through the Rust SDK; no generic Python callback bridge or WASM Query API is added.
This candidate makes no new performance, release or deployment qualification.
