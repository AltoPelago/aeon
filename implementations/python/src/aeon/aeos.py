from __future__ import annotations

import json
import re

from ._compat import dataclass
from .sansa import parse_address as parse_sansa_address, resolve_address as resolve_sansa_address


KNOWN_CONSTRAINT_KEYS = {
    "required",
    "type",
    "any_of",
    "nullable",
    "allow_infinity",
    "allow_nan",
    "null_value",
    "null_values",
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
    "radix",
    "allow_unspecified_radix",
    "min_value",
    "max_value",
    "min_length",
    "max_length",
    "pattern",
    "datatype",
    "attributes",
    "closed_attributes",
}

MAX_SCHEMA_REGEX_LENGTH = 512
PORTABLE_REGEX_ESCAPES = set("0bBdDfnrsStvwW\\^$.|?*+()[]{}-")
RESOURCE_POLICY_KEYS = {
    "max_events",
    "max_rules",
    "max_any_of_cases",
    "max_schema_depth",
    "max_path_length",
    "max_reference_resolution_steps",
    "max_selector_expansions",
    "max_string_length_default",
    "max_container_children_default",
}
DEFAULT_RESOURCE_POLICY = {
    "max_events": 100_000,
    "max_rules": 10_000,
    "max_any_of_cases": 64,
    "max_schema_depth": 64,
    "max_path_length": 4_096,
    "max_reference_resolution_steps": 64,
    "max_selector_expansions": 100_000,
    "max_string_length_default": 10_000_000,
    "max_container_children_default": 1_000_000,
}

STRING_LIKE_VALUE_TYPES = {
    "StringLiteral",
    "TrimtickLiteral",
    "SeparatorLiteral",
    "HexLiteral",
    "EncodingLiteral",
    "NullLiteral",
    "DateLiteral",
    "TimeLiteral",
    "DateTimeLiteral",
    "WTCDateTimeLiteral",
}


def _is_regex_quantifier_start(pattern: str, index: int) -> bool:
    return index < len(pattern) and pattern[index] in "*+{"


def _has_nested_quantified_group(pattern: str) -> bool:
    stack: list[dict[str, bool]] = []
    escaped = False
    in_class = False

    for index, char in enumerate(pattern):
        if escaped:
            escaped = False
            continue
        if char == "\\":
            escaped = True
            continue
        if char == "[":
            in_class = True
            continue
        if char == "]" and in_class:
            in_class = False
            continue
        if in_class:
            continue
        if char == "(":
            stack.append({"inner": False})
            continue
        if char == ")":
            group = stack.pop() if stack else None
            if group is None:
                continue
            if group["inner"] and _is_regex_quantifier_start(pattern, index + 1):
                return True
            if stack and _is_regex_quantifier_start(pattern, index + 1):
                stack[-1]["inner"] = True
            continue
        if stack and _is_regex_quantifier_start(pattern, index):
            stack[-1]["inner"] = True

    return False


