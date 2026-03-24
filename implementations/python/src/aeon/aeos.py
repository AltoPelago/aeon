from __future__ import annotations

from dataclasses import dataclass
import json
import re


KNOWN_CONSTRAINT_KEYS = {
    "required",
    "type",
    "type_is",
    "length_exact",
    "sign",
    "min_digits",
    "max_digits",
    "min_length",
    "max_length",
    "pattern",
    "datatype",
}

TYPE_ALIASES = {
    "NumberLiteral": {"NumberLiteral", "IntegerLiteral", "FloatLiteral"},
    "StringLiteral": {"StringLiteral"},
    "BooleanLiteral": {"BooleanLiteral"},
    "NullLiteral": {"NullLiteral"},
    "ObjectNode": {"ObjectNode"},
    "ListNode": {"ListNode"},
    "ListLiteral": {"ListNode", "ListLiteral"},
    "TupleLiteral": {"TupleLiteral"},
    "CloneReference": {"CloneReference"},
    "PointerReference": {"PointerReference"},
}

ERROR_CODES = {
    "duplicate_binding": "duplicate_binding",
    "rule_missing_path": "rule_missing_path",
    "duplicate_rule_path": "duplicate_rule_path",
    "unknown_constraint_key": "unknown_constraint_key",
    "missing_required_field": "missing_required_field",
    "type_mismatch": "type_mismatch",
    "wrong_container_kind": "WRONG_CONTAINER_KIND",
    "tuple_arity_mismatch": "TUPLE_ARITY_MISMATCH",
    "tuple_element_type_mismatch": "TUPLE_ELEMENT_TYPE_MISMATCH",
    "invalid_index_format": "invalid_index_format",
    "numeric_form_violation": "numeric_form_violation",
    "string_length_violation": "string_length_violation",
    "pattern_mismatch": "pattern_mismatch",
    "datatype_allowlist_reject": "datatype_allowlist_reject",
    "trailing_separator_delimiter": "trailing_separator_delimiter",
    "unexpected_binding": "unexpected_binding",
}


@dataclass(slots=True)
class DiagContext:
    errors: list[dict[str, object]]
    warnings: list[dict[str, object]]


def validate(aes: list[dict[str, object]], schema: dict[str, object], options: dict[str, object] | None = None) -> dict[str, object]:
    opts = options or {}
    trailing_policy = str(opts.get("trailingSeparatorDelimiterPolicy", "off"))
    ctx = DiagContext(errors=[], warnings=[])

    seen: dict[str, object] = {}
    bound_paths: set[str] = set()
    events_by_path: dict[str, dict[str, object]] = {}
    container_arity: dict[str, int] = {}

    for event in aes:
        path_str = format_canonical_path(event.get("path"))
        for segment in event.get("path", {}).get("segments", []) if isinstance(event.get("path"), dict) else []:
            if isinstance(segment, dict) and segment.get("type") == "index":
                idx = segment.get("index")
                if not isinstance(idx, int) or idx < 0:
                    emit_error(ctx, create_diag(path_str, to_span_tuple(event.get("span")), f"Invalid index segment format at {path_str}", ERROR_CODES["invalid_index_format"]))

        if path_str in seen:
            emit_error(ctx, create_diag(path_str, to_span_tuple(event.get("span")), f"Duplicate binding: {path_str}", ERROR_CODES["duplicate_binding"]))
        else:
            seen[path_str] = event.get("span")
            bound_paths.add(path_str)
            value = event.get("value")
            if isinstance(value, dict) and isinstance(value.get("type"), str):
                events_by_path[path_str] = {
                    "type": value.get("type"),
                    "raw": value.get("raw", "") if isinstance(value.get("raw", ""), str) else "",
                    "value": value.get("value", "") if isinstance(value.get("value", ""), str) else "",
                    "span": to_span_tuple(event.get("span")),
                }
                if value.get("type") in {"TupleLiteral", "ListLiteral", "ListNode"} and isinstance(value.get("elements"), list):
                    elements = value.get("elements")
                    assert isinstance(elements, list)
                    container_arity[path_str] = len(elements)
                    hydrate_indexed_fallback(path_str, value, to_span_tuple(event.get("span")), events_by_path)

    if trailing_policy != "off":
        for event in aes:
            value = event.get("value")
            if not isinstance(value, dict) or value.get("type") != "SeparatorLiteral":
                continue
            payload = value.get("value")
            if not isinstance(payload, str) or not payload:
                continue
            separators = decode_separator_chars(event.get("datatype") if isinstance(event.get("datatype"), str) else None)
            if not separators:
                continue
            last_char = payload[-1]
            if last_char not in separators:
                continue
            diag = create_diag(format_canonical_path(event.get("path")), to_span_tuple(event.get("span")), f"Separator literal payload ends with declared separator '{last_char}'", ERROR_CODES["trailing_separator_delimiter"])
            if trailing_policy == "warn":
                emit_warning(ctx, diag)
            else:
                emit_error(ctx, diag)

    rule_index = build_rule_index(schema, ctx)
    check_presence(rule_index, bound_paths, ctx)
    check_types(rule_index, events_by_path, ctx)

    for path, rule in rule_index.items():
        expected_length = rule.get("constraints", {}).get("length_exact")
        actual_length = container_arity.get(path)
        if isinstance(expected_length, int) and actual_length is not None and actual_length != expected_length:
            emit_error(ctx, create_diag(path, events_by_path.get(path, {}).get("span"), f"Tuple/List arity mismatch: expected {expected_length}, got {actual_length}", ERROR_CODES["tuple_arity_mismatch"]))

    check_numeric_form(rule_index, events_by_path, ctx)
    check_string_form(rule_index, events_by_path, ctx)
    check_patterns(rule_index, events_by_path, ctx)
    check_world_policy(schema, aes, bound_paths, ctx)

    if ctx.errors:
        return {
            "ok": False,
            "errors": ctx.errors,
            "warnings": ctx.warnings,
            "guarantees": {},
        }

    guarantees = build_guarantees(bound_paths, events_by_path)
    return {
        "ok": True,
        "errors": [],
        "warnings": ctx.warnings,
        "guarantees": guarantees,
    }


