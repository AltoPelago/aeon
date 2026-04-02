from __future__ import annotations

from dataclasses import fields, is_dataclass
import re

from ._compat import dataclass
from .ast import (
    Attribute,
    AttributePathSegment,
    Binding,
    CloneReference,
    DateTimeLiteral,
    Document,
    EncodingLiteral,
    HexLiteral,
    ListNode,
    NodeLiteral,
    ObjectNode,
    PointerReference,
    RadixLiteral,
    SeparatorLiteral,
    StringLiteral,
    TupleLiteral,
    TypeAnnotation,
    Value,
)
from .errors import (
    AeonError,
    AttributeDepthExceededError,
    CustomDatatypeNotAllowedError,
    DatatypeLiteralMismatchError,
    DuplicateCanonicalPathError,
    ForwardReferenceError,
    InvalidCustomDatatypeBracketShapeError,
    InvalidNodeHeadDatatypeError,
    MissingReferenceTargetError,
    SelfReferenceError,
    SyntaxError,
    InputSizeExceededError,
    UntypedSwitchLiteralError,
    UntypedValueInStrictModeError,
)
from .lexer import tokenize
from .parser import parse_tokens
from .spans import Position, Span


@dataclass(slots=True)
class CompileOptions:
    recovery: bool = False
    max_attribute_depth: int = 1
    max_separator_depth: int = 1
    max_generic_depth: int = 1
    datatype_policy: str | None = None
    max_input_bytes: int | None = None


@dataclass(slots=True)
class CompileResult:
    events: list[dict[str, object]]
    errors: list[AeonError]
    internal_events: list[dict[str, object]] | None = None


@dataclass(slots=True, frozen=True)
class CanonicalSegment:
    type: str
    key: str | None = None
    index: int | None = None


@dataclass(slots=True, frozen=True)
class CanonicalPath:
    segments: tuple[CanonicalSegment, ...]


@dataclass(slots=True)
class ResolvedBinding:
    path: CanonicalPath
    key: str
    value: Value
    span: Span
    datatype: str | None
    annotations: dict[str, dict[str, object]] | None


RESERVED_KIND_MAP = {
    "string": ("StringLiteral",),
    "boolean": ("BooleanLiteral",),
    "bool": ("BooleanLiteral",),
    "switch": ("SwitchLiteral",),
    "infinity": ("InfinityLiteral",),
    "hex": ("HexLiteral",),
    "date": ("DateLiteral",),
    "time": ("TimeLiteral",),
    "datetime": ("DateTimeLiteral",),
    "zrut": ("ZRUTDateTimeLiteral",),
    "tuple": ("TupleLiteral",),
    "list": ("ListNode",),
    "object": ("ObjectNode",),
    "obj": ("ObjectNode",),
    "envelope": ("ObjectNode",),
    "o": ("ObjectNode",),
    "node": ("NodeLiteral",),
    "trimtick": ("TrimtickStringLiteral",),
    "encoding": ("EncodingLiteral",),
    "base64": ("EncodingLiteral",),
    "embed": ("EncodingLiteral",),
    "inline": ("EncodingLiteral",),
    "radix": ("RadixLiteral",),
    "radix2": ("RadixLiteral",),
    "radix6": ("RadixLiteral",),
    "radix8": ("RadixLiteral",),
    "radix12": ("RadixLiteral",),
    "sep": ("SeparatorLiteral",),
    "set": ("SeparatorLiteral",),
}

NUMERIC_TYPES = {
    "number",
    "n",
    "int",
    "int8",
    "int16",
    "int32",
    "int64",
    "uint",
    "uint8",
    "uint16",
    "uint32",
    "uint64",
    "float",
    "float32",
    "float64",
}


