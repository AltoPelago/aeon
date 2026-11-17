# Experimental property fixtures

These three files are byte-identical mirrors of SANSA revision
`dbe6d7f0ebcc40418b3b979475d6798f65d2fe2f`. They are experimental parity
inputs, not a new CTS claim or a stable profile declaration.

| File | SHA-256 |
| --- | --- |
| property-parser-candidate-v1.json | 84aac40fa4360a7fccfa16f820195edef5f0fe8938ad6d689a7c43c7477d25e0 |
| property-resolve-candidate-v1.json | 724ea13d00ccf53c23cee502fa7f858925f2ef4b1e0e591759750e18d4290ec2 |
| property-namespace-candidate-v1.json | 7261bc7219b49e8f8c03b2b43e931ac611fafd2fc3e48b28dd3e51f2e4072b16 |

Pure Python checks every present expected field in all 34 parser and 83 Resolve
vectors. The scripted namespace adapter translates non-array wire responses to
checked metadata faults; real Python iterable/generator tests cover the native
protocol separately. Rust Core checks 33 parser vectors: its existing parse API
has no raised-index option, so that one vector remains covered by standalone
Python and SDK APIs. Core's reduced namespace deliberately denies evaluation.
The owning SDK's 26 shared document cases remain in `../property-resolve-sdk.json`.

`../property-address-literals.json` freezes eight canonical spellings against the
same SANSA source. Rust Core, pure/native Python and regenerated WASM test these
inert literals and keep clone/pointer references structural. Streaming tests cover
Rust character boundaries and WASM UTF-8 byte boundaries. No new consumer
admission, performance acceptance or release is implied.
