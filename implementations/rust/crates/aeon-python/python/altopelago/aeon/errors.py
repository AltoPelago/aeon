from __future__ import annotations

from collections.abc import Iterable, Mapping
from typing import Any

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


class AeonLoadError(AeonError):
    """Raised when a compiled document cannot be validated or materialised."""

    errors: tuple[Diagnostic | Mapping[str, Any] | str, ...]

    def __init__(
        self,
        errors: Iterable[Diagnostic | Mapping[str, Any] | str],
        message: str = "AEON load failed",
    ) -> None:
        self.errors = tuple(errors)
        lines: list[str] = []
        for error in self.errors:
            if isinstance(error, Diagnostic):
                lines.append(f"{error.code}: {error.message}")
            elif isinstance(error, Mapping):
                code = error.get("code", "ERROR")
                path = error.get("path")
                suffix = f" at {path}" if path else ""
                detail = error.get("message", error.get("phase", message))
                lines.append(f"{code}{suffix}: {detail}")
            else:
                lines.append(str(error))
        super().__init__("\n".join(lines) or message)


class TelexError(AeonLoadError):
    """Raised when Telex cannot be decoded, validated, or materialised."""
