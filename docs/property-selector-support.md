# Property selector support by API and host

Published 0.17.0 entrypoint boundaries, updated 25 November 2026 from the
22 November provider audit. This table records supported APIs and capability
boundaries; package and selected host acceptance retain their own evidence. See the [release strategy](release-strategy.md)
and [implementation releases](https://github.com/AltoPelago/aeon/releases) for
publication evidence. A package version does not promote experimental profiles
or stable CTS claims. Parsing/transport preserve inert values; evaluation requires
an explicitly authorized namespace and admitted consumer.

In the tagged-node development model, TypeScript and Rust (including native
Python) read `&tag("book")` from the selected node's intrinsic tag. For
`<book("yes")>`, the first child is `$.book[0]` in both SANSA and portable AES,
and `~book[0]` addresses the same value in source. The published 0.17.0 and
pure-Python reference paths retain the earlier topology described below.

## Owning APIs

| Entry point | Delivered property behavior | Boundary |
| --- | --- | --- |
| TypeScript SDK `readAeonNamespace` / `createAeonNamespace` plus SANSA Resolve/Query | Authoritative graph-backed keys, node containers and direct heads; original handles, scope and structural paths retained | Public display fields, strings and ordinary `tag` values do not grant authority |
| Rust SDK `AeonSansaNamespace` with its optional `sansa` integration | Same document facet for read-only Resolve/direct Query | No JSON conversion or alternate Query engine; panic/abort and all adapter construction costs are not covered by checked logical inspection accounting |
| Pure Python `aeon.sansa` / `aeon.sansa_document` | Addressing/rendering and standalone Resolve from assignment events or portable records | No pure-Python Query evaluator; no implicit fallback to the native package |
| Existing native Pytonic `Document.query()` | Property Query through the Rust SDK; bounded `max_property_inspections` and structured diagnostics | Separate from pure Python and from inert Core literal APIs; no generic Python callback facet |
| Portable AEOS TS/Rust/pure Python | `validateTelexRecords` / `validate_telex_records` and `validateTelex` / `validate_telex` admit properties in rule selectors under `aeos-properties-0.1` | Event-locally valid portable records/Telex; legacy native-event `validate` / `validate_events` and structural `path` rules remain closed |
| Existing native Python `load_telex_text` / `load_telex_file` with `schema=` | Reaches the same Rust portable validation path | Existing restricted schema format/default allowance; inspect `.validation` separately from finalisation. Native-source `load_text` / `load_file` retain denial |
| Core/native/WASM literal APIs | Existing inert parsing, AST, canonical representation and transport | No address activation or new generic standalone Resolve/WASM Query API; reduced Core namespaces cannot evaluate properties |

`&key("name")` compares the literal authorized member/attribute key, including
empty/Unicode names. Indices are not keys. `&tag("book")` returns a NodeLiteral
container with a matching direct head; `&headTag("book")` returns a NodeHead.
Explicit `.*` then visits head children. A scoped root hides its incoming key
while retaining intrinsic tags. Neither selector rewrites a result into an
identity address or follows a reference implicitly.

See the [TypeScript SDK](../implementations/typescript/packages/sdk/README.md),
[Rust SDK](../implementations/rust/crates/aeon-sdk/README.md),
[pure Python](../implementations/python/README.md),
[native/Pytonic](../implementations/rust/crates/aeon-python/README.md) and
[portable AEOS profile](aeos-property-selectors.md) for signatures and limits.

## Hosts, exports and intentional denials

| Host/export | Current boundary |
| --- | --- |
| [AEON local playground](../tools/playground/README.md) | Compiles and displays inert property literals in its representation views; it has no Resolve or Query action. Composer parsing and highlighting do not evaluate selectors |
| [SANSA source playground](https://github.com/AltoPelago/sansa/blob/main/README.md#source-playground) | Runs property Resolve and Query using the real SDK namespace and SANSA engines with a matching built AEON checkout |
| Legacy SANSA query CLI/workbench | Their own namespace adapters expose no property facet. A valid property expression can parse but evaluation returns `SANSA_RESOLVE_UNSUPPORTED_PROPERTY_SCOPE`; use a capable SDK or the separate [SANSA source playground](https://github.com/AltoPelago/sansa/blob/main/README.md#source-playground) for evaluation |
| AEON LSP | The compiler accepts inert property literals. Trusted schema validation currently uses native events and rejects property rules with `invalid_schema_policy`, rather than silently converting to portable AEOS |
| Pure Python detailed compiled-AST JSON (`inspect --json`) | Property literals remain explicitly rejected before output. `--json --portable-aes`, `--telex` and annotation-only output remain available; this does not reject standalone parser/Resolve APIs |
| IDE grammars, native editor/Quick Look hosts, website/Tonics bundles | Source parsing or a shared highlighter does not prove full presentation or final installed/vendor support. Selected editor, installed VSIX, browser and vendor checks are recorded in the owning release evidence; they do not establish blanket native-host/platform support |

The SANSA browser launcher requires the built checkout layout under
`implementations/typescript/packages/`. An installed consumer root with packages
under `node_modules`, or the SDK package directory itself, is not accepted as
`--aeon-root`. Installed packages
can instead be checked with the separate
[non-browser property verification workflow](https://github.com/AltoPelago/sansa/blob/main/tools/playground/README.md#property-selectors-development),
run from the SANSA repository:

```sh
node tools/workflows/verify-property-playground.mjs /absolute/path/to/consumer --installed
```

`--installed` belongs to that verification script, not the browser launcher.
Passing its 15 examples establishes the selected installed API behavior, not
browser-launcher layout support.

Activation (including trusted), Graph, Instruction/Mutate/SO, clone/pointer
references and event/storage paths do not admit property predicates. Direct
read-only Query does not authorize Query-shaped mutation/precondition callers.
The AES Type Transpiler remains deferred, not a 0.17.0 prerequisite. Positional
selectors retain their separate resource/grouping/scope gate.

## Allowances and release evidence

Resolve uses `maxPropertyInspections` (Rust `max_property_inspections`), default
10,000 and portable maximum 1,000,000. Direct Query shares one private allowance
across its clauses; native Pytonic exposes `max_property_inspections`. Portable
AEOS exposes its own schema/host resource policy. Do not pass one entry point's
option spelling to another or infer an override on the restricted native loader.
Candidates and yielded direct heads are charged as documented, including misses
and repeated occurrences. Logical allowances do not bound construction, ancestry,
old navigation, all host work, wall time or heap.

These delivered APIs do not establish exhaustive/stable CTS, experimental-profile
promotion or whole-platform support. Package publication, installed extensions and
registry/vendor graphs require their own exact artifact/consumer evidence. Prior
native/WASM checks are not a new rebuild or exact binary reproducibility proof.
Compatibility/target checks, defaults and existing 1.15x latency / 1.20x memory
budgets remain unchanged, including the narrow identity qualification limitation.
The reviewed provider-first publication and stable downstream adoption are complete.
Selected live website deployment is accepted; staging is owner-deferred. See the
[deployment checkpoint](https://github.com/AltoPelago/roadmap/blob/main/aeon/work-in-progress/release-0.17.0-live-deployment-2026-11-25.md)
for exact scope. Newline/local positions remain deferred to tentative 0.17.1.