def build_rule_index(schema: dict[str, object], ctx: DiagContext) -> dict[str, dict[str, object]]:
    index: dict[str, dict[str, object]] = {}
    datatype_allowlist = schema.get("datatype_allowlist")
    allowlist = datatype_allowlist if isinstance(datatype_allowlist, list) else None
    rules = schema.get("rules")
    if not isinstance(rules, list):
        return index
    for rule in rules:
        if not isinstance(rule, dict):
            continue
        path = rule.get("path")
        constraints = rule.get("constraints")
        if not isinstance(path, str):
            emit_error(ctx, create_diag("<unknown>", None, 'Rule missing required "path" field', ERROR_CODES["rule_missing_path"]))
            continue
        if path in index:
            emit_error(ctx, create_diag(path, None, f"Duplicate rule for path: {path}", ERROR_CODES["duplicate_rule_path"]))
            continue
        if not isinstance(constraints, dict):
            constraints = {}
            rule["constraints"] = constraints
        if any(key not in KNOWN_CONSTRAINT_KEYS for key in constraints.keys()):
            emit_error(ctx, create_diag(path, None, f"Unknown constraint key in rule for path: {path}", ERROR_CODES["unknown_constraint_key"]))
            continue
        datatype = constraints.get("datatype")
        if allowlist is not None and isinstance(datatype, str) and datatype not in allowlist:
            emit_error(ctx, create_diag(path, None, f"Datatype '{datatype}' not allowed by schema datatype_allowlist", ERROR_CODES["datatype_allowlist_reject"]))
        index[path] = rule
    return index


def check_presence(rule_index: dict[str, dict[str, object]], bound_paths: set[str], ctx: DiagContext) -> None:
    for path, rule in rule_index.items():
        constraints = rule.get("constraints")
        if isinstance(constraints, dict) and constraints.get("required") is True and path not in bound_paths:
            emit_error(ctx, create_diag(path, None, f"Missing required field: {path}", ERROR_CODES["missing_required_field"]))


def check_types(rule_index: dict[str, dict[str, object]], events: dict[str, dict[str, object]], ctx: DiagContext) -> None:
    for path, rule in rule_index.items():
        constraints = rule.get("constraints")
        if not isinstance(constraints, dict):
            continue
        expected_type = constraints.get("type")
        expected_container = constraints.get("type_is")
        if expected_type is None and expected_container is None:
            continue
        event = events.get(path)
        if event is None:
            continue
        actual_type = event.get("type")
        if not isinstance(actual_type, str):
            continue
        if expected_container is not None:
            ok = expected_container == "list" and actual_type in {"ListLiteral", "ListNode"} or expected_container == "tuple" and actual_type == "TupleLiteral"
            if not ok:
                emit_error(ctx, create_diag(path, event.get("span"), f"Container kind mismatch: expected {expected_container}, got {actual_type}", ERROR_CODES["wrong_container_kind"]))
        if isinstance(expected_type, str):
            if expected_type not in TYPE_ALIASES.get(actual_type, {actual_type}):
                code = ERROR_CODES["tuple_element_type_mismatch"] if re.search(r"\[\d+\]$", path) else ERROR_CODES["type_mismatch"]
                emit_error(ctx, create_diag(path, event.get("span"), f"Type mismatch: expected {expected_type}, got {actual_type}", code))