def _portable_pattern_problem(pattern: str) -> str | None:
    if len(pattern) > MAX_SCHEMA_REGEX_LENGTH:
        return f"regex exceeds {MAX_SCHEMA_REGEX_LENGTH} characters"

    stack: list[str] = []
    escaped = False
    in_class = False
    for index, char in enumerate(pattern):
        if escaped:
            if re.fullmatch(r"[1-9]", char):
                return "backreferences are not part of the AEOS portable pattern profile"
            if char in {"p", "P"} and index + 1 < len(pattern) and pattern[index + 1] == "{":
                return "Unicode property escapes are not part of the AEOS portable pattern profile"
            if char == "k" and index + 1 < len(pattern) and pattern[index + 1] == "<":
                return "named backreferences are not part of the AEOS portable pattern profile"
            if re.fullmatch(r"[A-Za-z0-9]", char) and char not in PORTABLE_REGEX_ESCAPES:
                return f"unsupported escape sequence \\{char}"
            escaped = False
            continue
        if char == "\\":
            escaped = True
            continue
        if in_class:
            if char == "]":
                in_class = False
            continue
        if char == "[":
            in_class = True
            continue
        if char == "(":
            if index + 1 < len(pattern) and pattern[index + 1] == "?":
                if index + 2 >= len(pattern) or pattern[index + 2] != ":":
                    return "lookaround, named groups, and inline regex flags are not part of the AEOS portable pattern profile"
            stack.append("(")
            continue
        if char == ")":
            if not stack:
                return "unmatched closing group"
            stack.pop()

    if escaped:
        return "trailing escape"
    if in_class:
        return "unterminated character class"
    if stack:
        return "unterminated group"
    if _has_nested_quantified_group(pattern):
        return "regex contains a nested quantified group"
    try:
        re.compile(pattern)
    except re.error:
        return "regex is not valid portable syntax"
    return None


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
    "invalid_schema_policy": "invalid_schema_policy",
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
    resource_policy = resolve_resource_policy(schema.get("resource_policy"), opts.get("resourcePolicy"), ctx)
    if len(aes) > resource_policy["max_events"]:
        emit_resource_error(ctx, "$", f"AES event count {len(aes)} exceeds max_events {resource_policy['max_events']}")
    rules = schema.get("rules")
    if isinstance(rules, list) and len(rules) > resource_policy["max_rules"]:
        emit_resource_error(ctx, "$", f"Schema rule count {len(rules)} exceeds max_rules {resource_policy['max_rules']}")
    inspect_schema_resource_shape(schema, resource_policy, ctx)
    if ctx.errors:
        return {"ok": False, "errors": ctx.errors, "warnings": ctx.warnings, "guarantees": {}}

    seen: dict[str, object] = {}
    bound_paths: set[str] = set()
    events_by_path: dict[str, dict[str, object]] = {}
    container_arity: dict[str, int] = {}

    for event in aes:
        path_str = format_canonical_path(event.get("path"))
        if len(path_str) > resource_policy["max_path_length"]:
            emit_resource_error(ctx, path_str, f"Path length {len(path_str)} exceeds max_path_length {resource_policy['max_path_length']}", to_span_tuple(event.get("span")))
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
                info = {
                    "type": value.get("type"),
                    "raw": value.get("raw", "") if isinstance(value.get("raw", ""), str) else "",
                    "value": value.get("value", "") if isinstance(value.get("value", ""), str) else "",
                    "span": to_span_tuple(event.get("span")),
                    "datatype": event.get("datatype") if isinstance(event.get("datatype"), str) else None,
                    "reference_path": value.get("path") if isinstance(value.get("path"), list) else None,
                    "attributes": build_attribute_info_map(event.get("annotations")),
                }
                events_by_path[path_str] = info
                hydrate_attribute_info_events(path_str, info.get("attributes"), events_by_path)
                if value.get("type") in {"TupleLiteral", "ListLiteral", "ListNode"} and isinstance(value.get("elements"), list):
                    elements = value.get("elements")
                    assert isinstance(elements, list)
                    container_arity[path_str] = len(elements)
                    if len(elements) > resource_policy["max_container_children_default"]:
                        emit_resource_error(ctx, path_str, f"Container child count {len(elements)} exceeds max_container_children_default {resource_policy['max_container_children_default']}", to_span_tuple(event.get("span")))
                    hydrate_indexed_fallback(path_str, value, to_span_tuple(event.get("span")), events_by_path)
                elif value.get("type") == "ObjectNode" and isinstance(value.get("bindings"), list):
                    bindings = value.get("bindings", [])
                    container_arity[path_str] = len(bindings)
                    if len(bindings) > resource_policy["max_container_children_default"]:
                        emit_resource_error(ctx, path_str, f"Container child count {len(bindings)} exceeds max_container_children_default {resource_policy['max_container_children_default']}", to_span_tuple(event.get("span")))
                elif value.get("type") == "NodeLiteral" and isinstance(value.get("children"), list):
                    children = value.get("children", [])
                    container_arity[path_str] = len(children)
                    if len(children) > resource_policy["max_container_children_default"]:
                        emit_resource_error(ctx, path_str, f"Container child count {len(children)} exceeds max_container_children_default {resource_policy['max_container_children_default']}", to_span_tuple(event.get("span")))

    bound_paths.update(events_by_path.keys())

    for path_str, info in events_by_path.items():
        enforce_string_length_resource_budget(info, path_str, resource_policy, ctx)

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
    expansion_budget = {"count": 0}
    expanded_rule_index = expand_selector_rules(rule_index, schema, events_by_path, ctx, resource_policy, expansion_budget)
    effective_rule_index = merge_datatype_rules(expanded_rule_index, schema.get("datatype_rules"), events_by_path)
    check_presence(effective_rule_index, bound_paths, ctx)
    check_reference_forms(schema, effective_rule_index, events_by_path, ctx)
    effective_events_by_path = resolve_reference_form_events(effective_rule_index, events_by_path, resource_policy, ctx)
    selected_rule_index = select_any_of_rules(effective_rule_index, effective_events_by_path, ctx)
    check_types(selected_rule_index, effective_events_by_path, ctx)

    for path, rule in selected_rule_index.items():
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

    check_literal_lexical_constraints(selected_rule_index, effective_events_by_path, ctx)
    check_numeric_form(selected_rule_index, effective_events_by_path, ctx)
    check_string_form(selected_rule_index, effective_events_by_path, ctx)
    check_patterns(selected_rule_index, effective_events_by_path, ctx)
    check_attribute_constraints(selected_rule_index, effective_events_by_path, schema.get("datatype_rules"), ctx)
    check_world_policy(schema, aes, bound_paths, events_by_path, ctx)

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


def emit_resource_error(ctx: DiagContext, path: str, message: str, span: tuple[int, int] | None = None) -> None:
    emit_error(ctx, create_diag(path, span, message, ERROR_CODES["invalid_schema_policy"]))


def string_like_payload_length(info: dict[str, object]) -> int | None:
    if info.get("type") not in STRING_LIKE_VALUE_TYPES:
        return None
    value = info.get("value")
    raw = info.get("raw")
    payload = value if isinstance(value, str) and value else raw
    return len(payload) if isinstance(payload, str) else 0


def enforce_string_length_resource_budget(info: dict[str, object], path: str, policy: dict[str, int], ctx: DiagContext) -> None:
    payload_length = string_like_payload_length(info)
    if payload_length is not None and payload_length > policy["max_string_length_default"]:
        emit_resource_error(
            ctx,
            path,
            f"String-like payload length {payload_length} exceeds max_string_length_default {policy['max_string_length_default']}",
            info.get("span") if isinstance(info.get("span"), tuple) else None,
        )
    attributes = info.get("attributes")
    if isinstance(attributes, dict):
        for key, attribute in attributes.items():
            if isinstance(attribute, dict):
                enforce_string_length_resource_budget(attribute, f"{path}.@.{key}", policy, ctx)


