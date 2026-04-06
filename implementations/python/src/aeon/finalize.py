from __future__ import annotations

from dataclasses import fields, is_dataclass
import re
from typing import Iterable

from ._compat import dataclass
MAX_SAFE_INTEGER = 9007199254740991
RESERVED_OBJECT_KEYS = {"@", "$", "$node", "$children"}


@dataclass(slots=True)
class FinalizeOptions:
    mode: str = "strict"
    materialization: str = "all"
    include_paths: list[str] | None = None
    scope: str = "payload"
    header: dict[str, object] | None = None
    max_materialized_weight: int | None = None


def finalize_json(aes: object, options: FinalizeOptions | None = None) -> dict[str, object]:
    opts = options or FinalizeOptions()
    aes = normalize_aes_input(aes)
    strict = opts.mode == "strict"
    projection = Projection(opts.materialization, opts.include_paths)
    errors: list[dict[str, object]] = []
    warnings: list[dict[str, object]] = []
    path_values = {
        event["path"]: event["value"]
        for event in aes
        if isinstance(event, dict)
        and isinstance(event.get("path"), str)
        and isinstance(event.get("value"), dict)
    }
    ctx = JsonContext(
        strict=strict,
        projection=projection,
        errors=errors,
        warnings=warnings,
        path_values=path_values,
        max_materialized_weight=opts.max_materialized_weight,
        materialized_weight=0,
        materialized_weight_cache={},
        active_clone_paths=[],
        active_paths=[],
    )

    payload = payload_to_json(aes, ctx, opts.scope, opts.header)
    header = header_to_json(opts.header, ctx, opts.scope)
    document = scope_to_json_document(opts.scope, header, payload)

    result: dict[str, object] = {"document": document}
    meta: dict[str, object] = {}
    if errors:
        meta["errors"] = errors
    if warnings:
        meta["warnings"] = warnings
    if meta:
        result["meta"] = meta
    return result


def finalize_map(aes: object, options: FinalizeOptions | None = None) -> dict[str, object]:
    opts = options or FinalizeOptions()
    aes_events = normalize_aes_input(aes)
    projection = Projection(opts.materialization, opts.include_paths)
    entries: list[dict[str, object]] = []

    for event in aes_events:
        if not isinstance(event, dict):
            continue
        key = event.get("key")
        path = event.get("path")
        if not isinstance(key, str) or not isinstance(path, str):
            continue
        if opts.scope == "payload" and key.startswith("aeon:"):
            continue
        if opts.scope == "header" and not key.startswith("aeon:"):
            continue
        if not projection.includes(path):
            continue
        entries.append(
            {
                "path": path,
                "key": key,
                "datatype": event.get("datatype"),
                "value": normalize_value(event.get("value")),
                "span": normalize_value(event.get("span")),
                "annotations": normalize_value(event.get("annotations")) if event.get("annotations") else None,
            }
        )

    document: dict[str, object] = {"entries": entries}
    return {"document": document}


@dataclass(slots=True)
class Projection:
    materialization: str
    include_paths: list[str] | None

    def includes(self, path: str) -> bool:
        if self.materialization != "projected" or not self.include_paths:
            return True
        canonical_path = normalize_projection_path(path)
        for include_path in self.include_paths:
            canonical_include = normalize_projection_path(include_path)
            if canonical_path == canonical_include:
                return True
            if is_descendant_path(canonical_path, canonical_include):
                return True
            if is_descendant_path(canonical_include, canonical_path):
                return True
        return False


@dataclass(slots=True)
class JsonContext:
    strict: bool
    projection: Projection
    errors: list[dict[str, object]]
    warnings: list[dict[str, object]]
    path_values: dict[str, dict[str, object]]
    max_materialized_weight: int | None
    materialized_weight: int
    materialized_weight_cache: dict[str, int]
    active_clone_paths: list[str]
    active_paths: list[str]

    def emit(self, level: str, code: str, message: str, path: str | None = None, span: object = None) -> None:
        target = self.errors if level == "error" else self.warnings
        diag = {"level": level, "code": code, "message": message, "phaseLabel": "Finalization"}
        if path is not None:
            diag["path"] = path
        if span is not None:
            diag["span"] = span
        target.append(diag)


