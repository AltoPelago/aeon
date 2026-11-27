from __future__ import annotations

import json
from bisect import bisect_left, bisect_right
from dataclasses import field

from ._compat import dataclass
from .lexer import Token, tokenize
from .spans import Position, Span, position_from_offset


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
    value_span: Span | None = None
    value_type: str | None = None
    kind: str = "binding"
    span_json: dict[str, object] | None = None
    landmarks: list[PlacementLandmark] | None = None


@dataclass(slots=True)
class PlacementLandmark:
    part: str
    span: Span


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

    def resolve_placement(self, comment_span: Span, target: dict[str, object]) -> dict[str, str] | None:
        if target.get("kind") != "path":
            return None
        path = target.get("path")
        if not isinstance(path, str):
            return None
        bindable = next((item for item in self.path_bindables if item.path == path), None)
        if bindable is None or not bindable.landmarks:
            return None
        if any(spans_overlap(landmark.span, comment_span) for landmark in bindable.landmarks):
            return None

        previous = next(
            (
                landmark
                for landmark in reversed(bindable.landmarks)
                if landmark.span.end.offset <= comment_span.start.offset
            ),
            None,
        )
        next_landmark = next(
            (
                landmark
                for landmark in bindable.landmarks
                if landmark.span.start.offset >= comment_span.end.offset
            ),
            None,
        )
        if previous is None and next_landmark is None:
            return None

        placement: dict[str, str] = {}
        if previous is not None:
            placement["after"] = previous.part
        if next_landmark is not None:
            placement["before"] = next_landmark.part
        return placement

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


_TOKEN_DELIMITERS = {
    "LANGLE": "RANGLE", "LBRACE": "RBRACE", "LBRACKET": "RBRACKET", "LPAREN": "RPAREN",
}


@dataclass(slots=True)
class PositionLookup:
    source: str
    line_starts: list[int]
    node_values: dict[int, dict[str, object]] = field(default_factory=dict)
    attribute_values: dict[int, dict[str, object]] = field(default_factory=dict)
    tokens: list[Token] = field(default_factory=list)
    token_starts: list[int] = field(default_factory=list)
    closing_tokens: dict[int, int] = field(default_factory=dict)

    def index_tokens(self) -> None:
        if self.tokens:
            return
        self.tokens = [token for token in tokenize(self.source).tokens if token.kind != "NEWLINE"]
        self.token_starts = [token.span.start.offset for token in self.tokens]
        stack = []
        for index, token in enumerate(self.tokens):
            closer = _TOKEN_DELIMITERS.get(token.kind)
            if closer is not None:
                stack.append((closer, index))
            elif stack and token.kind == stack[-1][0]:
                _, opening = stack.pop()
                self.closing_tokens[opening] = index

    @classmethod
    def from_source(cls, source: str) -> PositionLookup:
        return cls(
            source=source,
            line_starts=[0] + [index + 1 for index, char in enumerate(source) if char == "\n"],
        )

    def position_at(self, offset: int) -> Position:
        bounded_offset = min(max(offset, 0), len(self.source))
        line_index = bisect_right(self.line_starts, bounded_offset) - 1
        line_start = self.line_starts[line_index]
        return Position(line=line_index + 1, column=bounded_offset - line_start + 1, offset=bounded_offset)


def build_annotation_stream(
    source: str,
    events: list[dict[str, object]],
    spans: list[dict[str, object]] | None = None,
) -> list[dict[str, object]]:
    comments = scan_structured_comments(source)
    if not comments:
        return []

    positions = PositionLookup.from_source(source)
    path_bindables = build_path_bindables(source, events, positions)
    resolver = AnnotationResolver(
        path_bindables=path_bindables,
        span_bindables=[
            BindableRecord(span=parse_span(raw_span["span"]), order=index, span_json=raw_span["span"])
            for index, raw_span in enumerate(spans or [])
        ],
    )
    records: list[dict[str, object]] = []
    for comment in comments:
        target = resolver.resolve_target(comment.span)
        record: dict[str, object] = {
            "kind": comment.kind,
            **({"subtype": comment.subtype} if comment.subtype is not None else {}),
            "form": comment.form,
            "raw": comment.raw,
            "span": comment.span.to_json(),
            "target": target,
        }
        placement = resolver.resolve_placement(comment.span, target)
        if placement is not None:
            record["placement"] = placement
        records.append(record)
    return records


