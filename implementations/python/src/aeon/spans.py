from __future__ import annotations

from ._compat import dataclass

@dataclass(frozen=True)
class Position:
    line: int
    column: int
    offset: int

    def to_json(self) -> dict[str, int]:
        return {
            "line": self.line,
            "column": self.column,
            "offset": self.offset,
        }


@dataclass(frozen=True)
class Span:
    start: Position
    end: Position

    def to_json(self) -> dict[str, dict[str, int]]:
        return {
            "start": self.start.to_json(),
            "end": self.end.to_json(),
        }


def span_from_offsets(source: str, start_offset: int, end_offset: int) -> Span:
    return Span(
        start=position_from_offset(source, start_offset),
        end=position_from_offset(source, end_offset),
    )


def position_from_offset(source: str, offset: int) -> Position:
    line = 1
    column = 1
    index = 0
    while index < offset and index < len(source):
        if source[index] == "\n":
            line += 1
            column = 1
        else:
            column += 1
        index += 1
    return Position(line=line, column=column, offset=offset)
