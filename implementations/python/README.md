# AEON Python Implementation

Dependency-free Python implementation of the AEON Core v1 parser surface.

## Scope

Current implementation target:

- AEON Core parsing
- canonical path projection
- reference legality checks
- transport, strict, and custom mode enforcement
- JSON finalization from assignment events
- CTS-compatible `inspect --json` CLI surface
- annotation stream extraction
- AEOS validator CTS adapter via `--cts-validate`

Current CLI scope is intentionally narrower than the TypeScript and Rust workspaces.
Python is still the conformance-first implementation, but its supported command surface is now pinned with direct tests for:

- `inspect`
- `fmt`
- `--cts-validate`

Current CTS status:

- `core`: green
- `aes`: green
- `annotations`: green
- `aeos`: green

Current mode semantics:

- `transport`: untyped values allowed, custom datatypes allowed by default
- `strict`: typed values required, reserved datatypes only by default
- `custom`: typed values required, custom datatypes allowed by default

## Usage

For CLI spot checks, prefer the repo wrapper [./bin/aeon-python](./bin/aeon-python) rather than a direct `python -m aeon.cli ...` invocation. The wrapper pins the repo-local source path and is the same entrypoint used by the shared stress/parity scripts.

```bash
cd implementations/python
./bin/aeon-python inspect ../../examples/aeon-1-hello-world/hello.aeon --json
```

Finalize compiled events to a JSON-like document:

```bash
cd implementations/python
python3 - <<'PY'
from aeon import compile_source, finalize_json

source = 'greeting:string = "Hello"'
compiled = compile_source(source)
finalized = finalize_json(compiled.events)
print(finalized["document"])
PY
```

Inspect only the file preamble:

```bash
cd implementations/python
python3 - <<'PY'
from aeon import inspect_file_preamble

info = inspect_file_preamble('#!/usr/bin/env aeon\n//! format:aeon.test.v1\nvalue = {')
print(info.format)
PY
```

Annotation-only JSON:

```bash
cd implementations/python
./bin/aeon-python inspect ../../examples/aeon-1-hello-world/hello.aeon --json --annotations-only
```

AEOS CTS adapter mode:

```bash
cd implementations/python
printf '{"aes": [], "schema": {"rules": []}}' | ./bin/aeon-python --cts-validate
```

## Tests

```bash
cd implementations/python
python3 -m unittest discover -s tests -p 'test_*.py'
```

## CTS

```bash
node ../../scripts/cts-source-lane-runner.mjs --sut ./bin/aeon-python --cts ../../cts/core/v1/core-cts.v1.json --lane core
node ../../scripts/cts-source-lane-runner.mjs --sut ./bin/aeon-python --cts ../../cts/aes/v1/aes-cts.v1.json --lane aes
node ../typescript/tools/annotation-cts-runner/dist/index.js --sut ./bin/aeon-python --cts ../../cts/annotations/v1/annotation-stream-cts.v1.json
node ../typescript/tools/cts-runner/dist/index.js --sut ./bin/aeon-python --cts ../../cts/aeos/v1/aeos-validator-cts.v1.json
```

Those commands fall back to the sibling `aeonite-org/aeonite-cts` checkout automatically when the old in-repo `cts/` paths are absent.

The sibling roots can be overridden with:

- `AEONITE_CTS_ROOT`
- `AEON_TOOLING_PRIVATE_ROOT`

Run all supported CTS lanes from one command:

```bash
cd implementations/python
python3 tools/run_cts.py
```

Run a subset:

```bash
cd implementations/python
python3 tools/run_cts.py core aes
```

## Cross-Implementation Diff

Compare Python and TypeScript `inspect --json` output across the example and stress fixture corpus:

```bash
cd implementations/python
python3 tools/compare_with_typescript.py
```

Compare a subset of fixtures:

```bash
cd implementations/python
python3 tools/compare_with_typescript.py ../../examples/aeon-1-hello-world/hello.aeon ../../stress-tests/canonical/node-introducer-singleline.aeon
```

Run the repo-level canonical parity harness, which executes the full TypeScript and Python suites first and then compares `fmt` output across the shared fixture corpus:

```bash
cd ../..
python3 ./scripts/compare-canonical-implementations.py
```