def compile_source(source: str, options: CompileOptions | None = None) -> CompileResult:
    opts = options or CompileOptions()
    if opts.max_input_bytes is not None:
        actual_bytes = len(source.encode("utf-8"))
        if actual_bytes > opts.max_input_bytes:
            zero = Position(line=1, column=1, offset=0)
            error = InputSizeExceededError(actual_bytes, opts.max_input_bytes, Span(start=zero, end=zero))
            return CompileResult(events=[], errors=[error])
    source = strip_leading_bom(source)
    lex_result = tokenize(source)
    if lex_result.errors and not opts.recovery:
        return CompileResult(events=[], errors=lex_result.errors)

    parse_result = parse_tokens(
        source,
        lex_result.tokens,
        max_separator_depth=opts.max_separator_depth,
        max_generic_depth=opts.max_generic_depth,
    )
    parse_errors = [error for error in parse_result.errors if isinstance(error, AeonError)]
    if parse_errors and not opts.recovery:
        return CompileResult(events=[], errors=[*lex_result.errors, *parse_errors])
    if parse_result.document is None:
        return CompileResult(events=[], errors=[*lex_result.errors, *parse_errors])

    resolved_bindings, path_errors = resolve_paths(parse_result.document)
    if path_errors and not opts.recovery:
        return CompileResult(events=[], errors=[*lex_result.errors, *parse_errors, *path_errors])

    mode_errors = enforce_mode(parse_result.document, resolved_bindings, opts.datatype_policy)
    if mode_errors and not opts.recovery:
        return CompileResult(events=[], errors=[*lex_result.errors, *parse_errors, *path_errors, *mode_errors])

    reference_errors = validate_references(resolved_bindings, opts.max_attribute_depth)
    all_errors = [*lex_result.errors, *parse_errors, *path_errors, *mode_errors, *reference_errors]
    if reference_errors and not opts.recovery:
        return CompileResult(events=[], errors=all_errors)

    internal_events = [resolved_binding_to_event(binding, include_annotations=True) for binding in resolved_bindings]
    events = [
        strip_event_annotations(event)
        for event in internal_events
        if not str(event["key"]).startswith("aeon:")
    ]
    return CompileResult(events=events, errors=all_errors, internal_events=internal_events)


def strip_leading_bom(source: str) -> str:
    return source[1:] if source.startswith("\ufeff") else source


def resolve_paths(document: Document) -> tuple[list[ResolvedBinding], list[AeonError]]:
    bindings: list[ResolvedBinding] = []
    errors: list[AeonError] = []
    seen: set[str] = set()
    root = CanonicalPath(segments=(CanonicalSegment(type="root"),))

    if document.header is not None:
        for binding in document.header.bindings:
            synthetic = Binding(
                key=f"aeon:{binding.key}",
                value=binding.value,
                datatype=binding.datatype,
                attributes=binding.attributes,
                span=binding.span,
            )
            resolve_binding(synthetic, root, bindings, errors, seen)

    for binding in document.bindings:
        resolve_binding(binding, root, bindings, errors, seen)
    return bindings, errors


def resolve_binding(
    binding: Binding,
    parent: CanonicalPath,
    bindings: list[ResolvedBinding],
    errors: list[AeonError],
    seen: set[str],
) -> None:
    path = extend_member(parent, binding.key)
    path_str = format_path(path)
    if path_str in seen:
        errors.append(DuplicateCanonicalPathError(path_str, binding.span))
        return
    seen.add(path_str)
    bindings.append(
        ResolvedBinding(
            path=path,
            key=binding.key,
            value=binding.value,
            span=binding.span,
            datatype=format_datatype(binding.datatype),
            annotations=build_annotations(binding.attributes),
        )
    )
    resolve_value(binding.value, path, bindings, errors, seen)


def resolve_value(value: Value, parent: CanonicalPath, bindings: list[ResolvedBinding], errors: list[AeonError], seen: set[str]) -> None:
    if isinstance(value, ObjectNode):
        for binding in value.bindings:
            resolve_binding(binding, parent, bindings, errors, seen)
        return
    if isinstance(value, (ListNode, TupleLiteral)):
        elements = value.elements
        for index, element in enumerate(elements):
            element_path = extend_index(parent, index)
            path_str = format_path(element_path)
            if path_str in seen:
                errors.append(DuplicateCanonicalPathError(path_str, element.span))
                continue
            seen.add(path_str)
            bindings.append(
                ResolvedBinding(
                    path=element_path,
                    key=str(index),
                    value=element,
                    span=element.span,
                    datatype=None,
                    annotations=None,
                )
            )
            resolve_value(element, element_path, bindings, errors, seen)


def build_annotations(attributes: list[Attribute]) -> dict[str, dict[str, object]] | None:
    if not attributes:
        return None
    result: dict[str, dict[str, object]] = {}
    for attribute in attributes:
        for key, entry in attribute.entries.items():
            mapped = {
                "value": entry.value,
                "datatype": format_datatype(entry.datatype),
            }
            nested = build_annotations(entry.attributes)
            if nested is not None:
                mapped["annotations"] = nested
            result[key] = mapped
    return result


