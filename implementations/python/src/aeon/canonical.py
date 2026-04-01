from __future__ import annotations

import re

from ._compat import dataclass
from .ast import (
    Attribute,
    AttributePathSegment,
    Binding,
    BooleanLiteral,
    CloneReference,
    DateLiteral,
    DateTimeLiteral,
    Document,
    EncodingLiteral,
    InfinityLiteral,
    Header,
    HexLiteral,
    ListNode,
    NodeLiteral,
    NumberLiteral,
    ObjectNode,
    PointerReference,
    RadixLiteral,
    SeparatorLiteral,
    StringLiteral,
    SwitchLiteral,
    TimeLiteral,
    TupleLiteral,
    TypeAnnotation,
    Value,
)
from .errors import AeonError
from .lexer import tokenize
from .parser import parse_tokens
from .spans import Span


@dataclass(slots=True)
class CanonicalResult:
    text: str
    errors: list[AeonError]


def _zero_span() -> Span:
    from .spans import Position

    pos = Position(line=1, column=1, offset=0)
    return Span(start=pos, end=pos)


DEFAULT_HEADER = {
    "encoding": StringLiteral(value="utf-8", raw="utf-8", delimiter='"', span=_zero_span()),
    "mode": StringLiteral(value="transport", raw="transport", delimiter='"', span=_zero_span()),
    "profile": StringLiteral(value="core", raw="core", delimiter='"', span=_zero_span()),
    "version": NumberLiteral(value="1.0", raw="1.0", span=_zero_span()),
}


def canonicalize(source: str) -> CanonicalResult:
    source = strip_leading_bom(source)
    lex_result = tokenize(source)
    if lex_result.errors:
        return CanonicalResult(text="", errors=lex_result.errors)
    parse_result = parse_tokens(source, lex_result.tokens, max_separator_depth=8, max_generic_depth=8)
    if parse_result.errors or parse_result.document is None:
        return CanonicalResult(text="", errors=[error for error in parse_result.errors if isinstance(error, AeonError)])
    return CanonicalResult(text=render_document(parse_result.document), errors=[])


def strip_leading_bom(source: str) -> str:
    return source[1:] if source.startswith("\ufeff") else source


def render_document(document: Document) -> str:
    lines: list[str] = []
    lines.extend(render_header(document.header))
    for binding in sorted(document.bindings, key=lambda item: item.key):
        lines.extend(render_binding(binding, 0))
    return "\n".join(lines)


def render_header(header: Header | None) -> list[str]:
    if header is None:
        bindings = [
            Binding(key=key, value=value, datatype=None, attributes=[], span=value.span or _zero_span())
            for key, value in DEFAULT_HEADER.items()
        ]
    else:
        bindings = sorted(header.bindings, key=lambda item: item.key)
    lines = ["aeon:header = {"]
    for binding in bindings:
        lines.extend(render_binding(binding, 2))
    lines.append("}")
    return lines


def render_binding(binding: Binding, indent: int) -> list[str]:
    prefix = " " * indent
    key = f"{format_binding_key(binding.key)}{render_attributes(binding.attributes)}{render_type(binding.datatype)}"

    if isinstance(binding.value, ObjectNode):
        lines = [f"{prefix}{key} = {{"]
        for child in sorted(binding.value.bindings, key=lambda item: item.key):
            lines.extend(render_binding(child, indent + 2))
        lines.append(f"{prefix}}}")
        return lines
    if isinstance(binding.value, ListNode):
        return render_list_binding(prefix, key, binding.value, indent)
    if isinstance(binding.value, TupleLiteral):
        return render_tuple_binding(prefix, key, binding.value, indent)
    if isinstance(binding.value, NodeLiteral):
        node_lines = render_node_value(binding.value, indent, inline_only=False)
        if len(node_lines) == 1:
            return [f"{prefix}{key} = {node_lines[0].lstrip()}"]
        return [f"{prefix}{key} = {node_lines[0].lstrip()}", *node_lines[1:]]

    value_lines = render_value(binding.value, indent, inline_only=True)
    if len(value_lines) == 1:
        return [f"{prefix}{key} = {value_lines[0]}"]
    return [f"{prefix}{key} = {value_lines[0]}", *value_lines[1:]]


