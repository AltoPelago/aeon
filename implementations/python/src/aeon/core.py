from __future__ import annotations

from dataclasses import field, fields, is_dataclass
import json
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
    NumberLiteral,
    ObjectNode,
    PointerReference,
    RadixLiteral,
    SeparatorLiteral,
    StringLiteral,
    TupleLiteral,
    TypedValue,
    TypeAnnotation,
    Value,
)
from .errors import (
    AeonError,
    AttributeDepthExceededError,
    CustomToggleAliasNotAllowedError,
    CustomDatatypeNotAllowedError,
    DatatypeLiteralMismatchError,
    DuplicateCanonicalPathError,
    ForwardReferenceError,
    InvalidNodeHeadDatatypeError,
    MissingReferenceTargetError,
    SelfReferenceError,
    SyntaxError,
    EventCountExceededError,
    InputSizeExceededError,
    ResourceLimitExceededError,
    UntypedToggleLiteralError,
    UntypedValueInStrictModeError,
)
from .lexer import tokenize
from .parser import parse_tokens
from .spans import Position, Span


@dataclass(slots=True)
class CompileOptions:
    recovery: bool = False
    max_attribute_depth: int = 1
    max_clarifier_values: int | None = None
    # Deprecated compatibility alias for max_clarifier_values.
    max_separator_depth: int = 1
    max_generic_depth: int = 1
    max_generic_arguments: int = 32
    max_datatype_components: int = 64
    max_value_nesting_depth: int | None = None
    # Deprecated compatibility alias for max_value_nesting_depth.
    max_nesting_depth: int = 256
    max_path_depth: int = 1024
    max_string_codepoints: int = 1_048_576
    max_key_segment_codepoints: int = 1024
    max_list_items: int = 65_536
    max_tuple_items: int = 65_536
    max_path_characters: int = 8192
    max_numeric_literal_characters: int = 1024
    max_structured_comment_characters: int = 1_048_576
    datatype_policy: str | None = None
    profile: str | None = None
    # Consumer-selected effective mode. When omitted, Core honors aeon:mode
    # declared in the document for backwards-compatible authoring flows.
    mode: str | None = None
    max_input_bytes: int | None = None
    max_events: int | None = None

    def effective_max_clarifier_values(self) -> int:
        return self.max_separator_depth if self.max_clarifier_values is None else self.max_clarifier_values

    def effective_max_value_nesting_depth(self) -> int:
        return self.max_nesting_depth if self.max_value_nesting_depth is None else self.max_value_nesting_depth


@dataclass(slots=True)
class CompileResult:
    events: list[dict[str, object]]
    errors: list[AeonError]
    internal_events: list[dict[str, object]] | None = None
    header: dict[str, object] | None = None
    warnings: list[dict[str, object]] = field(default_factory=list)


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
    structural_id: str | None


