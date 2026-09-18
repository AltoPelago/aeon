# AltoPelago AEON for Python

Native CPython bindings for the Rust AEON implementation.

```python
import altopelago.aeon as aeon

result = aeon.compile('name:string = "Sofia"')
result.require_ok()
print(result.events)

encoded = aeon.compile_to_telex('name:string = "Sofia"')
```

The public API is the `altopelago.aeon` Python facade. The
`altopelago.aeon._native` extension is private and may change between releases.

The initial package supports non-free-threaded CPython 3.12 through 3.14. It
does not run the WebAssembly build and it does not silently fall back to the
repository's pure-Python reference implementation.

## Local development

Create and activate a virtual environment, install maturin, and then run:

```bash
maturin develop --release
python -m unittest discover -s tests
```

`compile()` copies the input into Rust before releasing Python's interpreter
lock. Its returned dataclasses and strings are Python-owned and do not borrow
Rust storage. `compile_to_telex()` follows the same input-copy rule and returns
Python-owned `bytes`; on its successful path it does not materialize an object
for every AES event.

The crate disables Cargo's default library test target because an extension
module is not an embedded-Python executable. The repository's `ci:rust` task
still checks and lints this crate and sets `PYO3_BUILD_EXTENSION_MODULE=1` when
Cargo is explicitly asked to build every test target. Behavioral tests run
against an installed wheel.
