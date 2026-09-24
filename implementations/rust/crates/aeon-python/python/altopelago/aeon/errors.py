from __future__ import annotations

from collections.abc import Iterable

from ._models import Diagnostic


class AeonError(Exception):
    """Base class for public AEON Python errors."""


class CompileError(AeonError):
    """Raised when an operation requires valid AEON but compilation failed."""

    diagnostics: tuple[Diagnostic, ...]

    def __init__(self, diagnostics: Iterable[Diagnostic]) -> None:
        self.diagnostics = tuple(diagnostics)
        message = "\n".join(
            f"{diagnostic.code}: {diagnostic.message}"
            for diagnostic in self.diagnostics
        )
        super().__init__(message or "AEON compilation failed")


class NativeError(AeonError):
    """Raised when the private native adapter cannot complete an operation."""