def render_list_binding(prefix: str, key: str, value: ListNode, indent: int) -> list[str]:
    if all(is_simple_value(element) for element in value.elements):
        rendered = ", ".join(render_value(element, indent + 1, inline_only=True)[0] for element in value.elements)
        return [f"{prefix}{key} = [{rendered}]"]

    lines = [f"{prefix}{key} = ["]
    for index, element in enumerate(value.elements):
        item_lines = render_value(element, indent + 2, inline_only=False)
        if item_lines and not item_lines[0].startswith(" " * (indent + 2)):
            item_lines[0] = f"{' ' * (indent + 2)}{item_lines[0]}"
        if index < len(value.elements) - 1:
            item_lines[-1] = f"{item_lines[-1]},"
        lines.extend(item_lines)
    lines.append(f"{prefix}]")
    return lines


def render_tuple_binding(prefix: str, key: str, value: TupleLiteral, indent: int) -> list[str]:
    if all(is_simple_value(element) for element in value.elements):
        rendered = ", ".join(render_value(element, indent + 1, inline_only=True)[0] for element in value.elements)
        return [f"{prefix}{key} = ({rendered})"]

    lines = [f"{prefix}{key} = ("]
    for index, element in enumerate(value.elements):
        item_lines = render_value(element, indent + 2, inline_only=False)
        if item_lines and not item_lines[0].startswith(" " * (indent + 2)):
            item_lines[0] = f"{' ' * (indent + 2)}{item_lines[0]}"
        if index < len(value.elements) - 1:
            item_lines[-1] = f"{item_lines[-1]},"
        lines.extend(item_lines)
    lines.append(f"{prefix})")
    return lines


def render_value(value: Value, indent: int, inline_only: bool) -> list[str]:
    prefix = " " * indent

    if isinstance(value, StringLiteral):
        return format_string_lines(value.value, indent)
    if isinstance(value, NumberLiteral):
        return [format_number(value.raw or value.value)]
    if isinstance(value, InfinityLiteral):
        return [value.raw]
    if isinstance(value, BooleanLiteral):
        return ["true" if value.value else "false"]
    if isinstance(value, SwitchLiteral):
        return [value.value]
    if isinstance(value, HexLiteral):
        return [f"#{value.value.replace('_', '').lower()}"]
    if isinstance(value, RadixLiteral):
        return [f"%{value.value.replace('_', '')}"]
    if isinstance(value, EncodingLiteral):
        return [f"${format_encoding_literal(value.value)}"]
    if isinstance(value, SeparatorLiteral):
        return [f"^{format_separator(value.raw or value.value)}"]
    if isinstance(value, (DateLiteral, DateTimeLiteral, TimeLiteral)):
        return [value.value]
    if isinstance(value, CloneReference):
        return [f"~{render_reference_path(value.path)}"]
    if isinstance(value, PointerReference):
        return [f"~>{render_reference_path(value.path)}"]
    if isinstance(value, ObjectNode):
        lines = [f"{prefix}{{".rstrip()]
        for binding in sorted(value.bindings, key=lambda item: item.key):
            lines.extend(render_binding(binding, indent + 2))
        lines.append(f"{prefix}}}".rstrip())
        return lines
    if isinstance(value, ListNode):
        if inline_only and all(is_simple_value(element) for element in value.elements):
            rendered = ", ".join(render_value(element, indent + 1, inline_only=True)[0] for element in value.elements)
            return [f"[{rendered}]"]
        lines = [f"{prefix}[".rstrip()]
        for index, element in enumerate(value.elements):
            item_lines = render_value(element, indent + 2, inline_only=False)
            if item_lines and not item_lines[0].startswith(" " * (indent + 2)):
                item_lines[0] = f"{' ' * (indent + 2)}{item_lines[0]}"
            if index < len(value.elements) - 1:
                item_lines[-1] = f"{item_lines[-1]},"
            lines.extend(item_lines)
        lines.append(f"{prefix}]".rstrip())
        return lines
    if isinstance(value, TupleLiteral):
        if inline_only and all(is_simple_value(element) for element in value.elements):
            rendered = ", ".join(render_value(element, indent + 1, inline_only=True)[0] for element in value.elements)
            return [f"({rendered})"]
        lines = [f"{prefix}(".rstrip()]
        for index, element in enumerate(value.elements):
            item_lines = render_value(element, indent + 2, inline_only=False)
            if item_lines and not item_lines[0].startswith(" " * (indent + 2)):
                item_lines[0] = f"{' ' * (indent + 2)}{item_lines[0]}"
            if index < len(value.elements) - 1:
                item_lines[-1] = f"{item_lines[-1]},"
            lines.extend(item_lines)
        lines.append(f"{prefix})".rstrip())
        return lines
    if isinstance(value, NodeLiteral):
        return render_node_value(value, indent, inline_only)
    return [""]


