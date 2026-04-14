# AEON Rust Fuzzing

This directory contains the local `cargo-fuzz` setup for the AEON Rust parser surface.

Current targets:

- `compile`: exercises `aeon_core::compile(...)` across the full compile pipeline
- `token_parse`: exercises `aeon_core::benchmark_token_parse(...)` at the token-parser boundary

The initial corpora are seeded from the repository `stress-tests/` fixtures so the fuzzer starts from real AEON syntax and known edge cases.

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

You can point a target at its seeded corpus explicitly:

```bash
cd implementations/rust/fuzz
cargo +nightly fuzz run compile corpus/compile
```

## Notes

- Both targets treat fuzz input as lossy UTF-8 because AEON source is text-oriented.
- The harnesses cap `max_input_bytes` to keep mutations bounded and reduce low-value resource blowups.
- As AEON grows, it is worth adding structure-aware fuzz targets for specific sub-surfaces such as references, trimticks, or header lowering.
