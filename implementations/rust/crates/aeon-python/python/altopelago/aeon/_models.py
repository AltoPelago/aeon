"""Public immutable result types implemented by the native extension."""

from ._native import CompileResult, Diagnostic, Event, Position, Span

__all__ = ("CompileResult", "Diagnostic", "Event", "Position", "Span")
