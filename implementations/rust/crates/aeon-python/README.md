# AltoPelago AEON for Python

Native CPython bindings for the Rust AEON implementation. The package covers
compilation, canonical formatting, JSON-profile materialisation, AEOS
validation, and Telex transport operations.

```python
import altopelago.aeon as aeon

result = aeon.compile('name:string = "Sofia"')
result.require_ok()
print(result.events)

encoded = aeon.compile_to_telex('name:string = "Sofia"')

loaded = aeon.load_text('name:string = "Sofia"')
loaded.require_ok()
print(loaded.document)

canonical = aeon.canonicalize('name:string="Sofia"')
decoded = aeon.load_telex_text(encoded).require_ok()
```

`load_text()` and `load_file()` return a `LoadedDocument` containing the
materialised value together with compile, finalisation, and optional AEOS
validation reports. Pass a JSON or AEON schema contract through `schema=` to
validate during the same native operation, or its path through `schema_file=`.
`load_telex_text()` and
`load_telex_file()` provide the equivalent Telex path, while
`canonicalize_telex()` normalises a stream without materialising it.

Materialisation deliberately uses AEON's JSON output profile. Values that are
not losslessly representable in JSON (including symbols) fail in `mode="strict"`
and become strings with retained warnings in `mode="loose"`. The package does
not currently replace those values with Python-specific scalar wrappers.

The public API is the `altopelago.aeon` Python facade. The
`altopelago.aeon._native` extension is private and may change between releases.

The package supports non-free-threaded CPython 3.12 through 3.14. It
does not run the WebAssembly build and it does not silently fall back to the
repository's pure-Python reference implementation.

For metadata-preserving navigation, the opt-in `pytonic` facade exposes
immutable views over the shared Rust document graph without passing through
JSON materialisation:

```python
from altopelago.aeon import pytonic

document = pytonic.loads('''
status = |approved|
orders = [{ id = "A-100", status = |approved| }]
''')
status = document["status"]
print(status.address)        # $.status
print(status.value.kind)     # SymbolicLiteral
print(status.value.decoded)  # approved

result = document.query("""
from $.orders.*
where .status == |approved|
select { id = .id status = .status }
""", max_result_records=100)
if result.ok:
    for record in result.results:
        print(record.candidate.address, record.value["id"][0].value.decoded)
```

Bindings retain datatype, identity, source plane, attributes, provenance,
lineage, and exact canonical scalar payload where supplied. `pytonic` also
evaluates stable SANSA Query through the shared Rust runtime. Selected
document values remain `Binding` views; derived scalar and object values use
immutable `QueryScalar` and `QueryObject` wrappers. Structural values returned
by functions such as `fallback(...)` use `QueryContainer`, whose recursive
payload remains accessible without JSON materialisation. Query failures are
returned as structured `SansaDiagnostic` values, including policy and budget
context.

Dynamic `path(...)` activation is disabled by default. Callers may opt into
the Rust runtime's constrained policy with `activation_roots`, an explicit
`activation_selectors` allow-list, and optional activation depth and binding
ceilings. The unrestricted trusted-activation mode is intentionally not
exposed to Python.

Experimental mutation planning uses structured dictionaries:

```python
result = document.plan_mutation({
    "op": "replace", "target": "$.status",
    "value": pytonic.scalar("symbol", "held"),
})
if result.ok:
    plan = result.plan
    operation = plan.operations[0]
    print(operation.target.canonical_address, operation.value.family)
    aeon_target = plan.validate_target("aeon")
    json_target = plan.validate_target("json-compatible")
```

The surface supports exact `create`, `replace`, `remove`, ordered `insert`
and same-container `move`. Create uses `parent` and `name`; replace/remove use
`target`; insert/move use `container`; move also uses `source`. Ordered placement
is `"first"`, `"last"`, or `{"kind": "before"/"after", "anchor": "$.items[0]"}`.
For a batch, pass `{"operations": [...], "preconditions": [{"expression":
". == 1", "target": "$.count"}], "provenance": {...}}`. Operation provenance
is also supported and remains inert data.

Plans and all their views are frozen. Targets expose original and canonical
addresses, representation kind and a `binding` that retains the source snapshot.
Operations retain value intent, anchors and provenance. Preconditions, warnings
and diagnostics remain inspectable tuples. Plan views remain valid after the
original `Document` variable is dropped; plans cannot be constructed or pickled
as replayable artifacts. Planning does not change the document.