def build_path_bindables(
    source: str,
    events: list[dict[str, object]],
    positions: PositionLookup,
) -> list[BindableRecord]:
    index_annotation_values(events, positions)
    bindables: list[BindableRecord] = []
    for index, event in enumerate(events):
        span = parse_span(event["span"])
        value_span = event_value_span(event) or span
        value_type = event_value_type(event)
        path = str(event["path"])
        bindables.append(
            BindableRecord(
                span=span,
                order=index * 1000,
                path=path,
                value_span=value_span,
                value_type=value_type,
                kind="binding",
                landmarks=binding_landmarks(source, event, positions),
            )
        )
        bindables.extend(attribute_bindables(source, event, positions, index * 1000 + 1))
    return bindables


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


def index_annotation_values(events: list[dict[str, object]], positions: PositionLookup) -> None:
    seen = set()
    pending = [(event.get("value"), event.get("annotations")) for event in events]
    while pending:
        value, annotations = pending.pop()
        if isinstance(annotations, dict):
            for entry in annotations.values():
                if not isinstance(entry, dict):
                    continue
                value = entry.get("value")
                span = entry.get("span")
                if isinstance(value, dict) and isinstance(span, dict):
                    positions.attribute_values[parse_span(span).start.offset] = value
                pending.append((value, entry.get("annotations")))
                for block in entry.get("attributes") or []:
                    if isinstance(block, dict):
                        pending.append((None, block.get("entries")))
        if not isinstance(value, dict):
            continue
        kind = value.get("type")
        if kind not in {"NodeLiteral", "ObjectNode", "ListNode", "TupleLiteral", "TypedValue"}:
            continue
        raw_span = value.get("span")
        if not isinstance(raw_span, dict):
            continue
        offset = parse_span(raw_span).start.offset
        occurrence = (kind, offset)
        if occurrence in seen:
            continue
        seen.add(occurrence)
        if kind == "NodeLiteral":
            positions.node_values[offset] = value
        for block in value.get("attributes") or []:
            if isinstance(block, dict):
                pending.append((None, block.get("entries")))
        if kind == "ObjectNode":
            pending.extend(
                (binding.get("value"), entry_block.get("entries") if entry_block is not None else None)
                for binding in value.get("bindings") or [] if isinstance(binding, dict)
                for entry_block in binding.get("attributes") or [None]
            )
        elif kind == "TypedValue":
            pending.append((value.get("value"), None))
        else:
            pending.extend(
                (item, None) for item in value.get("children" if kind == "NodeLiteral" else "elements") or []
            )


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
    containing = [
        candidate
        for candidate in bindables
        if candidate.path is not None
        and candidate.path != container.path
        and is_descendant_path(container.path, candidate.path)
        and span_contains(container.span, candidate.span)
        and span_contains(candidate.span, comment_span)
    ]
    if containing:
        return min(containing, key=containing_key)

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

    if (
        container.kind == "binding"
        and ((trailing_hit is not None and trailing_hit.kind == "attribute") or (forward_hit is not None and forward_hit.kind == "attribute"))
    ):
        return None

    if trailing_hit is not None and forward_hit is not None:
        assert trailing_distance is not None and forward_distance is not None
        return forward_hit if forward_distance <= trailing_distance else trailing_hit
    if (
        forward_hit is not None
        and trailing_hit is None
        and should_keep_comment_on_container_before_descendant(comment_span, container, forward_hit)
    ):
        return None
    return forward_hit or trailing_hit


