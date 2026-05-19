from __future__ import annotations

import json
import re

from ._compat import dataclass


KNOWN_CONSTRAINT_KEYS = {
    "required",
    "type",
    "nullable",
    "allow_infinity",
    "allow_nan",
    "null_value",
    "toggle_pair",
    "reference",
    "reference_kind",
    "reference_target_pattern",
    "resolve_reference_form",
    "type_is",
    "length_exact",
    "min_children",
    "max_children",
    "sign",
    "min_digits",
    "max_digits",
    "min_value",
    "max_value",
    "min_length",
    "max_length",
    "pattern",
    "datatype",
    "attributes",
    "closed_attributes",
}

TYPE_ALIASES = {
    "NumberLiteral": {"NumberLiteral", "IntegerLiteral", "FloatLiteral"},
    "StringLiteral": {"StringLiteral"},
    "BooleanLiteral": {"BooleanLiteral"},
    "NullLiteral": {"NullLiteral"},
    "ToggleLiteral": {"ToggleLiteral"},
    "InfinityLiteral": {"InfinityLiteral"},
    "NaNLiteral": {"NaNLiteral"},
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
    "invalid_reference_constraint": "invalid_reference_constraint",
    "missing_required_field": "missing_required_field",
    "type_mismatch": "type_mismatch",
    "reference_required": "reference_required",
    "reference_forbidden": "reference_forbidden",
    "reference_kind_mismatch": "reference_kind_mismatch",
    "reference_target_mismatch": "reference_target_mismatch",
    "wrong_container_kind": "WRONG_CONTAINER_KIND",
    "tuple_arity_mismatch": "TUPLE_ARITY_MISMATCH",
    "tuple_element_type_mismatch": "TUPLE_ELEMENT_TYPE_MISMATCH",
    "container_cardinality_mismatch": "container_cardinality_mismatch",
    "null_value_mismatch": "null_value_mismatch",
    "toggle_pair_mismatch": "toggle_pair_mismatch",
    "invalid_index_format": "invalid_index_format",
    "numeric_form_violation": "numeric_form_violation",
    "string_length_violation": "string_length_violation",
    "pattern_mismatch": "pattern_mismatch",
    "datatype_allowlist_reject": "datatype_allowlist_reject",
    "trailing_separator_delimiter": "trailing_separator_delimiter",
    "unexpected_binding": "unexpected_binding",
    "unexpected_attribute_entry": "unexpected_attribute_entry",
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
                    "datatype": event.get("datatype") if isinstance(event.get("datatype"), str) else None,
                    "reference_path": value.get("path") if isinstance(value.get("path"), list) else None,
                    "attributes": build_attribute_info_map(event.get("annotations")),
                }
                if value.get("type") in {"TupleLiteral", "ListLiteral", "ListNode"} and isinstance(value.get("elements"), list):
                    elements = value.get("elements")
                    assert isinstance(elements, list)
                    container_arity[path_str] = len(elements)
                    hydrate_indexed_fallback(path_str, value, to_span_tuple(event.get("span")), events_by_path)
                elif value.get("type") == "ObjectNode" and isinstance(value.get("bindings"), list):
                    container_arity[path_str] = len(value.get("bindings", []))
                elif value.get("type") == "NodeLiteral" and isinstance(value.get("children"), list):
                    container_arity[path_str] = len(value.get("children", []))

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
    check_reference_forms(schema, rule_index, events_by_path, ctx)
    effective_events_by_path = resolve_reference_form_events(rule_index, events_by_path)
    check_types(rule_index, effective_events_by_path, ctx)

    for path, rule in rule_index.items():
        constraints = rule.get("constraints", {})
        expected_length = constraints.get("length_exact") if isinstance(constraints, dict) else None
        min_children = constraints.get("min_children") if isinstance(constraints, dict) else None
        max_children = constraints.get("max_children") if isinstance(constraints, dict) else None
        actual_length = container_arity.get(path)
        if isinstance(expected_length, int) and actual_length is not None and actual_length != expected_length:
            emit_error(ctx, create_diag(path, events_by_path.get(path, {}).get("span"), f"Tuple/List arity mismatch: expected {expected_length}, got {actual_length}", ERROR_CODES["tuple_arity_mismatch"]))
        if isinstance(min_children, int) and actual_length is not None and actual_length < min_children:
            emit_error(ctx, create_diag(path, events_by_path.get(path, {}).get("span"), f"Container cardinality mismatch: expected at least {min_children}, got {actual_length}", ERROR_CODES["container_cardinality_mismatch"]))
        if isinstance(max_children, int) and actual_length is not None and actual_length > max_children:
            emit_error(ctx, create_diag(path, events_by_path.get(path, {}).get("span"), f"Container cardinality mismatch: expected at most {max_children}, got {actual_length}", ERROR_CODES["container_cardinality_mismatch"]))

    check_literal_lexical_constraints(rule_index, effective_events_by_path, ctx)
    check_numeric_form(rule_index, effective_events_by_path, ctx)
    check_string_form(rule_index, effective_events_by_path, ctx)
    check_patterns(rule_index, effective_events_by_path, ctx)
    check_attribute_constraints(rule_index, effective_events_by_path, schema.get("datatype_rules"), ctx)
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


