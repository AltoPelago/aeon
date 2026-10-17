from typing import assert_type

from altopelago.aeon import CompileError, canonicalize

assert_type(canonicalize("a=1"), str)
assert_type(canonicalize("z=1\na=~z", ordering="reference-safe-v1", max_ordering_edges=10, max_attribute_depth=2), str)
try:
    canonicalize("a=~z\nz=1", ordering="reference-safe-v1")
except CompileError as error:
    assert_type(error.diagnostics[0].code, str)
