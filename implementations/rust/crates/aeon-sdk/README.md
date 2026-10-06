# AltoPelago AEON for Rust

`altopelago-aeon` is the public Rust facade for compiling, validating, and
loading AEON documents. It combines the current baseline parser with AEOS
validation, materialization, and portable AES/Telex interchange. The Sofia
parser is available through feature-gated runtime adapters while its public
facade rollout is evaluated separately.

## SANSA document projection

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
altopelago-aeon = { version = "0.15", features = ["sansa"] }
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
Rust also omits spans for anonymous sequence occurrences because the current
native event model supplies only their owner's range; named bindings and node
heads retain their exact source spans.

The crate is part of the [AltoPelago AEON project](https://github.com/AltoPelago/aeon).