def resolved_binding_to_event(binding: ResolvedBinding, include_annotations: bool = False) -> dict[str, object]:
    event = {
        "path": format_path(binding.path),
        "key": binding.key,
        "datatype": binding.datatype,
        "span": binding.span.to_json(),
        "value": value_to_json(binding.value),
    }
    if include_annotations and binding.annotations is not None:
        event["annotations"] = annotations_to_json(binding.annotations)
    return event


def strip_event_annotations(event: dict[str, object]) -> dict[str, object]:
    if "annotations" not in event:
        return event
    return {key: value for key, value in event.items() if key != "annotations"}


def annotations_to_json(annotations: dict[str, dict[str, object]]) -> dict[str, dict[str, object]]:
    return {
        key: {
            "value": value_to_json(entry["value"]),
            "datatype": entry["datatype"],
        }
        for key, entry in annotations.items()
    }


def value_to_json(value: Value) -> dict[str, object]:
    if is_dataclass(value):
        payload: dict[str, object] = {"type": getattr(value, "type")}
        for field in fields(value):
            key = field.name
            if key == "type":
                continue
            raw = getattr(value, key)
            if raw is None and key not in {"span", "datatype"}:
                continue
            if key == "span":
                payload[key] = raw.to_json() if raw is not None else None
            elif key == "datatype":
                payload[key] = type_annotation_to_json(raw)
            elif key == "attributes":
                payload[key] = [attribute_to_json(item) for item in raw]
            elif key == "trimticks":
                payload[key] = raw
            elif key == "bindings":
                payload[key] = [binding_to_json(item) for item in raw]
            elif key in {"elements", "children"}:
                payload[key] = [value_to_json(item) for item in raw]
            elif key == "path":
                payload[key] = reference_path_to_json(raw)
            else:
                payload[key] = raw
        return payload
    raise TypeError("Unsupported value")


def binding_to_json(binding: Binding) -> dict[str, object]:
    return {
        "type": "Binding",
        "key": binding.key,
        "datatype": type_annotation_to_json(binding.datatype),
        "attributes": [attribute_to_json(item) for item in binding.attributes],
        "value": value_to_json(binding.value),
        "span": binding.span.to_json(),
    }


def attribute_to_json(attribute: Attribute) -> dict[str, object]:
    return {
        "type": "Attribute",
        "entries": {
            key: {
                "datatype": type_annotation_to_json(entry.datatype),
                "attributes": [attribute_to_json(item) for item in entry.attributes],
                "value": value_to_json(entry.value),
            }
            for key, entry in attribute.entries.items()
        },
        "span": attribute.span.to_json(),
    }


def enforce_mode(document: Document, bindings: list[ResolvedBinding], datatype_policy: str | None) -> list[AeonError]:
    mode = extract_mode(document)
    effective_policy = effective_datatype_policy(mode, datatype_policy)
    errors: list[AeonError] = []
    lookup = {format_path(binding.path): binding for binding in bindings}
    for binding in bindings:
        if should_skip_header_binding_for_mode(document, binding):
            continue
        last_segment = binding.path.segments[-1]
        if last_segment.type == "index":
            continue
        if binding.datatype is None:
            if mode in {"strict", "custom"}:
                if mode == "strict" and value_kind(binding.value) == "SwitchLiteral":
                    errors.append(UntypedSwitchLiteralError(format_path(binding.path), binding.span))
                else:
                    errors.append(UntypedValueInStrictModeError(format_path(binding.path), binding.span))
            continue
        expected = expected_kinds_for_reserved_datatype(binding.datatype)
        if mode in {"strict", "custom"} and expected is None and effective_policy == "reserved_only":
            errors.append(CustomDatatypeNotAllowedError(format_path(binding.path), binding.datatype, binding.span))
            continue
        actual_kind = datatype_check_kind(binding, lookup)
        if expected is None:
            custom_shape = classify_custom_datatype_shape(binding.datatype)
            if custom_shape == "invalid_both" and actual_kind in {"SeparatorLiteral", "RadixLiteral"}:
                errors.append(
                    InvalidCustomDatatypeBracketShapeError(
                        format_path(binding.path),
                        binding.datatype,
                        actual_kind,
                        binding.span,
                    )
                )
            else:
                custom_expected = expected_kinds_for_custom_datatype_shape(custom_shape, actual_kind)
                if custom_expected is not None:
                    expected = custom_expected
        if expected is not None and actual_kind not in expected:
            errors.append(
                DatatypeLiteralMismatchError(
                    format_path(binding.path),
                    binding.datatype,
                    actual_kind,
                    expected,
                    binding.span,
                )
            )
        errors.extend(
            validate_annotation_entries(
                binding.annotations,
                format_path(binding.path),
                binding.span,
                lookup,
                mode,
                effective_policy,
            )
        )
        errors.extend(validate_node_head_datatypes(binding.value, format_path(binding.path), binding.span, mode))
    return errors