def should_keep_comment_on_container_before_descendant(
    comment_span: Span,
    container: BindableRecord,
    forward_hit: BindableRecord,
) -> bool:
    if container.value_span is None:
        return False
    if comment_span.end.offset <= container.value_span.start.offset:
        return True
    return (
        container.value_type == "NodeLiteral"
        and comment_span.start.offset >= container.value_span.start.offset
        and comment_span.end.offset <= forward_hit.span.start.offset
    )


def scan_structured_comments(source: str, *, include_host: bool = False) -> list[CommentRecord]:
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
            if kind != "host" or include_host:
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


def binding_landmarks(
    source: str,
    event: dict[str, object],
    positions: PositionLookup | None = None,
) -> list[PlacementLandmark]:
    positions = positions or PositionLookup.from_source(source)
    span = parse_span(event["span"])
    value_span = event_value_span(event)
    if value_span is None:
        value_span = span

    if event_value_type(event) == "NodeLiteral" and span.start.offset == value_span.start.offset:
        return node_value_landmarks(source, value_span, positions)
    landmarks: list[PlacementLandmark] = []
    key_span = scan_key_span(source, span.start.offset, positions)
    if key_span is not None:
        landmarks.append(PlacementLandmark("key", key_span))
        head_start = key_span.end.offset
    else:
        head_start = span.start.offset

    equals_offset = find_top_level_char(source, "=", head_start, value_span.start.offset)
    head_end = equals_offset if equals_offset is not None else value_span.start.offset
    attribute_marks = attribute_landmarks(source, head_start, head_end, positions)
    landmarks.extend(attribute_marks)

    attribute_end = attribute_marks[-1].span.end.offset if attribute_marks else head_start
    colon_offset = find_top_level_colon(source, attribute_end, head_end)
    if colon_offset is not None:
        colon_start = positions.position_at(colon_offset)
        colon_end = positions.position_at(colon_offset + 1)
        landmarks.append(PlacementLandmark("datatype-colon", Span(colon_start, colon_end)))
        datatype_start = skip_head_trivia(source, colon_offset + 1, head_end)
        datatype_end = scan_datatype_end(source, datatype_start, head_end)
        if datatype_start < datatype_end:
            landmarks.append(
                PlacementLandmark(
                    "datatype",
                    Span(positions.position_at(datatype_start), positions.position_at(datatype_end)),
                )
            )

    if equals_offset is not None:
        landmarks.append(
            PlacementLandmark(
                "equals",
                Span(positions.position_at(equals_offset), positions.position_at(equals_offset + 1)),
            )
        )
    if event_value_type(event) == "NodeLiteral":
        landmarks.extend(node_value_landmarks(source, value_span, positions))
    else:
        landmarks.append(PlacementLandmark("value", value_span))
    return sorted(landmarks, key=lambda landmark: landmark.span.start.offset)


def attribute_bindables(
    source: str,
    event: dict[str, object],
    positions: PositionLookup,
    order_start: int,
) -> list[BindableRecord]:
    span = parse_span(event["span"])
    value_span = event_value_span(event) or span
    key_span = scan_key_span(source, span.start.offset, positions)
    head_start = key_span.end.offset if key_span is not None else span.start.offset
    equals_offset = find_top_level_char(source, "=", head_start, value_span.start.offset)
    head_end = equals_offset if equals_offset is not None else value_span.start.offset
    path = str(event["path"])
    entries = attribute_entry_bindables(source, head_start, head_end, path, positions)
    if event_value_type(event) == "NodeLiteral":
        entries.extend(node_attribute_entry_bindables(source, value_span, path, positions))
    for index, entry in enumerate(entries):
        entry.order = order_start + index
    return entries


