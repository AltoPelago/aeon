# Property selector support by API and host

Unreleased development support, updated 22 November 2026. The table records
existing entry points; it changes no capability manifest, selector policy, package
version or dependency selection. Parsing and transport preserve inert address
values; evaluation needs an explicitly authorized namespace and admitted consumer.

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
| Local source playground / coordinated SANSA source playground | Use the real compiler/SDK/SANSA engines with the explicitly selected built or installed graph. Highlighting and Composer parsing do not authorize another API |
| Legacy SANSA query CLI/workbench | Their own namespace adapters expose no property facet. A valid property expression can parse but evaluation returns `SANSA_RESOLVE_UNSUPPORTED_PROPERTY_SCOPE`; use a capable SDK or source playground instead |
| AEON LSP | The compiler accepts inert property literals. Trusted schema validation currently uses native events and rejects property rules with `invalid_schema_policy`, rather than silently converting to portable AEOS |
| Pure Python detailed compiled-AST JSON (`inspect --json`) | Property literals remain explicitly rejected before output. `--json --portable-aes`, `--telex` and annotation-only output remain available; this does not reject standalone parser/Resolve APIs |
| IDE grammars, native editor/Quick Look hosts, website/Tonics bundles | Source parsing or a shared highlighter does not prove full presentation or final installed/vendor support. Editor property-literal coverage and exact selected graph/platform/registry qualification remain separate work |

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

These delivered APIs are development support, not an exhaustive/stable CTS or
whole-platform claim. Published packages, installed extensions, registry/vendor
assets and every runtime/platform combination require their own exact artifact
evidence. Prior native/WASM evidence is not a new rebuild or proof of exact WASM
binary reproducibility. Compatibility/target checks, default limits and the
existing 1.15x latency / 1.20x memory budgets are unchanged. Official releases,
deployment and stable promotion remain on hold.
