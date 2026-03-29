from __future__ import annotations

from bisect import bisect_left, bisect_right

from ._compat import dataclass
from .spans import Position, Span


@dataclass(slots=True)
class CommentRecord:
    kind: str
    form: str
    raw: str
    span: Span
    subtype: str | None = None


@dataclass(slots=True)
class BindableRecord:
    span: Span
    order: int
    path: str | None = None
    span_json: dict[str, object] | None = None


@dataclass(slots=True)
class AnnotationResolver:
    path_bindables: list[BindableRecord]
    span_bindables: list[BindableRecord]
    path_by_start: list[BindableRecord] | None = None
    path_starts: list[int] | None = None
    path_trailing_by_line: dict[int, tuple[list[BindableRecord], list[int]]] | None = None
    path_cursor: int = 0
    path_active: list[BindableRecord] | None = None
    span_by_start: list[BindableRecord] | None = None
    span_starts: list[int] | None = None
    span_trailing_by_line: dict[int, tuple[list[BindableRecord], list[int]]] | None = None
    span_cursor: int = 0
    span_active: list[BindableRecord] | None = None

    def __post_init__(self) -> None:
        self.path_by_start = sorted(self.path_bindables, key=lambda bindable: bindable.span.start.offset)
        self.path_starts = [bindable.span.start.offset for bindable in self.path_by_start]
        self.path_trailing_by_line = build_trailing_index(self.path_bindables)
        self.path_active = []
        self.span_by_start = sorted(self.span_bindables, key=lambda bindable: bindable.span.start.offset)
        self.span_starts = [bindable.span.start.offset for bindable in self.span_by_start]
        self.span_trailing_by_line = build_trailing_index(self.span_bindables)
        self.span_active = []

    def resolve_target(self, comment_span: Span) -> dict[str, object]:
        if not self.path_bindables and not self.span_bindables:
            return {"kind": "unbound", "reason": "no_bindable"}
        path_target = self.resolve_path_target(comment_span)
        if path_target is not None:
            return path_target
        span_target = self.resolve_span_target(comment_span)
        if span_target is not None:
            return span_target
        return {"kind": "unbound", "reason": "eof"}

    def resolve_path_target(self, comment_span: Span) -> dict[str, object] | None:
        self.path_cursor, self.path_active = advance_active_bindables(
            comment_span,
            self.path_by_start,
            self.path_cursor,
            self.path_active,
        )
        container = smallest_containing(comment_span, self.path_active)
        if container is not None and container.path is not None:
            nearest = nearest_descendant(comment_span, container, self.path_bindables)
            if nearest is not None and nearest.path is not None:
                return {"kind": "path", "path": nearest.path}
            return {"kind": "path", "path": container.path}

        trailing = nearest_trailing_same_line(comment_span, self.path_trailing_by_line)
        if trailing is not None:
            return {"kind": "path", "path": trailing.path}

        forward = first_forward(comment_span, self.path_by_start, self.path_starts)
        if forward is not None and forward.path is not None:
            return {"kind": "path", "path": forward.path}
        return None

    def resolve_span_target(self, comment_span: Span) -> dict[str, object] | None:
        self.span_cursor, self.span_active = advance_active_bindables(
            comment_span,
            self.span_by_start,
            self.span_cursor,
            self.span_active,
        )
        container = smallest_containing(comment_span, self.span_active)
        if container is not None and container.span_json is not None:
            return {"kind": "span", "span": container.span_json}

        trailing = nearest_trailing_same_line(comment_span, self.span_trailing_by_line)
        if trailing is not None and trailing.span_json is not None:
            return {"kind": "span", "span": trailing.span_json}

        forward = first_forward(comment_span, self.span_by_start, self.span_starts)
        if forward is not None and forward.span_json is not None:
            return {"kind": "span", "span": forward.span_json}
        return None