def validate_node_head_datatypes(value: Value, owner_path: str, span: Span, mode: str) -> list[AeonError]:
    errors: list[AeonError] = []
    if isinstance(value, NodeLiteral):
        head_datatype = format_datatype(value.datatype)
        if mode == "strict" and head_datatype is not None and value.datatype is not None and value.datatype.name != "node":
            errors.append(InvalidNodeHeadDatatypeError(owner_path, head_datatype, span))
        for index, child in enumerate(value.children):
            errors.extend(validate_node_head_datatypes(child, f"{owner_path}[{index}]", span, mode))
        return errors
    if isinstance(value, ObjectNode):
        for binding in value.bindings:
            errors.extend(validate_node_head_datatypes(binding.value, f"{owner_path}.{binding.key}", span, mode))
        return errors
    if isinstance(value, (ListNode, TupleLiteral)):
        for index, element in enumerate(value.elements):
            errors.extend(validate_node_head_datatypes(element, f"{owner_path}[{index}]", span, mode))
    return errors


def should_skip_header_binding_for_mode(document: Document, binding: ResolvedBinding) -> bool:
    if not binding.key.startswith("aeon:"):
        return False
    if document.header is None:
        return False
    if document.header.has_structured and not document.header.has_shorthand:
        return is_mode_selector_header_binding(binding)
    return True


def is_mode_selector_header_binding(binding: ResolvedBinding) -> bool:
    return (
        len(binding.path.segments) == 2
        and binding.path.segments[1].type == "member"
        and binding.path.segments[1].key == "aeon:mode"
    )


def validate_references(bindings: list[ResolvedBinding], max_attribute_depth: int) -> list[AeonError]:
    errors: list[AeonError] = []
    lookup = {format_path(binding.path): binding for binding in bindings}
    order = {format_path(binding.path): index for index, binding in enumerate(bindings)}
    for source_index, binding in enumerate(bindings):
        source_path = format_path(binding.path)
        for reference in iter_owned_references(binding.value):
            target_path = format_reference_target_path(reference.path)
            attr_depth = sum(1 for segment in reference.path if isinstance(segment, AttributePathSegment))
            if attr_depth > max_attribute_depth:
                errors.append(AttributeDepthExceededError(target_path, attr_depth, max_attribute_depth, reference.span))
                continue
            if target_path == source_path:
                errors.append(SelfReferenceError(source_path, reference.span))
                continue
            target_index = resolve_reference_target(reference.path, lookup, order)
            if target_index is None:
                errors.append(MissingReferenceTargetError(target_path, reference.span))
                continue
            if target_index > source_index:
                errors.append(ForwardReferenceError(source_path, target_path, reference.span))
        for reference in iter_annotation_references(binding.annotations):
            target_path = format_reference_target_path(reference.path)
            attr_depth = sum(1 for segment in reference.path if isinstance(segment, AttributePathSegment))
            if attr_depth > max_attribute_depth:
                errors.append(AttributeDepthExceededError(target_path, attr_depth, max_attribute_depth, reference.span))
                continue
            if target_path == source_path:
                errors.append(SelfReferenceError(source_path, reference.span))
                continue
            target_index = resolve_reference_target(reference.path, lookup, order)
            if target_index is None:
                errors.append(MissingReferenceTargetError(target_path, reference.span))
                continue
            if target_index > source_index:
                errors.append(ForwardReferenceError(source_path, target_path, reference.span))
    return errors