def attribute_landmarks(
    source: str,
    start: int,
    end: int,
    positions: PositionLookup,
) -> list[PlacementLandmark]:
    landmarks: list[PlacementLandmark] = []
    offset = start
    while offset < end:
        at = find_top_level_char(source, "@", offset, end)
        if at is None:
            break
        scanned = scan_attribute_block(source, at, end, "", positions, make_bindables=False)
        landmarks.extend(scanned[0])
        offset = max(at + 1, scanned[2])
    return landmarks


def attribute_entry_bindables(
    source: str,
    start: int,
    end: int,
    owner_path: str,
    positions: PositionLookup,
) -> list[BindableRecord]:
    entries: list[BindableRecord] = []
    offset = start
    while offset < end:
        at = find_top_level_char(source, "@", offset, end)
        if at is None:
            break
        _landmarks, block_entries, next_offset = scan_attribute_block(source, at, end, owner_path, positions, make_bindables=True)
        entries.extend(block_entries)
        offset = max(at + 1, next_offset)
    return entries


def node_attribute_entry_bindables(
    source: str,
    value_span: Span,
    owner_path: str,
    positions: PositionLookup,
) -> list[BindableRecord]:
    entries: list[BindableRecord] = []
    offset = value_span.start.offset
    end = value_span.end.offset
    if offset >= end or source[offset] != "<":
        return entries
    offset += 1
    offset = skip_node_layout(source, offset, end)
    key_span = scan_key_span(source, offset, positions)
    if key_span is None:
        return entries
    offset = key_span.end.offset
    offset = skip_node_layout(source, offset, end)
    if offset < end and source[offset] == "\\":
        close = source.find("\\", offset + 1, end)
        if close != -1:
            offset = close + 1
    while offset < end:
        offset = skip_node_layout(source, offset, end)
        if offset >= end or source[offset] in {":", "(", ">"}:
            break
        if source[offset] == "@":
            _landmarks, block_entries, next_offset = scan_attribute_block(source, offset, end, owner_path, positions, make_bindables=True)
            entries.extend(block_entries)
            offset = max(offset + 1, next_offset)
            continue
        offset += 1
    return entries


def scan_attribute_block(
    source: str,
    at: int,
    end: int,
    owner_path: str,
    positions: PositionLookup,
    *,
    make_bindables: bool,
) -> tuple[list[PlacementLandmark], list[BindableRecord], int]:
    landmarks = [PlacementLandmark("attribute-marker", Span(positions.position_at(at), positions.position_at(at + 1)))]
    entries: list[BindableRecord] = []
    open_offset = skip_node_layout(source, at + 1, end)
    if open_offset >= end or source[open_offset] != "{":
        return landmarks, entries, open_offset
    landmarks.append(PlacementLandmark("attribute-open", Span(positions.position_at(open_offset), positions.position_at(open_offset + 1))))
    offset = open_offset + 1
    while offset < end:
        offset = skip_node_layout(source, offset, end)
        if offset >= end:
            break
        if source[offset] == "}":
            landmarks.append(PlacementLandmark("attribute-close", Span(positions.position_at(offset), positions.position_at(offset + 1))))
            return landmarks, entries, offset + 1
        entry = scan_attribute_entry(source, offset, end, owner_path, positions, make_bindables=make_bindables)
        if entry is None:
            offset += 1
            continue
        entry_landmarks, entry_bindables, offset = entry
        landmarks.extend(entry_landmarks)
        entries.extend(entry_bindables)
        offset = skip_node_layout(source, offset, end)
        if offset < end and source[offset] == ",":
            landmarks.append(PlacementLandmark("attribute-separator", Span(positions.position_at(offset), positions.position_at(offset + 1))))
            offset += 1
    return landmarks, entries, offset


