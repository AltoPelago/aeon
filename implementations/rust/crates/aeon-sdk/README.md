# AltoPelago AEON for Rust

`altopelago-aeon` is the public Rust facade for compiling, validating, and
loading AEON documents. It combines the current baseline parser with AEOS
validation, materialization, and portable AES/Telex interchange. The Sofia
parser is available through feature-gated runtime adapters while its public
facade rollout is evaluated separately.

## Load a profile contract

Read a trusted `.aeon` profile artifact and pass its source to
`profiles::load_profile_contract`. The loader validates the artifact as
plain Core v1 data. Use the returned policy for repeated compilation.

```rust
use altopelago_aeon::profiles::load_profile_contract;

let artifact = std::fs::read_to_string("aeon.gp.profile.v1.aeon")?;
let policy = load_profile_contract(&artifact)?;
let result = policy.compile("duration:symbol<time> = |1min|", Default::default());
assert!(result.errors.is_empty());
# Ok::<(), Box<dyn std::error::Error>>(())
```

Use `policy.compile_options(options)` to pass the loaded rules through
`LoadOptions::compile` or to the native compiler. The selected rules take
precedence over profile identifiers in document headers or compile options.
Explicit caller mode and datatype policy options override the corresponding
profile defaults. Profiles that omit `generic_admission`, including GP 1.0.0,
use Core's generic admission and still apply declared datatype semantics.
The loaded GP policy requires a declared rule for each clarifier-bearing
datatype. Collection, container, and capability declarations are available
as metadata.

From `implementations/rust`, test the official artifact against the opt-in
GP profile CTS. The runner verifies the artifact hash and version using the
specs registry.

```sh
cargo run --locked -p altopelago-aeon --example gp_profile_cts -- \
  /path/to/aeonite-specs/resources/contracts/v1 \
  /path/to/aeonite-cts/cts/profile/v1/gp-profile-cts.v1.next.json
```

## SANSA document projection

Property selectors are delivered through the authoritative document
facet for read-only Resolve/direct Query. The
[provider/host matrix](../../../../docs/property-selector-support.md) distinguishes
this from inert Core/WASM literals, native Pytonic Query, the selected portable
AEOS entrypoints and legacy host denials. Stable capability/CTS claims and
release qualification remain separate.

The `sansa_document` module projects an immutable `AeonDocument` as cheap,
cloneable binding handles. It matches the TypeScript AEON namespace contract
for payload, header, and full-document scopes, including attributes, node-head
topology, datatype metadata, references, and lossless numeric lexemes.

Enable the optional `sansa` feature to connect that graph to the independent
`altopelago-sansa-runtime` crate. The adapter then exposes stable SANSA Address,
Resolve, and Query without converting the document to JSON or reimplementing
Query inside AEON:

```toml
[dependencies]
altopelago-aeon = { version = "0.17", features = ["sansa"] }
```

```rust
use altopelago_aeon::sansa_document::{
    AeonNumericMaterialization, AeonSansaNamespace, AeonSansaScope, CompileOptions,
    runtime::evaluate::EvaluateOptions,
};

let namespace = AeonSansaNamespace::compile(
    "items = [{ sku = \"A-100\", qty = 2 }]",
    CompileOptions::default(),
    AeonSansaScope::Payload,
    AeonNumericMaterialization::Lossless,
)?;
let result = namespace.evaluate_query(
    "from $.items.*\nwhere .qty >= 2\nselect .sku",
    &EvaluateOptions::default(),
);
assert!(result.is_ok());
# Ok::<(), altopelago_aeon::sansa_document::DocumentError>(())
```

Local spaces remain host-mounted and are not invented by the document adapter.

With the coordinated SANSA 0.15 provider, the same feature supplies an
authoritative property facet for standalone `namespace.resolve_address(...)` and
direct read-only `namespace.evaluate_query(...)`:
`$.*&key("item")&tag("widget")` selects the original named container for
`item = <widget("hello")>`. `runtime::resolve::ResolveOptions` provides
`max_property_inspections` (default 10,000, maximum 1,000,000).

Authorization uses the immutable document graph, selected plane, materialization
and per-occurrence scope ancestry. Contextual roots hide incoming keys; intrinsic
root tags remain visible. Tag matching streams directly owned `NodeHead` handles
from existing child storage without cloning the children vector. Scope ancestry
has depth-dependent cost, which the logical inspection allowance does not bound.
No performance improvement or new allocation bound is claimed.

Query `.&key("item")` retains its row's originating scope; explicit `?&key("item")`
starts a boundary at that row. One private inspection allowance covers from, where,
ordering and select. Reentrant/public calls receive fresh allowances; outputs keep
original handles and canonical structural paths.

This does not admit property selectors into activation, mutation, AEOS
rules, exact lookup or references. The legacy Core parser/Resolve and actual
Python/native/WASM lexical/AST surfaces are separate ports. Full provider/profile
and resource qualification, owning review/main verification, release and deployment remain
pending; capability manifests and package versions are unchanged.

The same feature exposes experimental `namespace.plan_mutation(&request,
&options)` using the structured types in `runtime::mutate`. The returned
`AeonMutationPlanResult::Planned(plan)` retains the originating namespace and
document, including for an empty plan. `plan.plan()` provides immutable native
operation, target, anchor, precondition and diagnostic views;
`plan.validate_target("aeon")` or `plan.validate_target("json")` performs the
separate representability check. Contextual root handles must belong to the
same document snapshot and scope. Capability fields `mutate_plan` and
`mutate_target_validation` report `Experimental`, while `mutate_apply` reports
`NotExposed`.

Plans are current-process inspection objects. They do not alter the document
or establish schema or authorization approval. Their native target validator
accepts Core's reduced-date datetime/WTC forms, such as `2024-T10:&Europe`,
without imposing GP/schema limits on second 60 or fractional precision.
Temporal relations involving clock-bearing reduced dates conservatively remain
incomparable; their disjoint calendar completion sets are not yet evaluated.

Rust also omits spans for anonymous sequence occurrences because the current
native event model supplies only their owner's range; named bindings and node
heads retain their exact source spans.

The crate is part of the [AltoPelago AEON project](https://github.com/AltoPelago/aeon).
