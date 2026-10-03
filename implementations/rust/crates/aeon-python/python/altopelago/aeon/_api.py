from __future__ import annotations

import json
from os import PathLike
from pathlib import Path
from typing import Any

from . import _native
from ._loading import LoadedDocument, LoadedTelexDocument
from ._models import CompileResult, Diagnostic, Event, Position, Span
from .errors import CompileError, NativeError, TelexError


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


def canonicalize(source: str) -> str:
    """Return the canonical AEON spelling of one complete document."""

    try:
        ok, payload = _native.canonicalize_native(source)
    except RuntimeError as error:
        raise NativeError(str(error)) from error
    if ok:
        return payload.decode("utf-8")
    raise CompileError(_diagnostic(item) for item in json.loads(payload))


def canonicalize_telex(source: str | bytes) -> str:
    """Decode and re-encode a Telex stream in canonical form."""

    text = _text(source)
    try:
        ok, payload = _native.canonicalize_telex_native(text)
    except RuntimeError as error:
        raise NativeError(str(error)) from error
    if ok:
        return payload.decode("utf-8")
    error = json.loads(payload)
    raise TelexError((error,))


def load_text(
    source: str,
    *,
    mode: str = "strict",
    scope: str = "payload",
    schema: str | None = None,
    schema_file: str | PathLike[str] | None = None,
) -> LoadedDocument:
    """Compile and JSON-materialise AEON while retaining all reports."""

    try:
        payload = json.loads(
            _native.load_json(source, mode, scope, _schema_text(schema, schema_file))
        )
    except RuntimeError as error:
        raise NativeError(str(error)) from error
    finalization = payload.get("finalization") or {}
    return LoadedDocument(
        source=source,
        compile=_compile_result(payload["compile"]),
        document=payload.get("document"),
        finalization_errors=tuple(
            _diagnostic(item) for item in finalization.get("errors", ())
        ),
        finalization_warnings=tuple(
            _diagnostic(item) for item in finalization.get("warnings", ())
        ),
        validation=payload.get("validation"),
        schema_error=payload.get("schemaError"),
    )


def load_file(
    path: str | PathLike[str],
    *,
    mode: str = "strict",
    scope: str = "payload",
    schema: str | None = None,
    schema_file: str | PathLike[str] | None = None,
) -> LoadedDocument:
    """Read, compile, and JSON-materialise an UTF-8 AEON file."""

    return load_text(
        Path(path).read_text(encoding="utf-8"),
        mode=mode,
        scope=scope,
        schema=schema,
        schema_file=schema_file,
    )


def load_telex_text(
    source: str | bytes,
    *,
    mode: str = "strict",
    scope: str = "payload",
    schema: str | None = None,
    schema_file: str | PathLike[str] | None = None,
) -> LoadedTelexDocument:
    """Decode, validate, and JSON-materialise a complete Telex stream."""

    text = _text(source)
    try:
        payload = json.loads(
            _native.load_telex_json(text, mode, scope, _schema_text(schema, schema_file))
        )
    except RuntimeError as error:
        raise NativeError(str(error)) from error
    finalization = payload.get("finalization") or {}
    return LoadedTelexDocument(
        source=text,
        document=payload.get("document"),
        finalization_errors=tuple(
            _diagnostic(item) for item in finalization.get("errors", ())
        ),
        finalization_warnings=tuple(
            _diagnostic(item) for item in finalization.get("warnings", ())
        ),
        validation=payload.get("validation"),
        error_kind=payload.get("errorKind"),
        error=payload.get("error"),
    )


def load_telex_file(
    path: str | PathLike[str],
    *,
    mode: str = "strict",
    scope: str = "payload",
    schema: str | None = None,
    schema_file: str | PathLike[str] | None = None,
) -> LoadedTelexDocument:
    """Read and load an UTF-8 Telex file."""

    return load_telex_text(
        Path(path).read_text(encoding="utf-8"),
        mode=mode,
        scope=scope,
        schema=schema,
        schema_file=schema_file,
    )


def _text(source: str | bytes) -> str:
    return source.decode("utf-8") if isinstance(source, bytes) else source


def _schema_text(
    schema: str | None, schema_file: str | PathLike[str] | None
) -> str | None:
    if schema is not None and schema_file is not None:
        raise ValueError("schema and schema_file are mutually exclusive")
    if schema_file is not None:
        return Path(schema_file).read_text(encoding="utf-8")
    return schema


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
