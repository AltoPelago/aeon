from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from ._models import CompileResult, Diagnostic
from .errors import AeonLoadError, CompileError, TelexError


@dataclass(frozen=True, slots=True)
class LoadedDocument:
    """The compiled and JSON-materialised views of one AEON document."""

    source: str
    compile: CompileResult
    document: Any | None
    finalization_errors: tuple[Diagnostic, ...] = ()
    finalization_warnings: tuple[Diagnostic, ...] = ()
    validation: dict[str, Any] | None = None
    schema_error: str | None = None

    @property
    def validation_errors(self) -> tuple[dict[str, Any], ...]:
        if self.validation is None:
            return ()
        return tuple(self.validation.get("errors", ()))

    @property
    def validation_warnings(self) -> tuple[dict[str, Any], ...]:
        if self.validation is None:
            return ()
        return tuple(self.validation.get("warnings", ()))

    @property
    def warnings(self) -> tuple[Diagnostic | dict[str, Any], ...]:
        return (*self.compile.warnings, *self.finalization_warnings, *self.validation_warnings)

    @property
    def ok(self) -> bool:
        return not (
            self.compile.errors
            or self.finalization_errors
            or self.validation_errors
            or self.schema_error
        )

    def require_ok(self) -> LoadedDocument:
        if self.compile.errors:
            raise CompileError(self.compile.errors)
        errors: list[Diagnostic | dict[str, Any] | str] = [
            *self.finalization_errors,
            *self.validation_errors,
        ]
        if self.schema_error is not None:
            errors.append(self.schema_error)
        if errors:
            raise AeonLoadError(errors)
        return self

    def get(self, path: str, default: Any = None) -> Any:
        if self.document is None:
            return default
        current = self.document
        for segment in _document_path(path):
            if isinstance(segment, int):
                if not isinstance(current, list) or segment >= len(current):
                    return default
                current = current[segment]
            else:
                if not isinstance(current, dict) or segment not in current:
                    return default
                current = current[segment]
        return current

    def require(self, path: str) -> Any:
        sentinel = object()
        value = self.get(path, sentinel)
        if value is sentinel:
            raise AeonLoadError((f"Missing required value at {path}",))
        return value


@dataclass(frozen=True, slots=True)
class LoadedTelexDocument:
    """A decoded and JSON-materialised Telex document."""

    source: str
    document: Any | None
    finalization_errors: tuple[Diagnostic, ...] = ()
    finalization_warnings: tuple[Diagnostic, ...] = ()
    validation: dict[str, Any] | None = None
    error_kind: str | None = None
    error: str | None = None

    @property
    def validation_errors(self) -> tuple[dict[str, Any], ...]:
        if self.validation is None:
            return ()
        return tuple(self.validation.get("errors", ()))

    @property
    def warnings(self) -> tuple[Diagnostic | dict[str, Any], ...]:
        validation_warnings = (
            () if self.validation is None else tuple(self.validation.get("warnings", ()))
        )
        return (*self.finalization_warnings, *validation_warnings)

    @property
    def ok(self) -> bool:
        return not (self.error or self.finalization_errors or self.validation_errors)

    def require_ok(self) -> LoadedTelexDocument:
        errors: list[Diagnostic | dict[str, Any] | str] = [
            *self.finalization_errors,
            *self.validation_errors,
        ]
        if self.error is not None:
            errors.append(self.error)
        if errors:
            raise TelexError(errors, "Telex load failed")
        return self


def _document_path(path: str) -> tuple[str | int, ...]:
    if path == "$":
        return ()
    if not path.startswith("$"):
        raise ValueError("document paths must start with '$'")
    segments: list[str | int] = []
    cursor = 1
    while cursor < len(path):
        if path.startswith('.["', cursor):
            member, cursor = _quoted_member(path, cursor + 3)
            segments.append(member)
            continue
        if path[cursor] == ".":
            start = cursor + 1
            cursor = start
            while cursor < len(path) and (
                path[cursor] == "_" or path[cursor].isascii() and path[cursor].isalnum()
            ):
                cursor += 1
            member = path[start:cursor]
            if not member or not (member[0] == "_" or member[0].isascii() and member[0].isalpha()):
                raise ValueError(f"invalid document path: {path!r}")
            segments.append(member)
            continue
        if path[cursor] == "[":
            end = path.find("]", cursor + 1)
            index = path[cursor + 1 : end] if end >= 0 else ""
            if end < 0 or not index.isdecimal():
                raise ValueError(f"invalid document path: {path!r}")
            segments.append(int(index))
            cursor = end + 1
            continue
        raise ValueError(f"invalid document path: {path!r}")
    return tuple(segments)


def _quoted_member(path: str, cursor: int) -> tuple[str, int]:
    value: list[str] = []
    while cursor < len(path):
        character = path[cursor]
        if character == "\\":
            cursor += 1
            if cursor >= len(path) or path[cursor] not in {'"', "\\"}:
                raise ValueError(f"invalid document path: {path!r}")
            value.append(path[cursor])
            cursor += 1
            continue
        if character == '"' and path.startswith('"]', cursor):
            return "".join(value), cursor + 2
        value.append(character)
        cursor += 1
    raise ValueError(f"invalid document path: {path!r}")


__all__ = ("LoadedDocument", "LoadedTelexDocument")