def check_numeric_form(rule_index: dict[str, dict[str, object]], events: dict[str, dict[str, object]], ctx: DiagContext) -> None:
    for path, rule in rule_index.items():
        constraints = rule.get("constraints")
        if not isinstance(constraints, dict):
            continue
        sign = constraints.get("sign")
        min_digits = constraints.get("min_digits")
        max_digits = constraints.get("max_digits")
        if sign is None and min_digits is None and max_digits is None:
            continue
        event = events.get(path)
        if event is None or event.get("type") not in {"NumberLiteral", "IntegerLiteral", "FloatLiteral"}:
            continue
        raw = str(event.get("raw", ""))
        if sign == "unsigned" and is_negative(raw):
            emit_error(ctx, create_diag(path, event.get("span"), "Numeric form violation: expected unsigned, got negative", ERROR_CODES["numeric_form_violation"]))
            continue
        digit_count = count_integer_digits(raw)
        if isinstance(min_digits, int) and digit_count < min_digits:
            emit_error(ctx, create_diag(path, event.get("span"), f"Numeric form violation: expected min {min_digits} digits, got {digit_count}", ERROR_CODES["numeric_form_violation"]))
            continue
        if isinstance(max_digits, int) and digit_count > max_digits:
            emit_error(ctx, create_diag(path, event.get("span"), f"Numeric form violation: expected max {max_digits} digits, got {digit_count}", ERROR_CODES["numeric_form_violation"]))


def check_string_form(rule_index: dict[str, dict[str, object]], events: dict[str, dict[str, object]], ctx: DiagContext) -> None:
    for path, rule in rule_index.items():
        constraints = rule.get("constraints")
        if not isinstance(constraints, dict):
            continue
        min_length = constraints.get("min_length")
        max_length = constraints.get("max_length")
        pattern = constraints.get("pattern")
        if min_length is None and max_length is None and pattern is None:
            continue
        event = events.get(path)
        if event is None or event.get("type") != "StringLiteral":
            continue
        value = str(event.get("value", ""))
        length = len(value.encode("utf-16-le")) // 2
        if isinstance(min_length, int) and length < min_length:
            emit_error(ctx, create_diag(path, event.get("span"), f"String form violation: expected min length {min_length}, got {length}", ERROR_CODES["string_length_violation"]))
            continue
        if isinstance(max_length, int) and length > max_length:
            emit_error(ctx, create_diag(path, event.get("span"), f"String form violation: expected max length {max_length}, got {length}", ERROR_CODES["string_length_violation"]))


def check_patterns(rule_index: dict[str, dict[str, object]], events: dict[str, dict[str, object]], ctx: DiagContext) -> None:
    for path, rule in rule_index.items():
        constraints = rule.get("constraints")
        if not isinstance(constraints, dict):
            continue
        pattern = constraints.get("pattern")
        if not isinstance(pattern, str):
            continue
        event = events.get(path)
        if event is None or event.get("type") != "StringLiteral":
            continue
        regex = pattern
        if not regex.startswith("^"):
            regex = "^" + regex
        if not regex.endswith("$"):
            regex = regex + "$"
        if not re.search(regex, str(event.get("value", ""))):
            emit_error(ctx, create_diag(path, event.get("span"), f"Pattern mismatch: value does not match pattern \"{pattern}\"", ERROR_CODES["pattern_mismatch"]))


def check_world_policy(schema: dict[str, object], aes: list[dict[str, object]], bound_paths: set[str], ctx: DiagContext) -> None:
    if str(schema.get("world", "open")) != "closed":
        return

    rules = schema.get("rules")
    if not isinstance(rules, list):
        return

    allowed_paths = {
        path
        for rule in rules
        if isinstance(rule, dict)
        for path in [rule.get("path")]
        if isinstance(path, str)
    }

    for event in aes:
        key = event.get("key")
        if isinstance(key, str) and key.startswith("aeon:"):
            continue
        path = format_canonical_path(event.get("path"))
        if path not in bound_paths or path in allowed_paths:
            continue
        emit_error(
            ctx,
            create_diag(
                path,
                to_span_tuple(event.get("span")),
                f"Binding '{path}' is not allowed by closed-world schema",
                ERROR_CODES["unexpected_binding"],
            ),
        )


