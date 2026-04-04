from __future__ import annotations

from dataclasses import fields, is_dataclass
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


def finalize_json(aes: object, options: FinalizeOptions | None = None) -> dict[str, object]:
    opts = options or FinalizeOptions()
    aes = normalize_aes_input(aes)
    strict = opts.mode == "strict"
    projection = Projection(opts.materialization, opts.include_paths)
    errors: list[dict[str, object]] = []
    warnings: list[dict[str, object]] = []
    ctx = JsonContext(strict=strict, projection=projection, errors=errors, warnings=warnings)

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


@dataclass(slots=True)
class Projection:
    materialization: str
    include_paths: list[str] | None

    def includes(self, path: str) -> bool:
        if self.materialization != "projected" or not self.include_paths:
            return True
        for include_path in self.include_paths:
            if path == include_path:
                return True
            if path.startswith(include_path + ".") or path.startswith(include_path + "["):
                return True
            if include_path.startswith(path + ".") or include_path.startswith(path + "["):
                return True
        return False


@dataclass(slots=True)
class JsonContext:
    strict: bool
    projection: Projection
    errors: list[dict[str, object]]
    warnings: list[dict[str, object]]

    def emit(self, level: str, message: str, path: str | None = None, span: object = None) -> None:
        target = self.errors if level == "error" else self.warnings
        diag = {"level": level, "message": message}
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
            ctx.emit("error", f"Reserved key cannot be materialized in JSON output: {key}", scoped_path, event.get("span"))
            continue
        if key in document:
            ctx.emit("error" if ctx.strict else "warning", f"Duplicate top-level key during JSON finalization: {key}", scoped_path, event.get("span"))
            if ctx.strict:
                continue
        document[key] = value_to_json(event.get("value"), ctx, scoped_path)
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


def value_to_json(value: object, ctx: JsonContext, path: str) -> object:
    value = normalize_value(value)
    if not isinstance(value, dict):
        return None

    value_type = value.get("type")
    if value_type == "StringLiteral":
        return value.get("value")
    if value_type == "NumberLiteral":
        return number_to_json(value, ctx, path)
    if value_type == "BooleanLiteral":
        return value.get("value")
    if value_type == "SwitchLiteral":
        return value.get("value") in {"yes", "on"}
    if value_type in {"HexLiteral", "RadixLiteral", "EncodingLiteral", "SeparatorLiteral", "DateLiteral", "DateTimeLiteral", "TimeLiteral"}:
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
        return reference_to_json("~", value, ctx, path)
    if value_type == "PointerReference":
        return reference_to_json("~>", value, ctx, path)
    return None


def number_to_json(value: dict[str, object], ctx: JsonContext, path: str) -> object:
    raw = str(value.get("value", ""))
    try:
        number = float(raw) if any(char in raw for char in ".eE") else int(raw, 10)
    except ValueError:
        ctx.emit("error" if ctx.strict else "warning", f"Invalid numeric literal for JSON output: {raw}", path, value.get("span"))
        return raw

    if abs(float(number)) > MAX_SAFE_INTEGER:
        ctx.emit("error" if ctx.strict else "warning", f"Numeric literal exceeds JSON safe range: {raw}", path, value.get("span"))
        return raw
    return number


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
            ctx.emit("error", f"Reserved key cannot be materialized in JSON output: {key}", entry_path, binding.get("span"))
            continue
        if key in obj:
            ctx.emit("error" if ctx.strict else "warning", f"Duplicate object key during JSON finalization: {key}", entry_path, binding.get("span"))
            if ctx.strict:
                continue
        obj[key] = value_to_json(binding.get("value"), ctx, entry_path)
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


def reference_to_json(prefix: str, value: dict[str, object], ctx: JsonContext, path: str) -> str:
    token = prefix + format_reference_path(value.get("path"))
    ctx.emit("error" if ctx.strict else "warning", f"Reference cannot be materialized in JSON output: {token}", path, value.get("span"))
    return token


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