def scan_attribute_entry(
    source: str,
    offset: int,
    end: int,
    owner_path: str,
    positions: PositionLookup,
    *,
    make_bindables: bool,
) -> tuple[list[PlacementLandmark], list[BindableRecord], int] | None:
    if source[offset] == "<":
        positions.index_tokens()
        opening = bisect_left(positions.token_starts, offset)
        closing = positions.closing_tokens.get(opening)
        if closing is None:
            return None
        value_end = positions.tokens[closing].span.end.offset
        if value_end > end:
            return None
        tag = positions.tokens[opening + 1].value
        value_span = Span(positions.position_at(offset), positions.position_at(value_end))
        if not make_bindables:
            return [PlacementLandmark("attribute-value", value_span)], [], value_end
        landmarks = node_value_landmarks(source, value_span, positions)
        path = format_attribute_path(owner_path, tag)
        entries = [BindableRecord(
            span=value_span, order=0, path=path, value_span=value_span,
            value_type="NodeLiteral", kind="attribute", landmarks=landmarks,
        )]
        entries.extend(node_attribute_entry_bindables(source, value_span, path, positions))
        node = positions.node_values.get(offset, {})
        entries.extend(metadata_descendants(source, node, path, positions))
        return landmarks, entries, value_end
    key_span = scan_key_span(source, offset, positions)
    if key_span is None:
        return None
    key = decode_key(source[key_span.start.offset:key_span.end.offset])
    path = format_attribute_path(owner_path, key)
    landmarks = [PlacementLandmark("attribute-key", key_span)]
    entries = []
    payload = positions.attribute_values.get(key_span.start.offset)
    scan = key_span.end.offset
    entry_end = scan
    value_span = key_span
    while scan < end:
        scan = skip_head_trivia(source, scan, end)
        if scan >= end or source[scan] in {",", "}", "\r", "\n"}:
            entry_end = scan
            break
        if source[scan] == "@":
            attr_marks, bindables, scan = scan_attribute_block(
                source, scan, end, path, positions, make_bindables=make_bindables,
            )
            landmarks.extend(attr_marks)
            entries.extend(bindables)
            continue
        if source[scan] == ":":
            landmarks.append(PlacementLandmark("attribute-datatype-colon", Span(positions.position_at(scan), positions.position_at(scan + 1))))
            dtype_start = skip_head_trivia(source, scan + 1, end)
            dtype_end = scan_datatype_end(source, dtype_start, end)
            if dtype_start < dtype_end:
                landmarks.append(PlacementLandmark("attribute-datatype", Span(positions.position_at(dtype_start), positions.position_at(dtype_end))))
            scan = dtype_end
            continue
        if source[scan] == "=":
            landmarks.append(PlacementLandmark("attribute-equals", Span(positions.position_at(scan), positions.position_at(scan + 1))))
            authored_span = event_value_span({"value": payload})
            if authored_span is not None and authored_span.end.offset <= end:
                value_span = authored_span
            else:
                value_start = skip_node_layout(source, scan + 1, end)
                value_end = scan_attribute_value_end(source, value_start, end)
                value_span = Span(positions.position_at(value_start), positions.position_at(value_end))
            if value_span.start.offset < value_span.end.offset:
                landmarks.append(PlacementLandmark("attribute-value", value_span))
            entry_end = skip_head_trivia(source, value_span.end.offset, end)
            break
        scan += 1
    if make_bindables:
        entries.insert(0, BindableRecord(
            span=Span(key_span.start, positions.position_at(entry_end)),
            order=0,
            path=path,
            value_span=value_span,
            value_type=event_value_type({"value": payload}),
            kind="attribute",
            landmarks=landmarks,
        ))
        if payload is not None:
            entries.extend(metadata_descendants(source, payload, path, positions))
    return landmarks, entries, entry_end


def decode_key(raw: str) -> str:
    if raw.startswith(('"', "'")):
        tokens = tokenize(raw).tokens
        if tokens and tokens[0].kind == "STRING":
            return tokens[0].value
    return raw