def payload_to_json(
    aes: list[dict[str, object]],
    ctx: JsonContext,
    scope: str,
    header: dict[str, object] | None,
) -> dict[str, object]:
    if scope == "header":
        return {}

    document: dict[str, object] = {}
    document_attrs: dict[str, object] = {}

    header_keys = set(extract_header_keys(header))
    for event in aes:
        path = event.get("path")
        key = event.get("key")
        if not isinstance(path, str) or not isinstance(key, str):
            continue
        if not is_top_level_path(path):
            continue
        if key.startswith("aeon:") or key in header_keys:
            continue
        scoped_path = scoped_top_level_path(scope, "payload", key)
        if not ctx.projection.includes(scoped_path):
            continue
        if key in RESERVED_OBJECT_KEYS:
            ctx.emit("error", "FINALIZE_RESERVED_KEY", f"Reserved key cannot be materialized in JSON output: {key}", scoped_path, event.get("span"))
            continue
        if key in document:
            ctx.emit("error" if ctx.strict else "warning", "FINALIZE_DUPLICATE_PATH", f"Duplicate top-level key during JSON finalization: {key}", scoped_path, event.get("span"))
            if ctx.strict:
                continue
        document[key] = value_to_json(event.get("value"), ctx, scoped_path, event.get("datatype"))
        attr_json = annotation_entries_to_json(event.get("annotations"), ctx, scoped_path)
        if attr_json:
            document_attrs[key] = attr_json

    if document_attrs:
        document["@"] = document_attrs
    return document


def header_to_json(header: dict[str, object] | None, ctx: JsonContext, scope: str) -> dict[str, object]:
    if scope == "payload" or header is None:
        return {}

    result: dict[str, object] = {}
    for key, value in header_field_items(header):
        path = scoped_top_level_path(scope, "header", key)
        if not ctx.projection.includes(path):
            continue
        result[key] = value_to_json(value, ctx, path)
    return result


def scope_to_json_document(scope: str, header: dict[str, object], payload: dict[str, object]) -> dict[str, object]:
    if scope == "header":
        return header
    if scope == "full":
        return {"header": header, "payload": payload}
    return payload


def value_to_json(value: object, ctx: JsonContext, path: str, datatype: object = None) -> object:
    value = normalize_value(value)
    if not isinstance(value, dict):
        return None

    ctx.active_paths.append(path)
    try:
        value_type = value.get("type")
        if value_type == "StringLiteral":
            return value.get("value")
        if value_type == "NumberLiteral":
            return number_to_json(value, ctx, path)
        if value_type == "InfinityLiteral":
            return infinity_to_json(value, ctx, path)
        if value_type == "BooleanLiteral":
            return value.get("value")
        if value_type == "SwitchLiteral":
            return value.get("value") in {"yes", "on"}
        if value_type == "HexLiteral":
            return str(value.get("value", "")).replace("_", "")
        if value_type == "RadixLiteral":
            return radix_to_json(value, ctx, path, datatype)
        if value_type in {"EncodingLiteral", "SeparatorLiteral", "DateLiteral", "DateTimeLiteral", "TimeLiteral"}:
            return value.get("value")
        if value_type == "ObjectNode":
            bindings = value.get("bindings")
            return object_to_json(bindings if isinstance(bindings, list) else [], ctx, path)
        if value_type in {"ListNode", "TupleLiteral"}:
            elements = value.get("elements")
            if not isinstance(elements, list):
                return []
            result = []
            for index, element in enumerate(elements):
                element_path = f"{path}[{index}]"
                if ctx.projection.includes(element_path):
                    result.append(value_to_json(element, ctx, element_path))
            return result
        if value_type == "NodeLiteral":
            return node_to_json(value, ctx, path)
        if value_type == "CloneReference":
            resolved = resolve_clone_reference(value, ctx)
            if resolved is not None:
                target_path, target_value = resolved
                if target_path in ctx.active_clone_paths or target_path in ctx.active_paths:
                    ctx.emit(
                        "error",
                        "FINALIZE_REFERENCE_CYCLE",
                        f"Reference cycle during finalization: '{path}' resolves through '{target_path}'",
                        path,
                        value.get("span"),
                    )
                    return reference_to_json("~", value, ctx, path, emit_diagnostic=False)
                if not consume_clone_budget(target_path, target_value, ctx, path, value.get("span")):
                    return reference_to_json("~", value, ctx, path, emit_diagnostic=False)
                ctx.active_clone_paths.append(target_path)
                try:
                    return value_to_json(target_value, ctx, path, datatype)
                finally:
                    ctx.active_clone_paths.pop()
            return reference_to_json("~", value, ctx, path)
        if value_type == "PointerReference":
            return reference_to_json("~>", value, ctx, path)
        return None
    finally:
        ctx.active_paths.pop()