def normalize_resource_policy(policy: object, source: str, ctx: DiagContext) -> dict[str, int]:
    if policy is None:
        return {}
    if not isinstance(policy, dict):
        emit_resource_error(ctx, "$", f"{source} resource policy must be an object")
        return {}
    normalized: dict[str, int] = {}
    for key, value in policy.items():
        if key not in RESOURCE_POLICY_KEYS:
            emit_resource_error(ctx, "$", f"Unknown {source} resource policy key: {key}")
            continue
        if not isinstance(value, int) or value < 0:
            emit_resource_error(ctx, "$", f"{source} resource policy {key} must be a non-negative integer")
            continue
        normalized[str(key)] = value
    return normalized


def resolve_resource_policy(schema_policy: object, option_policy: object, ctx: DiagContext) -> dict[str, int]:
    return {
        **DEFAULT_RESOURCE_POLICY,
        **normalize_resource_policy(schema_policy, "schema", ctx),
        **normalize_resource_policy(option_policy, "option", ctx),
    }


def inspect_schema_resource_shape(schema: dict[str, object], policy: dict[str, int], ctx: DiagContext) -> None:
    rules = schema.get("rules")
    if isinstance(rules, list):
        for rule in rules:
            if not isinstance(rule, dict):
                continue
            rule_path = rule.get("path") if isinstance(rule.get("path"), str) and rule.get("path") else rule.get("selector")
            path = rule_path if isinstance(rule_path, str) and rule_path else "$"
            if len(path) > policy["max_path_length"]:
                emit_resource_error(ctx, path, f"Rule path length {len(path)} exceeds max_path_length {policy['max_path_length']}")
            constraints = rule.get("constraints")
            if isinstance(constraints, dict):
                inspect_constraint_resource_shape(constraints, path, 1, policy, ctx)
    datatype_rules = schema.get("datatype_rules")
    if isinstance(datatype_rules, dict):
        for datatype, constraints in datatype_rules.items():
            if isinstance(constraints, dict):
                inspect_constraint_resource_shape(constraints, f"datatype_rules.{datatype}", 1, policy, ctx)