def datatype_check_kind(binding: ResolvedBinding, lookup: dict[str, ResolvedBinding], stack: tuple[str, ...] = ()) -> str:
    resolved = resolve_reference_value(binding.value, lookup)
    if resolved is None:
        return value_kind(binding.value)
    if isinstance(resolved, (CloneReference, PointerReference)):
        resolution = resolve_mode_reference_target(resolved.path, lookup)
        if resolution is None or resolution[0] in stack:
            return value_kind(resolved)
        return datatype_check_kind(resolution[1], lookup, (*stack, resolution[0]))
    return value_kind(resolved)


def validate_annotation_entries(
    annotations: dict[str, dict[str, object]] | None,
    owner_path: str,
    span: Span,
    lookup: dict[str, ResolvedBinding],
    mode: str,
    effective_policy: str,
) -> list[AeonError]:
    if annotations is None:
        return []
    errors: list[AeonError] = []
    for key, entry in annotations.items():
        attr_path = f"{owner_path}@{key}"
        datatype = entry.get("datatype")
        if isinstance(datatype, str):
            expected = expected_kinds_for_reserved_datatype(datatype)
            if mode in {"strict", "custom"} and expected is None and effective_policy == "reserved_only":
                errors.append(CustomDatatypeNotAllowedError(attr_path, datatype, span))
            else:
                value = entry.get("value")
                if value is not None and hasattr(value, "type"):
                    actual_kind = value_kind(resolve_reference_value(value, lookup) or value)
                    if expected is None:
                        custom_shape = classify_custom_datatype_shape(datatype)
                        if custom_shape == "invalid_both" and actual_kind in {"SeparatorLiteral", "RadixLiteral"}:
                            errors.append(InvalidCustomDatatypeBracketShapeError(attr_path, datatype, actual_kind, span))
                            expected = None
                        else:
                            custom_expected = expected_kinds_for_custom_datatype_shape(custom_shape, actual_kind)
                            if custom_expected is not None:
                                expected = custom_expected
                    if expected is not None and actual_kind not in expected:
                        errors.append(DatatypeLiteralMismatchError(attr_path, datatype, actual_kind, expected, span))
        value = entry.get("value")
        if isinstance(value, (ObjectNode, ListNode, TupleLiteral, NodeLiteral)):
            errors.extend(validate_node_head_datatypes(value, attr_path, span, mode))
        nested = entry.get("annotations")
        if isinstance(nested, dict):
            errors.extend(validate_annotation_entries(nested, attr_path, span, lookup, mode, effective_policy))
    return errors


def resolve_reference_value(
    value: Value,
    lookup: dict[str, ResolvedBinding],
) -> Value | None:
    if not isinstance(value, (CloneReference, PointerReference)):
        return value
    resolution = resolve_mode_reference_target(value.path, lookup)
    if resolution is None:
        return None
    _, target, remainder = resolution
    return resolve_reference_subpath(target.value, target.annotations, remainder, lookup)


def resolve_mode_reference_target(path: list[object], lookup: dict[str, ResolvedBinding]) -> tuple[str, ResolvedBinding, list[object]] | None:
    for split in range(len(path), 0, -1):
        prefix = path[:split]
        if any(isinstance(segment, AttributePathSegment) for segment in prefix):
            continue
        prefix_path = format_reference_target_path(prefix)
        binding = lookup.get(prefix_path)
        if binding is None:
            continue
        remainder = path[split:]
        if not remainder:
            return prefix_path, binding, remainder
        if resolve_reference_subpath(binding.value, binding.annotations, remainder, lookup) is not None:
            return prefix_path, binding, remainder
    return None


def resolve_reference_subpath(
    value: Value,
    annotations: dict[str, dict[str, object]] | None,
    remainder: list[object],
    lookup: dict[str, ResolvedBinding],
) -> Value | None:
    context_value = value
    context_annotations = select_annotations(annotations, context_value)
    for segment in remainder:
        if isinstance(segment, AttributePathSegment):
            if context_annotations is None or segment.key not in context_annotations:
                return None
            entry = context_annotations[segment.key]
            context_value = entry["value"]
            context_annotations = select_annotations(entry.get("annotations"), context_value)
            continue
        if isinstance(segment, str):
            if not isinstance(context_value, ObjectNode):
                return None
            child = next((binding for binding in context_value.bindings if binding.key == segment), None)
            if child is None:
                return None
            context_value = child.value
            context_annotations = select_annotations(build_annotations(child.attributes), context_value)
            continue
        if isinstance(segment, int):
            if not isinstance(context_value, (ListNode, TupleLiteral)):
                return None
            if segment < 0 or segment >= len(context_value.elements):
                return None
            context_value = context_value.elements[segment]
            context_annotations = select_annotations(None, context_value)
            continue
        return None
    return context_value