def number_to_json(value: dict[str, object], ctx: JsonContext, path: str) -> object:
    raw = str(value.get("value", ""))
    try:
        number = float(raw) if any(char in raw for char in ".eE") else int(raw, 10)
    except ValueError:
        ctx.emit("error" if ctx.strict else "warning", "FINALIZE_INVALID_NUMBER", f"Invalid numeric literal for JSON output: {raw}", path, value.get("span"))
        return raw

    if abs(float(number)) > MAX_SAFE_INTEGER:
        ctx.emit("error" if ctx.strict else "warning", "FINALIZE_UNSAFE_NUMBER", f"Numeric literal exceeds JSON safe range: {raw}", path, value.get("span"))
        return raw
    return number


def infinity_to_json(value: dict[str, object], ctx: JsonContext, path: str) -> str:
    raw = str(value.get("value", ""))
    ctx.emit(
        "error" if ctx.strict else "warning",
        "FINALIZE_JSON_PROFILE_INFINITY",
        f"Infinity literal is not representable in the strict JSON profile: {raw}",
        path,
        value.get("span"),
    )
    return raw


def radix_to_json(value: dict[str, object], ctx: JsonContext, path: str, datatype: object) -> str:
    raw = str(value.get("value", ""))
    normalized = raw.replace("_", "")
    base = declared_radix_base(datatype)
    if base is not None and exceeds_declared_radix(normalized, base):
        ctx.emit(
            "error" if ctx.strict else "warning",
            "FINALIZE_INVALID_RADIX_BASE",
            f"Radix literal exceeds declared radix {base}: %{raw}",
            path,
            value.get("span"),
        )
    return normalized


def object_to_json(bindings: list[object], ctx: JsonContext, base_path: str) -> dict[str, object]:
    obj: dict[str, object] = {}
    attr_entries: dict[str, object] = {}

    for binding in bindings:
        if not isinstance(binding, dict):
            continue
        key = binding.get("key")
        if not isinstance(key, str):
            continue
        entry_path = format_child_path(base_path, key)
        if not ctx.projection.includes(entry_path):
            continue
        if key in RESERVED_OBJECT_KEYS:
            ctx.emit("error", "FINALIZE_RESERVED_KEY", f"Reserved key cannot be materialized in JSON output: {key}", entry_path, binding.get("span"))
            continue
        if key in obj:
            ctx.emit("error" if ctx.strict else "warning", "FINALIZE_DUPLICATE_PATH", f"Duplicate object key during JSON finalization: {key}", entry_path, binding.get("span"))
            if ctx.strict:
                continue
        obj[key] = value_to_json(binding.get("value"), ctx, entry_path, binding.get("datatype"))
        attr_json = attributes_to_json(binding.get("attributes"), ctx, entry_path)
        if attr_json:
            attr_entries[key] = attr_json

    if attr_entries:
        obj["@"] = attr_entries
    return obj


def node_to_json(node: dict[str, object], ctx: JsonContext, path: str) -> dict[str, object]:
    result = {"$node": node.get("tag")}
    attr_json = attributes_to_json(node.get("attributes"), ctx, path + "@")
    if attr_json:
        result["@"] = attr_json
    children = node.get("children")
    if isinstance(children, list):
        result["$children"] = [
            value_to_json(child, ctx, f"{path}<{index}>")
            for index, child in enumerate(children)
        ]
    else:
        result["$children"] = []
    return result