def validate_events(events: list[dict[str, object]], schema: dict[str, object], options: dict[str, object] | None = None) -> dict[str, object]:
    normalized: list[dict[str, object]] = []
    for event in events:
        path = event.get("path")
        if not isinstance(path, str):
            continue
        normalized.append({**event, "path": canonical_path_to_json(path)})
    return validate(normalized, schema, options)


def build_rule_index(schema: dict[str, object], ctx: DiagContext) -> dict[str, dict[str, object]]:
    index: dict[str, dict[str, object]] = {}
    reference_policy = schema.get("reference_policy")
    if reference_policy is not None and reference_policy not in {"allow", "forbid"}:
        emit_error(ctx, create_diag("$", None, f"Invalid schema reference_policy: {reference_policy}", ERROR_CODES["invalid_reference_constraint"]))
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
        if not validate_constraint_tree(schema, path, constraints, ctx):
            continue
        datatype = constraints.get("datatype")
        if allowlist is not None and isinstance(datatype, str) and datatype not in allowlist:
            emit_error(ctx, create_diag(path, None, f"Datatype '{datatype}' not allowed by schema datatype_allowlist", ERROR_CODES["datatype_allowlist_reject"]))
        index[path] = rule
    return index


def validate_constraint_tree(schema: dict[str, object], path: str, constraints: dict[str, object], ctx: DiagContext) -> bool:
    if any(key not in KNOWN_CONSTRAINT_KEYS for key in constraints.keys()):
        emit_error(ctx, create_diag(path, None, f"Unknown constraint key in rule for path: {path}", ERROR_CODES["unknown_constraint_key"]))
        return False
    if not validate_reference_constraints(schema, path, constraints, ctx):
        return False
    nested = constraints.get("attributes")
    if nested is None:
        return True
    if not isinstance(nested, dict):
        emit_error(ctx, create_diag(path, None, f"Invalid attributes constraint for path: {path}", ERROR_CODES["unknown_constraint_key"]))
        return False
    for key, child in nested.items():
        child_path = f"{path}@{key}"
        if not isinstance(child, dict):
            emit_error(ctx, create_diag(child_path, None, f"Invalid attribute constraint for path: {child_path}", ERROR_CODES["unknown_constraint_key"]))
            return False
        if not validate_constraint_tree(schema, child_path, child, ctx):
            return False
    return True


