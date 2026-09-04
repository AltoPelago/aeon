from __future__ import annotations

import json
from typing import Iterable


PortableEvent = dict[str, object]


def project_portable_events(events: Iterable[dict[str, object]]) -> list[PortableEvent]:
    """Project legacy Python AES events into the portable flat event shape."""

    source_events = list(events)
    node_source_paths = {
        str(event.get("path"))
        for event in source_events
        if value_type(unwrap_typed_value(event.get("value"))) == "NodeLiteral"
    }
    projected: list[PortableEvent] = []

    for event in source_events:
        source_path = str(event.get("path", "$"))
        translated_path = translate_node_path(source_path, node_source_paths)
        value = unwrap_typed_value(event.get("value"))
        projected.append(
            make_event(
                translated_path,
                value,
                identity=optional_string(event.get("structuralId")),
                datatype=optional_string(event.get("datatype")),
                span=event.get("span"),
                node_source_paths=node_source_paths,
            )
        )
        project_mapped_attributes(
            event.get("annotations"),
            translated_path,
            projected,
            node_source_paths,
        )

        if value_type(value) == "NodeLiteral" and isinstance(value, dict):
            head_path = f"{translated_path}[0]"
            projected.append(
                compact_event(
                    path=head_path,
                    kind="node-head",
                    identity=optional_string(value.get("structuralId")),
                    datatype=format_datatype(value.get("datatype")),
                    value=optional_string(value.get("tag")),
                )
            )
            project_parser_attributes(
                value.get("attributes"),
                head_path,
                projected,
                node_source_paths,
            )

    return projected


def make_event(
    path: str,
    raw_value: object,
    *,
    identity: str | None,
    datatype: str | None,
    span: object,
    node_source_paths: set[str],
) -> PortableEvent:
    kind, value = project_value(raw_value, node_source_paths)
    return compact_event(
        path=path,
        kind=kind,
        identity=identity,
        datatype=datatype,
        value=value,
        span=span,
    )


def compact_event(
    *,
    path: str,
    kind: str,
    identity: str | None = None,
    datatype: str | None = None,
    value: str | None = None,
    span: object = None,
) -> PortableEvent:
    event: PortableEvent = {"path": path, "kind": kind}
    if identity is not None:
        event["identity"] = identity
    if datatype is not None:
        event["datatype"] = datatype
    if value is not None:
        event["value"] = value
    if span is not None:
        event["span"] = span
    return event


def project_mapped_attributes(
    attributes: object,
    owner_path: str,
    projected: list[PortableEvent],
    node_source_paths: set[str],
) -> None:
    if not isinstance(attributes, dict):
        return
    for key, raw_entry in attributes.items():
        if not isinstance(raw_entry, dict):
            continue
        project_value_tree(
            append_attribute(owner_path, str(key)),
            raw_entry.get("value"),
            identity=optional_string(raw_entry.get("structuralId")),
            datatype=optional_string(raw_entry.get("datatype")),
            mapped_attributes=raw_entry.get("annotations"),
            parser_attributes=None,
            span=None,
            projected=projected,
            node_source_paths=node_source_paths,
        )


def project_parser_attributes(
    attributes: object,
    owner_path: str,
    projected: list[PortableEvent],
    node_source_paths: set[str],
) -> None:
    if not isinstance(attributes, list):
        return
    for attribute in attributes:
        if not isinstance(attribute, dict):
            continue
        entries = attribute.get("entries")
        if not isinstance(entries, dict):
            continue
        for key, raw_entry in entries.items():
            if not isinstance(raw_entry, dict):
                continue
            project_value_tree(
                append_attribute(owner_path, str(key)),
                raw_entry.get("value"),
                identity=optional_string(raw_entry.get("structuralId")),
                datatype=format_datatype(raw_entry.get("datatype")),
                mapped_attributes=None,
                parser_attributes=raw_entry.get("attributes"),
                span=None,
                projected=projected,
                node_source_paths=node_source_paths,
            )


def project_value_tree(
    path: str,
    raw_value: object,
    *,
    identity: str | None,
    datatype: str | None,
    mapped_attributes: object,
    parser_attributes: object,
    span: object,
    projected: list[PortableEvent],
    node_source_paths: set[str],
) -> None:
    value = unwrap_typed_value(raw_value)
    projected.append(
        make_event(
            path,
            value,
            identity=identity,
            datatype=datatype,
            span=span,
            node_source_paths=node_source_paths,
        )
    )
    project_mapped_attributes(mapped_attributes, path, projected, node_source_paths)
    project_parser_attributes(parser_attributes, path, projected, node_source_paths)
    project_value_children(path, value, projected, node_source_paths)


