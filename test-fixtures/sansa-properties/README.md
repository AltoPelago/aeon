# Experimental property fixtures

These three files are byte-identical mirrors of SANSA revision
`da76789aff29025affe180196e79ba5749c9e0a2`. They are experimental parity
inputs, not a new CTS claim or a stable profile declaration.

| File | SHA-256 |
| --- | --- |
| property-parser-candidate-v1.json | 7549b6c501f306368ed76adf47ba3c7d8f605fd9b40338b3010dc1254eaa896b |
| property-resolve-candidate-v1.json | 3cafd875d3341719f4cb2b2b2fcc1d48404e2a9644c8b83ff6a8b80336690cba |
| property-namespace-candidate-v1.json | 867feaee7445b4bbb7d86ed84c0b8ce18523ebbc1ec76cd4f845b24aec273a83 |

Pure Python checks every present expected field in all 40 parser and 95 Resolve
vectors. The scripted namespace adapter translates non-array wire responses to
checked metadata faults; real Python iterable/generator tests cover the native
protocol separately. Rust Core checks 39 parser vectors: its existing parse API
has no raised-index option, so that one vector remains covered by standalone
Python and SDK APIs. Core's reduced namespace deliberately denies evaluation.
The owning SDK's 31 shared document cases remain in `../property-resolve-sdk.json`.

`../property-address-literals.json` freezes ten canonical spellings against the
same SANSA source. Rust Core, pure/native Python and regenerated WASM test these
inert literals and keep clone/pointer references structural. Streaming tests cover
Rust character boundaries and WASM UTF-8 byte boundaries. No new consumer
admission, performance acceptance or release is implied.