def inspect_constraint_resource_shape(constraints: dict[str, object], path: str, depth: int, policy: dict[str, int], ctx: DiagContext) -> None:
    if depth > policy["max_schema_depth"]:
        emit_resource_error(ctx, path, f"Schema constraint depth exceeds max_schema_depth {policy['max_schema_depth']}")
        return
    any_of = constraints.get("any_of")
    if isinstance(any_of, list):
        if len(any_of) > policy["max_any_of_cases"]:
            emit_resource_error(ctx, path, f"any_of case count {len(any_of)} exceeds max_any_of_cases {policy['max_any_of_cases']}")
        for index, branch in enumerate(any_of):
            if isinstance(branch, dict):
                inspect_constraint_resource_shape(branch, f"{path}.any_of[{index}]", depth + 1, policy, ctx)
    attributes = constraints.get("attributes")
    if isinstance(attributes, dict):
        for key, child in attributes.items():
            if isinstance(child, dict):
                inspect_constraint_resource_shape(child, f"{path}.@.{key}", depth + 1, policy, ctx)


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
        selector = rule.get("selector")
        constraints = rule.get("constraints")
        has_path = isinstance(path, str) and len(path) > 0
        has_selector = isinstance(selector, str) and len(selector) > 0
        if not has_path and not has_selector:
            emit_error(ctx, create_diag("<unknown>", None, 'Rule missing required "path" field', ERROR_CODES["rule_missing_path"]))
            continue
        if has_path and has_selector:
            emit_error(ctx, create_diag("<unknown>", None, 'Rule must provide either "path" or "selector", not both', ERROR_CODES["rule_missing_path"]))
            continue
        if has_path and "[*]" in path:
            emit_error(ctx, create_diag(path, None, f"Legacy indexed wildcard paths are not supported; use a SANSA selector with .* instead: {path}", ERROR_CODES["invalid_schema_policy"]))
            continue
        if has_selector and "[*]" in selector:
            emit_error(ctx, create_diag(selector, None, f"Legacy indexed wildcard selectors are not supported; use SANSA .* instead: {selector}", ERROR_CODES["invalid_schema_policy"]))
            continue
        if path in index:
            emit_error(ctx, create_diag(path, None, f"Duplicate rule for path: {path}", ERROR_CODES["duplicate_rule_path"]))
            continue
        if not isinstance(constraints, dict):
            constraints = {}
            rule["constraints"] = constraints
        rule_path = path if has_path else selector
        assert isinstance(rule_path, str)
        if not has_path:
            validate_constraint_tree(schema, rule_path, constraints, ctx)
            continue
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
    pattern = constraints.get("pattern")
    if pattern is not None:
        if not isinstance(pattern, str):
            emit_error(ctx, create_diag(path, None, f"Invalid pattern constraint for path {path}: {pattern}", ERROR_CODES["unknown_constraint_key"]))
            return False
        problem = _portable_pattern_problem(pattern)
        if problem is not None:
            emit_error(ctx, create_diag(path, None, f"Invalid pattern regex for path {path}: {problem}", ERROR_CODES["unknown_constraint_key"]))
            return False
    allow_unspecified_radix = constraints.get("allow_unspecified_radix")
    if allow_unspecified_radix is not None and not isinstance(allow_unspecified_radix, bool):
        emit_error(ctx, create_diag(path, None, f"allow_unspecified_radix must be boolean for path {path}", ERROR_CODES["unknown_constraint_key"]))
        return False
    for key in ("required", "nullable", "allow_infinity", "allow_nan", "resolve_reference_form", "closed_attributes"):
        value = constraints.get(key)
        if value is not None and not isinstance(value, bool):
            emit_error(ctx, create_diag(path, None, f"{key} must be boolean for path {path}", ERROR_CODES["unknown_constraint_key"]))
            return False
    for key in ("type", "null_value", "sign", "datatype"):
        value = constraints.get(key)
        if value is not None and not isinstance(value, str):
            emit_error(ctx, create_diag(path, None, f"{key} must be string for path {path}", ERROR_CODES["unknown_constraint_key"]))
            return False
    if constraints.get("sign") is not None and constraints.get("sign") not in {"signed", "unsigned"}:
        emit_error(ctx, create_diag(path, None, f"Invalid sign constraint for path {path}", ERROR_CODES["unknown_constraint_key"]))
        return False
    for key in ("min_children", "max_children", "length_exact", "radix", "min_digits", "max_digits", "min_length", "max_length"):
        value = constraints.get(key)
        if value is not None and (not isinstance(value, int) or value < 0):
            emit_error(ctx, create_diag(path, None, f"Invalid {key} constraint for path {path}", ERROR_CODES["unknown_constraint_key"]))
            return False
    for key in ("min_value", "max_value"):
        value = constraints.get(key)
        if value is not None and not isinstance(value, str):
            emit_error(ctx, create_diag(path, None, f"{key} must be string for path {path}", ERROR_CODES["unknown_constraint_key"]))
            return False
    any_of = constraints.get("any_of")
    if any_of is not None:
        if not isinstance(any_of, list) or len(any_of) == 0:
            emit_error(ctx, create_diag(path, None, f"Invalid any_of constraint for path: {path}", ERROR_CODES["unknown_constraint_key"]))
            return False
        for index, branch in enumerate(any_of):
            branch_path = f"{path}.any_of[{index}]"
            if not isinstance(branch, dict):
                emit_error(ctx, create_diag(branch_path, None, f"Invalid any_of branch for path: {path}", ERROR_CODES["unknown_constraint_key"]))
                return False
            if not validate_constraint_tree(schema, branch_path, branch, ctx):
                return False
    nested = constraints.get("attributes")
    if nested is None:
        return True
    if not isinstance(nested, dict):
        emit_error(ctx, create_diag(path, None, f"Invalid attributes constraint for path: {path}", ERROR_CODES["unknown_constraint_key"]))
        return False
    for key, child in nested.items():
        child_path = f"{path}.@.{key}"
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
        problem = _portable_pattern_problem(reference_target_pattern)
        if problem is not None:
            emit_error(ctx, create_diag(path, None, f"Invalid reference_target_pattern regex for path {path}: {problem}", ERROR_CODES["invalid_reference_constraint"]))
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
        expected_datatype = constraints.get("datatype")
        expected_container = constraints.get("type_is")
        if expected_type is None and expected_datatype is None and expected_container is None:
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
        if isinstance(expected_datatype, str) and event.get("datatype") != expected_datatype:
            actual_datatype = event.get("datatype")
            emit_error(ctx, create_diag(path, event.get("span"), f"Datatype mismatch: expected {expected_datatype}, got {actual_datatype if isinstance(actual_datatype, str) else 'none'}", ERROR_CODES["type_mismatch"]))
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
            if isinstance(reference_path, list) and not matches_portable_pattern(target_pattern, format_reference_target_path(reference_path)):
                emit_error(ctx, create_diag(path, event.get("span"), f"Reference target path does not satisfy reference_target_pattern at {path}", ERROR_CODES["reference_target_mismatch"]))