def project_value_children(
    path: str,
    value: object,
    projected: list[PortableEvent],
    node_source_paths: set[str],
) -> None:
    if not isinstance(value, dict):
        return
    kind = value_type(value)
    if kind == "ObjectNode":
        bindings = value.get("bindings")
        if isinstance(bindings, list):
            for binding in bindings:
                if isinstance(binding, dict):
                    project_binding_tree(path, binding, projected, node_source_paths)
        return
    if kind in {"ListNode", "TupleLiteral"}:
        elements = value.get("elements")
        if isinstance(elements, list):
            for index, element in enumerate(elements):
                project_anonymous_tree(
                    f"{path}[{index}]",
                    element,
                    projected,
                    node_source_paths,
                )
        return
    if kind == "NodeLiteral":
        head_path = f"{path}[0]"
        projected.append(
            compact_event(
                path=head_path,
                kind="node-head",
                identity=optional_string(value.get("structuralId")),
                datatype=format_datatype(value.get("datatype")),
                value=optional_string(value.get("tag")),
            )
        )
        project_parser_attributes(
            value.get("attributes"),
            head_path,
            projected,
            node_source_paths,
        )
        children = value.get("children")
        if isinstance(children, list):
            for index, child in enumerate(children):
                project_anonymous_tree(
                    f"{head_path}[{index}]",
                    child,
                    projected,
                    node_source_paths,
                )


def project_binding_tree(
    owner_path: str,
    binding: dict[str, object],
    projected: list[PortableEvent],
    node_source_paths: set[str],
) -> None:
    key = binding.get("key")
    if not isinstance(key, str):
        return
    project_value_tree(
        append_member(owner_path, key),
        binding.get("value"),
        identity=optional_string(binding.get("structuralId")),
        datatype=format_datatype(binding.get("datatype")),
        mapped_attributes=None,
        parser_attributes=binding.get("attributes"),
        span=binding.get("span"),
        projected=projected,
        node_source_paths=node_source_paths,
    )


def project_anonymous_tree(
    path: str,
    raw_value: object,
    projected: list[PortableEvent],
    node_source_paths: set[str],
) -> None:
    if isinstance(raw_value, dict) and value_type(raw_value) == "TypedValue":
        project_value_tree(
            path,
            raw_value.get("value"),
            identity=optional_string(raw_value.get("structuralId")),
            datatype=format_datatype(raw_value.get("datatype")),
            mapped_attributes=None,
            parser_attributes=raw_value.get("attributes"),
            span=raw_value.get("span"),
            projected=projected,
            node_source_paths=node_source_paths,
        )
        return
    span = raw_value.get("span") if isinstance(raw_value, dict) else None
    project_value_tree(
        path,
        raw_value,
        identity=None,
        datatype=None,
        mapped_attributes=None,
        parser_attributes=None,
        span=span,
        projected=projected,
        node_source_paths=node_source_paths,
    )


def project_value(value: object, node_source_paths: set[str]) -> tuple[str, str | None]:
    value = unwrap_typed_value(value)
    if not isinstance(value, dict):
        return "null", None
    kind = value_type(value)
    scalar_kinds = {
        "StringLiteral": "string",
        "InfinityLiteral": "infinity",
        "NaNLiteral": "nan",
        "NullLiteral": "null",
        "ToggleLiteral": "toggle",
        "HexLiteral": "hex",
        "RadixLiteral": "radix",
        "EncodingLiteral": "encoding",
        "SeparatorLiteral": "separator",
        "DateLiteral": "date",
        "TimeLiteral": "time",
        "DateTimeLiteral": "datetime",
        "WTCDateTimeLiteral": "datetime",
    }
    if kind == "NumberLiteral":
        raw = value.get("raw")
        source = raw if isinstance(raw, str) else stringify_value(value.get("value")) or ""
        return "number", normalize_number_literal(source)
    if kind in scalar_kinds:
        return scalar_kinds[kind], stringify_value(value.get("value"))
    if kind == "BooleanLiteral":
        raw = value.get("value")
        return "boolean", "true" if raw is True else "false"
    if kind == "SansaAddressLiteral":
        return "sansa-address", optional_string(value.get("canonical"))
    if kind == "ObjectNode":
        return "object", None
    if kind == "ListNode":
        return "list", None
    if kind == "TupleLiteral":
        return "tuple", None
    if kind == "NodeLiteral":
        return "node", None
    if kind == "CloneReference":
        return "clone-reference", translate_reference_target(value.get("path"), node_source_paths)
    if kind == "PointerReference":
        return "pointer-reference", translate_reference_target(value.get("path"), node_source_paths)
    return kind or "null", stringify_value(value.get("value"))


def unwrap_typed_value(value: object) -> object:
    while isinstance(value, dict) and value_type(value) == "TypedValue":
        value = value.get("value")
    return value


def value_type(value: object) -> str:
    if not isinstance(value, dict):
        return ""
    raw = value.get("type")
    return raw if isinstance(raw, str) else ""


