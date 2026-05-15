# @altopelago/aeon-wasm

Browser-facing wrapper for the Rust AEON implementation.

The TypeScript package is intentionally thin. It loads the generated `wasm-pack`
output from `pkg/` and exposes a typed async API for parity playgrounds and
browser-based conformance checks.

```ts
import { processAeon } from '@altopelago/aeon-wasm';

const result = await processAeon('name:string = "AEON"\n', {
  validationMode: 'strict',
  finalizeScope: 'payload',
});

console.log(result.finalized.document);
```

`processAeon` returns the normalized engine contract used by browser parity
tools:

- `engine`: currently `rust-wasm`
- `ok`: true when there are no errors
- `canonical.text`: canonical AEON text
- `finalized.document`: materialized JSON-compatible output, or `null`
- `events`: normalized event summaries
- `annotations`: annotation stream records
- `diagnostics.errors` and `diagnostics.warnings`

For compatibility, `errors` and `warnings` are also exposed as top-level aliases
of `diagnostics.errors` and `diagnostics.warnings`.

## Build

Build the TypeScript wrapper:

```sh
pnpm --filter @altopelago/aeon-wasm build
```

Build the Rust WASM artifact:

```sh
pnpm --filter @altopelago/aeon-wasm build:wasm
```

`build:wasm` requires `wasm-pack` and reads the Rust crate from
`implementations/rust/crates/aeon-wasm`.
