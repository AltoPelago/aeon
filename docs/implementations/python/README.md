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

Supply-chain notes:

- the current Python implementation is intentionally dependency-free at runtime
- new external Python dependencies should be treated as a high-scrutiny change
- repository-level CODEOWNERS and dependency review are part of the cross-implementation hardening layer even though this workspace currently has no third-party runtime dependencies
- if runtime dependencies are introduced later, they should be pinned and reviewed with the same supply-chain discipline used for the TypeScript workspace

## Public Import Surface

The package’s top-level supported import surface is currently:

- `CompileOptions`
- `CompileResult`
- `AeonicLimitsV1`
- `load_aeonic_limits`
- `aeon_compile_limits`
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

The pure-Python API has an experimental explicit ordering opt-in:

```python
from aeon.canonical import CanonicalizeOptions, canonicalize

result = canonicalize("d=3\nc=2\nb=~c\na=1", CanonicalizeOptions(
    ordering="reference-safe-v1", max_ordering_edges=1_000_000,
))
# Body order: a, c, b, d; a default header is added when absent.
```

It validates authored Core references before default-header insertion or
sorting, emits the smallest eligible decoded Unicode key after every step,
and revalidates its output. Header/body planes, indexed positions, reference
forms, and metadata ownership are retained. This is not profile/schema
approval. Errors return empty text rather than partial or fallback output.
The edge budget counts distinct projected dependencies; it accepts integers
from zero through `2**53 - 1` (not booleans).

Omitting `ordering` or selecting `"lexical-v1"` preserves historical Python
bytes and behavior. The explicit new contract ends successful output with a
newline to match TypeScript/Rust. CLI, native-Python `altopelago.aeon`, WASM,
and integrity/hash APIs have not switched contracts. Treat opt-in hashes and
signatures as experimental and separate from historical canonical bytes.

Numeric datatype clarifiers in the pure-Python AST use `NumberLiteral`
nodes with exact normalized `value` text, source `raw` text, and a token
`span`, matching numeric values. Serialized nested ASTs retain that tagged
shape. String clarifiers remain strings; caller-constructed annotations
still accept native integers and floats. Native floats cannot recover
precision already lost before the call. Portable AES uses its existing
`NumberLiteral`/`StringLiteral` tags with string payloads.

AEON source generic arguments must be datatype descriptors. `custom<1.0>`
is invalid; `custom<number>[1.0]` and `list<custom[1.0]>` retain numeric
clarifiers on valid type names. Portable AES records and Telex descriptors
enforce the same type-only rule; numeric literals belong in clarifier brackets,
not generic angle brackets. Telex preserves their exact numeric strings.

Limits and policy:

- module: `aeon.limits`
- `load_aeonic_limits(source)` validates the closed
  `altopelago.aeonic-limits.v1` format under its fixed bootstrap policy
- `aeon_compile_limits(limits)` returns the normalized AEON compiler subset
- `inspect --limits-file <path>` applies the selected file; explicit CLI
  limits take precedence
- `max_clarifier_values` and `max_value_nesting_depth` are canonical; the old
  separator and nesting names remain compatibility aliases

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

These lanes resolve manifests from `AEONITE_CTS_ROOT`, which defaults to the
sibling `aeonite-org/aeonite-cts/cts` checkout.

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
