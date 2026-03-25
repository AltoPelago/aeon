# AEON Rust Implementation

Rust workspace for the AEON implementation effort.

## Goal

The Rust implementation is intended to validate that the current AEON v1 specs and CTS are strong enough to support a third independent implementation without copying TypeScript-specific structure.

Its first job is conformance, not feature breadth.

The current Rust work also makes one boundary explicit:

- `spec + CTS` are enough for the semantic core
- TypeScript CLI contract tests are still important for full user-facing CLI parity

## Toolchain

- MSRV: Rust `1.85`
- Edition: Rust `2024`

## Phase 1 Target

Initial Rust deliverables:

- Core compile pipeline
- CTS adapter support for `core`, `aes`, `annotations`, and `aeos`
- canonical formatting
- practical Rust CLI with `inspect`, `fmt`, and `finalize`

## Guidance

Start with these documents:

- [`docs/implementations/implementation-guideline.md`](../../docs/implementations/implementation-guideline.md)
- [`specs/02-implementation/rust/rust-implementation-checklist.md`](../../specs/02-implementation/rust/rust-implementation-checklist.md)
- [`specs/02-implementation/rust/rust-restart-note.md`](../../specs/02-implementation/rust/rust-restart-note.md)
- [`cts/README.md`](../../cts/README.md)

## Status

This workspace is now an active implementation rather than a placeholder scaffold.

The current crates include:

- `aeon-core`
- `aeon-annotations`
- `aeon-aeos`
- `aeon-canonical`
- `aeon-finalize`
- `aeon-cli`

Current verified status:

- `core` CTS: green
- `aes` CTS: green
- `annotations` CTS: green
- `aeos` CTS: green
- `canonical` CTS: green
- promoted fail-closed Core semantics (`DUPLICATE_CANONICAL_PATH`, `HEADER_CONFLICT`, strict untyped switch rejection) now live in shared CTS too
- exact Rust-side CLI contract tests cover `check`, `fmt`, `inspect`, `finalize`, `bind`, `doctor`, and `integrity`
- a first Rust stress-smoke pass against the repository stress corpus exposed follow-up parser hardening work in:
  - slash-channel and unterminated structured comment handling
  - namespace and escaped quoted-key stress fixtures
  - multiline node-introducer parsing
  - trimticks mixed-whitespace parsing
- a follow-up hardening pass cleared those parser gaps
- the repository full-feature stress fixture now runs cleanly under the current shared three-mode contract
- production compile now uses the token parser directly
- the legacy raw parser and its comparison tooling have been removed
- post-removal verification remains green:
  - Rust stress smoke
  - strict `scenarios.aeon` check

Current CLI status:

- markdown and JSON `inspect`
- annotation variants for `inspect`
- `fmt`
- `finalize --json`
- `finalize --map`
- minimal `bind --schema <schema.json>`
- direct schema JSON validation for canonical metadata keys and required fields
- `bind --annotations` and `--sort-annotations`
- `bind --trailing-separator-delimiter-policy <off|warn|error>`
- `bind --datatype-policy allow_custom` and `--rich`
- explicit `bind --profile <id>` warning when profile processors are acknowledged but not executed
- `bind --contract-registry <registry.json>` for trusted schema/profile resolution from header IDs
- contract artifact existence and SHA-256 verification
- `integrity validate <file>` with plain and JSON output
- `integrity verify <file>` with canonical hash verification and JSON metadata
- `integrity verify <file> --public-key <path>` for Ed25519 signature verification
- `integrity sign <file> --private-key <path>` with JSON and `--write` output
- `integrity sign ... --replace`
- `integrity sign ... --include-bytes`
- `integrity sign ... --include-checksum`
- GP security convention insertion/merge on `integrity sign --write`
- `doctor [--json] [--contract-registry <registry.json>]`
- projected and loose-mode `bind` behavior
- AEOS CTS adapter via `--cts-validate`

Run the starter test suite with:

```bash
cd implementations/rust
cargo test
```

For direct CLI benchmarking, prefer the built release binary over `cargo run`.
The repository benchmark helper is:

```bash
python3 scripts/bench-cli.py \
  --cwd implementations/rust \
  --timeout 15 \
  -- ./target/release/aeon-rust check /tmp/example.aeon
```

## macOS Release Binary Note

On this machine, the Rust release binary can be emitted in a `linker-signed`
state that hangs before `main()` runs, even though the debug binary works.

If `./target/release/aeon-rust help` hangs but `./target/debug/aeon-rust help`
works, re-sign the release binary ad hoc:

```bash
```

This produces a plain ad-hoc signature and has been sufficient to restore
normal startup on macOS in local testing.
