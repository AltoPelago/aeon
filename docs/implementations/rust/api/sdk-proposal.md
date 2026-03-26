# Convenience Crate Proposal

Informative status: proposal for a public Rust convenience crate to simplify application-facing AEON usage.

## Problem

The current Rust implementation has a good minimal typed-loading path, but richer application flows still require too much library glue.

The Rust examples now show that split clearly:

- `hello-world` is compact and ergonomic
- `sayonara-sun` has to manually orchestrate compile, AEOS validation, envelope conversion, finalization, and business-rule checks

That means the implementation has the right low-level pieces, but it does not yet have a small public app-facing layer for the common "load and validate config" workflow.

## Current split

Today the Rust library surface is roughly:

- `aeon-core`
  - compile-only AEON processing
- `aeon-finalize`
  - finalization and typed materialization
- `aeon-aeos`
  - AEOS validation over explicit validation envelopes
- `aeon-canonical`
  - canonical formatting
- `aeon-cli`
  - binary and repo-facing orchestration

The friction is that application code needing schema validation currently has to recreate logic that already exists in the CLI:

- compile source
- convert `AssignmentEvent` values into `aeon-aeos` envelope events
- build `ValidationEnvelope`
- check schema errors
- then perform typed materialization

## Recommendation

Do not push that glue into `aeon-aeos`.

`aeon-aeos` should remain the lower-level validation surface, especially because it also serves conformance and CTS-oriented use cases.

Instead, add a small public convenience crate:

- proposed name: `aeon-sdk`

## Proposed crate role

`aeon-sdk` should be the app-facing convenience layer for common Rust application tasks:

- load AEON text or files
- fail on compile errors before application logic continues
- optionally apply AEOS schema validation
- materialize into typed Rust structs
- provide a small loaded-document result shape for cases where callers want both events and typed output

That would make it the Rust counterpart to:

- Python `load_text(...)` / `load_file(...)`
- TypeScript `@aeon/sdk`

## Proposed API shape

Minimum first-wave API:

```rust
load_str::<T>(source, options)
load_file::<T>(path, options)
```

Proposed supporting types:

```rust
LoadOptions
LoadedDocument<T>
AeonLoadError
```

Likely `LoadOptions` fields:

```rust
compile: CompileOptions
finalize: FinalizeOptions
schema: Option<Schema>
```

Likely `LoadedDocument<T>` shape:

```rust
pub struct LoadedDocument<T> {
    pub compiled: CompileResult,
    pub validation: Option<ResultEnvelope>,
    pub document: T,
}
```

If a lighter first step is preferred, `load_str::<T>` and `load_file::<T>` can simply return `Result<T, AeonLoadError>` first, with `LoadedDocument<T>` added later.

## Boundary rules

Recommended crate boundaries after promotion:

- keep in `aeon-core`
  - low-level compile entry
  - event model
  - diagnostics
- keep in `aeon-finalize`
  - finalization and typed materialization primitives
- keep in `aeon-aeos`
  - explicit schema/AEOS validation primitives
  - CTS-oriented envelope validation
- keep in `aeon-canonical`
  - formatting and emission
- move to `aeon-sdk`
  - convenience wrappers that compose core, finalize, and optional AEOS validation

## What should move out of examples

Once `aeon-sdk` exists, examples should no longer need to carry:

- compile error summarizers
- manual `AssignmentEvent -> AesEvent` conversion
- explicit `ValidationEnvelope` assembly for ordinary app usage
- duplicate "load, validate, materialize" orchestration

That logic should live in one library place, not be repeated in each example.

## Example guidance

Once `aeon-sdk` exists:

- simple application examples should prefer `aeon-sdk`
- compile-only or infrastructure-heavy examples can still use `aeon-core` directly
- CLI/conformance code can continue to use the lower-level crates directly

## Migration path

1. Create `aeon-sdk` as a new public Rust crate in the workspace.
2. Implement `load_str::<T>` and `load_file::<T>` on top of `aeon-core`, `aeon-finalize`, and optional `aeon-aeos`.
3. Move the Sayonara Sun Rust example to `aeon-sdk`.
4. Leave `hello-world` either on `aeon-finalize::from_aeon_str` or move it too if the API is clearly simpler.
5. Keep CLI-only conversion helpers out of examples once the convenience crate exists.

## Why this is better than only using `aeon-finalize`

`aeon-finalize::from_aeon_str` is already a good primitive for:

- "load this document into a typed struct"

But richer application code also wants:

- optional schema validation
- one error type for compile, schema, and materialization failure
- file-oriented loading
- a consistent result story across examples

That is convenience-layer territory, not something every application should rebuild.

## Short conclusion

Rust already has the right low-level pieces.
The main issue is that richer application flows still require too much orchestration code at the call site.

The cleanest next step is:

- add a public `aeon-sdk` crate
- keep `aeon-core`, `aeon-finalize`, and `aeon-aeos` focused on their current lower-level roles