def render_node_value(value: NodeLiteral, indent: int, inline_only: bool) -> list[str]:
    prefix = " " * indent
    head = f"<{value.tag}{render_attributes(value.attributes)}{render_type(value.datatype)}"
    simple = all(is_simple_value(child) for child in value.children)

    if not value.children:
        return [f"{head}>"]
    if inline_only and simple:
        rendered = ", ".join(render_value(child, indent + 1, inline_only=True)[0] for child in value.children)
        return [f"{head}({rendered})>"]

    lines = [f"{prefix}{head}(".rstrip()]
    for index, child in enumerate(value.children):
        item_lines = render_value(child, indent + 2, inline_only=True)
        if item_lines and not item_lines[0].startswith(" " * (indent + 2)):
            item_lines[0] = f"{' ' * (indent + 2)}{item_lines[0]}"
        if index < len(value.children) - 1:
            item_lines[-1] = f"{item_lines[-1]},"
        lines.extend(item_lines)
    lines.append(f"{prefix})>".rstrip())
    return lines


def render_attributes(attributes: list[Attribute]) -> str:
    if not attributes:
        return ""

    merged_entries = {}
    for attribute in attributes:
        for key, value in attribute.entries.items():
            merged_entries[key] = value

    rendered = []
    for key, entry in sorted(merged_entries.items(), key=lambda item: item[0]):
        rendered.append(
            f"{format_binding_key(key)}{render_attributes(entry.attributes)}{render_type(entry.datatype)} = {render_value_inline(entry.value)}"
        )
    return f"@{{{', '.join(rendered)}}}"


def render_type(datatype: TypeAnnotation | None) -> str:
    if datatype is None:
        return ""
    text = datatype.name
    if datatype.generic_args:
        text += "<" + ", ".join(datatype.generic_args) + ">"
    for separator in datatype.separators:
        text += f"[{separator}]"
    return f":{text}"


def render_value_inline(value: Value) -> str:
    if isinstance(value, StringLiteral) and "\n" in value.value:
        return format_string(value.value)
    return render_compact_inline_value(value)


def render_compact_inline_value(value: Value) -> str:
    if isinstance(value, StringLiteral):
        return format_string(value.value)
    if isinstance(value, NumberLiteral):
        return format_number(value.raw or value.value)
    if isinstance(value, InfinityLiteral):
        return value.raw
    if isinstance(value, BooleanLiteral):
        return "true" if value.value else "false"
    if isinstance(value, SwitchLiteral):
        return value.value
    if isinstance(value, HexLiteral):
        return f"#{value.value.replace('_', '').lower()}"
    if isinstance(value, RadixLiteral):
        return f"%{value.value.replace('_', '')}"
    if isinstance(value, EncodingLiteral):
        return f"${format_encoding_literal(value.value)}"
    if isinstance(value, SeparatorLiteral):
        return f"^{format_separator(value.raw or value.value)}"
    if isinstance(value, (DateLiteral, DateTimeLiteral, TimeLiteral)):
        return value.value
    if isinstance(value, CloneReference):
        return f"~{render_reference_path(value.path)}"
    if isinstance(value, PointerReference):
        return f"~>{render_reference_path(value.path)}"
    if isinstance(value, ObjectNode):
        bindings = []
        for binding in sorted(value.bindings, key=lambda item: item.key):
            key = f"{format_binding_key(binding.key)}{render_attributes(binding.attributes)}{render_type(binding.datatype)}"
            bindings.append(f"{key} = {render_compact_inline_value(binding.value)}")
        return "{ " + ", ".join(bindings) + " }" if bindings else "{ }"
    if isinstance(value, ListNode):
        return "[" + ", ".join(render_compact_inline_value(element) for element in value.elements) + "]"
    if isinstance(value, TupleLiteral):
        return "(" + ", ".join(render_compact_inline_value(element) for element in value.elements) + ")"
    if isinstance(value, NodeLiteral):
        head = f"<{value.tag}{render_attributes(value.attributes)}{render_type(value.datatype)}"
        if not value.children:
            return f"{head}>"
        return f"{head}({', '.join(render_compact_inline_value(child) for child in value.children)})>"
    return ""