RESERVED_KIND_MAP = {
    "string": ("StringLiteral",),
    "boolean": ("BooleanLiteral",),
    "bool": ("BooleanLiteral",),
    "toggle": ("ToggleLiteral",),
    "infinity": ("InfinityLiteral",),
    "nan": ("NaNLiteral",),
    "null": ("NullLiteral",),
    "hex": ("HexLiteral",),
    "date": ("DateLiteral",),
    "time": ("TimeLiteral",),
    "datetime": ("DateTimeLiteral",),
    "wtc": ("WTCDateTimeLiteral",),
    "tuple": ("TupleLiteral",),
    "triple": ("TupleLiteral",),
    "list": ("ListNode",),
    "object": ("ObjectNode",),
    "obj": ("ObjectNode",),
    "envelope": ("ObjectNode",),
    "o": ("ObjectNode",),
    "node": ("NodeLiteral",),
    "trimtick": ("TrimtickStringLiteral",),
    "prose": ("TrimtickStringLiteral",),
    "encoding": ("EncodingLiteral",),
    "base64": ("EncodingLiteral",),
    "embed": ("EncodingLiteral",),
    "inline": ("EncodingLiteral",),
    "radix": ("RadixLiteral",),
    "decimal": ("RadixLiteral",),
    "radix2": ("RadixLiteral",),
    "radix6": ("RadixLiteral",),
    "radix8": ("RadixLiteral",),
    "radix12": ("RadixLiteral",),
    "sep": ("SeparatorLiteral",),
    "kadot": ("SeparatorLiteral",),
    "sansa": ("SansaAddressLiteral",),
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
    warnings = compile_portability_warnings(opts) if options is not None else []
    if opts.max_input_bytes is not None:
        actual_bytes = len(source.encode("utf-8"))
        if actual_bytes > opts.max_input_bytes:
            zero = Position(line=1, column=1, offset=0)
            error = InputSizeExceededError(actual_bytes, opts.max_input_bytes, Span(start=zero, end=zero))
            return CompileResult(events=[], errors=[error], warnings=warnings)
    source = strip_leading_bom(source)
    lex_result = tokenize(source)
    if lex_result.errors and not opts.recovery:
        return CompileResult(events=[], errors=lex_result.errors, warnings=warnings)

    parse_result = parse_tokens(
        source,
        lex_result.tokens,
        max_clarifier_values=opts.effective_max_clarifier_values(),
        max_generic_depth=opts.max_generic_depth,
        max_generic_arguments=opts.max_generic_arguments,
        max_datatype_components=opts.max_datatype_components,
        max_attribute_depth=opts.max_attribute_depth,
        max_value_nesting_depth=opts.effective_max_value_nesting_depth(),
    )
    parse_errors = [coerce_error(error) for error in parse_result.errors]
    if parse_errors and not opts.recovery:
        return CompileResult(events=[], errors=[*lex_result.errors, *parse_errors], warnings=warnings)
    if parse_result.document is None:
        return CompileResult(events=[], errors=[*lex_result.errors, *parse_errors], warnings=warnings)

    structure_error = validate_source_structure(parse_result.document, opts)
    if structure_error is not None:
        return CompileResult(events=[], errors=[*lex_result.errors, *parse_errors, structure_error], warnings=warnings)
    structured_comment_error = validate_structured_comment_limits(source, opts.max_structured_comment_characters)
    if structured_comment_error is not None:
        return CompileResult(events=[], errors=[*lex_result.errors, *parse_errors, structured_comment_error], warnings=warnings)

    resolved_bindings, path_errors = resolve_paths(parse_result.document)
    if path_errors and not opts.recovery:
        return CompileResult(events=[], errors=[*lex_result.errors, *parse_errors, *path_errors], warnings=warnings)
    for binding in resolved_bindings:
        depth = max(0, len(binding.path.segments) - 1)
        if depth > opts.max_path_depth:
            return CompileResult(events=[], errors=[ResourceLimitExceededError("max_path_depth", depth, opts.max_path_depth)], warnings=warnings)
        characters = len(format_path(binding.path))
        if characters > opts.max_path_characters:
            return CompileResult(events=[], errors=[ResourceLimitExceededError("max_path_characters", characters, opts.max_path_characters)], warnings=warnings)

    mode_errors = enforce_mode(parse_result.document, resolved_bindings, opts.datatype_policy, opts.mode)
    if mode_errors and not opts.recovery:
        return CompileResult(events=[], errors=[*lex_result.errors, *parse_errors, *path_errors, *mode_errors], warnings=warnings)

    reference_errors = validate_references(resolved_bindings, opts.max_attribute_depth)
    profile_errors = (
        validate_gp_datatype_clarifiers(resolved_bindings)
        if uses_gp_profile(opts, parse_result.document)
        else []
    )
    all_errors = [*lex_result.errors, *parse_errors, *path_errors, *mode_errors, *reference_errors, *profile_errors]
    if (reference_errors or profile_errors) and not opts.recovery:
        return CompileResult(events=[], errors=all_errors, warnings=warnings)

    internal_events = [resolved_binding_to_event(binding, include_annotations=True) for binding in resolved_bindings]
    if opts.max_events is not None and len(internal_events) > opts.max_events:
        return CompileResult(
            events=[],
            errors=[*all_errors, EventCountExceededError(len(internal_events), opts.max_events)],
            warnings=warnings,
        )
    events = [
        event
        for event in internal_events
        if not str(event["key"]).startswith("aeon:")
    ]
    return CompileResult(
        events=events,
        errors=all_errors,
        internal_events=internal_events,
        header=header_to_result(parse_result.document),
        warnings=warnings,
    )


def validate_source_structure(document: Document, options: CompileOptions) -> ResourceLimitExceededError | None:
    def check_key(key: str) -> ResourceLimitExceededError | None:
        return ResourceLimitExceededError("max_key_segment_codepoints", len(key), options.max_key_segment_codepoints) if len(key) > options.max_key_segment_codepoints else None

    def check_datatype(datatype: TypeAnnotation | None) -> ResourceLimitExceededError | None:
        if datatype is None:
            return None
        for clarifier in datatype.clarifiers:
            if isinstance(clarifier, str) and len(clarifier) > options.max_string_codepoints:
                return ResourceLimitExceededError("max_string_codepoints", len(clarifier), options.max_string_codepoints, datatype.span)
        return None

    def check_attributes(attributes: list[Attribute]) -> ResourceLimitExceededError | None:
        for attribute in attributes:
            for key, entry in attribute.entries.items():
                error = check_key(key) or check_datatype(entry.datatype) or check_attributes(entry.attributes) or check_value(entry.value)
                if error is not None:
                    return error
        return None

    def check_reference(value: CloneReference | PointerReference) -> ResourceLimitExceededError | None:
        depth = len(value.path)
        if depth > options.max_path_depth:
            return ResourceLimitExceededError("max_path_depth", depth, options.max_path_depth, value.span)
        rendered = "$"
        for segment in value.path:
            if isinstance(segment, int):
                rendered += f"[{segment}]"
            elif isinstance(segment, str):
                rendered += f".{segment}" if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", segment) else ".[" + json.dumps(segment, ensure_ascii=False) + "]"
            else:
                rendered += f".@.{segment.key}" if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", segment.key) else ".@.[" + json.dumps(segment.key, ensure_ascii=False) + "]"
        if len(rendered) > options.max_path_characters:
            return ResourceLimitExceededError("max_path_characters", len(rendered), options.max_path_characters, value.span)
        return None

    def check_value(value: Value) -> ResourceLimitExceededError | None:
        if isinstance(value, StringLiteral):
            return ResourceLimitExceededError("max_string_codepoints", len(value.value), options.max_string_codepoints, value.span) if len(value.value) > options.max_string_codepoints else None
        if isinstance(value, NumberLiteral):
            return ResourceLimitExceededError("max_numeric_literal_characters", len(value.raw), options.max_numeric_literal_characters, value.span) if len(value.raw) > options.max_numeric_literal_characters else None
        if isinstance(value, ListNode):
            if len(value.elements) > options.max_list_items:
                return ResourceLimitExceededError("max_list_items", len(value.elements), options.max_list_items, value.span)
            return next((error for item in value.elements if (error := check_value(item)) is not None), None) or check_attributes(value.attributes)
        if isinstance(value, TupleLiteral):
            if len(value.elements) > options.max_tuple_items:
                return ResourceLimitExceededError("max_tuple_items", len(value.elements), options.max_tuple_items, value.span)
            return next((error for item in value.elements if (error := check_value(item)) is not None), None) or check_attributes(value.attributes)
        if isinstance(value, ObjectNode):
            return next((error for binding in value.bindings if (error := check_binding(binding)) is not None), None) or check_attributes(value.attributes)
        if isinstance(value, NodeLiteral):
            return check_key(value.tag) or check_datatype(value.datatype) or check_attributes(value.attributes) or next((error for child in value.children if (error := check_value(child)) is not None), None)
        if isinstance(value, TypedValue):
            return check_datatype(value.datatype) or check_attributes(value.attributes) or (check_value(value.value) if value.value is not None else None)
        if isinstance(value, (CloneReference, PointerReference)):
            return check_reference(value)
        return None

    def check_binding(binding: Binding) -> ResourceLimitExceededError | None:
        return check_key(binding.key) or check_datatype(binding.datatype) or check_attributes(binding.attributes) or check_value(binding.value)

    if document.header is not None:
        for binding in document.header.bindings:
            if (error := check_binding(binding)) is not None:
                return error
    for binding in document.bindings:
        if (error := check_binding(binding)) is not None:
            return error
    return None


def validate_structured_comment_limits(source: str, limit: int) -> ResourceLimitExceededError | None:
    from .annotations import scan_structured_comments

    for comment in scan_structured_comments(source, include_host=True):
        payload = comment.raw[3:] if comment.form == "line" else comment.raw[2:-2]
        if len(payload) > limit:
            return ResourceLimitExceededError("max_structured_comment_characters", len(payload), limit, comment.span)
    return None


def compile_portability_warnings(options: CompileOptions) -> list[dict[str, object]]:
    defaults = CompileOptions()
    warnings: list[dict[str, object]] = []
    warn_if_above(
        warnings,
        "AEON_NON_PORTABLE_POLICY_DEPTH",
        "max_attribute_depth",
        options.max_attribute_depth,
        8,
        defaults.max_attribute_depth,
    )
    warn_if_above(
        warnings,
        "AEON_NON_PORTABLE_POLICY_DEPTH",
        "max_clarifier_values",
        options.effective_max_clarifier_values(),
        8,
        defaults.effective_max_clarifier_values(),
    )
    warn_if_above(
        warnings,
        "AEON_NON_PORTABLE_POLICY_DEPTH",
        "max_generic_depth",
        options.max_generic_depth,
        8,
        defaults.max_generic_depth,
    )
    warn_if_above(
        warnings,
        "AEON_NON_PORTABLE_CONTAINER_NESTING_DEPTH",
        "max_value_nesting_depth",
        options.effective_max_value_nesting_depth(),
        64,
        defaults.effective_max_value_nesting_depth(),
    )
    if options.max_events is not None:
        warn_if_above(
            warnings,
            "AEON_NON_PORTABLE_EVENT_BUDGET",
            "max_events",
            options.max_events,
            100_000,
            defaults.max_events,
        )
    return warnings


def warn_if_above(
    warnings: list[dict[str, object]],
    code: str,
    policy: str,
    observed: int,
    portable_floor: int,
    default_value: int | None,
) -> None:
    if observed == default_value or observed <= portable_floor:
        return
    warnings.append(
        {
            "code": code,
            "path": "$",
            "policy": policy,
            "observed": observed,
            "portableFloor": portable_floor,
            "message": f"{policy} {observed} exceeds the AEON v1 portable floor {portable_floor}",
        }
    )


def header_to_result(document: Document) -> dict[str, object] | None:
    if document.header is None:
        return None
    return {
        "fields": document.header.fields,
        "bindings": [binding_to_json(binding) for binding in document.header.bindings],
        "order": [binding.key for binding in document.header.bindings],
        "span": document.header.span.to_json(),
    }


def strip_leading_bom(source: str) -> str:
    return source[1:] if source.startswith("\ufeff") else source


def coerce_error(error: Exception) -> AeonError:
    if isinstance(error, AeonError):
        return error
    zero = Position(line=1, column=1, offset=0)
    return SyntaxError(str(error) or error.__class__.__name__, Span(start=zero, end=zero))


AEON_GP_PROFILE_ID = "aeon.gp.profile.v1"

GP_DATATYPE_CLARIFIER_RULES = {
    "decimal": "none",
    "kadot": "none",
    "radix": "radix_base",
    "sep": "separator_chars",
    "separator": "separator_chars",
    "encoding": "encoding_name",
    "inline": "encoding_name",
    "embed": "encoding_name",
}


def uses_gp_profile(options: CompileOptions, document: Document) -> bool:
    if options.profile == AEON_GP_PROFILE_ID:
        return True
    if document.header is None:
        return False
    profile = document.header.fields.get("profile")
    return isinstance(profile, StringLiteral) and profile.value == AEON_GP_PROFILE_ID


def validate_gp_datatype_clarifiers(bindings: list[ResolvedBinding]) -> list[AeonError]:
    errors: list[AeonError] = []
    for binding in bindings:
        if binding.key.startswith("aeon:") or binding.datatype is None:
            continue
        surface = parse_gp_datatype_surface(binding.datatype)
        if surface is None:
            continue
        validate_gp_datatype_surface(surface, format_path(binding.path), binding.span, errors)
    return errors


def validate_gp_datatype_surface(
    surface: dict[str, object],
    path: str,
    span: Span,
    errors: list[AeonError],
) -> None:
    name = str(surface["name"])
    clarifiers = surface.get("clarifiers")
    if isinstance(clarifiers, list):
        rule = GP_DATATYPE_CLARIFIER_RULES.get(name)
        if rule == "radix_base":
            valid = (
                len(clarifiers) == 1
                and isinstance(clarifiers[0], int)
                and not isinstance(clarifiers[0], bool)
                and 2 <= clarifiers[0] <= 64
            )
            if not valid:
                errors.append(
                    AeonError(
                        f"Profile datatype ':{name}' expects exactly one integral radix-base clarifier from 2 to 64",
                        span,
                        "PROFILE_DATATYPE_CLARIFIER_INVALID",
                        path,
                    )
                )
        elif rule == "separator_chars":
            if not clarifiers or any(not isinstance(value, str) for value in clarifiers):
                errors.append(
                    AeonError(
                        f"Profile datatype ':{name}' expects string separator-character clarifiers",
                        span,
                        "PROFILE_DATATYPE_CLARIFIER_INVALID",
                        path,
                    )
                )
        elif rule == "encoding_name":
            if len(clarifiers) != 1 or not isinstance(clarifiers[0], str):
                errors.append(
                    AeonError(
                        f"Profile datatype ':{name}' expects exactly one string encoding-name clarifier",
                        span,
                        "PROFILE_DATATYPE_CLARIFIER_INVALID",
                        path,
                    )
                )
        else:
            errors.append(
                AeonError(
                    f"Profile does not allow clarifiers on datatype ':{name}'",
                    span,
                    "PROFILE_DATATYPE_CLARIFIER_NOT_ALLOWED",
                    path,
                )
            )

    for arg in surface["args"]:
        validate_gp_datatype_surface(arg, path, span, errors)


def parse_gp_datatype_surface(source: str) -> dict[str, object] | None:
    text = source.strip()
    match = re.match(r"[A-Za-z_][A-Za-z0-9_-]*", text)
    if match is None:
        return None
    name = match.group(0)
    index = skip_gp_whitespace(text, match.end())

    args: list[dict[str, object]] = []
    if index < len(text) and text[index] == "<":
        end = find_gp_matching_delimiter(text, index, "<", ">")
        if end is None:
            return None
        for part in split_gp_top_level(text[index + 1 : end], ","):
            stripped = part.strip()
            if stripped:
                parsed = parse_gp_datatype_surface(stripped)
                if parsed is None:
                    return None
                args.append(parsed)
        index = skip_gp_whitespace(text, end + 1)

    clarifiers: list[object] | None = None
    if index < len(text) and text[index] == "[":
        end = find_gp_matching_delimiter(text, index, "[", "]")
        if end is None:
            return None
        try:
            parsed = json.loads("[" + text[index + 1 : end] + "]")
        except json.JSONDecodeError:
            return None
        if not isinstance(parsed, list):
            return None
        clarifiers = parsed
        index = skip_gp_whitespace(text, end + 1)

    if index != len(text):
        return None

    return {"name": name, "args": args, "clarifiers": clarifiers}


def find_gp_matching_delimiter(source: str, start: int, open_char: str, close_char: str) -> int | None:
    depth = 0
    quote: str | None = None
    escaped = False
    for index in range(start, len(source)):
        char = source[index]
        if quote is not None:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == quote:
                quote = None
            continue
        if char in {'"', "'", "`"}:
            quote = char
            continue
        if char == open_char:
            depth += 1
        elif char == close_char:
            depth -= 1
            if depth == 0:
                return index
            if depth < 0:
                return None
    return None


def split_gp_top_level(source: str, delimiter: str) -> list[str]:
    parts: list[str] = []
    start = 0
    angle_depth = 0
    square_depth = 0
    quote: str | None = None
    escaped = False
    for index, char in enumerate(source):
        if quote is not None:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == quote:
                quote = None
            continue
        if char in {'"', "'", "`"}:
            quote = char
        elif char == "<":
            angle_depth += 1
        elif char == ">":
            angle_depth = max(0, angle_depth - 1)
        elif char == "[":
            square_depth += 1
        elif char == "]":
            square_depth = max(0, square_depth - 1)
        elif char == delimiter and angle_depth == 0 and square_depth == 0:
            parts.append(source[start:index])
            start = index + 1
    parts.append(source[start:])
    return parts


def skip_gp_whitespace(source: str, index: int) -> int:
    while index < len(source) and source[index].isspace():
        index += 1
    return index


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
            structural_id=binding.structural_id,
        )
    )
    resolve_value(binding.value, path, bindings, errors, seen)


