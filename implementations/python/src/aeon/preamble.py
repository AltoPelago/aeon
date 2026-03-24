from __future__ import annotations

from dataclasses import dataclass

from .spans import Position, Span


@dataclass(slots=True, frozen=True)
class HostDirective:
    raw: str
    kind: str
    value: str | None


@dataclass(slots=True, frozen=True)
class FilePreambleInfo:
    shebang: str | None
    host_directive: HostDirective | None
    format: str | None
    span: dict[str, Span]


@dataclass(slots=True, frozen=True)
class _LineInfo:
    raw: str
    span: Span
    next_offset: int


def inspect_file_preamble(source: str) -> FilePreambleInfo:
    source = _strip_leading_bom(source)
    first_line = _read_line(source, 0, 1)
    if first_line is None:
        return FilePreambleInfo(shebang=None, host_directive=None, format=None, span={})

    shebang: str | None = None
    shebang_span: Span | None = None
    host_line: _LineInfo | None = None

    if first_line.raw.startswith("#!"):
        shebang = first_line.raw
        shebang_span = first_line.span
        host_line = _read_line(source, first_line.next_offset, 2)
    elif first_line.raw.startswith("//!"):
        host_line = first_line

    if host_line is not None and not host_line.raw.startswith("//!"):
        host_line = None

    host_directive: HostDirective | None = None
    host_span: Span | None = None
    format_value: str | None = None
    if host_line is not None:
        host_directive = _parse_host_directive(host_line.raw)
        host_span = host_line.span
        if host_directive.kind == "format":
            format_value = host_directive.value

    span: dict[str, Span] = {}
    if shebang_span is not None:
        span["shebang"] = shebang_span
    if host_span is not None:
        span["host_directive"] = host_span

    return FilePreambleInfo(
        shebang=shebang,
        host_directive=host_directive,
        format=format_value,
        span=span,
    )


def _parse_host_directive(raw: str) -> HostDirective:
    prefix = "//! format:"
    if raw.startswith(prefix):
        value = raw[len(prefix):].strip()
        return HostDirective(raw=raw, kind="format", value=value or None)
    return HostDirective(raw=raw, kind="unknown", value=None)


def _strip_leading_bom(source: str) -> str:
    return source[1:] if source.startswith("\ufeff") else source


def _read_line(source: str, offset: int, line: int) -> _LineInfo | None:
    start_offset = offset
    if start_offset >= len(source):
        return None
    if line > 1 and source[start_offset] == "\n":
        start_offset += 1
    if start_offset >= len(source):
        return None

    end_offset = start_offset
    while end_offset < len(source) and source[end_offset] != "\n":
        end_offset += 1

    raw_end_offset = end_offset
    if raw_end_offset > start_offset and source[raw_end_offset - 1] == "\r":
        raw_end_offset -= 1

    return _LineInfo(
        raw=source[start_offset:raw_end_offset],
        span=Span(
            start=Position(line=line, column=1, offset=start_offset),
            end=Position(line=line, column=(raw_end_offset - start_offset + 1), offset=raw_end_offset),
        ),
        next_offset=(end_offset + 1 if end_offset < len(source) else end_offset),
    )