def build_annotation_stream(
    source: str,
    events: list[dict[str, object]],
    spans: list[dict[str, object]] | None = None,
) -> list[dict[str, object]]:
    resolver = AnnotationResolver(
        path_bindables=[
            BindableRecord(span=parse_span(event["span"]), order=index, path=str(event["path"]))
            for index, event in enumerate(events)
        ],
        span_bindables=[
            BindableRecord(span=parse_span(raw_span["span"]), order=index, span_json=raw_span["span"])
            for index, raw_span in enumerate(spans or [])
        ],
    )
    records: list[dict[str, object]] = []
    for comment in scan_structured_comments(source):
        target = resolver.resolve_target(comment.span)
        record: dict[str, object] = {
            "kind": comment.kind,
            "form": comment.form,
            "raw": comment.raw,
            "span": comment.span.to_json(),
            "target": target,
        }
        if comment.subtype is not None:
            record["subtype"] = comment.subtype
        records.append(record)
    return records


def sort_annotation_records(records: list[dict[str, object]]) -> list[dict[str, object]]:
    def key(record: dict[str, object]) -> tuple[int, int, str, str, str]:
        span = record["span"]
        assert isinstance(span, dict)
        start = span["start"]
        end = span["end"]
        assert isinstance(start, dict) and isinstance(end, dict)
        return (
            int(start["offset"]),
            int(end["offset"]),
            str(record["kind"]),
            str(record["form"]),
            str(record["raw"]),
        )

    return sorted(records, key=key)


def build_trailing_index(bindables: list[BindableRecord]) -> dict[int, tuple[list[BindableRecord], list[int]]]:
    trailing_by_line: dict[int, list[BindableRecord]] = {}
    for bindable in bindables:
        trailing_by_line.setdefault(bindable.span.end.line, []).append(bindable)
    indexed: dict[int, tuple[list[BindableRecord], list[int]]] = {}
    for line, line_bindables in trailing_by_line.items():
        line_bindables.sort(key=lambda bindable: bindable.span.end.offset)
        indexed[line] = (line_bindables, [bindable.span.end.offset for bindable in line_bindables])
    return indexed


def nearest_trailing_same_line(
    comment_span: Span,
    trailing_by_line: dict[int, tuple[list[BindableRecord], list[int]]],
) -> BindableRecord | None:
    line_entry = trailing_by_line.get(comment_span.start.line)
    if not line_entry:
        return None
    line_bindables, offsets = line_entry
    index = bisect_right(offsets, comment_span.start.offset) - 1
    if index < 0:
        return None
    return line_bindables[index]


def first_forward(
    comment_span: Span,
    by_start: list[BindableRecord],
    starts: list[int],
) -> BindableRecord | None:
    index = bisect_left(starts, comment_span.end.offset)
    if index >= len(by_start):
        return None
    return by_start[index]


def smallest_containing(comment_span: Span, bindables: list[BindableRecord]) -> BindableRecord | None:
    best: BindableRecord | None = None
    for bindable in bindables:
        if not span_contains(bindable.span, comment_span):
            continue
        if best is None or containing_key(bindable) < containing_key(best):
            best = bindable
    return best


def containing_key(bindable: BindableRecord) -> tuple[int, int]:
    return (span_length(bindable.span), bindable.order)


def advance_active_bindables(
    comment_span: Span,
    by_start: list[BindableRecord],
    cursor: int,
    active: list[BindableRecord],
) -> tuple[int, list[BindableRecord]]:
    while cursor < len(by_start) and by_start[cursor].span.start.offset <= comment_span.start.offset:
        active.append(by_start[cursor])
        cursor += 1
    if active:
        active = [bindable for bindable in active if bindable.span.end.offset >= comment_span.end.offset]
    return cursor, active


def nearest_descendant(
    comment_span: Span,
    container: BindableRecord,
    bindables: list[BindableRecord],
) -> BindableRecord | None:
    assert container.path is not None
    trailing_hit: BindableRecord | None = None
    forward_hit: BindableRecord | None = None
    trailing_distance: int | None = None
    forward_distance: int | None = None

    for candidate in bindables:
        if candidate.path is None or candidate.path == container.path:
            continue
        if not is_descendant_path(container.path, candidate.path):
            continue
        if not span_contains(container.span, candidate.span):
            continue
        if candidate.span.end.offset <= comment_span.start.offset:
            distance = comment_span.start.offset - candidate.span.end.offset
            if trailing_distance is None or distance < trailing_distance:
                trailing_hit = candidate
                trailing_distance = distance
        elif candidate.span.start.offset >= comment_span.end.offset:
            distance = candidate.span.start.offset - comment_span.end.offset
            if forward_distance is None or distance < forward_distance:
                forward_hit = candidate
                forward_distance = distance

    if trailing_hit is not None and forward_hit is not None:
        assert trailing_distance is not None and forward_distance is not None
        return forward_hit if forward_distance <= trailing_distance else trailing_hit
    return forward_hit or trailing_hit