def check_numeric_form(rule_index: dict[str, dict[str, object]], events: dict[str, dict[str, object]], ctx: DiagContext) -> None:
    for path, rule in rule_index.items():
        constraints = rule.get("constraints")
        if not isinstance(constraints, dict):
            continue
        sign = constraints.get("sign")
        min_digits = constraints.get("min_digits")
        max_digits = constraints.get("max_digits")
        radix = constraints.get("radix")
        min_value = constraints.get("min_value")
        max_value = constraints.get("max_value")
        if sign is None and min_digits is None and max_digits is None and radix is None and min_value is None and max_value is None:
            continue
        event = events.get(path)
        if event is None or not is_digit_form_literal(str(event.get("type", ""))):
            continue
        raw = str(event.get("raw", ""))
        event_type = str(event.get("type", ""))
        if sign == "unsigned" and event_type in {"NumberLiteral", "IntegerLiteral", "FloatLiteral", "RadixLiteral"} and is_form_negative(raw):
            emit_error(ctx, create_diag(path, event.get("span"), "Numeric form violation: expected unsigned, got negative", ERROR_CODES["numeric_form_violation"]))
            continue
        digit_count = count_form_digits(event_type, raw)
        if isinstance(min_digits, int) and digit_count < min_digits:
            emit_error(ctx, create_diag(path, event.get("span"), f"Numeric form violation: expected min {min_digits} digits, got {digit_count}", ERROR_CODES["numeric_form_violation"]))
            continue
        if isinstance(max_digits, int) and digit_count > max_digits:
            emit_error(ctx, create_diag(path, event.get("span"), f"Numeric form violation: expected max {max_digits} digits, got {digit_count}", ERROR_CODES["numeric_form_violation"]))
            continue
        if event_type == "RadixLiteral" and isinstance(radix, int):
            declared_radix = declared_radix_from_datatype(event.get("datatype") if isinstance(event.get("datatype"), str) else None)
            if declared_radix is None and constraints.get("allow_unspecified_radix") is not True:
                emit_error(ctx, create_diag(path, event.get("span"), f"Numeric form violation: radix literal requires declared radix {radix}", ERROR_CODES["numeric_form_violation"]))
                continue
            if declared_radix is not None and declared_radix != radix:
                emit_error(ctx, create_diag(path, event.get("span"), f"Numeric form violation: expected radix {radix}, got declared radix {declared_radix}", ERROR_CODES["numeric_form_violation"]))
                continue
            invalid_digit = first_invalid_radix_digit(raw, radix)
            if invalid_digit is not None:
                emit_error(ctx, create_diag(path, event.get("span"), f"Numeric form violation: radix literal digit '{invalid_digit}' is outside radix {radix}", ERROR_CODES["numeric_form_violation"]))
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
        if actual_type == "NullLiteral" and not null_value_matches(str(event.get("value", "")), constraints):
            emit_error(ctx, create_diag(path, event.get("span"), f"Null value mismatch: expected {format_expected_null_values(constraints)}, got {event.get('value')}", ERROR_CODES["null_value_mismatch"]))
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
        if min_length is None and max_length is None:
            continue
        event = events.get(path)
        if event is None or not is_string_like_literal(str(event.get("type", ""))):
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
        if event is None or not is_string_like_literal(str(event.get("type", ""))):
            continue
        if not matches_portable_pattern(pattern, str(event.get("value", ""))):
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
            child_path = f"{base_path}.@.{key}"
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
            child_path = f"{base_path}.@.{key}"
            emit_error(ctx, create_diag(child_path, span, f"Unexpected attribute entry: {child_path}", ERROR_CODES["unexpected_attribute_entry"]))


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

    if is_digit_form_literal(actual_type):
        digit_count = count_form_digits(actual_type, raw)
        if effective_constraints.get("sign") == "unsigned" and actual_type in {"NumberLiteral", "IntegerLiteral", "FloatLiteral", "RadixLiteral"} and is_form_negative(raw):
            emit_error(ctx, create_diag(path, span, "Numeric form violation: expected unsigned, got negative", ERROR_CODES["numeric_form_violation"]))
        min_digits = effective_constraints.get("min_digits")
        max_digits = effective_constraints.get("max_digits")
        radix = effective_constraints.get("radix")
        min_value = effective_constraints.get("min_value")
        max_value = effective_constraints.get("max_value")
        if isinstance(min_digits, int) and digit_count < min_digits:
            emit_error(ctx, create_diag(path, span, f"Numeric form violation: expected min {min_digits} digits, got {digit_count}", ERROR_CODES["numeric_form_violation"]))
        if isinstance(max_digits, int) and digit_count > max_digits:
            emit_error(ctx, create_diag(path, span, f"Numeric form violation: expected max {max_digits} digits, got {digit_count}", ERROR_CODES["numeric_form_violation"]))
        if actual_type == "RadixLiteral" and isinstance(radix, int):
            declared_radix = declared_radix_from_datatype(datatype if isinstance(datatype, str) else None)
            if declared_radix is None and effective_constraints.get("allow_unspecified_radix") is not True:
                emit_error(ctx, create_diag(path, span, f"Numeric form violation: radix literal requires declared radix {radix}", ERROR_CODES["numeric_form_violation"]))
            if declared_radix is not None and declared_radix != radix:
                emit_error(ctx, create_diag(path, span, f"Numeric form violation: expected radix {radix}, got declared radix {declared_radix}", ERROR_CODES["numeric_form_violation"]))
            invalid_digit = first_invalid_radix_digit(raw, radix)
            if invalid_digit is not None:
                emit_error(ctx, create_diag(path, span, f"Numeric form violation: radix literal digit '{invalid_digit}' is outside radix {radix}", ERROR_CODES["numeric_form_violation"]))
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

    if is_string_like_literal(str(actual_type)):
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
    if actual_type == "NullLiteral" and not null_value_matches(str(entry.get("value", "")), constraints):
        emit_error(ctx, create_diag(path, entry.get("span"), f"Null value mismatch: expected {format_expected_null_values(constraints)}, got {entry.get('value')}", ERROR_CODES["null_value_mismatch"]))
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


def merge_datatype_rules(rule_index: dict[str, dict[str, object]], datatype_rules: object, events: dict[str, dict[str, object]]) -> dict[str, dict[str, object]]:
    if not isinstance(datatype_rules, dict):
        return rule_index
    merged = {
        path: {**rule, "constraints": {**rule.get("constraints", {})}}
        for path, rule in rule_index.items()
        if isinstance(rule, dict)
    }
    for path, event in events.items():
        datatype = event.get("datatype")
        if not isinstance(datatype, str):
            continue
        datatype_rule = datatype_rules.get(datatype_base(datatype).lower())
        if not isinstance(datatype_rule, dict):
            continue
        existing = merged.get(path, {"path": path, "constraints": {}})
        constraints = existing.get("constraints", {})
        if not isinstance(constraints, dict):
            constraints = {}
        merged[path] = {**existing, "path": path, "constraints": {**datatype_rule, **constraints}}
    return merged


