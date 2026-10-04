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

This is deliberately an integration boundary rather than a claim of complete
SANSA support. Exact address lookup is available as graph indexing, while
SANSA address parsing, Resolve, Query, and local spaces remain unexposed until
the Rust implementations satisfy the corresponding contracts. Rust also omits
spans for anonymous sequence occurrences because the current native event
model supplies only their owner's range; named bindings and node heads retain
their exact source spans.

The crate is part of the [AltoPelago AEON project](https://github.com/AltoPelago/aeon).