def resolve_value(value: Value, parent: CanonicalPath, bindings: list[ResolvedBinding], errors: list[AeonError], seen: set[str]) -> None:
    value = unwrap_typed_value(value)
    if isinstance(value, ObjectNode):
        local_keys: set[str] = set()
        for binding in value.bindings:
            if binding.key in local_keys:
                errors.append(AeonError(message=f"Duplicate key: '{binding.key}'", span=binding.span, code="DUPLICATE_KEY"))
                continue
            local_keys.add(binding.key)
            resolve_binding(binding, parent, bindings, errors, seen)
        return
    if isinstance(value, (ListNode, TupleLiteral)):
        elements = value.elements
        for index, element in enumerate(elements):
            element_value = unwrap_typed_value(element)
            element_datatype = format_datatype(element.datatype) if isinstance(element, TypedValue) else None
            element_annotations = build_annotations(element.attributes) if isinstance(element, TypedValue) else None
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
                    value=element_value,
                    span=element.span,
                    datatype=element_datatype,
                    annotations=element_annotations,
                    structural_id=element.structural_id if isinstance(element, TypedValue) else None,
                )
            )
            resolve_value(element_value, element_path, bindings, errors, seen)
        return
    if isinstance(value, NodeLiteral):
        for index, child in enumerate(value.children):
            child_value = unwrap_typed_value(child)
            child_datatype = format_datatype(child.datatype) if isinstance(child, TypedValue) else None
            child_annotations = build_annotations(child.attributes) if isinstance(child, TypedValue) else None
            child_path = extend_index(parent, index)
            path_str = format_path(child_path)
            if path_str in seen:
                errors.append(DuplicateCanonicalPathError(path_str, child.span))
                continue
            seen.add(path_str)
            bindings.append(
                ResolvedBinding(
                    path=child_path,
                    key=str(index),
                    value=child_value,
                    span=child.span,
                    datatype=child_datatype,
                    annotations=child_annotations,
                    structural_id=child.structural_id if isinstance(child, TypedValue) else None,
                )
            )
            resolve_value(child_value, child_path, bindings, errors, seen)