def render_reference_path(path: list[object]) -> str:
    if not path:
        return ""
    result = ""
    for index, segment in enumerate(path):
        if isinstance(segment, int):
            result += f"[{segment}]"
            continue
        if isinstance(segment, AttributePathSegment):
            if re.match(r"^[A-Za-z_][A-Za-z0-9_]*$", segment.key):
                result += f"@{segment.key}"
            else:
                result += f"@[{format_string(segment.key)}]"
            continue
        member = str(segment)
        if index > 0:
            result += "."
        if re.match(r"^[A-Za-z_][A-Za-z0-9_]*$", member):
            result += member
        else:
            result += f"[{format_string(member)}]"
    return result


def format_encoding_literal(value: str) -> str:
    return value.replace("+", "-").replace("/", "_").rstrip("=")


def format_binding_key(key: str) -> str:
    return key if re.match(r"^[A-Za-z_][A-Za-z0-9_]*$", key) else format_string(key)


def format_string(value: str) -> str:
    out: list[str] = []
    for char in value:
        if char == '"':
            out.append('\\"')
        elif char == "\\":
            out.append("\\\\")
        elif char == "\n":
            out.append("\\n")
        elif char == "\r":
            out.append("\\r")
        elif char == "\t":
            out.append("\\t")
        else:
            code = ord(char)
            if code < 0x20:
                out.append(f"\\u{code:04x}")
            else:
                out.append(char)
    return '"' + "".join(out) + '"'


def format_string_lines(value: str, indent: int) -> list[str]:
    if "\n" not in value:
        return [format_string(value)]
    prefix = " " * indent
    body_prefix = " " * (indent + 2)
    return [">`", *(f"{body_prefix}{line}" for line in value.split("\n")), f"{prefix}`"]


def format_number(raw: str) -> str:
    value = raw.replace("_", "").replace("E", "e")
    if value.startswith("."):
        value = f"0{value}"
    if value.startswith("-."):
        value = value.replace("-.", "-0.", 1)
    if value.startswith("+."):
        value = value.replace("+.", "0.", 1)
    if value.startswith("+") and len(value) > 1 and value[1].isdigit():
        value = value[1:]

    parts = value.split("e", 1)
    mantissa = parts[0]
    exponent = parts[1] if len(parts) == 2 else None
    if "." in mantissa:
        int_part, frac_part = mantissa.split(".", 1)
        frac_part = frac_part.rstrip("0")
        if not frac_part:
            frac_part = "0"
        if exponent is not None and frac_part == "0":
            mantissa = int_part
        else:
            mantissa = f"{int_part}.{frac_part}"
    if exponent is not None:
        exponent = re.sub(r"^\+", "", exponent)
        exponent = re.sub(r"^(-?)0+(\d)", r"\1\2", exponent)
        return f"{mantissa}e{exponent}"
    return mantissa


def format_separator(raw: str) -> str:
    content = raw[1:] if raw.startswith("^") else raw
    parts: list[str] = []
    separators: list[str] = []
    current: list[str] = []
    in_quote: str | None = None

    for char in content:
        if char in {'"', "'"}:
            if in_quote is None:
                in_quote = char
            elif in_quote == char:
                in_quote = None
            current.append(char)
            continue
        if in_quote is None and char in {"|", ",", ";"}:
            parts.append("".join(current).strip())
            separators.append(char)
            current = []
            continue
        current.append(char)

    parts.append("".join(current) if in_quote else "".join(current).strip())
    result: list[str] = []
    for index, part in enumerate(parts):
        result.append(part)
        if index < len(separators):
            result.append(separators[index])
    return "".join(result)


def is_simple_value(value: Value) -> bool:
    if isinstance(value, StringLiteral) and "\n" in value.value:
        return False
    return isinstance(
        value,
        (
        StringLiteral,
        NumberLiteral,
        InfinityLiteral,
        BooleanLiteral,
            SwitchLiteral,
            HexLiteral,
            RadixLiteral,
            EncodingLiteral,
            SeparatorLiteral,
            DateLiteral,
            DateTimeLiteral,
            TimeLiteral,
            CloneReference,
            PointerReference,
        ),
    )
