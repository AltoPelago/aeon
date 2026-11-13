# AEON Python Implementation

Dependency-free Python implementation of the AEON Core v1 parser surface.

Current package line: `0.16.0`.
This is the implementation/package version, not the AEON language version.
See [`VERSIONING.md`](../../VERSIONING.md).

Authority surfaces:

- this workspace is the Python implementation surface
- normative AEON specification authority lives in [`aeonite-org/aeonite-specs`](https://github.com/aeonite-org/aeonite-specs)
- cross-implementation conformance authority lives in [`aeonite-org/aeonite-cts`](https://github.com/aeonite-org/aeonite-cts)

## Scope

Current implementation target:

- AEON Core parsing
- canonical path projection
- reference legality checks
- transport, strict, and custom mode enforcement
- JSON finalization from assignment events
- portable AES projection and Telex v1 encode/decode/validation
- direct portable AES materialization and AEOS validation without reparsing AEON
- CTS-compatible `inspect --json` CLI surface
- annotation stream extraction
- AEOS validator CTS adapter via `--cts-validate`

Current CLI scope is intentionally narrower than the TypeScript and Rust workspaces.
Python is still the conformance-first implementation, but its supported command surface is now pinned with direct tests for:

- `inspect`
- `fmt`
- `telex decode`, `telex canonicalize`, and `telex materialize`
- `--cts-validate`

Current CTS status:

- `core`: green
- `aes`: green
- `annotations`: green
- `aeos`: green
- portable `aes.events.v1`: green (snapshot 0.2)
- `telex/v1`: green (snapshot 0.2)

Implementation note:

- AEOS reference-form behavior is part of shared conformance.
- `adapt_python_assignment_events_to_portable_aes` exposes the named
  `aeon.python.assignment-events.v0-to-aes.events.v1` compatibility result and
  returns strict portable events plus its conversion report. Pass the separate
  compile-result `header` when selecting `include_headers=True`. Native source
  locations use Unicode code-point offsets; optional exact `source_bytes`
  derive the portable `sha256:` origin and convert retained ranges to UTF-8
  byte spans.
- Native assignment events carry `sourcePlane` as `header` or `body`, inherited
  by expanded inline descendants. Portable adapters, AEOS, and finalizers use
  it before the legacy key-prefix fallback, so a quoted body key may safely
  have the same spelling and textual address as a header occurrence.
- `max_materialized_weight` and `--max-materialized-weight` are processor controls, not AEON Core or AEOS conformance requirements.
- `max_reference_depth` and `--max-reference-depth` are processor controls, not AEON Core or AEOS conformance requirements.

Current mode semantics:

- `transport`: untyped values allowed, custom datatypes allowed by default
- `strict`: typed values required, reserved datatypes only by default
- `custom`: typed values required, custom datatypes allowed by default

## Usage

For CLI spot checks, prefer the repo wrapper [./bin/aeon-python](./bin/aeon-python) rather than a direct `python -m aeon.cli ...` invocation. The wrapper pins the repo-local source path and is the same entrypoint used by the shared stress/parity scripts.

```bash
cd implementations/python
./bin/aeon-python inspect ../../stress-tests/full/full-feature-stress.aeon --json
```

Finalize compiled events to a JSON-like document:

```bash
cd implementations/python
python3 - <<'PY'
from aeon import load_text

loaded = load_text('greeting:string = "Hello"')
loaded.require_ok()
print(loaded.document)
PY
```

Cap clone expansion during materialization:

```bash
cd implementations/python
python3 - <<'PY'
from aeon import load_text, LoadOptions
from aeon.finalize import FinalizeOptions

loaded = load_text(
    'big = { a = 1, b = 2, c = 3 }\ncopy1 = ~big\ncopy2 = ~big',
    LoadOptions(finalize=FinalizeOptions(max_materialized_weight=4)),
)
print(loaded.document)
print(loaded.finalized["meta"]["errors"][0]["code"])
PY
```

Cap transitive clone resolution depth during materialization:

```bash
cd implementations/python
python3 - <<'PY'
from aeon import load_text, LoadOptions
from aeon.finalize import FinalizeOptions

loaded = load_text(
    'base = { a = 1, b = 2 }\ncopy1 = ~base\ncopy2 = ~copy1',
    LoadOptions(finalize=FinalizeOptions(max_reference_depth=1)),
)
print(loaded.document)
print(loaded.finalized["meta"]["errors"][0]["code"])
PY
```

Load from disk and access a finalized value directly:

```bash
cd implementations/python
python3 - <<'PY'
from pathlib import Path
from aeon import load_file

loaded = load_file(Path('../../stress-tests/full/full-feature-stress.aeon'))
loaded.require_ok()
print(loaded.get('$.numbers[1]'))
PY
```

Export AEON as Telex, then consume it directly through the portable AES path:

```bash
cd implementations/python
python3.12 - <<'PY'
from aeon import aeon_to_telex, load_telex_text

wire = aeon_to_telex('answer:number = 42')
loaded = load_telex_text(wire).require_ok()
print(wire, end='')
print(loaded.document)
PY
```

`origin` and `span` are optional. To include exact source-backed provenance,
pass the original, unnormalized UTF-8 artifact alongside the source string:

```python
from pathlib import Path

source_bytes = Path("document.aeon").read_bytes()
source = source_bytes.decode("utf-8")
wire = aeon_to_telex(source, source_bytes=source_bytes)
```

At the lower-level `export_telex()` boundary, `source_bytes` is an assertion
that the supplied bytes are the exact artifact from which the native events
were compiled. Invalid UTF-8 and native ranges outside that artifact are
rejected rather than emitted as portable provenance.

Headers remain opt-in and use the `aeon.document.v1` projection:

```bash
./bin/aeon-python inspect document.aeon --telex --include-headers
```

Telex can also be decoded, canonicalized, or materialized without invoking the AEON parser:

```bash
./bin/aeon-python telex decode stream.telex.aes
./bin/aeon-python telex canonicalize stream.telex.aes
./bin/aeon-python telex materialize stream.telex.aes --scope full
```

Load an AEOS schema document directly from `.aeos` and validate through the convenience API:

```bash
cd implementations/python
python3 - <<'PY'
from aeon import load_schema_file, load_text, LoadOptions

schema = load_schema_file('../../staging/aeon-examples-private-main/shared/reference-safe-schema/schema.aeos')
loaded = load_text('person = { age = 42 }', LoadOptions(schema=schema))
print(schema["rules"][0]["path"])
print(loaded.validation["ok"])
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
./bin/aeon-python inspect ../../stress-tests/full/full-feature-stress.aeon --json --annotations-only
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
node ../../scripts/cts-source-lane-runner.mjs --sut ./bin/aeon-python --cts "$AEONITE_CTS_ROOT/core/v1/core-cts.v1.snapshot-0.5.json" --lane core
node ../../scripts/cts-source-lane-runner.mjs --sut ./bin/aeon-python --cts "$AEONITE_CTS_ROOT/aes/v1/aes-cts.v1.snapshot-0.4.json" --lane aes
python3.12 tools/run_sansa_resolve_cts.py --cts "$AEONITE_CTS_ROOT/sansa/v1/sansa-resolve-cts.v1.json"
node ../typescript/tools/annotation-cts-runner/dist/index.js --sut ./bin/aeon-python --cts "$AEONITE_CTS_ROOT/annotations/v1/annotation-stream-cts.v1.json"
node ../typescript/tools/cts-runner/dist/index.js --sut ./bin/aeon-python --cts "$AEONITE_CTS_ROOT/aeos/v1/aeos-validator-cts.v1.json"
```

The sibling roots can be overridden with:

- `AEONITE_CTS_ROOT`
- `AEON_TOOLING_ROOT`

Backward-compatible alias:

- `AEON_TOOLING_PRIVATE_ROOT`

Run all supported CTS lanes from one command:

```bash
cd implementations/python
python3 tools/run_cts.py
```

Run a subset:

```bash
cd implementations/python
python3 tools/run_cts.py core aes sansa-resolve
```

`core` and `aes` run their current immutable 0.4 compatibility targets. Use
`core-legacy` or `aes-legacy` for historical targets, and `core-next` or
`aes-next` for mutable development targets. The explicit `*-released` aliases
select the same targets as the defaults.

## Cross-Implementation Diff

Compare Python and TypeScript `inspect --json` output across the example and stress fixture corpus:

```bash
cd implementations/python
python3 tools/compare_with_typescript.py
```

Compare a subset of fixtures:

```bash
cd implementations/python
python3 tools/compare_with_typescript.py ../../stress-tests/full/full-feature-stress.aeon ../../stress-tests/canonical/node-introducer-singleline.aeon
```

Run the repo-level canonical parity harness, which executes the full TypeScript and Python suites first and then compares `fmt` output across the shared fixture corpus:

```bash
cd ../..
python3 ./scripts/compare-canonical-implementations.py
```

The Rust CLI also supports a future-facing sibling examples override via `AEON_EXAMPLES_ROOT`.

## Structural reference path pilot

This checkout shares SANSA-owned path-step grammar and raw index validation with
clone/pointer references through native tokens. Reference indexes use unsigned
ASCII decimal spelling `0..999999`; signs, separators, fractions, exponents and
leading zeroes are rejected. Quoted numeric member names and ordinary numeric
values retain their existing meaning. Structural identity metadata remains
supported; identity reference steps and recursive selectors are deferred.

The implementation retains existing structural AST/event shapes and native
errors/spans. These internal cursors add no parser session, source reparse or
external package dependency. See the local
[pilot evidence](../../experiments/reference-parser-sharing/python-pilot/README.md)
for passed local native gates and outstanding hosted/release/boundary review. This is
not a published Python version change.

## Local child identity candidate

Explicit candidate fixture runners (excluded from the default lane set):

```bash
python3.12 tools/run_cts.py sansa-child-identity-parser sansa-child-identity-resolve
```

These tools exercise the direct Python API against the mutable experimental
manifests; they do not add a JSON request protocol or a released conformance
claim. The 20 parser/38 Resolve cases include selected-identity context on
unsupported/ambiguous diagnostics and inspection-limit context. Mutable fixtures
also assert six parser diagnostic code/index pairs. Cross-runtime performance,
artifact and release qualification is tracked separately; source fixture success
is not a release certificate. The standalone parser runner also
supports the stable parser manifest with no candidate flag.

The unpublished standalone `aeon.sansa` parser, renderer and read-only resolver
accept direct-child identity expressions such as `$.items.\item1\`. These
expressions have `isExact=False`; resolved bindings retain their structural
addresses and object identity. Identity chains traverse one child relationship
per segment and do not match the effective scope root itself.

A namespace opts in by supplying an `identity(binding)` callable returning the
binding's declared structural identity, or `None` when absent. The resolver does
not infer this capability from an opaque `identity` field, key or address. It
scans the namespace's direct `children`, rejects duplicate matches under one
parent, and shares a default budget of 10,000 logical identity inspections across
the operation. `maxIdentityInspections` accepts a non-negative safe integer;
iterator cleanup runs on early failure. Adapter allocation and I/O are outside
this logical budget. Caller-owned identity ASTs are bounded and normalized before
resolution; their supplied `canonical` and `isExact` fields are not trusted.

This candidate does not admit identity expressions into clone/pointer references,
AEOS rule selectors, event paths, Query, activation or mutation. Scoped document projection is described below. Bridge artifacts and the
combined release checks remain separate work. Package version `0.16.0` is unchanged for local evaluation and is
not a publication claim.

### Explicit document namespaces

The experimental `aeon.sansa_document` module provides
`namespace_from_assignment_events(events, header=..., scope="payload")` and
`namespace_from_portable_records(records, scope="payload", projection=...)`.
They snapshot one plane of a complete validated portable AES document. Check
compile errors before passing native assignment events. Header records require
the existing AEON document projection declaration; `scope="header"` selects
that plane. A combined `full` scope is not exposed.

```python
from aeon.core import compile_source
from aeon.sansa import resolve_address
from aeon.sansa_document import namespace_from_assignment_events

compiled = compile_source('items=[\\item1\\=2]')
assert not compiled.errors
namespace = namespace_from_assignment_events(compiled.events, header=compiled.header)
result = resolve_address('$.items.\\item1\\', namespace)
assert result['bindings'][0]['path'] == '$.items[0]'
```

The projection preserves physical Unicode paths and node-head topology. Synthetic
roots and attribute spaces are objects with no inherited identity. Numeric
children are ordered by position; object members retain first represented order.
References remain reference occurrences and are not followed or materialized.
Input record changes do not retarget the constructed namespace. Returned binding
dictionaries belong to this local projection; no mutation/continuity API is
implied. A namespace-local `identityScope` check rejects foreign contextual roots
before identity inspection, including after an otherwise missing prefix.

Portable validation keeps document-wide uniqueness and resource limits. SANSA
still validates an inspected identity's selectable spelling; broader transport
metadata is retained and produces an explicit resolver error when inspected.
Positions beyond the portable SANSA bound fail construction with
`SANSA_RESOLVE_UNSUPPORTED_NAMESPACE_PATH`, rather than disappearing from the
projection. `SansaNamespaceError` exposes the validation code and diagnostics.
Construction/validation work is separate from Resolve's logical inspection
budget. AEOS rule selectors continue to use their default-off namespace.