def select_annotations(
    preferred: dict[str, dict[str, object]] | None,
    value: Value,
) -> dict[str, dict[str, object]] | None:
    if preferred:
        return preferred
    return build_value_annotations(value)


def build_value_annotations(value: Value) -> dict[str, dict[str, object]] | None:
    if not isinstance(value, (ObjectNode, ListNode, TupleLiteral, NodeLiteral)):
        return None
    return build_annotations(value.attributes)


def iter_references(value: Value):
    if isinstance(value, (CloneReference, PointerReference)):
        yield value
        return
    if isinstance(value, ObjectNode):
        for binding in value.bindings:
            yield from iter_references(binding.value)
            for attribute in binding.attributes:
                yield from iter_attribute_references(attribute)
        return
    if isinstance(value, (ListNode, TupleLiteral)):
        for element in value.elements:
            yield from iter_references(element)
        return
    if isinstance(value, NodeLiteral):
        for attribute in value.attributes:
            yield from iter_attribute_references(attribute)
        for child in value.children:
            yield from iter_references(child)


def iter_owned_references(value: Value):
    if isinstance(value, (CloneReference, PointerReference)):
        yield value
        return
    if isinstance(value, ObjectNode):
        for attribute in value.attributes:
            yield from iter_attribute_references(attribute)
        return
    if isinstance(value, (ListNode, TupleLiteral)):
        for attribute in value.attributes:
            yield from iter_attribute_references(attribute)
        return
    if isinstance(value, NodeLiteral):
        for attribute in value.attributes:
            yield from iter_attribute_references(attribute)
        for child in value.children:
            yield from iter_references(child)


def iter_attribute_references(attribute: Attribute):
    for entry in attribute.entries.values():
        for nested in entry.attributes:
            yield from iter_attribute_references(nested)
        yield from iter_references(entry.value)


def iter_annotation_references(annotations: dict[str, dict[str, object]] | None):
    if annotations is None:
        return
    for entry in annotations.values():
        nested = entry.get("annotations")
        if isinstance(nested, dict):
            yield from iter_annotation_references(nested)
        value = entry.get("value")
        if isinstance(value, (CloneReference, PointerReference, ObjectNode, ListNode, TupleLiteral, NodeLiteral)):
            yield from iter_references(value)


def resolve_reference_target(
    path: list[object],
    lookup: dict[str, ResolvedBinding],
    order: dict[str, int],
) -> int | None:
    first_attr_index = next((index for index, segment in enumerate(path) if isinstance(segment, AttributePathSegment)), len(path))
    prefix_segments = path[:first_attr_index]
    prefix_path = format_path(reference_prefix_to_canonical(prefix_segments))
    binding = lookup.get(prefix_path)
    if binding is None:
        return None
    if first_attr_index == len(path):
        return order.get(prefix_path)
    context_value = binding.value
    context_annotations = binding.annotations
    for segment in path[first_attr_index:]:
        if isinstance(segment, AttributePathSegment):
            if context_annotations is None or segment.key not in context_annotations:
                return None
            entry = context_annotations[segment.key]
            context_value = entry["value"]
            nested_annotations = entry.get("annotations")
            context_annotations = nested_annotations if isinstance(nested_annotations, dict) else None
            continue
        if isinstance(segment, int):
            if not isinstance(context_value, (ListNode, TupleLiteral)):
                return None
            if segment < 0 or segment >= len(context_value.elements):
                return None
            context_value = context_value.elements[segment]
            context_annotations = None
            continue
        if isinstance(context_value, ObjectNode):
            nested = next((item for item in context_value.bindings if item.key == segment), None)
            if nested is None:
                return None
            context_value = nested.value
            context_annotations = build_annotations(nested.attributes)
            continue
        return None
    return order.get(prefix_path)


