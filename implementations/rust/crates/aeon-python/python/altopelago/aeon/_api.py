from __future__ import annotations

import json
from typing import Any

from . import _native
from ._models import CompileResult, Diagnostic, Event, Position, Span
from .errors import CompileError, NativeError


def compile(source: str) -> CompileResult:
    """Compile one complete AEON source string with the native Rust engine."""

    try:
        payload = json.loads(_native.compile_json(source))
    except RuntimeError as error:
        raise NativeError(str(error)) from error
    return _compile_result(payload)


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