def build_annotations(attributes: list[Attribute]) -> dict[str, dict[str, object]] | None:
    if not attributes:
        return None
    result: dict[str, dict[str, object]] = {}
    for attribute in attributes:
        for key, entry in attribute.entries.items():
            mapped = {
                "value": entry.value,
                "datatype": format_datatype(entry.datatype),
                "structuralId": entry.structural_id,
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
    if binding.structural_id is not None:
        event["structuralId"] = binding.structural_id
    return event

def annotations_to_json(annotations: dict[str, dict[str, object]]) -> dict[str, dict[str, object]]:
    result: dict[str, dict[str, object]] = {}
    for key, entry in annotations.items():
        mapped = {
            "value": value_to_json(entry["value"]),
            "datatype": entry["datatype"],
            "structuralId": entry["structuralId"],
        }
        nested = entry.get("annotations")
        if isinstance(nested, dict):
            mapped["annotations"] = annotations_to_json(nested)
        result[key] = mapped
    return result


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
            elif key == "structural_id":
                payload["structuralId"] = raw
            elif key == "attributes":
                payload[key] = [attribute_to_json(item) for item in raw]
            elif key == "trimticks":
                payload[key] = raw
            elif key == "bindings":
                payload[key] = [binding_to_json(item) for item in raw]
            elif key in {"elements", "children"}:
                payload[key] = [value_to_json(item) for item in raw]
            elif key == "value" and isinstance(value, TypedValue):
                payload[key] = value_to_json(raw)
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
        "structuralId": binding.structural_id,
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
                "structuralId": entry.structural_id,
                "datatype": type_annotation_to_json(entry.datatype),
                "attributes": [attribute_to_json(item) for item in entry.attributes],
                "value": value_to_json(entry.value),
            }
            for key, entry in attribute.entries.items()
        },
        "span": attribute.span.to_json(),
    }