def check_world_policy(
    schema: dict[str, object],
    aes: list[dict[str, object]],
    bound_paths: set[str],
    events_by_path: dict[str, dict[str, object]],
    ctx: DiagContext,
) -> None:
    if str(schema.get("world", "open")) != "closed":
        return

    rules = schema.get("rules")
    if not isinstance(rules, list):
        return

    allowed_rules = {
        ("path", path)
        for rule in rules
        if isinstance(rule, dict)
        for path in [rule.get("path")]
        if isinstance(path, str)
    }
    allowed_rules.update(
        {
            ("selector", selector)
            for rule in rules
            if isinstance(rule, dict)
            for selector in [rule.get("selector")]
            if isinstance(selector, str)
        }
    )

    selector_matches: dict[str, set[str] | None] = {}
    for kind, allowed_path in allowed_rules:
        if kind == "selector" and allowed_path not in selector_matches:
            selector_matches[allowed_path] = resolve_sansa_selector_path_set(allowed_path, events_by_path, ctx)

    for event in aes:
        key = event.get("key")
        if isinstance(key, str) and key.startswith("aeon:"):
            continue
        path = format_canonical_path(event.get("path"))
        if path not in bound_paths:
            continue
        if any(
            path in (selector_matches.get(allowed_path) or set()) if kind == "selector" else matches_allowed_path(path, allowed_path)
            for kind, allowed_path in allowed_rules
        ):
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


def resolve_reference_form_events(rule_index: dict[str, dict[str, object]], events: dict[str, dict[str, object]], resource_policy: dict[str, int], ctx: DiagContext) -> dict[str, dict[str, object]]:
    resolved = dict(events)
    for path, rule in rule_index.items():
        constraints = rule.get("constraints")
        if not isinstance(constraints, dict) or constraints.get("resolve_reference_form") is not True:
            continue
        event = events.get(path)
        if not isinstance(event, dict) or not is_reference_type(event.get("type")):
            continue
        state = {"exhausted": False}
        terminal = resolve_terminal_reference_event(event, events, set(), resource_policy["max_reference_resolution_steps"], state)
        if terminal is None:
            if state["exhausted"]:
                emit_resource_error(ctx, path, f"Reference resolution exceeded max_reference_resolution_steps {resource_policy['max_reference_resolution_steps']}", to_span_tuple(event.get("span")))
            resolved.pop(path, None)
            continue
        resolved[path] = {**terminal, "span": event.get("span")}
    return resolved


def expand_selector_rules(
    rule_index: dict[str, dict[str, object]],
    schema: dict[str, object],
    events: dict[str, dict[str, object]],
    ctx: DiagContext,
    resource_policy: dict[str, int],
    expansion_budget: dict[str, int],
) -> dict[str, dict[str, object]]:
    expanded = dict(rule_index)
    rules = schema.get("rules")
    if not isinstance(rules, list):
        return expanded
    for rule in rules:
        if not isinstance(rule, dict):
            continue
        selector = rule.get("selector")
        path = rule.get("path")
        if not isinstance(selector, str) or not selector:
            continue
        if isinstance(path, str) and path:
            continue
        resolved_paths = resolve_sansa_selector_path_set(selector, events, ctx)
        if resolved_paths is None:
            continue
        matched = False
        for actual_path in resolved_paths:
            matched = True
            expansion_budget["count"] = expansion_budget.get("count", 0) + 1
            if expansion_budget["count"] > resource_policy["max_selector_expansions"]:
                emit_resource_error(ctx, selector, f"Selector expansion count exceeds max_selector_expansions {resource_policy['max_selector_expansions']}")
                return expanded
            expanded.setdefault(actual_path, {**rule, "path": actual_path})
        constraints = rule.get("constraints")
        if not matched and isinstance(constraints, dict) and constraints.get("required") is True:
            emit_error(ctx, create_diag(selector, None, f"Missing required field: {selector}", ERROR_CODES["missing_required_field"]))
    return expanded


def resolve_sansa_selector_path_set(selector: str, events: dict[str, dict[str, object]], ctx: DiagContext) -> set[str] | None:
    result = resolve_sansa_address(selector, create_aeos_sansa_resolve_namespace(events))
    if not result.get("ok"):
        errors = result.get("errors")
        first = errors[0] if isinstance(errors, list) and errors and isinstance(errors[0], dict) else None
        message = first.get("message") if isinstance(first, dict) else None
        detail = f"Invalid or unsupported SANSA selector: {message}" if isinstance(message, str) else f"Invalid or unsupported SANSA selector: {selector}"
        emit_error(ctx, create_diag(selector, None, detail, ERROR_CODES["invalid_schema_policy"]))
        return None
    bindings = result.get("bindings")
    if not isinstance(bindings, list):
        return set()
    return {
        path
        for binding in bindings
        if isinstance(binding, dict)
        for path in [binding.get("path") or binding.get("address")]
        if isinstance(path, str) and path in events
    }


def create_aeos_sansa_resolve_namespace(events: dict[str, dict[str, object]]) -> dict[str, object]:
    return {
        "root": build_aeos_sansa_resolve_tree(events),
        "children": lambda binding: binding.get("children", []) if isinstance(binding, dict) else [],
        "member": lambda binding, name: next(
            (
                child
                for child in (binding.get("children", []) if isinstance(binding, dict) else [])
                if isinstance(child, dict) and child.get("name") == name
            ),
            None,
        ),
        "position": lambda binding, index: next(
            (
                child
                for child in (binding.get("children", []) if isinstance(binding, dict) else [])
                if isinstance(child, dict) and child.get("index") == index
            ),
            None,
        ),
        "attributeSpace": lambda binding: binding.get("attributeSpace") if isinstance(binding, dict) else None,
        "name": lambda binding: binding.get("name") if isinstance(binding, dict) else None,
        "index": lambda binding: binding.get("index") if isinstance(binding, dict) else None,
        "semanticType": lambda binding: (binding.get("info") or {}).get("datatype") if isinstance(binding, dict) else None,
        "representationKind": lambda binding: (binding.get("info") or {}).get("type") if isinstance(binding, dict) else None,
    }


