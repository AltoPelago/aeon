# Canonical And Stress Workflows

Primary scripts:

- `scripts/canonical-cts.sh`
- `scripts/stress-fixtures.py`
- `scripts/stress-canonical-corpus.py`
- `scripts/stress-canonical-snippets.py`
- `scripts/stress-diagnostic-snippets.py`
- `scripts/stress-positive-snippets.py`
- `scripts/stress-negative-snippets.py`
- `scripts/stress-whitespace-mutations.py`
- `scripts/stress-combinations.py`
- `scripts/stress-smoke.sh`

## `canonical-cts.sh`

Composite runner for canonical conformance and parity checks.

```bash
bash ./scripts/canonical-cts.sh [--mode <transport|strict|custom|all>] [--brief]
```

Pipeline:

1. TypeScript canonical package tests
2. Python implementation tests
3. Rust canonical package tests
4. External canonical CTS manifest against TypeScript, Python, and Rust
5. Cross-implementation canonical snippet parity
6. Cross-implementation real-document canonical corpus parity
7. Cross-implementation diagnostic snippet parity

`--brief` keeps failure output concise for CI or quick local loops.

## `stress-canonical-corpus.py`

Recursively discovers real `.aeon` documents and requires the TypeScript,
Python, and Rust formatters to accept each one and emit byte-identical canonical
output.

```bash
python3 ./scripts/stress-canonical-corpus.py [--corpus <directory>] [--brief]
```

The default drop directory is `stress-tests/canonical-corpus/`. The checked-in
seed is a positive snapshot of all AltoPelago website content; its source commit
and the corrections prompted by the initial import are recorded beside the
fixtures.

## `stress-fixtures.py`

Runs curated fixture matrix across selected implementations.

```bash
python3 ./scripts/stress-fixtures.py --impl <typescript|python|rust|all> [--brief]
```

Important flags:

- `--exclude-known-red`: skip known-red cases
- `--fail-known-red`: treat known-red as ordinary failures
- `--timeout <seconds>`: override per-fixture timeout

Summary includes totals for `failed`, `known`, `skipped`, and `passed`.

## Snippet and mutation runners

Use these for focused regressions:

- canonical parity: `stress-canonical-snippets.py`
- real-document canonical parity: `stress-canonical-corpus.py`
- diagnostic parity: `stress-diagnostic-snippets.py`
- positive/negative corpus validation: `stress-positive-snippets.py`, `stress-negative-snippets.py`
- mutation fuzzing and combination matrices: `stress-whitespace-mutations.py`, `stress-combinations.py`
- fast smoke across implementations: `stress-smoke.sh`

## Boundary note

These scripts validate implementation behavior and cross-implementation alignment.
They do not redefine AEON Core, AES, or CTS authority.