def enforce_mode(
    document: Document,
    bindings: list[ResolvedBinding],
    datatype_policy: str | None,
    effective_mode: str | None = None,
) -> list[AeonError]:
    mode = normalize_mode(effective_mode) if effective_mode is not None else extract_mode(document)
    effective_policy = effective_datatype_policy(mode, datatype_policy)
    errors: list[AeonError] = []
    lookup = {format_path(binding.path): binding for binding in bindings}
    for binding in bindings:
        if should_skip_header_binding_for_mode(document, binding):
            continue
        last_segment = binding.path.segments[-1]
        if last_segment.type == "index" and binding.datatype is None:
            continue
        if binding.datatype is None:
            if mode in {"strict", "custom"}:
                if mode == "strict" and value_kind(binding.value) == "ToggleLiteral":
                    errors.append(UntypedToggleLiteralError(format_path(binding.path), binding.span))
                else:
                    errors.append(UntypedValueInStrictModeError(format_path(binding.path), binding.span))
            continue
        expected = expected_kinds_for_reserved_datatype(binding.datatype)
        actual_kind = datatype_check_kind(binding, lookup)
        if datatype_base(binding.datatype) == "switch" and actual_kind == "ToggleLiteral":
            errors.append(
                CustomToggleAliasNotAllowedError(
                    format_path(binding.path),
                    binding.datatype,
                    binding.span,
                )
            )
            continue
        if mode in {"strict", "custom"} and expected is None and effective_policy == "reserved_only":
            errors.append(CustomDatatypeNotAllowedError(format_path(binding.path), binding.datatype, binding.span))
            continue
        if mode == "strict" and expected is None and actual_kind == "ToggleLiteral":
            errors.append(
                CustomToggleAliasNotAllowedError(
                    format_path(binding.path),
                    binding.datatype,
                    binding.span,
                )
            )
            continue
        if expected is None:
            expected = expected_kinds_for_custom_datatype(binding.datatype)
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
        errors.extend(validate_anonymous_typed_values(binding.value, format_path(binding.path), binding.span, lookup, mode, effective_policy))
    return errors