def reference_prefix_to_canonical(segments: list[object]) -> CanonicalPath:
    path = CanonicalPath(segments=(CanonicalSegment(type="root"),))
    for segment in segments:
        if isinstance(segment, int):
            path = extend_index(path, segment)
        else:
            path = extend_member(path, str(segment))
    return path


def extract_mode(document: Document) -> str:
    if document.header is None:
        return "transport"
    mode_value = document.header.fields.get("mode")
    if mode_value is not None and getattr(mode_value, "type", None) == "StringLiteral":
        lowered = getattr(mode_value, "value", "").lower()
        if lowered in {"transport", "strict", "custom"}:
            return lowered
    return "transport"


def effective_datatype_policy(mode: str, datatype_policy: str | None) -> str:
    if datatype_policy is not None:
        return datatype_policy
    return "reserved_only" if mode == "strict" else "allow_custom"


def expected_kinds_for_reserved_datatype(datatype: str) -> tuple[str, ...] | None:
    base = datatype_base(datatype)
    if base in NUMERIC_TYPES:
        return ("NumberLiteral",)
    return RESERVED_KIND_MAP.get(base)


def expected_kinds_for_custom_datatype_shape(
    custom_shape: str,
    actual_kind: str,
) -> tuple[str, ...] | None:
    if custom_shape in {"none", "invalid_both"}:
        return None
    if actual_kind not in {"SeparatorLiteral", "RadixLiteral"}:
        return None
    if custom_shape == "both":
        return ("SeparatorLiteral", "RadixLiteral")
    if custom_shape == "separator":
        return ("SeparatorLiteral",)
    return ("RadixLiteral",)


def classify_custom_datatype_shape(datatype: str) -> str:
    specs = datatype_bracket_specs(datatype)
    if not specs:
        return "none"

    separator_ok = all(is_valid_separator_spec(spec) for spec in specs)
    radix_ok = len(specs) == 1 and is_valid_custom_radix_base_spec(specs[0])

    if separator_ok and radix_ok:
        return "both"
    if separator_ok:
        return "separator"
    if radix_ok:
        return "radix"
    return "invalid_both"


def datatype_base(datatype: str) -> str:
    end = len(datatype)
    for marker in ("<", "["):
        index = datatype.find(marker)
        if index >= 0:
            end = min(end, index)
    return datatype[:end]


def datatype_bracket_specs(datatype: str) -> list[str]:
    specs: list[str] = []
    generic_depth = 0
    bracket_start = -1

    for index, char in enumerate(datatype):
        if char == "<":
            generic_depth += 1
            continue
        if char == ">":
            generic_depth = max(0, generic_depth - 1)
            continue
        if generic_depth > 0:
            continue
        if char == "[":
            bracket_start = index + 1
            continue
        if char == "]" and bracket_start >= 0:
            specs.append(datatype[bracket_start:index])
            bracket_start = -1

    if datatype_base(datatype) == "radix" and specs:
        return specs[1:]
    return specs


def is_valid_separator_spec(spec: str) -> bool:
    if len(spec) != 1:
        return False
    code = ord(spec)
    return 0x21 <= code <= 0x7E and spec not in {",", "[", "]"}


def is_valid_custom_radix_base_spec(spec: str) -> bool:
    if not spec or not re.fullmatch(r"[1-9]\d*", spec):
        return False
    return 2 <= int(spec) <= 64


def value_kind(value: Value) -> str:
    if isinstance(value, StringLiteral):
        return "TrimtickStringLiteral" if value.trimticks is not None else "StringLiteral"
    if isinstance(value, DateTimeLiteral):
        return "ZRUTDateTimeLiteral" if value.raw and "&" in value.raw else "DateTimeLiteral"
    if isinstance(value, SeparatorLiteral):
        return "InvalidSeparatorLiteral" if value.raw.startswith("^ ") else "SeparatorLiteral"
    if isinstance(value, HexLiteral):
        return "HexLiteral" if has_valid_literal_underscores(value.raw) else "InvalidHexLiteral"
    if isinstance(value, RadixLiteral):
        return "RadixLiteral" if has_valid_radix_literal(value.raw) else "InvalidRadixLiteral"
    if isinstance(value, EncodingLiteral):
        return "EncodingLiteral" if has_valid_encoding_literal(value.raw) else "InvalidEncodingLiteral"
    return getattr(value, "type")


