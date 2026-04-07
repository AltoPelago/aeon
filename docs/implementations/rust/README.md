# Rust Implementation

This section documents the Rust implementation as an implementation, not as the AEON language standard.

The pages here are informative. They describe the current Rust workspace structure, public crate entry points, CLI scope, and implementation-specific operational notes.

Related design note:

- [`api/sdk-proposal.md`](./api/sdk-proposal.md)

## Workspace

Rust workspace root:

- [`implementations/rust`](../../../implementations/rust)

Current workspace members:

- `aeon-sdk`
- `aeon-core`
- `aeon-annotations`
- `aeon-aeos`
- `aeon-canonical`
- `aeon-finalize`
- `aeon-cli`

Workspace/toolchain notes:

- MSRV: Rust `1.85`
- edition: Rust `2024`
- binary entrypoint: `aeon-rust`

Supply-chain notes:

- Rust dependencies are locked via `Cargo.lock`
- CI now runs a RustSec advisory scan (`cargo audit`) in addition to build/test checks
- this workspace currently does not depend on a general-purpose HTTP client stack, which reduces exposure to the class of incident that drove the recent TypeScript hardening pass

## Public Library Surfaces

Core compile pipeline:

- crate: `aeon-core`
- primary entry point: `compile(input: &str, options: CompileOptions) -> CompileResult`
- related public types include `CompileOptions`, `CompileResult`, `AssignmentEvent`, `Binding`, `Value`, `CanonicalPath`, `Diagnostic`, and `DatatypePolicy`

Canonical formatting:

- crate: `aeon-canonical`
- primary entry point: `canonicalize(source: &str) -> CanonicalResult`

Annotation extraction:

- crate: `aeon-annotations`
- primary entry points:
  - `extract_annotations(source: &str) -> Vec<AnnotationRecord>`
  - `sort_annotations(records) -> Vec<AnnotationRecord>`

AEOS validation:

- crate: `aeon-aeos`
- primary entry points:
  - `validate(envelope: &ValidationEnvelope) -> ResultEnvelope`
  - `validate_cts_payload(payload: &str) -> Result<String, String>`

Finalization/materialization:

- crate: `aeon-finalize`
- primary entry points:
  - `finalize_json(events, options) -> FinalizeJsonResult`
  - `finalize_map(events, options) -> FinalizeMapResult`
  - `from_aeon_str<T>(source, options) -> Result<T, MaterializeError>`
  - `finalize_into<T>(events, options) -> Result<T, MaterializeError>`

Application convenience layer:

- crate: `aeon-sdk`
- primary entry points:
  - `load_str::<T>(source, options) -> Result<LoadedDocument<T>, AeonLoadError>`
  - `load_file::<T>(path, options) -> Result<LoadedDocument<T>, AeonLoadError>`

CLI:

- crate: `aeon-cli`
- binary: `aeon-rust`

## CLI Scope

The Rust CLI is broader than the current Python CLI and is used as one of the repository’s independent implementation surfaces.

Documented current commands and capabilities include:

- `check`
- `inspect`
- `fmt`
- `finalize --json`
- `finalize --map`
- `bind`
- `doctor`
- `integrity validate`
- `integrity verify`
- `integrity sign`
- `--cts-validate`

For the most current supported flags and behavior details, use the workspace README and the command help from the binary itself:

```bash
cd implementations/rust
cargo run -p aeon-cli --bin aeon-rust -- help
```

## Build And Test

Run the Rust test suite:

```bash
cd implementations/rust
cargo test
```

Build the CLI:

```bash
cd implementations/rust
cargo build -p aeon-cli --bin aeon-rust
```

Build an optimized release binary:

```bash
cd implementations/rust
cargo build --release -p aeon-cli --bin aeon-rust
```

## CTS And Conformance

The Rust workspace is an active independent implementation and is currently used against shared CTS lanes.

Repository-level canonical parity harness:

```bash
bash ./scripts/canonical-cts.sh
```

Rust workspace README with current status and CTS notes:

- [`implementations/rust/README.md`](../../../implementations/rust/README.md)

Cross-language implementation guidance:

- [`docs/implementations/implementation-guideline.md`](../implementation-guideline.md)

## Operational Notes

The Rust workspace README also tracks a macOS-specific release-binary note for local ad-hoc re-signing when a release binary is emitted in a linker-signed state that hangs before `main()`.

Relevant helper:


## Boundary Note

- `specs/` defines AEON language and conformance requirements.
- `docs/` describes how the Rust implementation packages and exposes those rules.
