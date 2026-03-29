from __future__ import annotations

from dataclasses import field
from typing import Literal

from ._compat import dataclass
from .spans import Span


@dataclass(slots=True)
class TypeAnnotation:
    name: str
    generic_args: list[str]
    separators: list[str]
    span: Span


@dataclass(slots=True)
class AttributeEntry:
    value: "Value"
    datatype: TypeAnnotation | None
    attributes: list["Attribute"] = field(default_factory=list)


@dataclass(slots=True)
class Attribute:
    entries: dict[str, AttributeEntry]
    span: Span


@dataclass(slots=True)
class Binding:
    key: str
    value: "Value"
    datatype: TypeAnnotation | None
    attributes: list[Attribute]
    span: Span


@dataclass(slots=True)
class Header:
    bindings: list[Binding]
    fields: dict[str, "Value"]
    has_structured: bool
    has_shorthand: bool
    span: Span


@dataclass(slots=True)
class Document:
    header: Header | None
    bindings: list[Binding]
    span: Span


@dataclass(slots=True)
class StringLiteral:
    type: Literal["StringLiteral"] = "StringLiteral"
    value: str = ""
    raw: str = ""
    delimiter: Literal['"', "'", "`"] = '"'
    trimticks: dict[str, object] | None = None
    span: Span | None = None


@dataclass(slots=True)
class NumberLiteral:
    type: Literal["NumberLiteral"] = "NumberLiteral"
    value: str = ""
    raw: str = ""
    span: Span | None = None


@dataclass(slots=True)
class InfinityLiteral:
    type: Literal["InfinityLiteral"] = "InfinityLiteral"
    value: Literal["Infinity", "-Infinity"] = "Infinity"
    raw: Literal["Infinity", "-Infinity"] = "Infinity"
    span: Span | None = None


@dataclass(slots=True)
class BooleanLiteral:
    type: Literal["BooleanLiteral"] = "BooleanLiteral"
    value: bool = False
    raw: str = ""
    span: Span | None = None


@dataclass(slots=True)
class SwitchLiteral:
    type: Literal["SwitchLiteral"] = "SwitchLiteral"
    value: Literal["yes", "no", "on", "off"] = "on"
    raw: str = ""
    span: Span | None = None


@dataclass(slots=True)
class HexLiteral:
    type: Literal["HexLiteral"] = "HexLiteral"
    value: str = ""
    raw: str = ""
    span: Span | None = None


@dataclass(slots=True)
class RadixLiteral:
    type: Literal["RadixLiteral"] = "RadixLiteral"
    value: str = ""
    raw: str = ""
    span: Span | None = None


@dataclass(slots=True)
class EncodingLiteral:
    type: Literal["EncodingLiteral"] = "EncodingLiteral"
    value: str = ""
    raw: str = ""
    span: Span | None = None


@dataclass(slots=True)
class DateLiteral:
    type: Literal["DateLiteral"] = "DateLiteral"
    value: str = ""
    raw: str = ""
    span: Span | None = None


@dataclass(slots=True)
class DateTimeLiteral:
    type: Literal["DateTimeLiteral"] = "DateTimeLiteral"
    value: str = ""
    raw: str = ""
    span: Span | None = None


@dataclass(slots=True)
class TimeLiteral:
    type: Literal["TimeLiteral"] = "TimeLiteral"
    value: str = ""
    raw: str = ""
    span: Span | None = None


@dataclass(slots=True)
class SeparatorLiteral:
    type: Literal["SeparatorLiteral"] = "SeparatorLiteral"
    value: str = ""
    raw: str = ""
    span: Span | None = None


@dataclass(slots=True)
class ObjectNode:
    type: Literal["ObjectNode"] = "ObjectNode"
    bindings: list[Binding] = field(default_factory=list)
    attributes: list[Attribute] = field(default_factory=list)
    span: Span | None = None


@dataclass(slots=True)
class ListNode:
    type: Literal["ListNode"] = "ListNode"
    elements: list["Value"] = field(default_factory=list)
    attributes: list[Attribute] = field(default_factory=list)
    span: Span | None = None


@dataclass(slots=True)
class TupleLiteral:
    type: Literal["TupleLiteral"] = "TupleLiteral"
    elements: list["Value"] = field(default_factory=list)
    attributes: list[Attribute] = field(default_factory=list)
    raw: str = ""
    span: Span | None = None


@dataclass(slots=True)
class NodeLiteral:
    type: Literal["NodeLiteral"] = "NodeLiteral"
    tag: str = ""
    attributes: list[Attribute] = field(default_factory=list)
    datatype: TypeAnnotation | None = None
    children: list["Value"] = field(default_factory=list)
    span: Span | None = None


@dataclass(slots=True, frozen=True)
class AttributePathSegment:
    type: Literal["attr"] = "attr"
    key: str = ""


ReferencePathSegment = str | int | AttributePathSegment


@dataclass(slots=True)
class CloneReference:
    type: Literal["CloneReference"] = "CloneReference"
    path: list[ReferencePathSegment] = field(default_factory=list)
    span: Span | None = None


@dataclass(slots=True)
class PointerReference:
    type: Literal["PointerReference"] = "PointerReference"
    path: list[ReferencePathSegment] = field(default_factory=list)
    span: Span | None = None


Value = (
    StringLiteral
    | NumberLiteral
    | InfinityLiteral
    | BooleanLiteral
    | SwitchLiteral
    | HexLiteral
    | RadixLiteral
    | EncodingLiteral
    | DateLiteral
    | DateTimeLiteral
    | TimeLiteral
    | SeparatorLiteral
    | ObjectNode
    | ListNode
    | TupleLiteral
    | NodeLiteral
    | CloneReference
    | PointerReference
)