def add_metadata_value_bindables(
    source: str, payload: dict[str, object], path: str, positions: PositionLookup,
    *, binding_span: object = None,
) -> list[BindableRecord]:
    raw_span = binding_span or payload.get("span")
    if not isinstance(raw_span, dict):
        return []
    span = parse_span(raw_span)
    value = payload["value"] if payload.get("type") == "TypedValue" else payload
    event = {"path": path, "span": raw_span, "value": value}
    result = [BindableRecord(
        span=span, order=0, path=path, value_span=event_value_span(event),
        value_type=event_value_type(event), kind="binding",
        landmarks=binding_landmarks(source, event, positions),
    )]
    result.extend(attribute_bindables(source, event, positions, 0))
    result.extend(metadata_descendants(source, value, path, positions))
    return result


def metadata_descendants(
    source: str, value: dict[str, object], path: str, positions: PositionLookup,
) -> list[BindableRecord]:
    result = []
    kind = value.get("type")
    if kind == "ObjectNode":
        for binding in value.get("bindings") or []:
            key = binding["key"]
            member = key if is_ascii_identifier(key) else f"[{json.dumps(key, ensure_ascii=False)}]"
            result.extend(add_metadata_value_bindables(
                source, binding["value"], f"{path}.{member}", positions, binding_span=binding.get("span"),
            ))
    elif kind in {"NodeLiteral", "ListNode", "TupleLiteral"}:
        children = value.get("children" if kind == "NodeLiteral" else "elements") or []
        for index, item in enumerate(children):
            result.extend(add_metadata_value_bindables(source, item, f"{path}[{index}]", positions))
    return result


def scan_attribute_value_end(source: str, start: int, end: int) -> int:
    offset = start
    depth = 0
    while offset < end:
        if starts_comment(source, offset):
            break
        char = source[offset]
        if char in {'"', "'", "`"}:
            offset = skip_string(source, offset, char)
            continue
        if char in "{[(":
            depth += 1
        elif char in "}])":
            if depth == 0:
                break
            depth -= 1
        elif depth == 0 and char in {",", "}"}:
            break
        elif depth == 0 and char in {" ", "\t", "\n", "\r"}:
            break
        offset += 1
    return offset


def format_attribute_path(owner_path: str, key: str) -> str:
    return f"{owner_path}.@.{key}" if is_ascii_identifier(key) else f"{owner_path}.@.[{json.dumps(key, ensure_ascii=False)}]"


def is_ascii_identifier(value: str) -> bool:
    if not value:
        return False
    first = value[0]
    if first != "_" and not ("A" <= first <= "Z" or "a" <= first <= "z"):
        return False
    return all(ch == "_" or "A" <= ch <= "Z" or "a" <= ch <= "z" or "0" <= ch <= "9" for ch in value[1:])