def scan_structured_comments(source: str) -> list[CommentRecord]:
    records: list[CommentRecord] = []
    offset = 0
    line = 1
    column = 1

    def current_position() -> Position:
        return Position(line=line, column=column, offset=offset)

    def advance() -> str:
        nonlocal offset, line, column
        char = source[offset]
        offset += 1
        if char == "\n":
            line += 1
            column = 1
        else:
            column += 1
        return char

    def peek(index: int = 0) -> str:
        position = offset + index
        if position >= len(source):
            return "\0"
        return source[position]

    def read_string(delimiter: str) -> None:
        advance()
        raw_mode = delimiter == "`"
        while offset < len(source):
            char = advance()
            if not raw_mode and char == "\\" and offset < len(source):
                advance()
                continue
            if char == delimiter:
                return
            if char == "\n" and not raw_mode:
                return

    while offset < len(source):
        char = peek()
        if char in {'"', "'", "`"}:
            read_string(char)
            continue
        if char == "/" and peek(1) == "/":
            start = current_position()
            advance()
            advance()
            marker = peek()
            if marker not in {"#", "@", "?", "!", "{", "[", "("}:
                while offset < len(source) and peek() != "\n":
                    advance()
                continue
            advance()
            while offset < len(source) and peek() != "\n":
                advance()
            end = current_position()
            kind, subtype = line_channel_info(marker)
            if kind != "host":
                records.append(CommentRecord(kind=kind, form="line", raw=source[start.offset:end.offset], span=Span(start, end), subtype=subtype))
            continue
        if char == "/" and peek(1) in {"#", "@", "?", "{", "[", "("}:
            start = current_position()
            advance()
            marker = advance()
            closing = {"{": "}", "[": "]", "(": ")"}.get(marker, marker)
            while offset < len(source):
                if peek() == closing and peek(1) == "/":
                    advance()
                    advance()
                    break
                advance()
            end = current_position()
            kind, subtype = block_channel_info(marker)
            records.append(CommentRecord(kind=kind, form="block", raw=source[start.offset:end.offset], span=Span(start, end), subtype=subtype))
            continue
        if char == "/" and peek(1) == "*":
            advance()
            advance()
            while offset < len(source):
                if peek() == "*" and peek(1) == "/":
                    advance()
                    advance()
                    break
                advance()
            continue
        advance()

    return records


def line_channel_info(marker: str) -> tuple[str, str | None]:
    if marker == "#":
        return "doc", None
    if marker == "@":
        return "annotation", None
    if marker == "?":
        return "hint", None
    if marker == "!":
        return "host", None
    if marker == "{":
        return "reserved", "structure"
    if marker == "[":
        return "reserved", "profile"
    return "reserved", "future"


def block_channel_info(marker: str) -> tuple[str, str | None]:
    if marker == "#":
        return "doc", None
    if marker == "@":
        return "annotation", None
    if marker == "?":
        return "hint", None
    if marker == "{":
        return "reserved", "structure"
    if marker == "[":
        return "reserved", "profile"
    return "reserved", "future"


def parse_span(raw: object) -> Span:
    assert isinstance(raw, dict)
    start = raw["start"]
    end = raw["end"]
    assert isinstance(start, dict) and isinstance(end, dict)
    return Span(
        start=Position(line=int(start["line"]), column=int(start["column"]), offset=int(start["offset"])),
        end=Position(line=int(end["line"]), column=int(end["column"]), offset=int(end["offset"])),
    )


def span_contains(outer: Span, inner: Span) -> bool:
    return outer.start.offset <= inner.start.offset and outer.end.offset >= inner.end.offset


def span_length(span: Span) -> int:
    return span.end.offset - span.start.offset


def is_descendant_path(parent_path: str, candidate_path: str) -> bool:
    return len(candidate_path) > len(parent_path) and (
        candidate_path.startswith(parent_path + ".") or candidate_path.startswith(parent_path + "[")
    )
