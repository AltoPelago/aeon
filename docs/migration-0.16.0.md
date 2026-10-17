# Migrating to AEON 0.16.0

This coordinated TypeScript, Rust and Python implementation release targets
AEON v1. It does not rename the language line or rewrite published 0.15.0
artifacts. Update all packages in a TypeScript workspace together; the native
PyPI distribution remains `altopelago-aeon`, imported as `altopelago.aeon`.

## Canonical source bytes

Source canonicalization now defaults to `reference-safe-v1`, covered by
immutable `canonical-cts-v1-snapshot-0.4`. This applies to the TypeScript and
Rust canonical APIs, pure-Python reference API, native Python facade, all three
`fmt` CLIs, and standalone/process WASM.

The writer validates authored Core references before sorting or inserting a
default header. Missing, forward and self references fail; sorting does not
repair invalid source. A successful output preserves references rather than
evaluating them, is valid under the same Core reference rules, and is a fixed
point. This is not datatype, GP profile or schema approval.

For example, the valid input:

```aeon
d = 3
c = 2
b = ~c
a = 1
```

now has canonical body order `a, c, b, d`, not `a, b, c, d`. At every step the
writer selects the smallest eligible decoded key by Unicode scalar value.
Header fields, root/object bindings and metadata entries can be reordered;
list, tuple and node-child positions are unchanged. Unicode normalization and
case folding are not applied.

### Historical bytes and integrity

Keep stored digests/signatures, caches and reproducibility fixtures tied to
their original canonical contract. Do not silently recanonicalize a signed
payload using the new default. Explicit historical source ordering remains
available in the libraries:

```ts
import { canonicalize } from '@altopelago/aeon-canonical';

const historical = canonicalize(source, { ordering: 'lexical-v1' });
```

The WASM canonical API accepts the same option. Native Python uses
`aeon.canonicalize(source, ordering="lexical-v1")`; the pure-Python reference
API uses `CanonicalizeOptions(ordering="lexical-v1")`. Rust uses
`canonicalize_with_options` with `CanonicalOrdering::LexicalV1`.
The `fmt` CLIs and WASM process pipeline have no legacy-ordering flag; use the
standalone library operation when reproducing historical source bytes.

`lexical-v1` retains the historical writer's behavior, including its lack of
authored-reference validation. It is compatibility output, not a way to make
invalid input valid. The reference-safe APIs return diagnostics and no partial
source text on failure; native Python raises `CompileError` instead of
returning text. Pure-Python reference-safe output now ends with a newline,
matching TypeScript and Rust.

Integrity event hashing and receipt verification retain their separate legacy
assignment projection. They do not adopt source dependency ordering in this
release. Portable AES logical bytes, canonical AEON source text, and integrity
event bytes are distinct contracts. Plain-object emission (`emitFromObject`)
and Telex canonicalization are unchanged.

## Generic arguments must be types

Generic arguments now require datatype descriptors throughout AEON, portable
AES, Telex and validated Film. Bare numeric or string generic arguments such as
`custom<1.0>` are invalid. Put numeric/string parameters in clarifiers on the
appropriate descriptor, for example `custom[1.0]` or
`list<custom[1.0]>`; do not mechanically reinterpret a generic as a clarifier
without reviewing the intended type.

Reserved non-`node` arguments in a binding-side `node<T>` claim are rejected
consistently, even when clarified or attached to a reference-valued binding.
Custom/domain arguments and tag-head child-content claims remain separate.
Provisional Film inspection may expose historical numeric generic tags, but
those records cannot complete as accepted AES.

## Numeric clarifiers are exact number literals

TypeScript and pure-Python parser ASTs now retain numeric datatype clarifiers
as `NumberLiteral` nodes, not host numbers. Code inspecting clarifier arrays
must distinguish quoted string values from numeric nodes and read the node's
string `value` (normalized) or `raw` (authored spelling). For example:

```ts
const clarifier = annotation.clarifiers[0];
if (typeof clarifier === 'object' && clarifier.type === 'NumberLiteral') {
  console.log(clarifier.value); // exact numeric text, not a JavaScript Number
}
```

This preserves `9007199254740993` and `2.0000000000000001` without rounding.
Normalization follows value numbers: `1.00` becomes `1.0`, while `1e3` remains
`1e3`. The same rules apply inside nested descriptors and metadata. Quoted
clarifiers remain strings. Caller-constructed annotations still accept host
numbers, but cannot recover precision already lost before the call. Portable
AES retains its tagged numeric-string representation.

### Radix and GP validation

Core preserves a numeric clarifier without deciding whether it is a valid
radix base. GP and radix consumers perform that check exactly. Integral
decimal/exponent spellings such as `radix[2.00]` and `radix[2e0]` denote base 2;
`radix[2.0000000000000001]` is fractional and must not be rounded to base 2.
Explicit invalid bases cannot bypass finalization or AEOS constraints by being
treated as unspecified.

GP clarifier validation now also visits body metadata, anonymous item heads
and ordinary node tag heads. Previously missed invalid claims may therefore
be diagnosed. Core-only acceptance is not GP approval; canonicalization does
not impose GP policy merely because a document declares a GP header.

## Film dependency and release scope

Rust and native Python source builds require the published
`altopelago-aes-telex` 0.3.1 provider or later. It is independently versioned,
not an AEON 0.16.0 package. Film generic depth now follows shared logical AES
depth: `list<int>` fits a maximum generic depth of zero, and clarified leaves
do not add a level. Existing configured limits and wire/tag assignments are
unchanged. The TypeScript Film surface remains reader-only, claiming Film CTS
0.4; this release does not open the durable-writer gate.

The node/source-path adapter changes from 0.15.0 remain in effect; see the
[previous migration guide](migration-0.15.0.md) when upgrading from 0.14.x.