def has_valid_literal_underscores(raw: str) -> bool:
    body = raw[1:] if raw else ""
    if not body or body.startswith("_") or body.endswith("_") or "__" in body:
        return False
    return True


def is_valid_radix_digit(char: str) -> bool:
    return char.isalnum() or char in {"&", "!"}


def has_valid_radix_literal(raw: str) -> bool:
    body = raw[1:] if raw else ""
    if not body:
        return False
    index = 1 if body[0] in {"+", "-"} else 0
    if index >= len(body):
        return False
    saw_digit = False
    saw_decimal = False
    prev_was_digit = False
    while index < len(body):
        char = body[index]
        if is_valid_radix_digit(char):
            saw_digit = True
            prev_was_digit = True
        elif char == "_":
            if not prev_was_digit or index + 1 >= len(body) or not is_valid_radix_digit(body[index + 1]):
                return False
            prev_was_digit = False
        elif char == ".":
            if saw_decimal or not prev_was_digit or index + 1 >= len(body) or not is_valid_radix_digit(body[index + 1]):
                return False
            saw_decimal = True
            prev_was_digit = False
        else:
            return False
        index += 1
    return saw_digit and prev_was_digit


def has_valid_encoding_literal(raw: str) -> bool:
    body = raw[1:] if raw else ""
    if not body or not re.fullmatch(r"[A-Za-z0-9+/_-]+={0,2}", body):
        return False
    padding_index = body.find("=")
    return padding_index == -1 or all(char == "=" for char in body[padding_index:])


def format_datatype(datatype: TypeAnnotation | None) -> str | None:
    if datatype is None:
        return None
    generic = ""
    if datatype.generic_args:
        generic = "<" + ", ".join(datatype.generic_args) + ">"
    radix = f"[{datatype.radix_base}]" if datatype.radix_base is not None else ""
    separators = "".join(f"[{item}]" for item in datatype.separators)
    return f"{datatype.name}{generic}{radix}{separators}"


def type_annotation_to_json(datatype: TypeAnnotation | None) -> dict[str, object] | None:
    if datatype is None:
        return None
    return {
        "type": "TypeAnnotation",
        "name": datatype.name,
        "genericArgs": datatype.generic_args,
        "radixBase": datatype.radix_base,
        "separators": datatype.separators,
        "span": datatype.span.to_json(),
    }


def extend_member(path: CanonicalPath, key: str) -> CanonicalPath:
    return CanonicalPath(segments=(*path.segments, CanonicalSegment(type="member", key=key)))


def extend_index(path: CanonicalPath, index: int) -> CanonicalPath:
    return CanonicalPath(segments=(*path.segments, CanonicalSegment(type="index", index=index)))


def format_path(path: CanonicalPath) -> str:
    parts: list[str] = []
    for segment in path.segments:
        if segment.type == "root":
            parts.append("$")
        elif segment.type == "member":
            assert segment.key is not None
            if is_identifier_safe(segment.key):
                parts.append(f".{segment.key}")
            else:
                escaped = segment.key.replace('"', '\\"')
                parts.append(f'.["{escaped}"]')
        elif segment.type == "index":
            assert segment.index is not None
            parts.append(f"[{segment.index}]")
    return "".join(parts)


def format_reference_target_path(path: list[object]) -> str:
    result = "$"
    for segment in path:
        if isinstance(segment, AttributePathSegment):
            if is_identifier_safe(segment.key):
                result += f"@{segment.key}"
            else:
                escaped = segment.key.replace('"', '\\"')
                result += f'@["{escaped}"]'
        elif isinstance(segment, int):
            result += f"[{segment}]"
        else:
            key = str(segment)
            if is_identifier_safe(key):
                result += f".{key}"
            else:
                escaped = key.replace('"', '\\"')
                result += f'.["{escaped}"]'
    return result


def reference_path_to_json(path: list[object]) -> list[object]:
    result: list[object] = []
    for segment in path:
        if isinstance(segment, AttributePathSegment):
            result.append({"type": "attr", "key": segment.key})
        else:
            result.append(segment)
    return result


def is_identifier_safe(value: str) -> bool:
    if not value:
        return False
    if not (value[0].isalpha() or value[0] == "_"):
        return False
    return all(char.isalnum() or char == "_" for char in value[1:])
