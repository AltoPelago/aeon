from __future__ import annotations

import json
from typing import Any

from . import _native
from ._models import CompileResult, Diagnostic, Event, Position, Span
from .errors import CompileError, NativeError


def compile(source: str) -> CompileResult:
    """Compile one complete AEON source string with the native Rust engine."""

    try:
        result = _native.compile_native(source)
    except RuntimeError as error:
        raise NativeError(str(error)) from error
    return result


def compile_to_telex(source: str) -> bytes:
    """Compile AEON to encoded AES/Telex without per-event Python objects."""

    try:
        ok, payload = _native.compile_telex(source)
    except RuntimeError as error:
        raise NativeError(str(error)) from error
    if ok:
        return payload
    diagnostics = tuple(_diagnostic(item) for item in json.loads(payload))
    raise CompileError(diagnostics)


def _compile_result(payload: dict[str, Any]) -> CompileResult:
    return CompileResult(
        events=tuple(_event(item) for item in payload["events"]),
        warnings=tuple(_diagnostic(item) for item in payload["warnings"]),
        errors=tuple(_diagnostic(item) for item in payload["errors"]),
    )


def _compile_result_packed(payload: tuple[Any, Any, Any]) -> CompileResult:
    events, warnings, errors = payload
    return CompileResult(
        events=tuple(_event_packed(item) for item in events),
        warnings=tuple(_diagnostic_packed(item) for item in warnings),
        errors=tuple(_diagnostic_packed(item) for item in errors),
    )


def _event_packed(payload: tuple[Any, ...]) -> Event:
    path, key, source_plane, datatype, value_type, structural_id, span = payload
    return Event(
        path=path,
        key=key,
        source_plane=source_plane,
        datatype=datatype,
        value_type=value_type,
        structural_id=structural_id,
        span=_span_packed(span),
    )


def _diagnostic_packed(payload: tuple[Any, ...]) -> Diagnostic:
    code, message, path, span, phase = payload
    return Diagnostic(
        code=code,
        message=message,
        path=path,
        span=_span_packed(span) if span is not None else None,
        phase=phase,
    )


def _span_packed(payload: tuple[int, int, int, int, int, int]) -> Span:
    start_line, start_column, start_offset, end_line, end_column, end_offset = payload
    return Span(
        start=Position(line=start_line, column=start_column, offset=start_offset),
        end=Position(line=end_line, column=end_column, offset=end_offset),
    )


def _event(payload: dict[str, Any]) -> Event:
    return Event(
        path=payload["path"],
        key=payload["key"],
        source_plane=payload["sourcePlane"],
        datatype=payload.get("datatype"),
        value_type=payload["valueType"],
        structural_id=payload.get("structuralId"),
        span=_span(payload["span"]),
    )


def _diagnostic(payload: dict[str, Any]) -> Diagnostic:
    span = payload.get("span")
    return Diagnostic(
        code=payload["code"],
        message=payload["message"],
        path=payload.get("path"),
        span=_span(span) if span is not None else None,
        phase=payload.get("phase"),
    )


def _span(payload: dict[str, Any]) -> Span:
    return Span(start=_position(payload["start"]), end=_position(payload["end"]))


def _position(payload: dict[str, Any]) -> Position:
    return Position(
        line=payload["line"],
        column=payload["column"],
        offset=payload["offset"],
    )