Values cross directly into Rust as `None`, bool, exact int, float, str,
ordered dict, list or tuple. Ordinary strings are never parsed as AEON or SANSA.
Existing scalar `binding.value` and `QueryScalar` descriptors preserve their
native families. `pytonic.scalar(family, canonical, *, semantic_type=None)`
constructs a `QueryScalar` explicitly. Families are `string`, `finite_number`,
`boolean` (`"true"`/`"false"`), `toggle`, `hex`, `radix`, `encoding`, `separator`,
`symbol`, `sansa_address`, `date`, `time`, `datetime`, `wtc`, `clone_reference`,
`pointer_reference`, and `explicit_null`. Only radix accepts `semantic_type`,
for metadata such as `"radix[16]"`. Exact decimals use `finite_number` text;
Python floats already have Python's native precision. Derived values are
inspected through `QueryScalar`, `QueryObject` and tuples; no JSON conversion
occurs. Structural `Value`/`QueryContainer` descriptors are not accepted as
mutation scalars: supply explicit nested dictionaries/lists/tuples instead.

`plan_mutation` accepts `scope` (`payload`, `header`, `full`), `profile`,
`plan_id`, `max_bindings` (default 100,000), `max_position_index` (999,999), and
a `budget` dictionary with `max_operations` (10,000), `max_preconditions`
(1,000), `max_value_nodes` (100,000), `max_value_depth` (128) and
`max_string_length` (1,048,576). Python conversion has independent safety
ceilings of 128 nested levels, 100,000 value nodes and 16 MiB cumulative UTF-8
payload bytes, plus 100,000 operations/preconditions. Byte accounting is shared
across values (including typed descriptors), object keys, provenance, request
text fields and plan ID, and is checked before copying text or cloning typed
descriptors into the request.
Repeated references count on every occurrence. Raising a planner budget
does not disable these conversion ceilings. Malformed Python envelopes and
conversion failures raise `TypeError`/`ValueError`. SANSA planning failures
return `MutationResult(ok=False, plan=None)` and structured errors.

Target validation runs separately and returns `MutationValidation` with `ok`
and `errors`. It checks representability and does not grant schema approval or
authorization. The shared SANSA target grammar accepts Core's reduced-date
datetime/WTC payloads, such as `2024-T10:&Europe`, and preserves authored
fractional precision and second 60 without imposing GP/schema limits.
Temporal relations involving clock-bearing reduced dates conservatively remain
incomparable; their disjoint calendar completion sets are not yet evaluated.

`document.sansa_capabilities.mutate_plan` and `mutate_target_validation` report
`"experimental"`, while `mutate_apply` reports `"not_exposed"`. Local spaces,
Transform, Instruction, policy filtering and apply are not exposed. Inspect
the capability fields for the individual surfaces.

## Reference-safe canonical ordering

The installed native package defaults to the same reference-safe contract as the
independent TypeScript, Rust, and pure-Python writers:

```python
text = aeon.canonicalize("d=3\nc=2\nb=~c\na=1", ordering="reference-safe-v1",
                         max_ordering_edges=1_000_000, max_attribute_depth=1)
# Body order: a, c, b, d. A default header is inserted when absent.
```

This calls the Rust canonical API directly, with Python's interpreter lock
released during native work. It validates authored Core references before
sorting, preserves reference intent, metadata ownership and indexed positions,
and revalidates emitted text. It does not evaluate references or approve
profiles/schemas. In particular, this does not impose GP temporal/radix policy.

`max_ordering_edges` caps distinct projected dependency edges;
`max_attribute_depth` bounds authored/output metadata and reference traversal.
Both are keyword-only, non-negative integers up to `2**53 - 1`; booleans are
not accepted. Unknown ordering names and invalid options raise `ValueError`.
Source/ordering failures raise the existing `CompileError` with structured
diagnostics and no partial text. Success returns `str`, as before.

Omitting `ordering` selects `"reference-safe-v1"` (canonical CTS 0.4).
Explicit `"lexical-v1"` retains historical source bytes and behavior, including
the absence of authored-reference validation. The two limits are validated but
only applied by the reference-safe contract. All three source `fmt` CLIs and
WASM process output use the new default; integrity event hashing and receipt
verification remain unchanged. Keep hashes/signatures tied to their original
canonical contract rather than silently recanonicalizing stored payloads.

## Local development

Create and activate a virtual environment, install maturin, and then run:

```bash
maturin develop --release
python -m unittest discover -s tests
```

The wheel includes read-only native API stubs and a `py.typed` marker. To check
the typed mutation example against the installed package (also run by the
Python Wheels verification workflow):

```bash
python -m pip install mypy==1.19.1
python -m mypy --strict tests/typing/mutation.py
```

`compile()` copies the input into Rust before releasing Python's interpreter
lock. Its returned frozen, slotted native value objects own their Rust strings
and create Python scalar values on property access; nothing borrows compiler
storage. `compile_to_telex()` follows the same input-copy rule and returns
Python-owned `bytes`; on its successful path it does not materialize an object
for every AES event.

The crate disables Cargo's default library test target because an extension
module is not an embedded-Python executable. The repository's `ci:rust` task
still checks and lints this crate and sets `PYO3_BUILD_EXTENSION_MODULE=1` when
Cargo is explicitly asked to build every test target. Behavioral tests run
against an installed wheel.