def build_guarantees(bound_paths: set[str], events: dict[str, dict[str, object]]) -> dict[str, list[str]]:
    guarantees: dict[str, list[str]] = {}

    def add(path: str, tag: str) -> None:
        guarantees.setdefault(path, [])
        if tag not in guarantees[path]:
            guarantees[path].append(tag)

    int_re = re.compile(r"^[+-]?\d+$")
    float_re = re.compile(r"^[+-]?(?:\d+\.\d*|\d*\.\d+|\d+)(?:[eE][+-]?\d+)?$")

    for path in sorted(bound_paths):
        add(path, "present")
    for path, info in events.items():
        typ = info.get("type")
        raw = str(info.get("raw", ""))
        value = str(info.get("value", ""))
        if typ == "NumberLiteral":
            if int_re.match(raw):
                add(path, "integer-representable")
            if float_re.match(raw):
                add(path, "float-representable")
        elif typ == "StringLiteral":
            if int_re.match(value):
                add(path, "integer-representable")
            if float_re.match(value):
                add(path, "float-representable")
            if value in {"true", "false"}:
                add(path, "boolean-representable")
            if value:
                add(path, "non-empty-string")
        elif typ == "BooleanLiteral":
            add(path, "boolean-representable")
    return guarantees


def create_diag(path: str, span: object, message: str, code: str) -> dict[str, object]:
    return {
        "path": path,
        "span": span,
        "message": message,
        "phase": "schema_validation",
        "code": code,
    }


def emit_error(ctx: DiagContext, diag: dict[str, object]) -> None:
    ctx.errors.append(diag)


def emit_warning(ctx: DiagContext, diag: dict[str, object]) -> None:
    ctx.warnings.append(diag)


def format_canonical_path(path: object) -> str:
    if not isinstance(path, dict):
        return "$"
    segments = path.get("segments")
    if not isinstance(segments, list):
        return "$"
    result = ""
    for segment in segments:
        if not isinstance(segment, dict):
            continue
        seg_type = segment.get("type")
        if seg_type == "root":
            result = "$"
        elif seg_type == "member":
            key = str(segment.get("key", ""))
            if is_identifier_safe(key):
                result += f".{key}"
            else:
                result += f'.["{key.replace("\\", "\\\\").replace("\"", "\\\"")}"]'
        elif seg_type == "index":
            result += f"[{segment.get('index')}]"
    return result or "$"


def to_span_tuple(span: object) -> list[int] | None:
    if span is None:
        return None
    if isinstance(span, list) and len(span) == 2 and all(isinstance(item, int) for item in span):
        return [int(span[0]), int(span[1])]
    if isinstance(span, dict):
        start = span.get("start")
        end = span.get("end")
        if isinstance(start, dict) and isinstance(end, dict) and isinstance(start.get("offset"), int) and isinstance(end.get("offset"), int):
            return [int(start["offset"]), int(end["offset"])]
    return None


def hydrate_indexed_fallback(base_path: str, value: dict[str, object], fallback_span: list[int] | None, events_by_path: dict[str, dict[str, object]]) -> None:
    elements = value.get("elements")
    if not isinstance(elements, list):
        return
    for index, element in enumerate(elements):
        element_path = f"{base_path}[{index}]"
        if element_path in events_by_path:
            continue
        if not isinstance(element, dict):
            continue
        events_by_path[element_path] = {
            "type": str(element.get("type", "Unknown")),
            "raw": str(element.get("raw", "")) if isinstance(element.get("raw", ""), str) else "",
            "value": str(element.get("value", "")) if isinstance(element.get("value", ""), str) else "",
            "span": to_span_tuple(element.get("span")) or fallback_span,
        }


def decode_separator_chars(datatype: str | None) -> list[str]:
    if not datatype:
        return []
    match = re.search(r"\[([^\]]*)\]$", datatype)
    if match is None:
        return []
    payload = match.group(1)
    if not payload:
        return []
    separators: list[str] = []
    index = 0
    while index < len(payload):
        separators.append(payload[index])
        index += 1
        if index < len(payload):
            if payload[index] != ",":
                return []
            index += 1
    return separators


def count_integer_digits(raw: str) -> int:
    text = raw[1:] if raw.startswith(("+", "-")) else raw
    decimal_index = text.find(".")
    exp_index_e = text.find("e")
    exp_index_E = text.find("E")
    exp_index = min(index for index in [decimal_index if decimal_index != -1 else len(text), exp_index_e if exp_index_e != -1 else len(text), exp_index_E if exp_index_E != -1 else len(text), len(text)])
    return sum(1 for char in text[:exp_index] if char.isdigit())


def is_negative(raw: str) -> bool:
    return raw.startswith("-")


def is_identifier_safe(value: str) -> bool:
    if not value:
        return False
    if not (value[0].isalpha() or value[0] == "_"):
        return False
    return all(char.isalnum() or char == "_" for char in value[1:])


def validate_cts_payload(payload_text: str) -> str:
    payload = json.loads(payload_text)
    aes = payload.get("aes")
    schema = payload.get("schema")
    options = payload.get("options")
    if not isinstance(aes, list):
        raise ValueError('Missing or invalid "aes" field')
    if not isinstance(schema, dict):
        raise ValueError('Missing or invalid "schema" field')
    result = validate(aes, schema, options if isinstance(options, dict) else None)
    return json.dumps(result)
