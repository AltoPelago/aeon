from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class Position:
    """A 1-based line/column and 0-based UTF-8 byte offset."""

    line: int
    column: int
    offset: int


@dataclass(frozen=True, slots=True)
class Span:
    start: Position
    end: Position


@dataclass(frozen=True, slots=True)
class Diagnostic:
    code: str
    message: str
    path: str | None = None
    span: Span | None = None
    phase: str | None = None


@dataclass(frozen=True, slots=True)
class Event:
    path: str
    key: str
    source_plane: str
    datatype: str | None
    value_type: str
    structural_id: str | None
    span: Span


@dataclass(frozen=True, slots=True)
class CompileResult:
    events: tuple[Event, ...]
    warnings: tuple[Diagnostic, ...]
    errors: tuple[Diagnostic, ...]

    @property
    def ok(self) -> bool:
        return not self.errors

    def require_ok(self) -> CompileResult:
        if self.errors:
            from .errors import CompileError

            raise CompileError(self.errors)
        return self