def node_value_landmarks(source: str, value_span: Span, positions: PositionLookup) -> list[PlacementLandmark]:
    positions.index_tokens()
    tokens = positions.tokens
    start = bisect_left(positions.token_starts, value_span.start.offset)
    stop = positions.closing_tokens.get(start)
    if stop is None or stop - start < 2:
        return [PlacementLandmark("value", value_span)]

    landmarks = [
        PlacementLandmark("node-open", tokens[start].span),
        PlacementLandmark("node-tag", tokens[start + 1].span),
    ]
    cursor = start + 2
    if tokens[cursor].kind == "STRUCTURAL_IDENTITY":
        cursor += 1
    if tokens[cursor].kind == "AT":
        at = tokens[cursor].span.start.offset
        marks, _, attribute_end = scan_attribute_block(
            source, at, value_span.end.offset, "", positions, make_bindables=False,
        )
        landmarks.extend(marks)
        cursor = bisect_left(positions.token_starts, attribute_end, lo=cursor + 1)

    if cursor < stop and tokens[cursor].kind == "COLON":
        landmarks.append(PlacementLandmark("node-datatype-colon", tokens[cursor].span))
        cursor += 1
        datatype_start = cursor
        while cursor < stop and tokens[cursor].kind != "LPAREN":
            cursor = positions.closing_tokens.get(cursor, cursor) + 1
        if cursor > datatype_start:
            landmarks.append(PlacementLandmark(
                "node-datatype", Span(tokens[datatype_start].span.start, tokens[cursor - 1].span.end),
            ))

    if cursor < stop and tokens[cursor].kind == "LPAREN":
        close = positions.closing_tokens.get(cursor)
        if close is not None:
            landmarks.append(PlacementLandmark("node-children-open", tokens[cursor].span))
            raw_node = positions.node_values.get(value_span.start.offset, {})
            nodes = raw_node.get("children") or []
            last = cursor
            for child in nodes:
                span = parse_span(child["span"])
                child_start = bisect_left(positions.token_starts, span.start.offset, lo=last + 1)
                if tokens[last + 1].kind == "COMMA" and last + 1 < child_start:
                    landmarks.append(PlacementLandmark("node-child-separator", tokens[last + 1].span))
                landmarks.append(PlacementLandmark("node-child-value", span))
                last = bisect_left(positions.token_starts, span.end.offset, lo=child_start + 1) - 1
            landmarks.append(PlacementLandmark("node-children-close", tokens[close].span))

    landmarks.append(PlacementLandmark("node-close", tokens[stop].span))
    return landmarks


def event_value_span(event: dict[str, object]) -> Span | None:
    value = event.get("value")
    if not isinstance(value, dict):
        return None
    span = value.get("span")
    if not isinstance(span, dict):
        return None
    return parse_span(span)


def event_value_type(event: dict[str, object]) -> str | None:
    value = event.get("value")
    if not isinstance(value, dict):
        return None
    value_type = value.get("type")
    return value_type if isinstance(value_type, str) else None


def scan_key_span(
    source: str,
    offset: int,
    positions: PositionLookup | None = None,
) -> Span | None:
    positions = positions or PositionLookup.from_source(source)
    start = skip_horizontal_space(source, offset, len(source))
    if start >= len(source):
        return None
    if source[start] in {'"', "'"}:
        end = start + 1
        while end < len(source):
            char = source[end]
            end += 1
            if char == "\\" and end < len(source):
                end += 1
                continue
            if char == source[start]:
                return Span(positions.position_at(start), positions.position_at(end))
        return Span(positions.position_at(start), positions.position_at(end))

    end = start
    while end < len(source):
        if starts_comment(source, end):
            break
        if source[end] in {":", "@", "=", "\\", " ", "\t", "\n", "\r", ",", "}", "]", "(", ">"}:
            break
        end += 1
    if end == start:
        return None
    return Span(positions.position_at(start), positions.position_at(end))


def scan_attribute_span(
    source: str,
    start: int,
    end: int,
    positions: PositionLookup | None = None,
) -> Span | None:
    positions = positions or PositionLookup.from_source(source)
    at = find_top_level_char(source, "@", start, end)
    if at is None:
        return None
    stop = find_top_level_char(source, ":", at + 1, end)
    if stop is None:
        stop = end
    stop = trim_horizontal_space_end(source, stop, at + 1)
    return Span(positions.position_at(at), positions.position_at(stop))


def find_top_level_colon(source: str, start: int, end: int) -> int | None:
    return find_top_level_char(source, ":", start, end)


def find_top_level_char(source: str, needle: str, start: int, end: int) -> int | None:
    depth = 0
    offset = start
    while offset < min(end, len(source)):
        if starts_comment(source, offset):
            if starts_line_comment(source, offset):
                offset = skip_line_comment(source, offset, end)
            else:
                offset = skip_block_comment(source, offset, end)
            continue
        char = source[offset]
        if char in {'"', "'", "`"}:
            offset = skip_string(source, offset, char)
            continue
        if char in "{[(":
            depth += 1
        elif char in "}])" and depth > 0:
            depth -= 1
        elif char == needle and depth == 0:
            return offset
        offset += 1
    return None


