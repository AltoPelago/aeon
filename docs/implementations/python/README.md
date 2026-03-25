# Python Implementation

This section documents the Python implementation as an implementation, not as the AEON language standard.

The pages here are informative. They describe the current Python package surface, CLI scope, and implementation-specific usage and testing notes.

## Package

Python package root:

- [`implementations/python`](../../../implementations/python)

Distribution metadata:

- project name: `aeon-python`
- Python requirement: `>=3.12`
- console script: `aeon-python = aeon.cli:main`

## Public Import Surface

The package’s top-level supported import surface is currently:

- `CompileOptions`
- `CompileResult`
- `FinalizeOptions`
- `FilePreambleInfo`
- `HostDirective`
- `compile_source`
- `finalize_json`
- `inspect_file_preamble`

Those are re-exported from:

- [`implementations/python/src/aeon/__init__.py`](../../../implementations/python/src/aeon/__init__.py)

## Main Library Areas

Core compile pipeline:

- module: `aeon.core`
- primary entry point: `compile_source(source, options=None) -> CompileResult`

Finalization:

- module: `aeon.finalize`
- primary entry point: `finalize_json(aes, options=None) -> dict[str, object]`

Preamble inspection:

- module: `aeon.preamble`
- primary entry point: `inspect_file_preamble(source) -> FilePreambleInfo`

Canonical formatting:

- module: `aeon.canonical`
- primary entry point: `canonicalize(source) -> CanonicalResult`

AEOS validation:

- module: `aeon.aeos`
- primary entry points:
  - `validate(aes, schema, options=None) -> dict[str, object]`
  - `validate_cts_payload(payload_text) -> str`

Annotation extraction:

- module: `aeon.annotations`
- primary entry points:
  - `build_annotation_stream(...)`
  - `sort_annotation_records(records)`

CLI:

- module: `aeon.cli`
- entry point: `main(argv=None) -> int`

## CLI Scope

The Python implementation is currently conformance-first and keeps a narrower CLI than the TypeScript and Rust workspaces.

Documented current command surface:

- `inspect`
- `fmt`
- `--cts-validate`

Preferred repo-local wrapper:

- [`implementations/python/bin/aeon-python`](../../../implementations/python/bin/aeon-python)

Example:

```bash
cd implementations/python
./bin/aeon-python inspect ../../stress-tests/full/full-feature-stress.aeon --json
```

## Tests

Run the Python test suite:

```bash
cd implementations/python
python3 -m unittest discover -s tests -p 'test_*.py'
```

## CTS And Parity

Run all supported CTS lanes:

```bash
cd implementations/python
python3 tools/run_cts.py
```

Run selected lanes:

```bash
cd implementations/python
python3 tools/run_cts.py core aes
```

Cross-implementation diff helper:

```bash
cd implementations/python
python3 tools/compare_with_typescript.py
```

Repository-level canonical parity harness:

```bash
cd ../..
python3 ./scripts/compare-canonical-implementations.py
```

Python workspace README with current scope and CTS notes:

- [`implementations/python/README.md`](../../../implementations/python/README.md)

## Boundary Note

- `specs/` defines AEON language and conformance requirements.
- `docs/` describes how the Python implementation exposes and applies those rules.