def validate_reference_constraints(
    schema: dict[str, object],
    path: str,
    constraints: dict[str, object],
    ctx: DiagContext,
) -> bool:
    reference = constraints.get("reference")
    reference_kind = constraints.get("reference_kind")
    reference_target_pattern = constraints.get("reference_target_pattern")
    resolve_reference_form = constraints.get("resolve_reference_form")
    expected_type = constraints.get("type")
    schema_reference_policy = schema.get("reference_policy")

    if reference is not None and reference not in {"allow", "forbid", "require"}:
        emit_error(ctx, create_diag(path, None, f"Invalid reference constraint for path {path}: {reference}", ERROR_CODES["invalid_reference_constraint"]))
        return False

    if reference_kind is not None and reference_kind not in {"clone", "pointer", "either"}:
        emit_error(ctx, create_diag(path, None, f"Invalid reference_kind constraint for path {path}: {reference_kind}", ERROR_CODES["invalid_reference_constraint"]))
        return False

    if reference_kind is not None and reference != "require":
        emit_error(ctx, create_diag(path, None, f"reference_kind requires reference='require' for path {path}", ERROR_CODES["invalid_reference_constraint"]))
        return False

    if reference_target_pattern is not None:
        if not isinstance(reference_target_pattern, str):
            emit_error(ctx, create_diag(path, None, f"Invalid reference_target_pattern constraint for path {path}: {reference_target_pattern}", ERROR_CODES["invalid_reference_constraint"]))
            return False
        try:
            re.compile(reference_target_pattern)
        except re.error:
            emit_error(ctx, create_diag(path, None, f"Invalid reference_target_pattern regex for path {path}: {reference_target_pattern}", ERROR_CODES["invalid_reference_constraint"]))
            return False
        if reference == "forbid":
            emit_error(ctx, create_diag(path, None, f"reference_target_pattern conflicts with reference='forbid' for path {path}", ERROR_CODES["invalid_reference_constraint"]))
            return False

    if resolve_reference_form is not None and not isinstance(resolve_reference_form, bool):
        emit_error(ctx, create_diag(path, None, f"resolve_reference_form must be boolean for path {path}", ERROR_CODES["invalid_reference_constraint"]))
        return False

    if reference == "forbid" and is_reference_type(expected_type):
        emit_error(ctx, create_diag(path, None, f"reference='forbid' conflicts with type='{expected_type}' for path {path}", ERROR_CODES["invalid_reference_constraint"]))
        return False

    if reference == "require" and isinstance(expected_type, str) and not is_reference_type(expected_type):
        emit_error(ctx, create_diag(path, None, f"reference='require' conflicts with non-reference type='{expected_type}' for path {path}", ERROR_CODES["invalid_reference_constraint"]))
        return False

    if reference_kind == "clone" and expected_type == "PointerReference":
        emit_error(ctx, create_diag(path, None, f"reference_kind='clone' conflicts with type='PointerReference' for path {path}", ERROR_CODES["invalid_reference_constraint"]))
        return False

    if reference_kind == "pointer" and expected_type == "CloneReference":
        emit_error(ctx, create_diag(path, None, f"reference_kind='pointer' conflicts with type='CloneReference' for path {path}", ERROR_CODES["invalid_reference_constraint"]))
        return False

    if schema_reference_policy == "forbid" and (reference == "require" or is_reference_type(expected_type)):
        emit_error(ctx, create_diag(path, None, f"schema reference_policy='forbid' conflicts with rule for path {path}", ERROR_CODES["invalid_reference_constraint"]))
        return False

    return True


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
            if not type_matches(expected_type, actual_type, constraints):
                code = ERROR_CODES["tuple_element_type_mismatch"] if is_tuple_element_path(path, events) else ERROR_CODES["type_mismatch"]
                emit_error(ctx, create_diag(path, event.get("span"), f"Type mismatch: expected {expected_type}, got {actual_type}", code))


def type_matches(expected_type: str, actual_type: str, constraints: dict[str, object]) -> bool:
    if constraints.get("nullable") is True and actual_type == "NullLiteral":
        return True
    if constraints.get("allow_infinity") is True and actual_type == "InfinityLiteral" and expected_type in {"NumberLiteral", "IntegerLiteral", "FloatLiteral"}:
        return True
    if constraints.get("allow_nan") is True and actual_type == "NaNLiteral" and expected_type in {"NumberLiteral", "IntegerLiteral", "FloatLiteral"}:
        return True
    return expected_type in TYPE_ALIASES.get(actual_type, {actual_type})