def annotation_entries_to_json(annotations: object, ctx: JsonContext, path: str) -> dict[str, object] | None:
    if not isinstance(annotations, dict):
        return None
    result: dict[str, object] = {}
    for key, entry in annotations.items():
        if not isinstance(key, str) or not isinstance(entry, dict):
            continue
        entry_path = f"{path}@{format_annotation_key(key)}"
        if not ctx.projection.includes(entry_path):
            continue
        result[key] = value_to_json(entry.get("value"), ctx, entry_path)
    return result or None


def attributes_to_json(attributes: object, ctx: JsonContext, path: str) -> dict[str, object] | None:
    if not isinstance(attributes, list):
        return None
    result: dict[str, object] = {}
    for attribute in attributes:
        if not isinstance(attribute, dict):
            continue
        entries = attribute.get("entries")
        if not isinstance(entries, dict):
            continue
        for key, entry in entries.items():
            if not isinstance(key, str) or not isinstance(entry, dict):
                continue
            entry_path = f"{path}@{format_annotation_key(key)}"
            if not ctx.projection.includes(entry_path):
                continue
            result[key] = value_to_json(entry.get("value"), ctx, entry_path)
    return result or None


def reference_to_json(prefix: str, value: dict[str, object], ctx: JsonContext, path: str, emit_diagnostic: bool = True) -> str:
    token = prefix + format_reference_path(value.get("path"))
    if not emit_diagnostic:
        return token
    ctx.emit(
        "error" if ctx.strict else "warning",
        "FINALIZE_UNMATERIALIZED_REFERENCE",
        f"Reference cannot be materialized in JSON output: {token}",
        path,
        value.get("span"),
    )
    return token


def resolve_clone_reference(value: dict[str, object], ctx: JsonContext) -> tuple[str, dict[str, object]] | None:
    target_path = reference_target_path(value.get("path"))
    resolved = ctx.path_values.get(target_path)
    if not isinstance(resolved, dict):
        return None
    return target_path, resolved


def reference_target_path(path: object) -> str:
    return "$" + ("." + format_reference_path(path) if format_reference_path(path) else "")


def consume_clone_budget(
    target_path: str,
    value: dict[str, object],
    ctx: JsonContext,
    path: str,
    span: object,
) -> bool:
    if ctx.max_materialized_weight is None:
        return True

    weight = measure_materialized_weight(value, ctx, target_path, set())
    next_weight = ctx.materialized_weight + weight
    if next_weight <= ctx.max_materialized_weight:
        ctx.materialized_weight = next_weight
        return True

    ctx.emit(
        "error",
        "FINALIZE_REFERENCE_BUDGET_EXCEEDED",
        f"Reference materialization budget exceeded for '{target_path}' (budget=maxMaterializedWeight, observed={next_weight}, limit={ctx.max_materialized_weight})",
        path,
        span,
    )
    return False


def measure_materialized_weight(
    value: dict[str, object],
    ctx: JsonContext,
    current_path: str,
    stack: set[str],
) -> int:
    if current_path in stack:
        return 1

    value_type = value.get("type")
    if value_type in {
        "StringLiteral",
        "NumberLiteral",
        "InfinityLiteral",
        "BooleanLiteral",
        "SwitchLiteral",
        "HexLiteral",
        "RadixLiteral",
        "EncodingLiteral",
        "SeparatorLiteral",
        "DateLiteral",
        "DateTimeLiteral",
        "TimeLiteral",
        "PointerReference",
    }:
        return 1

    if value_type == "CloneReference":
        target_path = reference_target_path(value.get("path"))
        cached = ctx.materialized_weight_cache.get(target_path)
        if cached is not None:
            return cached
        resolved = ctx.path_values.get(target_path)
        if not isinstance(resolved, dict):
            return 1
        next_stack = set(stack)
        next_stack.add(current_path)
        weight = measure_materialized_weight(resolved, ctx, target_path, next_stack)
        ctx.materialized_weight_cache[target_path] = weight
        return weight

    if value_type == "ObjectNode":
        bindings = value.get("bindings")
        if not isinstance(bindings, list):
            return 0
        return sum(
            measure_binding_weight(binding, ctx, format_child_path(current_path, str(binding.get("key", ""))), stack)
            for binding in bindings
            if isinstance(binding, dict)
        )

    if value_type in {"ListNode", "TupleLiteral"}:
        elements = value.get("elements")
        if not isinstance(elements, list):
            return 0
        return sum(
            measure_materialized_weight(element, ctx, f"{current_path}[{index}]", stack)
            for index, element in enumerate(elements)
            if isinstance(element, dict)
        )

    if value_type == "NodeLiteral":
        children = value.get("children")
        attributes = value.get("attributes")
        attributes_weight = measure_attributes_weight(attributes, ctx, current_path, stack)
        children_weight = 0
        if isinstance(children, list):
            children_weight = sum(
                measure_materialized_weight(child, ctx, f"{current_path}<{index}>", stack)
                for index, child in enumerate(children)
                if isinstance(child, dict)
            )
        return 1 + attributes_weight + children_weight

    return 1


