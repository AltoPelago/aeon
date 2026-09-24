"""Public Python facade for the native Rust AEON engine."""

from ._api import compile, compile_to_telex
from ._models import CompileResult, Diagnostic, Event, Position, Span
from .errors import AeonError, CompileError, NativeError

__all__ = (
    "AeonError",
    "CompileError",
    "CompileResult",
    "Diagnostic",
    "Event",
    "NativeError",
    "Position",
    "Span",
    "compile",
    "compile_to_telex",
)