def validate_anonymous_typed_values(
    value: Value,
    owner_path: str,
    span: Span,
    lookup: dict[str, ResolvedBinding],
    mode: str,
    effective_policy: str,
) -> list[AeonError]:
    errors: list[AeonError] = []
    if isinstance(value, TypedValue):
        datatype = format_datatype(value.datatype)
        if datatype is not None and value.value is not None:
            expected = expected_kinds_for_reserved_datatype(datatype)
            actual_value = resolve_reference_value(value.value, lookup) or value.value
            actual_kind = value_kind(actual_value)
            if datatype_base(datatype) == "switch" and actual_kind == "ToggleLiteral":
                errors.append(CustomToggleAliasNotAllowedError(owner_path, datatype, value.span or span))
            elif mode in {"strict", "custom"} and expected is None and effective_policy == "reserved_only":
                errors.append(CustomDatatypeNotAllowedError(owner_path, datatype, value.span or span))
            else:
                if mode == "strict" and expected is None and actual_kind == "ToggleLiteral":
                    errors.append(CustomToggleAliasNotAllowedError(owner_path, datatype, value.span or span))
                elif expected is not None and actual_kind not in expected:
                    errors.append(DatatypeLiteralMismatchError(owner_path, datatype, actual_kind, expected, value.span or span))
                elif expected is None:
                    custom_expected = expected_kinds_for_custom_datatype(datatype)
                    if custom_expected is not None and actual_kind not in custom_expected:
                        errors.append(DatatypeLiteralMismatchError(owner_path, datatype, actual_kind, custom_expected, value.span or span))
        if value.value is not None:
            errors.extend(validate_anonymous_typed_values(value.value, owner_path, span, lookup, mode, effective_policy))
        return errors
    if isinstance(value, ObjectNode):
        for binding in value.bindings:
            errors.extend(validate_anonymous_typed_values(binding.value, f"{owner_path}.{binding.key}", span, lookup, mode, effective_policy))
        return errors
    if isinstance(value, (ListNode, TupleLiteral)):
        for index, element in enumerate(value.elements):
            errors.extend(validate_anonymous_typed_values(element, f"{owner_path}[{index}]", span, lookup, mode, effective_policy))
        return errors
    if isinstance(value, NodeLiteral):
        for index, child in enumerate(value.children):
            errors.extend(validate_anonymous_typed_values(child, f"{owner_path}[{index}]", span, lookup, mode, effective_policy))
    return errors