def measure_binding_weight(binding: dict[str, object], ctx: JsonContext, path: str, stack: set[str]) -> int:
    value = binding.get("value")
    total = 0
    if isinstance(value, dict):
        total += measure_materialized_weight(value, ctx, path, stack)
    total += measure_attributes_weight(binding.get("attributes"), ctx, path, stack)
    return total


def measure_attributes_weight(attributes: object, ctx: JsonContext, path: str, stack: set[str]) -> int:
    if not isinstance(attributes, list):
        return 0
    total = 0
    for attribute in attributes:
        if not isinstance(attribute, dict):
            continue
        entries = attribute.get("entries")
        if not isinstance(entries, dict):
            continue
        for key, entry in entries.items():
            if not isinstance(key, str) or not isinstance(entry, dict):
                continue
            entry_path = f"{path}@{format_annotation_key(key)}"
            value = entry.get("value")
            if isinstance(value, dict):
                total += measure_materialized_weight(value, ctx, entry_path, stack)
            total += measure_attributes_weight(entry.get("attributes"), ctx, entry_path, stack)
    return total


def format_reference_path(path: object) -> str:
    if not isinstance(path, list):
        return ""
    result = ""
    for index, segment in enumerate(path):
        if isinstance(segment, str):
            if index == 0:
                result += segment if is_identifier_safe(segment) else f'["{escape_string(segment)}"]'
            else:
                result += f".{segment}" if is_identifier_safe(segment) else f'.["{escape_string(segment)}"]'
            continue
        if isinstance(segment, int):
            result += f"[{segment}]"
            continue
        if isinstance(segment, dict) and segment.get("type") == "attr":
            key = segment.get("key")
            if isinstance(key, str):
                result += f"@{key}" if is_identifier_safe(key) else f'@["{escape_string(key)}"]'
    return result


def header_field_items(header: dict[str, object]) -> Iterable[tuple[str, object]]:
    fields = header.get("fields")
    if isinstance(fields, dict):
        return fields.items()
    return []


def extract_header_keys(header: dict[str, object] | None) -> list[str]:
    if header is None:
        return []
    return [key for key, _ in header_field_items(header)]


def is_top_level_path(path: str) -> bool:
    if path.startswith('$.["') and path.endswith('"]'):
        return True
    if not path.startswith("$."):
        return False
    suffix = path[2:]
    return all(ch not in suffix for ch in ".[@")


def scoped_top_level_path(scope: str, branch: str, key: str) -> str:
    base = f"$.{branch}" if scope == "full" else "$"
    return append_member_path(base, key)


def format_child_path(base_path: str, key: str) -> str:
    return append_member_path(base_path, key)


def append_member_path(base_path: str, key: str) -> str:
    if is_identifier_safe(key):
        return f"{base_path}.{key}"
    return f'{base_path}.["{escape_string(key)}"]'


def format_annotation_key(key: str) -> str:
    return key if is_identifier_safe(key) else f'["{escape_string(key)}"]'


