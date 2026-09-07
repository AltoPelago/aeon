from __future__ import annotations

import hashlib
import json
from typing import Iterable

from .telex import AEON_DOCUMENT_PROJECTION, encode_telex, parse_datatype_descriptor


PortableEvent = dict[str, object]

PYTHON_ASSIGNMENT_EVENTS_CONTRACT_V0 = "aeon.python.assignment-events.v0"
PYTHON_PORTABLE_AES_ADAPTER_V0 = "aeon.python.assignment-events.v0-to-aes.events.v0"
PYTHON_PORTABLE_AES_ADAPTER_VERSION_V0 = "0.1.0-candidate"


class PortableAesSourceError(ValueError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def adapt_python_assignment_events_to_portable_aes(
    events: Iterable[dict[str, object]],
    *,
    header: dict[str, object] | None = None,
    include_headers: bool = False,
    source_bytes: bytes | bytearray | memoryview | None = None,
) -> dict[str, object]:
    """Run the named Python legacy adapter and return events plus its report."""

    source_events = list(events)
    has_legacy_header_source = any(is_legacy_header_event(event) for event in source_events)
    body = [event for event in source_events if not is_legacy_header_event(event)]
    headers = [event for event in source_events if is_legacy_header_event(event)] if include_headers else []
    projected_body = project_portable_events(body)
    projected_headers = project_portable_events(headers)
    if include_headers and not projected_headers and header is not None:
        projected_headers = project_header_records(header)
    normalized_headers: list[PortableEvent] = []
    for event in projected_headers:
        portable = dict(event)
        if "header" not in portable:
            address = portable.pop("path")
            portable = {"header": address, **portable}
        normalized_headers.append(portable)
    source_context = create_source_context(source_bytes) if source_bytes is not None else None
    projected = [
        apply_source_provenance(event, source_context)
        for event in [*normalized_headers, *projected_body]
    ]
    changes = compatibility_changes(
        source_events,
        body,
        projected,
        include_headers,
        source_backed=source_context is not None,
    )
    if header is not None and not headers and not include_headers:
        changes.append(conversion_change(
            "omitted",
            "AES_COMPAT_HEADER_EXCLUDED",
            "header",
            "The separate AEON header is excluded by the default body-only projection.",
        ))
    has_header_source = has_legacy_header_source or header is not None
    no_source_records = len(source_events) == 0 and not has_header_source
    all_source_records_included = include_headers or not has_header_source
    provenance_lossless = no_source_records or (
        source_context is not None
        and all_source_records_included
        and bool(projected)
        and all("origin" in event and "span" in event for event in projected)
    )
    return {
        "events": projected,
        "report": {
            "sourceContract": PYTHON_ASSIGNMENT_EVENTS_CONTRACT_V0,
            "targetContract": "aes.events.v0",
            "adapter": PYTHON_PORTABLE_AES_ADAPTER_V0,
            "adapterVersion": PYTHON_PORTABLE_AES_ADAPTER_VERSION_V0,
            "profile": "aes.complete.v0",
            "projection": AEON_DOCUMENT_PROJECTION if include_headers else None,
            "semanticLossless": True,
            "recordLossless": len(source_events) == 0 and not has_header_source,
            "provenanceLossless": provenance_lossless,
            "semanticLossAuthorized": False,
            "changes": changes,
        },
    }


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
                    kind="NodeHead",
                    identity=optional_string(value.get("structuralId")),
                    datatype=format_datatype(value.get("datatype")),
                    value=optional_string(value.get("tag")),
                    span=value.get("headSpan"),
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
        event.update(parse_datatype_descriptor(datatype))
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
            span=raw_entry.get("span"),
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
                span=raw_entry.get("span"),
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
                kind="NodeHead",
                identity=optional_string(value.get("structuralId")),
                datatype=format_datatype(value.get("datatype")),
                value=optional_string(value.get("tag")),
                span=value.get("headSpan"),
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
        return "NullLiteral", None
    kind = value_type(value)
    scalar_kinds = {
        "StringLiteral": "StringLiteral",
        "InfinityLiteral": "InfinityLiteral",
        "NaNLiteral": "NaNLiteral",
        "NullLiteral": "NullLiteral",
        "ToggleLiteral": "ToggleLiteral",
        "HexLiteral": "HexLiteral",
        "RadixLiteral": "RadixLiteral",
        "EncodingLiteral": "EncodingLiteral",
        "SeparatorLiteral": "SeparatorLiteral",
        "DateLiteral": "DateLiteral",
        "TimeLiteral": "TimeLiteral",
        "WTCDateTimeLiteral": "WTCDateTimeLiteral",
    }
    if kind == "NumberLiteral":
        raw = value.get("raw")
        source = raw if isinstance(raw, str) else stringify_value(value.get("value")) or ""
        return "NumberLiteral", normalize_number_literal(source)
    if kind == "DateTimeLiteral":
        payload = stringify_value(value.get("value"))
        return ("WTCDateTimeLiteral" if payload is not None and "&" in payload else "DateTimeLiteral"), payload
    if kind in scalar_kinds:
        return scalar_kinds[kind], stringify_value(value.get("value"))
    if kind == "BooleanLiteral":
        raw = value.get("value")
        return "BooleanLiteral", "true" if raw is True else "false"
    if kind == "SansaAddressLiteral":
        return "SansaAddressLiteral", optional_string(value.get("canonical"))
    if kind == "ObjectNode":
        return "ObjectNode", None
    if kind == "ListNode":
        return "ListNode", None
    if kind == "TupleLiteral":
        return "TupleLiteral", None
    if kind == "NodeLiteral":
        return "NodeLiteral", None
    if kind == "CloneReference":
        return "CloneReference", translate_reference_target(value.get("path"), node_source_paths)
    if kind == "PointerReference":
        return "PointerReference", translate_reference_target(value.get("path"), node_source_paths)
    return kind or "NullLiteral", stringify_value(value.get("value"))


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


def is_legacy_header_event(event: dict[str, object]) -> bool:
    path = event.get("path")
    if not isinstance(path, str):
        return False
    try:
        segments = parse_canonical_path(path)
    except (TypeError, ValueError):
        return False
    return bool(segments) and isinstance(segments[0], str) and segments[0].startswith("aeon:")


def create_source_context(source_bytes: bytes | bytearray | memoryview) -> tuple[str, list[int]]:
    try:
        artifact = bytes(source_bytes)
    except (TypeError, ValueError) as error:
        raise PortableAesSourceError(
            "AES_COMPAT_SOURCE_REQUIRED",
            "Portable source provenance requires exact UTF-8 bytes.",
        ) from error
    try:
        source = artifact.decode("utf-8", errors="strict")
    except UnicodeDecodeError as error:
        raise PortableAesSourceError(
            "AES_SOURCE_INVALID_UTF8",
            "Portable source provenance requires a valid UTF-8 artifact.",
        ) from error

    byte_offsets = [0]
    for character in source:
        byte_offsets.append(byte_offsets[-1] + len(character.encode("utf-8")))
    origin = f"sha256:{hashlib.sha256(artifact).hexdigest()}"
    return origin, byte_offsets


def apply_source_provenance(
    event: PortableEvent,
    source_context: tuple[str, list[int]] | None,
) -> PortableEvent:
    local_span = event.get("span")
    portable = {key: value for key, value in event.items() if key != "span"}
    if source_context is None:
        return portable

    origin, byte_offsets = source_context
    portable["origin"] = origin
    if local_span is None:
        return portable
    if not isinstance(local_span, dict):
        raise invalid_source_range(local_span)
    start_position = local_span.get("start")
    end_position = local_span.get("end")
    if not isinstance(start_position, dict) or not isinstance(end_position, dict):
        raise invalid_source_range(local_span)
    start_offset = start_position.get("offset")
    end_offset = end_position.get("offset")
    if (
        isinstance(start_offset, bool)
        or isinstance(end_offset, bool)
        or not isinstance(start_offset, int)
        or not isinstance(end_offset, int)
        or start_offset < 0
        or end_offset >= len(byte_offsets)
        or start_offset >= end_offset
    ):
        raise invalid_source_range(local_span)
    portable["span"] = f"{byte_offsets[start_offset]}:{byte_offsets[end_offset]}"
    return portable


def invalid_source_range(span: object) -> PortableAesSourceError:
    return PortableAesSourceError(
        "AES_COMPAT_SOURCE_RANGE_INVALID",
        f"Native source span {span!r} is outside the exact UTF-8 artifact or is not a positive code-point range.",
    )


def conversion_change(
    kind: str,
    code: str,
    field: str,
    message: str,
    *,
    source_path: str | None = None,
    target_path: str | None = None,
) -> dict[str, object]:
    change: dict[str, object] = {
        "kind": kind,
        "code": code,
        "field": field,
        "message": message,
        "requiresAuthorization": kind == "semantic-loss",
    }
    if source_path is not None:
        change["sourcePath"] = source_path
    if target_path is not None:
        change["targetPath"] = target_path
    return change


def compatibility_changes(
    source_events: list[dict[str, object]],
    body_events: list[dict[str, object]],
    projected: list[PortableEvent],
    include_headers: bool,
    *,
    source_backed: bool,
) -> list[dict[str, object]]:
    changes: list[dict[str, object]] = []
    node_source_paths = {
        str(event.get("path"))
        for event in body_events
        if value_type(unwrap_typed_value(event.get("value"))) == "NodeLiteral"
    }
    path_map = {
        str(event.get("path", "$")): translate_node_path(str(event.get("path", "$")), node_source_paths)
        for event in body_events
    }
    for event in source_events:
        source_path = str(event.get("path", "$"))
        header = is_legacy_header_event(event)
        target_path = source_path if header and include_headers else path_map.get(source_path)
        if not source_backed:
            changes.append(conversion_change(
                "omitted",
                "AES_COMPAT_PROVENANCE_OMITTED",
                "span",
                "The local source span is omitted because it is not bound to an immutable portable origin.",
                source_path=source_path,
                target_path=target_path,
            ))
        changes.append(conversion_change(
            "transformed",
            "AES_COMPAT_SOURCE_REPRESENTATION_REDUCED",
            "normalizedPath,value",
            "Implementation-specific navigation fields and AST representation are reduced to portable AES fields.",
            source_path=source_path,
            target_path=target_path,
        ))
        if header and not include_headers:
            changes.append(conversion_change(
                "omitted",
                "AES_COMPAT_HEADER_EXCLUDED",
                "event",
                "The synthetic AEON header event is excluded by the default body-only projection.",
                source_path=source_path,
            ))
            continue
        if header:
            changes.append(conversion_change(
                "transformed",
                "AES_COMPAT_HEADER_PROJECTED",
                "path",
                "The recognized synthetic AEON header event is moved to the header address plane.",
                source_path=source_path,
                target_path=source_path,
            ))
        elif target_path is not None and target_path != source_path:
            changes.append(conversion_change(
                "transformed",
                "AES_COMPAT_PATH_TRANSLATED",
                "path",
                "The source occurrence path is translated through the explicit portable node-head level.",
                source_path=source_path,
                target_path=target_path,
            ))
        value = unwrap_typed_value(event.get("value"))
        if isinstance(value, dict) and value_type(value) in {"CloneReference", "PointerReference"}:
            source_target = translate_reference_target(value.get("path"), set())
            portable_target = translate_reference_target(value.get("path"), node_source_paths)
            if source_target != portable_target:
                changes.append(conversion_change(
                    "transformed",
                    "AES_COMPAT_REFERENCE_TRANSLATED",
                    "value.path",
                    f"The reference target is translated from {source_target} to {portable_target}.",
                    source_path=source_path,
                    target_path=target_path,
                ))

    for event in projected:
        target_path = optional_string(event.get("path")) or optional_string(event.get("header"))
        if source_backed:
            changes.append(conversion_change(
                "transformed" if "span" in event else "omitted",
                "AES_COMPAT_CODEPOINT_SPAN_CONVERTED" if "span" in event else "AES_COMPAT_PROVENANCE_RANGE_OMITTED",
                "span",
                (
                    "The native code-point source range is converted to an exact UTF-8 byte range."
                    if "span" in event
                    else "The exact source is identified, but this occurrence has no independently retained source range."
                ),
                target_path=target_path,
            ))
        if "header" in event:
            changes.append(conversion_change(
                "transformed",
                "AES_COMPAT_HEADER_PROJECTED",
                "header",
                "The recognized AEON header field is emitted in the header address plane.",
                target_path=target_path,
            ))
        if event.get("kind") == "NodeHead":
            changes.append(conversion_change(
                "synthesized",
                "AES_COMPAT_NODE_HEAD_SYNTHESIZED",
                "NodeHead",
                "The implicit implementation node tag is emitted as an explicit portable NodeHead event.",
                target_path=target_path,
            ))
        if target_path is not None and ".@" in target_path:
            changes.append(conversion_change(
                "transformed",
                "AES_COMPAT_ATTRIBUTE_FLATTENED",
                "attributes",
                "The nested implementation attribute entry is emitted as an ordinary flat AES event.",
                target_path=target_path,
            ))
        if "datatype" in event:
            changes.append(conversion_change(
                "transformed",
                "AES_COMPAT_DATATYPE_EXPANDED",
                "datatype",
                "The combined datatype descriptor is expanded into datatype, generics, and clarifiers.",
                target_path=target_path,
            ))
    return changes


def project_telex_records(
    events: Iterable[dict[str, object]],
    *,
    header: dict[str, object] | None = None,
    include_headers: bool = False,
    source_bytes: bytes | bytearray | memoryview | None = None,
) -> list[PortableEvent]:
    """Create portable AES records suitable for Telex encoding."""

    converted = adapt_python_assignment_events_to_portable_aes(
        events,
        header=header,
        include_headers=include_headers,
        source_bytes=source_bytes,
    )
    projected = converted["events"]
    assert isinstance(projected, list)
    return projected


def project_header_records(header: dict[str, object]) -> list[PortableEvent]:
    """Project the separate Python header result while retaining local ranges."""

    projected_header: list[PortableEvent] = []
    bindings = header.get("bindings")
    if isinstance(bindings, list):
        for raw_binding in bindings:
            if not isinstance(raw_binding, dict) or not isinstance(raw_binding.get("key"), str):
                continue
            key = str(raw_binding["key"])
            temporary: list[PortableEvent] = []
            project_value_tree(
                f'$.[' + json.dumps(f"aeon:{key}", ensure_ascii=False) + "]",
                raw_binding.get("value"),
                identity=optional_string(raw_binding.get("structuralId")),
                datatype=format_datatype(raw_binding.get("datatype")),
                mapped_attributes=None,
                parser_attributes=raw_binding.get("attributes"),
                span=raw_binding.get("span"),
                projected=temporary,
                node_source_paths=set(),
            )
            for record in temporary:
                address = record.pop("path")
                record["header"] = address
                projected_header.append(_ordered_portable_record(record, "header"))
    return projected_header


def export_telex(
    events: Iterable[dict[str, object]],
    *,
    header: dict[str, object] | None = None,
    include_headers: bool = False,
    profile: str | None = None,
    limits: object = None,
    source_bytes: bytes | bytearray | memoryview | None = None,
) -> str:
    records = project_telex_records(
        events,
        header=header,
        include_headers=include_headers,
        source_bytes=source_bytes,
    )
    return encode_telex(
        records,
        profile=profile,
        projection=AEON_DOCUMENT_PROJECTION if include_headers else None,
        limits=limits,
    )


def _ordered_portable_record(record: PortableEvent, address_field: str) -> PortableEvent:
    order = (address_field, "kind", "datatype", "generics", "clarifiers", "identity", "value", "origin", "span")
    return {key: record[key] for key in order if key in record}