def is_tuple_element_path(path: str, events: dict[str, dict[str, object]]) -> bool:
    if not re.search(r"\[\d+\]$", path):
        return False
    parent_path = path[:path.rfind("[")]
    parent = events.get(parent_path)
    return isinstance(parent, dict) and parent.get("type") == "TupleLiteral"


def check_reference_forms(
    schema: dict[str, object],
    rule_index: dict[str, dict[str, object]],
    events: dict[str, dict[str, object]],
    ctx: DiagContext,
) -> None:
    if schema.get("reference_policy", "allow") == "forbid":
        for path, event in events.items():
            if not is_reference_type(event.get("type")):
                continue
            emit_error(ctx, create_diag(path, event.get("span"), f"References are forbidden by schema reference_policy, got {event.get('type')}", ERROR_CODES["reference_forbidden"]))

    for path, rule in rule_index.items():
        constraints = rule.get("constraints")
        if not isinstance(constraints, dict):
            continue
        reference = constraints.get("reference")
        reference_kind = constraints.get("reference_kind")
        event = events.get(path)
        if event is None:
            continue
        actual_type = event.get("type")

        if reference == "forbid":
            if is_reference_type(actual_type):
                emit_error(ctx, create_diag(path, event.get("span"), f"Reference not allowed at {path}, got {actual_type}", ERROR_CODES["reference_forbidden"]))
            continue

        if reference == "require":
            if not is_reference_type(actual_type):
                emit_error(ctx, create_diag(path, event.get("span"), f"Reference required at {path}, got {actual_type}", ERROR_CODES["reference_required"]))
                continue

            if reference_kind not in {None, "either"}:
                expected_type = "CloneReference" if reference_kind == "clone" else "PointerReference"
                if actual_type != expected_type:
                    emit_error(ctx, create_diag(path, event.get("span"), f"Reference kind mismatch at {path}: expected {expected_type}, got {actual_type}", ERROR_CODES["reference_kind_mismatch"]))
                    continue

        target_pattern = constraints.get("reference_target_pattern")
        if isinstance(target_pattern, str) and is_reference_type(actual_type):
            reference_path = event.get("reference_path")
            if isinstance(reference_path, list) and re.search(target_pattern, format_reference_target_path(reference_path)) is None:
                emit_error(ctx, create_diag(path, event.get("span"), f"Reference target path does not satisfy reference_target_pattern at {path}", ERROR_CODES["reference_target_mismatch"]))


def check_numeric_form(rule_index: dict[str, dict[str, object]], events: dict[str, dict[str, object]], ctx: DiagContext) -> None:
    for path, rule in rule_index.items():
        constraints = rule.get("constraints")
        if not isinstance(constraints, dict):
            continue
        sign = constraints.get("sign")
        min_digits = constraints.get("min_digits")
        max_digits = constraints.get("max_digits")
        min_value = constraints.get("min_value")
        max_value = constraints.get("max_value")
        if sign is None and min_digits is None and max_digits is None and min_value is None and max_value is None:
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
            continue
        normalized = normalize_integer_literal(raw)
        if min_value is not None or max_value is not None:
            if normalized is None:
                emit_error(ctx, create_diag(path, event.get("span"), "Numeric form violation: exact integer range constraints require integer literal form", ERROR_CODES["numeric_form_violation"]))
                continue
            numeric = int(normalized)
            if isinstance(min_value, str) and numeric < int(min_value):
                emit_error(ctx, create_diag(path, event.get("span"), f"Numeric form violation: expected value >= {min_value}, got {normalized}", ERROR_CODES["numeric_form_violation"]))
                continue
            if isinstance(max_value, str) and numeric > int(max_value):
                emit_error(ctx, create_diag(path, event.get("span"), f"Numeric form violation: expected value <= {max_value}, got {normalized}", ERROR_CODES["numeric_form_violation"]))