def format_datatype(datatype: object) -> str | None:
    if isinstance(datatype, str):
        return datatype
    if not isinstance(datatype, dict):
        return None
    name = datatype.get("name")
    if not isinstance(name, str):
        return None
    generic_args = datatype.get("genericArgs")
    if isinstance(generic_args, list) and generic_args:
        name += "<" + ", ".join(str(argument) for argument in generic_args) + ">"
    clarifiers = datatype.get("clarifiers")
    if isinstance(clarifiers, list) and clarifiers:
        name += "[" + ", ".join(format_clarifier(value) for value in clarifiers) + "]"
    return name


def format_clarifier(value: object) -> str:
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    return str(value)


def normalize_number_literal(raw: str) -> str:
    value = raw.replace("_", "").replace("E", "e")
    if value.startswith("."):
        value = f"0{value}"
    elif value.startswith("-."):
        value = value.replace("-.", "-0.", 1)
    elif value.startswith("+."):
        value = value.replace("+.", "0.", 1)
    elif value.startswith("+") and len(value) > 1 and value[1].isdigit():
        value = value[1:]

    if "e" in value:
        mantissa, exponent = value.split("e", 1)
    else:
        mantissa, exponent = value, None
    if "." in mantissa:
        integer, fraction = mantissa.split(".", 1)
        fraction = fraction.rstrip("0") or "0"
        mantissa = integer if exponent is not None and fraction == "0" else f"{integer}.{fraction}"
    return f"{mantissa}e{exponent}" if exponent is not None else mantissa


def translate_node_path(path: str, node_source_paths: set[str]) -> str:
    source_segments: list[str | int] = []
    target_segments: list[str | int] = []
    for segment in parse_canonical_path(path):
        if isinstance(segment, int) and format_segments(source_segments) in node_source_paths:
            target_segments.append(0)
        source_segments.append(segment)
        target_segments.append(segment)
    return format_segments(target_segments)


def translate_reference_target(path: object, node_source_paths: set[str]) -> str:
    if not isinstance(path, list):
        return "$"
    source_segments: list[str | int] = []
    trackable = True
    output = "$"
    for segment in path:
        if isinstance(segment, bool):
            continue
        if isinstance(segment, int):
            if trackable and format_segments(source_segments) in node_source_paths:
                output += "[0]"
            output += f"[{segment}]"
            if trackable:
                source_segments.append(segment)
            continue
        if isinstance(segment, str):
            output += format_member(segment)
            if trackable:
                source_segments.append(segment)
            continue
        if isinstance(segment, dict) and segment.get("type") == "attr":
            key = segment.get("key")
            if isinstance(key, str):
                output += f".@{format_member(key)}"
                trackable = False
    return output


def parse_canonical_path(path: str) -> list[str | int]:
    if not path.startswith("$"):
        raise ValueError(f"Invalid canonical path: {path}")
    segments: list[str | int] = []
    index = 1
    decoder = json.JSONDecoder()
    while index < len(path):
        if path.startswith('.["', index):
            key, consumed = decoder.raw_decode(path[index + 2 :])
            if not isinstance(key, str) or index + 2 + consumed >= len(path) or path[index + 2 + consumed] != "]":
                raise ValueError(f"Invalid canonical path: {path}")
            segments.append(key)
            index += consumed + 3
            continue
        if path[index] == ".":
            end = index + 1
            while end < len(path) and path[end] not in ".[":
                end += 1
            if end == index + 1:
                raise ValueError(f"Invalid canonical path: {path}")
            segments.append(path[index + 1 : end])
            index = end
            continue
        if path[index] == "[":
            end = path.find("]", index)
            if end == -1:
                raise ValueError(f"Invalid canonical path: {path}")
            segments.append(int(path[index + 1 : end], 10))
            index = end + 1
            continue
        raise ValueError(f"Invalid canonical path: {path}")
    return segments


def format_segments(segments: Iterable[str | int]) -> str:
    output = "$"
    for segment in segments:
        output += f"[{segment}]" if isinstance(segment, int) else format_member(segment)
    return output


def append_member(owner_path: str, key: str) -> str:
    return f"{owner_path}{format_member(key)}"


def append_attribute(owner_path: str, key: str) -> str:
    return f"{owner_path}.@{format_member(key)}"


def format_member(key: str) -> str:
    if is_ascii_identifier(key):
        return f".{key}"
    return f".[{json.dumps(key, ensure_ascii=False)}]"


def is_ascii_identifier(value: str) -> bool:
    if not value or not (value[0].isascii() and (value[0].isalpha() or value[0] == "_")):
        return False
    return all(character.isascii() and (character.isalnum() or character == "_") for character in value[1:])


def optional_string(value: object) -> str | None:
    return value if isinstance(value, str) else None


def stringify_value(value: object) -> str | None:
    if value is None:
        return None
    return str(value)