def build_aeos_sansa_resolve_tree(events: dict[str, dict[str, object]]) -> dict[str, object]:
    root: dict[str, object] = {"path": "$", "children": []}
    for path, info in sorted(events.items(), key=lambda item: len(item[0])):
        insert_aeos_sansa_resolve_path(root, path, info)
    return root


def insert_aeos_sansa_resolve_path(root: dict[str, object], path: str, info: dict[str, object]) -> None:
    parsed = parse_sansa_address(path)
    if not parsed.get("ok"):
        return
    address = parsed.get("address")
    if not isinstance(address, dict) or not isinstance(address.get("root"), dict) or address["root"].get("kind") != "absolute":
        return

    current = root
    current_path = "$"
    selectors = address.get("selectors")
    if not isinstance(selectors, list):
        selectors = []
    for selector in selectors:
        if not isinstance(selector, dict):
            return
        selector_type = selector.get("type")
        if selector_type == "member":
            name = str(selector.get("name", ""))
            current_path += format_sansa_member_selector(name)
            current = get_or_create_sansa_child_binding(current, current_path, {"name": name})
        elif selector_type == "position":
            index = int(selector.get("index", 0))
            current_path += f"[{index}]"
            current = get_or_create_sansa_child_binding(current, current_path, {"index": index})
        elif selector_type == "attributeSpace":
            current_path += ".@"
            attribute_space = current.get("attributeSpace")
            if not isinstance(attribute_space, dict):
                attribute_space = {"path": current_path, "children": []}
                current["attributeSpace"] = attribute_space
            current = attribute_space
        else:
            return
    current["info"] = info


def get_or_create_sansa_child_binding(parent: dict[str, object], path: str, identity: dict[str, object]) -> dict[str, object]:
    children = parent.get("children")
    if not isinstance(children, list):
        children = []
        parent["children"] = children
    for child in children:
        if not isinstance(child, dict):
            continue
        if "name" in identity and child.get("name") == identity["name"]:
            return child
        if "index" in identity and child.get("index") == identity["index"]:
            return child
    child = {"path": path, "children": [], **identity}
    children.append(child)
    return child


def format_sansa_member_selector(name: str) -> str:
    return f".{name}" if is_identifier_safe(name) else f".[{json.dumps(name)}]"

def select_any_of_rules(rule_index: dict[str, dict[str, object]], events: dict[str, dict[str, object]], ctx: DiagContext) -> dict[str, dict[str, object]]:
    selected = dict(rule_index)
    for path, rule in rule_index.items():
        constraints = rule.get("constraints")
        if not isinstance(constraints, dict) or not isinstance(constraints.get("any_of"), list):
            continue
        event = events.get(path)
        if not isinstance(event, dict):
            continue
        outer = {key: value for key, value in constraints.items() if key != "any_of"}
        branch = next((candidate for candidate in constraints["any_of"] if isinstance(candidate, dict) and constraint_branch_matches_event(candidate, event)), None)
        if branch is None:
            emit_error(ctx, create_diag(path, event.get("span"), f"Value does not match any allowed constraint branch at {path}", ERROR_CODES["type_mismatch"]))
            selected[path] = {**rule, "constraints": outer}
            continue
        selected[path] = {**rule, "constraints": {**outer, **branch}}
    return selected


def constraint_branch_matches_event(constraints: dict[str, object], event: dict[str, object]) -> bool:
    actual_type = event.get("type")
    if not isinstance(actual_type, str):
        return False
    expected_container = constraints.get("type_is")
    if expected_container is not None:
        ok = expected_container == "list" and actual_type in {"ListLiteral", "ListNode"} or expected_container == "tuple" and actual_type == "TupleLiteral"
        if not ok:
            return False
    expected_type = constraints.get("type")
    if isinstance(expected_type, str) and not type_matches(expected_type, actual_type, constraints):
        return False
    expected_datatype = constraints.get("datatype")
    if isinstance(expected_datatype, str) and event.get("datatype") != expected_datatype:
        return False
    if actual_type == "NullLiteral" and not null_value_matches(str(event.get("value", "")), constraints):
        return False
    if actual_type == "ToggleLiteral" and isinstance(constraints.get("toggle_pair"), str) and constraints.get("toggle_pair") != "any":
        raw = str(event.get("raw", "")).lower()
        pair = constraints.get("toggle_pair")
        if not (raw in {"yes", "no"} if pair == "yes_no" else raw in {"on", "off"} if pair == "on_off" else True):
            return False
    if is_string_like_literal(str(actual_type)):
        value = str(event.get("value", ""))
        length = len(value.encode("utf-16-le")) // 2
        if isinstance(constraints.get("min_length"), int) and length < constraints["min_length"]:
            return False
        if isinstance(constraints.get("max_length"), int) and length > constraints["max_length"]:
            return False
        if isinstance(constraints.get("pattern"), str) and re.search(str(constraints["pattern"]), value) is None:
            return False
    if has_digit_form_constraints(constraints) and is_digit_form_literal(actual_type):
        raw = str(event.get("raw", ""))
        digit_count = count_form_digits(actual_type, raw)
        if constraints.get("sign") == "unsigned" and is_form_negative(raw):
            return False
        if isinstance(constraints.get("min_digits"), int) and digit_count < constraints["min_digits"]:
            return False
        if isinstance(constraints.get("max_digits"), int) and digit_count > constraints["max_digits"]:
            return False
        radix = constraints.get("radix")
        if actual_type == "RadixLiteral" and isinstance(radix, int):
            declared_radix = declared_radix_from_datatype(event.get("datatype") if isinstance(event.get("datatype"), str) else None)
            if declared_radix is None and constraints.get("allow_unspecified_radix") is not True:
                return False
            if declared_radix is not None and declared_radix != radix:
                return False
            if first_invalid_radix_digit(raw, radix) is not None:
                return False
    return True