def check_literal_lexical_constraints(rule_index: dict[str, dict[str, object]], events: dict[str, dict[str, object]], ctx: DiagContext) -> None:
    for path, rule in rule_index.items():
        constraints = rule.get("constraints")
        if not isinstance(constraints, dict):
            continue
        event = events.get(path)
        if event is None:
            continue
        actual_type = event.get("type")
        if actual_type == "NullLiteral" and isinstance(constraints.get("null_value"), str) and event.get("value") != constraints.get("null_value"):
            emit_error(ctx, create_diag(path, event.get("span"), f"Null value mismatch: expected {constraints.get('null_value')}, got {event.get('value')}", ERROR_CODES["null_value_mismatch"]))
        if actual_type == "ToggleLiteral" and isinstance(constraints.get("toggle_pair"), str) and constraints.get("toggle_pair") != "any":
            raw = str(event.get("raw", "")).lower()
            pair = constraints.get("toggle_pair")
            allowed = raw in {"yes", "no"} if pair == "yes_no" else raw in {"on", "off"} if pair == "on_off" else True
            if not allowed:
                emit_error(ctx, create_diag(path, event.get("span"), f"Toggle pair mismatch: expected {pair}, got {raw}", ERROR_CODES["toggle_pair_mismatch"]))


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


def check_attribute_constraints(rule_index: dict[str, dict[str, object]], events: dict[str, dict[str, object]], datatype_rules: object, ctx: DiagContext) -> None:
    for path, rule in rule_index.items():
        constraints = rule.get("constraints")
        if not isinstance(constraints, dict):
            continue
        if "attributes" not in constraints and constraints.get("closed_attributes") is not True:
            continue
        event = events.get(path)
        if not isinstance(event, dict):
            continue
        validate_attribute_map(path, event.get("attributes"), constraints, datatype_rules, ctx)


def validate_attribute_map(base_path: str, attributes: object, constraints: dict[str, object], datatype_rules: object, ctx: DiagContext) -> None:
    attribute_map = attributes if isinstance(attributes, dict) else {}
    nested_rules = constraints.get("attributes")
    if isinstance(nested_rules, dict):
        for key, child_constraints in nested_rules.items():
            child_path = f"{base_path}@{key}"
            if not isinstance(child_constraints, dict):
                continue
            entry = attribute_map.get(key) if isinstance(attribute_map, dict) else None
            if child_constraints.get("required") is True and not isinstance(entry, dict):
                emit_error(ctx, create_diag(child_path, None, f"Missing required field: {child_path}", ERROR_CODES["missing_required_field"]))
                continue
            if not isinstance(entry, dict):
                continue
            validate_attribute_entry(child_path, entry, child_constraints, datatype_rules, ctx)

    if constraints.get("closed_attributes") is True and isinstance(attribute_map, dict):
        allowed = set(nested_rules.keys()) if isinstance(nested_rules, dict) else set()
        for key, entry in attribute_map.items():
            if key in allowed:
                continue
            span = entry.get("span") if isinstance(entry, dict) else None
            emit_error(ctx, create_diag(f"{base_path}@{key}", span, f"Unexpected attribute entry: {base_path}@{key}", ERROR_CODES["unexpected_attribute_entry"]))


