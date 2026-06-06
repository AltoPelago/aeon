from __future__ import annotations

from bisect import bisect_left, bisect_right

from ._compat import dataclass
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


@dataclass(slots=True)
class PositionLookup:
    source: str
    line_starts: list[int]

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
    positions = PositionLookup.from_source(source)
    resolver = AnnotationResolver(
        path_bindables=[
            BindableRecord(
                span=parse_span(event["span"]),
                order=index,
                path=str(event["path"]),
                value_span=event_value_span(event),
                value_type=event_value_type(event),
                landmarks=binding_landmarks(source, event, positions),
            )
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
        placement = resolver.resolve_placement(comment.span, target)
        if placement is not None:
            record["placement"] = placement
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

    landmarks: list[PlacementLandmark] = []
    key_span = scan_key_span(source, span.start.offset, positions)
    if key_span is not None:
        landmarks.append(PlacementLandmark("key", key_span))
        head_start = key_span.end.offset
    else:
        head_start = span.start.offset

    equals_offset = source.rfind("=", span.start.offset, value_span.start.offset)
    head_end = equals_offset if equals_offset >= 0 else value_span.start.offset
    attributes_span = scan_attribute_span(source, head_start, head_end, positions)
    if attributes_span is not None:
        landmarks.append(PlacementLandmark("attributes", attributes_span))

    colon_offset = find_top_level_colon(source, attributes_span.end.offset if attributes_span else head_start, head_end)
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

    if equals_offset >= 0:
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


def node_value_landmarks(source: str, value_span: Span, positions: PositionLookup) -> list[PlacementLandmark]:
    tokens = node_value_tokens(source, value_span, positions)
    landmarks: list[PlacementLandmark] = []
    angle_depth = 0
    paren_depth = 0
    state = "open"

    for kind, span in tokens:
        if kind == "<" and angle_depth == 0:
            landmarks.append(PlacementLandmark("node-open", span))
            angle_depth = 1
            state = "tag"
            continue
        if kind == ">" and angle_depth == 1 and paren_depth == 0:
            landmarks.append(PlacementLandmark("node-close", span))
            state = "done"
            continue
        if state == "tag" and kind == "semantic":
            landmarks.append(PlacementLandmark("node-tag", span))
            state = "open"
            continue
        if angle_depth == 1 and paren_depth == 0 and kind == ":":
            landmarks.append(PlacementLandmark("node-datatype-colon", span))
            state = "datatype"
            continue
        if state == "datatype" and kind == "semantic":
            landmarks.append(PlacementLandmark("node-datatype", span))
            continue
        if angle_depth == 1 and kind == "(":
            paren_depth += 1
            landmarks.append(PlacementLandmark("node-children-open" if paren_depth == 1 else "value", span))
            state = "children"
            continue
        if angle_depth == 1 and kind == ")":
            if paren_depth == 1:
                landmarks.append(PlacementLandmark("node-children-close", span))
            paren_depth = max(0, paren_depth - 1)
            continue
        if angle_depth == 1 and paren_depth == 1 and kind == ",":
            landmarks.append(PlacementLandmark("node-child-separator", span))
            continue
        if angle_depth == 1 and paren_depth == 1 and kind == "semantic":
            landmarks.append(PlacementLandmark("node-child-value", span))

    return landmarks or [PlacementLandmark("value", value_span)]


def node_value_tokens(
    source: str,
    value_span: Span,
    positions: PositionLookup,
) -> list[tuple[str, Span]]:
    tokens: list[tuple[str, Span]] = []
    offset = value_span.start.offset
    end = value_span.end.offset
    while offset < end:
        char = source[offset]
        if char in {" ", "\t", "\n", "\r"}:
            offset += 1
            continue
        if starts_comment(source, offset):
            if starts_line_comment(source, offset):
                offset = skip_line_comment(source, offset, end)
            else:
                offset = skip_block_comment(source, offset, end)
            continue
        if char in {'"', "'", "`"}:
            token_end = skip_string(source, offset, char)
            tokens.append(("semantic", Span(positions.position_at(offset), positions.position_at(token_end))))
            offset = token_end
            continue
        if char in {"<", ">", "(", ")", ",", ":"}:
            tokens.append((char, Span(positions.position_at(offset), positions.position_at(offset + 1))))
            offset += 1
            continue
        token_end = offset + 1
        while token_end < end:
            next_char = source[token_end]
            if next_char in {" ", "\t", "\n", "\r", "<", ">", "(", ")", ",", ":"} or starts_comment(source, token_end):
                break
            token_end += 1
        tokens.append(("semantic", Span(positions.position_at(offset), positions.position_at(token_end))))
        offset = token_end
    return tokens


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
    if source[start] == '"':
        end = start + 1
        while end < len(source):
            char = source[end]
            end += 1
            if char == "\\" and end < len(source):
                end += 1
                continue
            if char == '"':
                return Span(positions.position_at(start), positions.position_at(end))
        return Span(positions.position_at(start), positions.position_at(end))

    end = start
    while end < len(source):
        if starts_comment(source, end):
            break
        if source[end] in {":", "@", "=", " ", "\t", "\n", "\r", ",", "}", "]"}:
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
        candidate_path.startswith(parent_path + ".") or candidate_path.startswith(parent_path + "[")
    )
