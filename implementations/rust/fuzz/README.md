# AEON Rust Fuzzing

This directory contains the local `cargo-fuzz` setup for the AEON Rust parser surface.

Current targets:

- `compile`: exercises `aeon_core::compile(...)` across the full compile pipeline
- `token_parse`: exercises `aeon_core::benchmark_token_parse(...)` at the token-parser boundary
- `sofia_token_parse`: exercises Sofia's strict and recovery frame-machine paths
- `sofia_incremental`: exercises byte chunking, UTF-8 decoding, incremental
  lexing, resumable Sofia parsing, and lifecycle-call sequences

The compile and baseline token-parser corpora are seeded from repository
`stress-tests/` fixtures. The Sofia corpus starts with focused frame-family and
recovery documents so mutations immediately reach its iterative transitions.

## Prerequisites

Install `cargo-fuzz` if it is not already available:

```bash
cargo install cargo-fuzz
```

`cargo-fuzz` uses libFuzzer and sanitizer support, so run it with nightly Rust:

```bash
cd implementations/rust/fuzz
cargo +nightly fuzz list
```

## Running

Run the full compile pipeline target:

```bash
cd implementations/rust/fuzz
cargo +nightly fuzz run compile
```

Run the lower-level token parser target:

```bash
cd implementations/rust/fuzz
cargo +nightly fuzz run token_parse
```

Run the Sofia-specific parser target:

```bash
cd implementations/rust/fuzz
cargo +nightly fuzz run sofia_token_parse corpus/sofia_token_parse
```

Run the incremental Sofia target:

```bash
cd implementations/rust/fuzz
cargo +nightly fuzz run sofia_incremental corpus/sofia_incremental
```

The incremental target treats the low nibble of the first byte as the schedule
header length. Header bytes select chunk widths and ordinary, empty-push, or
early-finish lifecycle operations; the remaining bytes are AEON source. This
lets the fuzzer mutate source content, raw-byte boundaries, and lifecycle calls
together. Valid UTF-8 inputs must match one-shot lexer and parser results
exactly. Invalid and truncated UTF-8 exercise the decoder failure paths without
lossy conversion.

The Sofia harness enables the private-purpose `sofia-fuzz` crate feature. Its
doc-hidden entry point does not expose the internal parser selector as a stable
API. Successful strict and recovery results are disposed with an explicit
worklist so recursive destruction of the existing output model cannot be
mistaken for parser stack growth.

You can point the other targets at their seeded corpora explicitly:

```bash
cd implementations/rust/fuzz
cargo +nightly fuzz run compile corpus/compile
```

## Notes

- All targets treat fuzz input as lossy UTF-8 because AEON source is text-oriented.
- The compile target applies a 1 MiB compile input limit. The Sofia target
  rejects raw fuzz inputs above 1 MiB before lossy conversion.
- As AEON grows, it is worth adding structure-aware fuzz targets for specific sub-surfaces such as references, trimticks, or header lowering.