def validate_node_head_datatypes(value: Value, owner_path: str, span: Span, mode: str) -> list[AeonError]:
    value = unwrap_typed_value(value)
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
    return True


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
        return value_kind(unwrap_typed_value(binding.value))
    if isinstance(resolved, (CloneReference, PointerReference)):
        resolution = resolve_mode_reference_target(resolved.path, lookup)
        if resolution is None or resolution[0] in stack:
            return value_kind(resolved)
        return datatype_check_kind(resolution[1], lookup, (*stack, resolution[0]))
    return value_kind(unwrap_typed_value(resolved))


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
        attr_path = f"{owner_path}.@.{key}"
        datatype = entry.get("datatype")
        value = entry.get("value")
        if not isinstance(datatype, str) and mode in {"strict", "custom"} and value is not None and hasattr(value, "type"):
            actual_kind = value_kind(resolve_reference_value(value, lookup) or value)
            if mode == "strict" and actual_kind == "ToggleLiteral":
                errors.append(UntypedToggleLiteralError(attr_path, span))
            else:
                errors.append(UntypedValueInStrictModeError(attr_path, span))
        elif isinstance(datatype, str):
            expected = expected_kinds_for_reserved_datatype(datatype)
            if mode in {"strict", "custom"} and expected is None and effective_policy == "reserved_only":
                errors.append(CustomDatatypeNotAllowedError(attr_path, datatype, span))
            else:
                if value is not None and hasattr(value, "type"):
                    actual_kind = value_kind(resolve_reference_value(value, lookup) or value)
                    if expected is None:
                        expected = expected_kinds_for_custom_datatype(datatype)
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
    value = unwrap_typed_value(value)
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
    context_value = unwrap_typed_value(value)
    context_annotations = select_annotations(annotations, context_value)
    for segment in remainder:
        if isinstance(segment, AttributePathSegment):
            if context_annotations is None or segment.key not in context_annotations:
                return None
            entry = context_annotations[segment.key]
            context_value = unwrap_typed_value(entry["value"])
            context_annotations = select_annotations(entry.get("annotations"), context_value)
            continue
        if isinstance(segment, str):
            if not isinstance(context_value, ObjectNode):
                return None
            child = next((binding for binding in context_value.bindings if binding.key == segment), None)
            if child is None:
                return None
            context_value = unwrap_typed_value(child.value)
            context_annotations = select_annotations(build_annotations(child.attributes), context_value)
            continue
        if isinstance(segment, int):
            if isinstance(context_value, (ListNode, TupleLiteral)):
                elements = context_value.elements
            elif isinstance(context_value, NodeLiteral):
                elements = context_value.children
            else:
                return None
            if segment < 0 or segment >= len(elements):
                return None
            context_value = unwrap_typed_value(elements[segment])
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
    if isinstance(value, TypedValue) and value.attributes:
        return build_annotations(value.attributes)
    value = unwrap_typed_value(value)
    if not isinstance(value, (ObjectNode, ListNode, TupleLiteral, NodeLiteral)):
        return None
    return build_annotations(value.attributes)


def iter_references(value: Value):
    value = unwrap_typed_value(value)
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
    value = unwrap_typed_value(value)
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
        if isinstance(value, (CloneReference, PointerReference, ObjectNode, ListNode, TupleLiteral, NodeLiteral, TypedValue)):
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
    context_value = unwrap_typed_value(binding.value)
    context_annotations = binding.annotations
    for segment in path[first_attr_index:]:
        if isinstance(segment, AttributePathSegment):
            if context_annotations is None or segment.key not in context_annotations:
                return None
            entry = context_annotations[segment.key]
            context_value = unwrap_typed_value(entry["value"])
            nested_annotations = entry.get("annotations")
            context_annotations = nested_annotations if isinstance(nested_annotations, dict) else None
            continue
        if isinstance(segment, int):
            if isinstance(context_value, (ListNode, TupleLiteral)):
                elements = context_value.elements
            elif isinstance(context_value, NodeLiteral):
                elements = context_value.children
            else:
                return None
            if segment < 0 or segment >= len(elements):
                return None
            context_value = unwrap_typed_value(elements[segment])
            context_annotations = None
            continue
        if isinstance(context_value, ObjectNode):
            nested = next((item for item in context_value.bindings if item.key == segment), None)
            if nested is None:
                return None
            context_value = unwrap_typed_value(nested.value)
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
        return normalize_mode(getattr(mode_value, "value", ""))
    return "transport"