def matches_allowed_path(actual_path: str, allowed_path: str) -> bool:
    return actual_path == allowed_path


def resolve_terminal_reference_event(event: dict[str, object], events: dict[str, dict[str, object]], active_paths: set[str], remaining_steps: int, state: dict[str, bool]) -> dict[str, object] | None:
    if not is_reference_type(event.get("type")):
        return event
    if remaining_steps <= 0:
        state["exhausted"] = True
        return None
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
    resolved = resolve_terminal_reference_event(target, events, active_paths, remaining_steps - 1, state) if is_reference_type(target.get("type")) else target
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
                out += f".@.{key}"
            else:
                escaped_key = key.replace("\\", "\\\\").replace('"', '\\"')
                out += f'.@.["{escaped_key}"]'
    return out


def format_attribute_path(owner_path: str, key: str) -> str:
    if is_identifier_safe(key):
        return f"{owner_path}.@.{key}"
    escaped_key = key.replace("\\", "\\\\").replace('"', '\\"')
    return f'{owner_path}.@.["{escaped_key}"]'


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
        hydrate_attribute_info_events(element_path, events_by_path[element_path].get("attributes"), events_by_path)


def hydrate_attribute_info_events(base_path: str, attributes: object, events_by_path: dict[str, dict[str, object]]) -> None:
    if not isinstance(attributes, dict):
        return
    for key, info in attributes.items():
        if not isinstance(info, dict):
            continue
        attribute_path = format_attribute_path(base_path, str(key))
        events_by_path[attribute_path] = info
        hydrate_attribute_info_events(attribute_path, info.get("attributes"), events_by_path)


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


def is_digit_form_literal(value_type: str) -> bool:
    return value_type in {"NumberLiteral", "IntegerLiteral", "FloatLiteral", "HexLiteral", "RadixLiteral"}


def is_string_like_literal(value_type: str) -> bool:
    return value_type in {
        "StringLiteral",
        "TrimtickLiteral",
        "TrimtickStringLiteral",
        "SeparatorLiteral",
        "NullLiteral",
        "EncodingLiteral",
        "DateLiteral",
        "TimeLiteral",
        "DateTimeLiteral",
        "WTCDateTimeLiteral",
    }


def matches_portable_pattern(pattern: str | None, value: str) -> bool:
    if pattern is None:
        return True
    regex = pattern
    if not regex.startswith("^"):
        regex = "^" + regex
    if not regex.endswith("$"):
        regex = regex + "$"
    try:
        return re.search(regex, value) is not None
    except re.error:
        return False


def has_digit_form_constraints(constraints: dict[str, object]) -> bool:
    return any(constraints.get(key) is not None for key in ("sign", "min_digits", "max_digits", "radix"))


def count_form_digits(value_type: str, raw: str) -> int:
    if value_type in {"NumberLiteral", "IntegerLiteral", "FloatLiteral"}:
        return count_integer_digits(raw)
    body = raw.lstrip("#%^").lstrip("+-").replace("_", "")
    return sum(1 for char in body if char.isdigit() or char.isalpha() or char in {"&", "!"})


def is_form_negative(raw: str) -> bool:
    return raw.startswith("-") or (len(raw) > 1 and raw[0] in "$#%^" and raw[1] == "-")


def declared_radix_from_datatype(datatype: str | None) -> int | None:
    if datatype is None:
        return None
    trimmed = datatype.strip()
    if trimmed.lower() == "decimal":
        return 10
    match = re.fullmatch(r"radix(?:\[(\d+)\]|(\d+))", trimmed, re.IGNORECASE)
    if match is None:
        return None
    return int(match.group(1) or match.group(2))


def first_invalid_radix_digit(raw: str, radix: int) -> str | None:
    body = raw.removeprefix("%").lstrip("+-").replace("_", "")
    for char in body:
        value = radix_digit_value(char)
        if value is not None and value >= radix:
            return char
    return None


def radix_digit_value(char: str) -> int | None:
    if "0" <= char <= "9":
        return ord(char) - ord("0")
    lower = char.lower()
    if "a" <= lower <= "z":
        return ord(lower) - ord("a") + 10
    if char == "&":
        return 36
    if char == "!":
        return 37
    return None


def expected_null_values(constraints: dict[str, object]) -> list[str]:
    values = []
    null_value = constraints.get("null_value")
    if isinstance(null_value, str):
        values.append(null_value)
    null_values = constraints.get("null_values")
    if isinstance(null_values, list):
        values.extend(value for value in null_values if isinstance(value, str))
    return values


def null_value_matches(value: str, constraints: dict[str, object]) -> bool:
    values = expected_null_values(constraints)
    return not values or value in values


def format_expected_null_values(constraints: dict[str, object]) -> str:
    values = expected_null_values(constraints)
    return " | ".join(values) if values else "<any>"


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