def escape_string(value: str) -> str:
    return value.replace("\\", "\\\\").replace('"', '\\"')


def is_identifier_safe(value: str) -> bool:
    if not value:
        return False
    if not (value[0].isalpha() or value[0] == "_"):
        return False
    return all(char.isalnum() or char == "_" for char in value[1:])


def normalize_value(value: object) -> object:
    if isinstance(value, dict):
        return {key: normalize_value(item) for key, item in value.items()}
    if isinstance(value, list):
        return [normalize_value(item) for item in value]
    if is_dataclass(value):
        return {
            field.name: normalize_value(getattr(value, field.name))
            for field in fields(value)
        }
    return value


def normalize_aes_input(aes: object) -> list[dict[str, object]]:
    if isinstance(aes, list):
        return aes
    if isinstance(aes, dict):
        internal_events = aes.get("internal_events")
        if isinstance(internal_events, list):
            return internal_events
        events = aes.get("events")
        if isinstance(events, list):
            return events
    internal_events = getattr(aes, "internal_events", None)
    if isinstance(internal_events, list):
        return internal_events
    events = getattr(aes, "events", None)
    if isinstance(events, list):
        return events
    raise TypeError("finalize_json expected AES events or a compile result")


def is_descendant_path(path: str, ancestor: str) -> bool:
    suffix = path[len(ancestor):] if path.startswith(ancestor) else None
    if suffix is None:
        return False
    return suffix.startswith((".", "[", "@", "<"))


def normalize_projection_path(path: str) -> str:
    normalized = path

    def replace_segment(match: re.Match[str]) -> str:
        prefix = match.group(1)
        key = match.group(2)
        if is_identifier_safe(key):
            return f"{prefix}{key}"
        return match.group(0)

    normalized = re.sub(r'(\.)\["([^"\\]+)"\]', replace_segment, normalized)
    normalized = re.sub(r'(@)\["([^"\\]+)"\]', replace_segment, normalized)
    root_match = re.fullmatch(r'\$\["([^"\\]+)"\](.*)', normalized)
    if root_match and is_identifier_safe(root_match.group(1)):
        normalized = f"$.{root_match.group(1)}{root_match.group(2)}"
    return normalized


def declared_radix_base(datatype: object) -> int | None:
    rendered = render_datatype(datatype)
    if rendered is None:
        return None
    trimmed = rendered.strip()
    if trimmed == "radix2":
        return 2
    if trimmed == "radix6":
        return 6
    if trimmed == "radix8":
        return 8
    if trimmed == "radix12":
        return 12
    if not trimmed.startswith("radix[") or not trimmed.endswith("]"):
        return None
    body = trimmed[6:-1]
    if not body.isdigit():
        return None
    base = int(body)
    if 2 <= base <= 64:
        return base
    return None


def render_datatype(datatype: object) -> str | None:
    if isinstance(datatype, str):
        return datatype
    if not isinstance(datatype, dict):
        return None
    name = datatype.get("name")
    if not isinstance(name, str):
        return None
    generic_args = datatype.get("genericArgs")
    generic = ""
    if isinstance(generic_args, list) and all(isinstance(item, str) for item in generic_args):
        if generic_args:
            generic = "<" + ", ".join(generic_args) + ">"
    radix_base = datatype.get("radixBase")
    radix = f"[{radix_base}]" if isinstance(radix_base, int) else ""
    separators = datatype.get("separators")
    suffix = ""
    if isinstance(separators, list):
        suffix = "".join(f"[{item}]" for item in separators if isinstance(item, str))
    return f"{name}{generic}{radix}{suffix}"


def exceeds_declared_radix(value: str, base: int) -> bool:
    for char in value:
        if char in "+-.":
            continue
        digit = radix_digit_value(char)
        if digit is None or digit >= base:
            return True
    return False


def radix_digit_value(char: str) -> int | None:
    if "0" <= char <= "9":
        return ord(char) - ord("0")
    if "A" <= char <= "Z":
        return ord(char) - ord("A") + 10
    if "a" <= char <= "z":
        return ord(char) - ord("a") + 36
    if char == "&":
        return 62
    if char == "!":
        return 63
    return None
