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

document = pytonic.loads('status = |approved|')
status = document["status"]
print(status.address)        # $.status
print(status.value.kind)     # SymbolicLiteral
print(status.value.decoded)  # approved
```

Bindings retain datatype, identity, source plane, attributes, provenance,
lineage, and exact canonical scalar payload where supplied. `pytonic` is an
immutable document-navigation API; it does not claim SANSA Query support.

The higher-level mutable object model and SANSA integration remain outside
this API and will be reviewed separately.

## Local development

Create and activate a virtual environment, install maturin, and then run:

```bash
maturin develop --release
python -m unittest discover -s tests
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