def skip_string(source: str, offset: int, delimiter: str) -> int:
    offset += 1
    raw = delimiter == "`"
    while offset < len(source):
        char = source[offset]
        offset += 1
        if char == "\\" and not raw and offset < len(source):
            offset += 1
            continue
        if char == delimiter:
            break
        if char == "\n" and not raw:
            break
    return offset


def skip_horizontal_space(source: str, start: int, end: int) -> int:
    while start < end and source[start] in {" ", "\t"}:
        start += 1
    return start


def skip_head_trivia(source: str, start: int, end: int) -> int:
    while start < end:
        if source[start] in {" ", "\t"}:
            start += 1
            continue
        if starts_structured_or_plain_block_comment(source, start):
            start = skip_block_comment(source, start, end)
            continue
        if starts_line_comment(source, start):
            start = skip_line_comment(source, start, end)
            continue
        break
    return start


def skip_node_layout(source: str, start: int, end: int) -> int:
    offset = skip_head_trivia(source, start, end)
    while offset < end and source[offset] in "\r\n":
        offset = skip_head_trivia(source, offset + 1, end)
    return offset


def scan_datatype_end(source: str, start: int, end: int) -> int:
    offset = start
    brackets = 0
    angles = 0
    while offset < end:
        char = source[offset]
        if char == "[":
            brackets += 1
        elif char == "]":
            brackets = max(0, brackets - 1)
        elif char == "<":
            angles += 1
        elif char == ">":
            angles = max(0, angles - 1)
        elif brackets == 0 and angles == 0:
            if char in {"@", "=", " ", "\t", "\n", "\r"} or starts_comment(source, offset):
                break
        offset += 1
    return offset


def starts_comment(source: str, offset: int) -> bool:
    return starts_line_comment(source, offset) or starts_structured_or_plain_block_comment(source, offset)


def starts_line_comment(source: str, offset: int) -> bool:
    return offset + 1 < len(source) and source[offset] == "/" and source[offset + 1] == "/"


def starts_structured_or_plain_block_comment(source: str, offset: int) -> bool:
    return (
        offset + 1 < len(source)
        and source[offset] == "/"
        and (source[offset + 1] in {"#", "@", "?", "{", "[", "("} or source[offset + 1] == "*")
    )


def skip_line_comment(source: str, start: int, end: int) -> int:
    while start < end and source[start] != "\n":
        start += 1
    return start


def skip_block_comment(source: str, start: int, end: int) -> int:
    if start + 1 >= end:
        return end
    marker = source[start + 1]
    closing = {"{": "}", "[": "]", "(": ")", "*": "*"}.get(marker, marker)
    offset = start + 2
    while offset + 1 < end:
        if source[offset] == closing and source[offset + 1] == "/":
            return offset + 2
        offset += 1
    return end


def trim_horizontal_space_end(source: str, end: int, lower_bound: int) -> int:
    while end > lower_bound and source[end - 1] in {" ", "\t"}:
        end -= 1
    return end


def position_at(source: str, offset: int) -> Position:
    return position_from_offset(source, offset)


def span_contains(outer: Span, inner: Span) -> bool:
    return outer.start.offset <= inner.start.offset and outer.end.offset >= inner.end.offset


def span_length(span: Span) -> int:
    return span.end.offset - span.start.offset


def spans_overlap(left: Span, right: Span) -> bool:
    return left.start.offset < right.end.offset and right.start.offset < left.end.offset


def is_descendant_path(parent_path: str, candidate_path: str) -> bool:
    return len(candidate_path) > len(parent_path) and (
        candidate_path.startswith(parent_path + ".")
        or candidate_path.startswith(parent_path + "[")
        or candidate_path.startswith(parent_path + "@")
    )