def validate_attribute_entry(path: str, entry: dict[str, object], constraints: dict[str, object], datatype_rules: object, ctx: DiagContext) -> None:
    effective_constraints = merge_datatype_rule_constraints(constraints, entry.get("datatype"), datatype_rules)
    actual_type = entry.get("type")
    span = entry.get("span")
    raw = entry.get("raw", "") if isinstance(entry.get("raw", ""), str) else ""
    value = entry.get("value", "") if isinstance(entry.get("value", ""), str) else ""
    datatype = entry.get("datatype") if isinstance(entry.get("datatype"), str) else None

    expected_container = effective_constraints.get("type_is")
    if expected_container is not None and isinstance(actual_type, str):
        ok = expected_container == "list" and actual_type in {"ListLiteral", "ListNode"} or expected_container == "tuple" and actual_type == "TupleLiteral"
        if not ok:
            emit_error(ctx, create_diag(path, span, f"Container kind mismatch: expected {expected_container}, got {actual_type}", ERROR_CODES["wrong_container_kind"]))

    expected_type = effective_constraints.get("type")
    if isinstance(expected_type, str) and isinstance(actual_type, str) and not type_matches(expected_type, actual_type, effective_constraints):
        emit_error(ctx, create_diag(path, span, f"Type mismatch: expected {expected_type}, got {actual_type}", ERROR_CODES["type_mismatch"]))

    expected_datatype = effective_constraints.get("datatype")
    if isinstance(expected_datatype, str) and datatype != expected_datatype:
        emit_error(ctx, create_diag(path, span, f"Datatype mismatch: expected {expected_datatype}, got {datatype}", ERROR_CODES["type_mismatch"]))

    check_attribute_lexical_constraints(path, entry, effective_constraints, ctx)

    reference = effective_constraints.get("reference")
    if reference == "forbid" and is_reference_type(actual_type):
        emit_error(ctx, create_diag(path, span, f"Reference not allowed at {path}, got {actual_type}", ERROR_CODES["reference_forbidden"]))
    if reference == "require" and not is_reference_type(actual_type):
        emit_error(ctx, create_diag(path, span, f"Reference required at {path}, got {actual_type}", ERROR_CODES["reference_required"]))

    if reference == "require":
        reference_kind = effective_constraints.get("reference_kind")
        expected_reference_type = "CloneReference" if reference_kind == "clone" else "PointerReference" if reference_kind == "pointer" else None
        if expected_reference_type is not None and actual_type != expected_reference_type:
            emit_error(ctx, create_diag(path, span, f"Reference kind mismatch at {path}: expected {expected_reference_type}, got {actual_type}", ERROR_CODES["reference_kind_mismatch"]))

    if actual_type == "NumberLiteral":
        digit_count = count_integer_digits(raw)
        if effective_constraints.get("sign") == "unsigned" and is_negative(raw):
            emit_error(ctx, create_diag(path, span, "Numeric form violation: expected unsigned, got negative", ERROR_CODES["numeric_form_violation"]))
        min_digits = effective_constraints.get("min_digits")
        max_digits = effective_constraints.get("max_digits")
        min_value = effective_constraints.get("min_value")
        max_value = effective_constraints.get("max_value")
        if isinstance(min_digits, int) and digit_count < min_digits:
            emit_error(ctx, create_diag(path, span, f"Numeric form violation: expected min {min_digits} digits, got {digit_count}", ERROR_CODES["numeric_form_violation"]))
        if isinstance(max_digits, int) and digit_count > max_digits:
            emit_error(ctx, create_diag(path, span, f"Numeric form violation: expected max {max_digits} digits, got {digit_count}", ERROR_CODES["numeric_form_violation"]))
        if min_value is not None or max_value is not None:
            normalized = normalize_integer_literal(raw)
            if normalized is None:
                emit_error(ctx, create_diag(path, span, "Numeric form violation: exact integer range constraints require integer literal form", ERROR_CODES["numeric_form_violation"]))
            else:
                numeric = int(normalized)
                if isinstance(min_value, str) and numeric < int(min_value):
                    emit_error(ctx, create_diag(path, span, f"Numeric form violation: expected value >= {min_value}, got {normalized}", ERROR_CODES["numeric_form_violation"]))
                if isinstance(max_value, str) and numeric > int(max_value):
                    emit_error(ctx, create_diag(path, span, f"Numeric form violation: expected value <= {max_value}, got {normalized}", ERROR_CODES["numeric_form_violation"]))

    if actual_type == "StringLiteral":
        min_length = effective_constraints.get("min_length")
        max_length = effective_constraints.get("max_length")
        pattern = effective_constraints.get("pattern")
        length = len(value.encode("utf-16-le")) // 2
        if isinstance(min_length, int) and length < min_length:
            emit_error(ctx, create_diag(path, span, f"String form violation: expected min length {min_length}, got {length}", ERROR_CODES["string_length_violation"]))
        if isinstance(max_length, int) and length > max_length:
            emit_error(ctx, create_diag(path, span, f"String form violation: expected max length {max_length}, got {length}", ERROR_CODES["string_length_violation"]))
        if isinstance(pattern, str):
            regex = pattern
            if not regex.startswith("^"):
                regex = "^" + regex
            if not regex.endswith("$"):
                regex = regex + "$"
            if not re.search(regex, value):
                emit_error(ctx, create_diag(path, span, f"Pattern mismatch: value does not match pattern \"{pattern}\"", ERROR_CODES["pattern_mismatch"]))

    if "attributes" in effective_constraints or effective_constraints.get("closed_attributes") is True:
        validate_attribute_map(path, entry.get("attributes"), effective_constraints, datatype_rules, ctx)