def normalize_mode(mode: str) -> str:
    lowered = mode.lower()
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


def expected_kinds_for_custom_datatype(datatype: str) -> tuple[str, ...] | None:
    if datatype_has_generic_args(datatype):
        return ("ListNode", "TupleLiteral")
    return None


def datatype_base(datatype: str) -> str:
    end = len(datatype)
    for marker in ("<", "["):
        index = datatype.find(marker)
        if index >= 0:
            end = min(end, index)
    return datatype[:end]


def datatype_has_generic_args(datatype: str) -> bool:
    bracket_depth = 0
    generic_start = -1
    for index, char in enumerate(datatype):
        if char == "[":
            bracket_depth += 1
            continue
        if char == "]":
            bracket_depth = max(0, bracket_depth - 1)
            continue
        if bracket_depth > 0:
            continue
        if char == "<":
            generic_start = index
            continue
        if char == ">" and generic_start >= 0:
            return True
    return False


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

    return specs


def value_kind(value: Value) -> str:
    value = unwrap_typed_value(value)
    if isinstance(value, StringLiteral):
        return "TrimtickStringLiteral" if value.trimticks is not None else "StringLiteral"
    if isinstance(value, DateTimeLiteral):
        return "WTCDateTimeLiteral" if value.raw and "&" in value.raw else "DateTimeLiteral"
    if isinstance(value, SeparatorLiteral):
        return "SeparatorLiteral"
    if isinstance(value, HexLiteral):
        return "HexLiteral" if has_valid_literal_underscores(value.raw) else "InvalidHexLiteral"
    if isinstance(value, RadixLiteral):
        return "RadixLiteral" if has_valid_radix_literal(value.raw) else "InvalidRadixLiteral"
    if isinstance(value, EncodingLiteral):
        return "EncodingLiteral" if has_valid_encoding_literal(value.raw) else "InvalidEncodingLiteral"
    return getattr(value, "type")


def unwrap_typed_value(value: Value) -> Value:
    if isinstance(value, TypedValue) and value.value is not None:
        return value.value
    return value


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
    saw_digit_before_decimal = False
    while index < len(body):
        char = body[index]
        if is_valid_radix_digit(char):
            saw_digit = True
            prev_was_digit = True
            if not saw_decimal:
                saw_digit_before_decimal = True
        elif char == "_":
            if not prev_was_digit or index + 1 >= len(body) or not is_valid_radix_digit(body[index + 1]):
                return False
            prev_was_digit = False
        elif char == ".":
            if saw_decimal or index + 1 >= len(body) or not is_valid_radix_digit(body[index + 1]):
                return False
            if not prev_was_digit and saw_digit_before_decimal:
                return False
            saw_decimal = True
            prev_was_digit = False
        else:
            return False
        index += 1
    return saw_digit and prev_was_digit


def has_valid_encoding_literal(raw: str) -> bool:
    if not raw.startswith("&"):
        return False
    body = raw[1:] if raw else ""
    if not body or not re.fullmatch(r"[A-Za-z0-9_-]+={0,2}", body):
        return False
    padding_index = body.find("=")
    return padding_index == -1 or all(char == "=" for char in body[padding_index:])


def format_datatype(datatype: TypeAnnotation | None) -> str | None:
    if datatype is None:
        return None
    name = datatype.name
    generic = ""
    if datatype.generic_args:
        generic = "<" + ", ".join(datatype.generic_args) + ">"
    clarifiers = ""
    if datatype.clarifiers:
        clarifiers = "[" + ", ".join(format_clarifier(value) for value in datatype.clarifiers) + "]"
    return f"{name}{generic}{clarifiers}"


def format_clarifier(value: str | int | float) -> str:
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    return str(value)


def type_annotation_to_json(datatype: TypeAnnotation | None) -> dict[str, object] | None:
    if datatype is None:
        return None
    name = datatype.name
    return {
        "type": "TypeAnnotation",
        "name": name,
        "genericArgs": datatype.generic_args,
        "clarifiers": datatype.clarifiers,
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
                result += f".@.{segment.key}"
            else:
                escaped = segment.key.replace('"', '\\"')
                result += f'.@.["{escaped}"]'
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
