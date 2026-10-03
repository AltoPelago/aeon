"""Public Python facade for the native Rust AEON engine."""

from ._api import (
    canonicalize,
    canonicalize_telex,
    compile,
    compile_to_telex,
    load_file,
    load_telex_file,
    load_telex_text,
    load_text,
)
from ._loading import LoadedDocument, LoadedTelexDocument
from ._models import CompileResult, Diagnostic, Event, Position, Span
from .errors import AeonError, AeonLoadError, CompileError, NativeError, TelexError

__all__ = (
    "AeonError",
    "AeonLoadError",
    "CompileError",
    "CompileResult",
    "Diagnostic",
    "Event",
    "LoadedDocument",
    "LoadedTelexDocument",
    "NativeError",
    "Position",
    "Span",
    "TelexError",
    "canonicalize",
    "canonicalize_telex",
    "compile",
    "compile_to_telex",
    "load_file",
    "load_telex_file",
    "load_telex_text",
    "load_text",
)