def check_attribute_lexical_constraints(path: str, entry: dict[str, object], constraints: dict[str, object], ctx: DiagContext) -> None:
    actual_type = entry.get("type")
    if actual_type == "NullLiteral" and isinstance(constraints.get("null_value"), str) and entry.get("value") != constraints.get("null_value"):
        emit_error(ctx, create_diag(path, entry.get("span"), f"Null value mismatch: expected {constraints.get('null_value')}, got {entry.get('value')}", ERROR_CODES["null_value_mismatch"]))
    if actual_type == "ToggleLiteral" and isinstance(constraints.get("toggle_pair"), str) and constraints.get("toggle_pair") != "any":
        raw = str(entry.get("raw", "")).lower()
        pair = constraints.get("toggle_pair")
        allowed = raw in {"yes", "no"} if pair == "yes_no" else raw in {"on", "off"} if pair == "on_off" else True
        if not allowed:
            emit_error(ctx, create_diag(path, entry.get("span"), f"Toggle pair mismatch: expected {pair}, got {raw}", ERROR_CODES["toggle_pair_mismatch"]))


def merge_datatype_rule_constraints(constraints: dict[str, object], datatype: object, datatype_rules: object) -> dict[str, object]:
    if not isinstance(datatype, str) or not isinstance(datatype_rules, dict):
        return constraints
    rule = datatype_rules.get(datatype_base(datatype).lower())
    if not isinstance(rule, dict):
        return constraints
    return {**rule, **constraints}


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


def resolve_reference_form_events(rule_index: dict[str, dict[str, object]], events: dict[str, dict[str, object]]) -> dict[str, dict[str, object]]:
    resolved = dict(events)
    for path, rule in rule_index.items():
        constraints = rule.get("constraints")
        if not isinstance(constraints, dict) or constraints.get("resolve_reference_form") is not True:
            continue
        event = events.get(path)
        if not isinstance(event, dict) or not is_reference_type(event.get("type")):
            continue
        terminal = resolve_terminal_reference_event(event, events, set())
        if terminal is None:
            resolved.pop(path, None)
            continue
        resolved[path] = {**terminal, "span": event.get("span")}
    return resolved


def resolve_terminal_reference_event(event: dict[str, object], events: dict[str, dict[str, object]], active_paths: set[str]) -> dict[str, object] | None:
    if not is_reference_type(event.get("type")):
        return event
    reference_path = event.get("reference_path")
    if not isinstance(reference_path, list):
        return None
    target_path = format_reference_target_path(reference_path)
    if target_path in active_paths:
        return None
    target = events.get(target_path)
    if not isinstance(target, dict):
        return None
    active_paths.add(target_path)
    resolved = resolve_terminal_reference_event(target, events, active_paths) if is_reference_type(target.get("type")) else target
    active_paths.discard(target_path)
    return resolved


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
                escaped_key = key.replace("\\", "\\\\").replace('"', '\\"')
                result += f'.["{escaped_key}"]'
        elif seg_type == "index":
            result += f"[{segment.get('index')}]"
    return result or "$"


def format_reference_target_path(segments: list[object]) -> str:
    if not segments:
        return "$"
    out = "$"
    for segment in segments:
        if isinstance(segment, int):
            out += f"[{segment}]"
        elif isinstance(segment, str):
            if is_identifier_safe(segment):
                out += f".{segment}"
            else:
                escaped_key = segment.replace("\\", "\\\\").replace('"', '\\"')
                out += f'.["{escaped_key}"]'
        elif isinstance(segment, dict) and segment.get("type") == "attr":
            key = str(segment.get("key", ""))
            if is_identifier_safe(key):
                out += f"@{key}"
            else:
                escaped_key = key.replace("\\", "\\\\").replace('"', '\\"')
                out += f'@["{escaped_key}"]'
    return out


def is_reference_type(value_type: object) -> bool:
    return value_type in {"CloneReference", "PointerReference"}


def normalize_integer_literal(raw: str) -> str | None:
    if re.fullmatch(r"[+-]?\d[\d_]*", raw) is None:
        return None
    return raw.replace("_", "")


def canonical_path_to_json(path: str) -> dict[str, object]:
    segments: list[dict[str, object]] = [{"type": "root"}]
    index = 1 if path.startswith("$") else 0
    while index < len(path):
        if path[index] == ".":
            if path.startswith('.["', index):
                key, index = parse_quoted_member(path, index + 3)
                segments.append({"type": "member", "key": key})
            else:
                start = index + 1
                end = start
                while end < len(path) and path[end] not in ".[":
                    end += 1
                segments.append({"type": "member", "key": path[start:end]})
                index = end
                continue
        elif path[index] == "[":
            end = path.index("]", index)
            segments.append({"type": "index", "index": int(path[index + 1:end], 10)})
            index = end + 1
            continue
        index += 1
    return {"segments": segments}


def parse_quoted_member(path: str, start: int) -> tuple[str, int]:
    value_chars: list[str] = []
    index = start
    while index < len(path):
        char = path[index]
        if char == "\\":
            index += 1
            if index >= len(path):
                break
            value_chars.append(path[index])
            index += 1
            continue
        if char == '"' and index + 1 < len(path) and path[index + 1] == "]":
            return "".join(value_chars), index + 2
        value_chars.append(char)
        index += 1
    raise ValueError(f"Invalid canonical path: {path}")


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
            "reference_path": element.get("path") if isinstance(element.get("path"), list) else None,
            "attributes": build_attribute_info_map(element.get("attributes")),
        }


def build_attribute_info_map(attributes: object) -> dict[str, dict[str, object]] | None:
    if not isinstance(attributes, dict) or not attributes:
        return None
    mapped: dict[str, dict[str, object]] = {}
    for key, entry in attributes.items():
        if not isinstance(entry, dict):
            continue
        value = entry.get("value")
        if not isinstance(value, dict):
            continue
        mapped[str(key)] = {
            "type": value.get("type"),
            "raw": value.get("raw", "") if isinstance(value.get("raw", ""), str) else "",
            "value": value.get("value", "") if isinstance(value.get("value", ""), str) else "",
            "span": to_span_tuple(value.get("span")),
            "datatype": entry.get("datatype") if isinstance(entry.get("datatype"), str) else None,
            "attributes": build_attribute_info_map(entry.get("annotations")),
        }
    return mapped


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


def datatype_base(datatype: str) -> str:
    generic_index = datatype.find("<")
    separator_index = datatype.find("[")
    end_index = min(index for index in [generic_index if generic_index != -1 else len(datatype), separator_index if separator_index != -1 else len(datatype), len(datatype)])
    return datatype[:end_index]


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
