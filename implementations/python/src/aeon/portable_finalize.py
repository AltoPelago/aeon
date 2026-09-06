from __future__ import annotations

import json
import math
import re
from dataclasses import field
from typing import Mapping

from ._compat import dataclass
from .telex import (
    AEON_DOCUMENT_PROJECTION,
    COMPLETE_AES_PROFILE,
    TelexLimits,
    parse_canonical_path,
    validate_telex_records,
)


MAX_SAFE_INTEGER = 9_007_199_254_740_991
RESERVED_OBJECT_KEYS = {"@", "$", "$node", "$children", "__proto__", "constructor", "prototype"}


@dataclass(slots=True)
class PortableFinalizeOptions:
    mode: str = "strict"
    scope: str = "payload"
    profile: str = COMPLETE_AES_PROFILE
    projection: str | None = None
    registered_fields: list[str] = field(default_factory=list)
    limits: TelexLimits | Mapping[str, object] | None = None
    max_materialized_weight: int | None = None
    max_reference_depth: int | None = None


@dataclass(slots=True)
class _IndexedRecord:
    record: int
    address: str
    segment: tuple[str, str | int]


@dataclass(slots=True)
class _Plane:
    by_address: dict[str, _IndexedRecord] = field(default_factory=dict)
    by_parent: dict[str, list[_IndexedRecord]] = field(default_factory=dict)


class _Context:
    def __init__(self, records: list[dict[str, object]], options: PortableFinalizeOptions) -> None:
        self.records = records
        self.strict = options.mode == "strict"
        self.body = _index_plane(records, "path")
        self.header = _index_plane(records, "header")
        self.errors: list[dict[str, object]] = []
        self.warnings: list[dict[str, object]] = []
        self.max_materialized_weight = options.max_materialized_weight
        self.max_reference_depth = options.max_reference_depth
        self.active_clone_paths: list[str] = []
        self.weight_cache: dict[str, int] = {}
        self.materialized_weight = 0

    def report(self, code: str, message: str, path: str, always_error: bool = False) -> None:
        diagnostic = {
            "level": "error" if always_error or self.strict else "warning",
            "code": code,
            "message": message,
            "phaseLabel": "Finalization",
            "path": path,
        }
        (self.errors if always_error or self.strict else self.warnings).append(diagnostic)


def finalize_portable_json(
    records: list[dict[str, object]], options: PortableFinalizeOptions | None = None
) -> dict[str, object]:
    opts = options or PortableFinalizeOptions()
    validation = validate_telex_records(
        records,
        profile=opts.profile,
        projection=opts.projection,
        limits=opts.limits,
        registered_fields=opts.registered_fields,
    )
    errors = [
        {
            "level": "error",
            "code": item["code"],
            "message": item["message"],
            "phaseLabel": "AES validation",
            **({"path": item["path"]} if item.get("path") is not None else {}),
        }
        for item in validation["diagnostics"]
    ]
    if opts.profile != COMPLETE_AES_PROFILE:
        errors.append(
            {
                "level": "error",
                "code": "FINALIZE_PARTIAL_AES_UNSUPPORTED",
                "message": f"Portable JSON materialization requires '{COMPLETE_AES_PROFILE}', received '{opts.profile}'",
                "phaseLabel": "Finalization",
                "path": "$",
            }
        )
    if errors:
        return {"document": _empty_document(opts.scope), "meta": {"errors": errors}}

    ctx = _Context(records, opts)
    payload = {} if opts.scope == "header" else _materialize_root(False, ctx)
    header = (
        {}
        if opts.scope == "payload" or opts.projection != AEON_DOCUMENT_PROJECTION
        else _materialize_root(True, ctx)
    )
    if opts.scope == "full":
        document: object = {"header": header, "payload": payload}
    elif opts.scope == "header":
        document = header
    else:
        document = payload
    result: dict[str, object] = {"document": document}
    meta: dict[str, object] = {}
    if ctx.errors:
        meta["errors"] = ctx.errors
    if ctx.warnings:
        meta["warnings"] = ctx.warnings
    if meta:
        result["meta"] = meta
    return result


def _empty_document(scope: str) -> dict[str, object]:
    return {"header": {}, "payload": {}} if scope == "full" else {}


def _index_plane(records: list[dict[str, object]], field_name: str) -> _Plane:
    plane = _Plane()
    for index, record in enumerate(records):
        address = record.get(field_name)
        if not isinstance(address, str):
            continue
        try:
            details = parse_canonical_path(address)
        except ValueError:
            continue
        if not details.segments:
            continue
        parent = "$" if len(details.prefixes) == 1 else details.prefixes[-2]
        indexed = _IndexedRecord(index, address, details.segments[-1])
        plane.by_address[address] = indexed
        plane.by_parent.setdefault(parent, []).append(indexed)
    return plane


def _materialize_root(header: bool, ctx: _Context) -> dict[str, object]:
    result: dict[str, object] = {}
    attributes: dict[str, object] = {}
    for child in _structural_children(ctx.header if header else ctx.body, "$"):
        segment_kind, raw_key = child.segment
        if segment_kind != "member":
            continue
        key = str(raw_key)
        if header and key.startswith("aeon:"):
            key = key[5:]
        if not _safe_member(key, child.address, ctx):
            continue
        result[key] = _materialize_record(child, ctx)
        metadata = _record_metadata(child, ctx)
        if metadata is not None:
            attributes[key] = metadata
    if attributes:
        result["@"] = attributes
    return result


def _materialize_record(indexed: _IndexedRecord, ctx: _Context) -> object:
    record = ctx.records[indexed.record]
    kind = str(record.get("kind", ""))
    value = str(record.get("value", ""))
    if kind == "StringLiteral":
        return value
    if kind == "NumberLiteral":
        return _number_value(value, indexed.address, ctx)
    if kind in {"InfinityLiteral", "NaNLiteral"}:
        code = "FINALIZE_JSON_PROFILE_NAN" if kind == "NaNLiteral" else "FINALIZE_JSON_PROFILE_INFINITY"
        ctx.report(code, f"The {kind} value '{value}' is not representable in strict JSON", indexed.address)
        return value
    if kind == "NullLiteral":
        return _null_value(value, indexed.address, ctx)
    if kind == "BooleanLiteral":
        return value == "true"
    if kind == "ToggleLiteral":
        return value in {"yes", "on"}
    if kind in {
        "HexLiteral", "EncodingLiteral", "SeparatorLiteral", "SansaAddressLiteral",
        "DateLiteral", "TimeLiteral", "DateTimeLiteral", "WTCDateTimeLiteral",
    }:
        return value
    if kind == "RadixLiteral":
        return _radix_value(record, value, indexed.address, ctx)
    if kind == "ObjectNode":
        return _materialize_object(indexed, ctx)
    if kind in {"ListNode", "TupleLiteral"}:
        return _materialize_indexed(indexed, ctx)
    if kind == "NodeLiteral":
        return _materialize_node(indexed, ctx)
    if kind == "CloneReference":
        return _materialize_clone(indexed, ctx)
    if kind == "PointerReference":
        token = _reference_token("~>", value)
        ctx.report("FINALIZE_UNRESOLVED_REFERENCE", f"Pointer reference remains symbolic during JSON materialization: {token}", indexed.address)
        return token
    if kind == "NodeHead":
        ctx.report("FINALIZE_ORPHAN_NODE_HEAD", "NodeHead can only be materialized through its owning NodeLiteral", indexed.address, True)
        return value
    ctx.report("FINALIZE_UNSUPPORTED_AES_KIND", f"Unsupported portable AES kind '{kind}'", indexed.address, True)
    return None


def _materialize_object(indexed: _IndexedRecord, ctx: _Context) -> dict[str, object]:
    result: dict[str, object] = {}
    attributes: dict[str, object] = {}
    for child in _structural_children(_plane_for(indexed, ctx), indexed.address):
        if child.segment[0] != "member":
            continue
        key = str(child.segment[1])
        if not _safe_member(key, child.address, ctx):
            continue
        result[key] = _materialize_record(child, ctx)
        metadata = _record_metadata(child, ctx)
        if metadata is not None:
            attributes[key] = metadata
    if attributes:
        result["@"] = attributes
    return result


def _materialize_indexed(indexed: _IndexedRecord, ctx: _Context) -> list[object]:
    children = [item for item in _structural_children(_plane_for(indexed, ctx), indexed.address) if item.segment[0] == "index"]
    children.sort(key=lambda item: int(item.segment[1]))
    result: list[object] = []
    for child in children:
        if child.segment[1] != len(result):
            ctx.report("FINALIZE_NON_CONTIGUOUS_INDEX", f"Indexed AES container cannot materialize non-contiguous index {child.segment[1]}", indexed.address, True)
            continue
        result.append(_materialize_record(child, ctx))
    return result


def _materialize_node(indexed: _IndexedRecord, ctx: _Context) -> object:
    heads = [item for item in _structural_children(_plane_for(indexed, ctx), indexed.address) if item.segment[0] == "index"]
    heads.sort(key=lambda item: int(item.segment[1]))
    valid = len(heads) == 1 and heads[0].segment[1] == 0 and ctx.records[heads[0].record].get("kind") == "NodeHead"
    if not valid:
        ctx.report("FINALIZE_UNREPRESENTABLE_NODE_HEADS", "The JSON output profile requires exactly one NodeHead at index 0", indexed.address, True)
        return None
    head = heads[0]
    result: dict[str, object] = {"$node": ctx.records[head.record].get("value", "")}
    attributes = _attributes_to_json(head, ctx)
    if attributes is not None:
        result["@"] = attributes
    result["$children"] = _materialize_indexed(head, ctx)
    return result


def _materialize_clone(indexed: _IndexedRecord, ctx: _Context) -> object:
    target_path = str(ctx.records[indexed.record].get("value", ""))
    target = ctx.body.by_address.get(target_path)
    if target is None:
        token = _reference_token("~", target_path)
        ctx.report("FINALIZE_UNRESOLVED_REFERENCE", f"Clone reference target is unavailable: {token}", indexed.address)
        return token
    if target_path in ctx.active_clone_paths:
        ctx.report("REFERENCE_CYCLE", f"Reference cycle detected during JSON materialization: '{target_path}'", indexed.address, True)
        return _reference_token("~", target_path)
    observed_depth = len(ctx.active_clone_paths) + 1
    if ctx.max_reference_depth is not None and observed_depth > ctx.max_reference_depth:
        ctx.report("FINALIZE_REFERENCE_DEPTH_EXCEEDED", f"Reference materialization depth {observed_depth} exceeds maxReferenceDepth {ctx.max_reference_depth}", indexed.address, True)
        return _reference_token("~", target_path)
    if ctx.max_materialized_weight is not None:
        weight = _measure_weight(target, ctx, set())
        observed = ctx.materialized_weight + weight
        if observed > ctx.max_materialized_weight:
            ctx.report("FINALIZE_REFERENCE_BUDGET_EXCEEDED", f"Reference materialization budget exceeded for '{target_path}' (budget=maxMaterializedWeight, observed={observed}, limit={ctx.max_materialized_weight})", indexed.address, True)
            return _reference_token("~", target_path)
        ctx.materialized_weight = observed
    ctx.active_clone_paths.append(target_path)
    try:
        return _materialize_record(target, ctx)
    finally:
        ctx.active_clone_paths.pop()


def _measure_weight(indexed: _IndexedRecord, ctx: _Context, stack: set[str]) -> int:
    if indexed.address in ctx.weight_cache:
        return ctx.weight_cache[indexed.address]
    if indexed.address in stack:
        return 1
    stack.add(indexed.address)
    kind = ctx.records[indexed.record].get("kind")
    if kind in {"ObjectNode", "ListNode", "TupleLiteral"}:
        weight = sum(_measure_weight(item, ctx, stack) for item in _plane_children(indexed, ctx))
    elif kind == "NodeLiteral":
        weight = sum(1 + sum(_measure_weight(child, ctx, stack) for child in _plane_children(head, ctx)) for head in _plane_children(indexed, ctx))
    elif kind == "CloneReference":
        target = ctx.body.by_address.get(str(ctx.records[indexed.record].get("value", "")))
        weight = 1 if target is None else _measure_weight(target, ctx, stack)
    else:
        weight = 1
    stack.remove(indexed.address)
    ctx.weight_cache[indexed.address] = weight
    return weight


def _record_metadata(indexed: _IndexedRecord, ctx: _Context) -> object | None:
    own = _attributes_to_json(indexed, ctx)
    items = _indexed_item_attributes(indexed, ctx)
    if own is not None and items is not None:
        own["@items"] = items
        return own
    if own is not None:
        return own
    if items is not None:
        return {"@items": items}
    return None


def _attributes_to_json(indexed: _IndexedRecord, ctx: _Context) -> dict[str, object] | None:
    result: dict[str, object] = {}
    nested: dict[str, object] = {}
    for child in _attribute_children(_plane_for(indexed, ctx), indexed.address):
        key = str(child.segment[1])
        if not _safe_member(key, child.address, ctx):
            continue
        result[key] = _materialize_record(child, ctx)
        metadata = _record_metadata(child, ctx)
        if metadata is not None:
            nested[key] = metadata
    if nested:
        result["@"] = nested
    return result or None


def _indexed_item_attributes(indexed: _IndexedRecord, ctx: _Context) -> dict[str, object] | None:
    kind = ctx.records[indexed.record].get("kind")
    if kind == "NodeLiteral":
        owners = [child for head in _structural_children(_plane_for(indexed, ctx), indexed.address) for child in _structural_children(_plane_for(head, ctx), head.address)]
    elif kind in {"ListNode", "TupleLiteral"}:
        owners = _structural_children(_plane_for(indexed, ctx), indexed.address)
    else:
        owners = []
    result: dict[str, object] = {}
    for owner in owners:
        if owner.segment[0] != "index":
            continue
        attributes = _attributes_to_json(owner, ctx)
        if attributes is not None:
            result[str(owner.segment[1])] = attributes
    return result or None


def _structural_children(plane: _Plane, parent: str) -> list[_IndexedRecord]:
    return [item for item in plane.by_parent.get(parent, []) if item.segment[0] != "attribute"]


def _attribute_children(plane: _Plane, parent: str) -> list[_IndexedRecord]:
    return [item for item in plane.by_parent.get(parent, []) if item.segment[0] == "attribute"]


def _plane_children(indexed: _IndexedRecord, ctx: _Context) -> list[_IndexedRecord]:
    return _plane_for(indexed, ctx).by_parent.get(indexed.address, [])


def _plane_for(indexed: _IndexedRecord, ctx: _Context) -> _Plane:
    return ctx.header if "header" in ctx.records[indexed.record] else ctx.body


def _number_value(value: str, path: str, ctx: _Context) -> object:
    normalized = value.replace("_", "")
    try:
        if re.fullmatch(r"[+-]?[0-9]+", normalized):
            number: int | float = int(normalized)
        else:
            number = float(normalized)
        if not math.isfinite(number) or abs(number) > MAX_SAFE_INTEGER:
            raise ValueError
        return number
    except ValueError:
        ctx.report("FINALIZE_UNSAFE_NUMBER", f"Numeric literal is not safely representable in JSON: {value}", path)
        return value


def _null_value(value: str, path: str, ctx: _Context) -> object:
    if value == "none":
        return None
    ctx.report("FINALIZE_JSON_PROFILE_NULL", f"Null literal is not losslessly representable in strict JSON: {value}", path)
    if value in {"notSet", "notApplicable", "tombstone"}:
        return f"!{value}"
    return "!" + json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _radix_value(record: Mapping[str, object], value: str, path: str, ctx: _Context) -> str:
    normalized = value.replace("_", "")
    base = _declared_radix_base(record)
    if base is not None:
        for char in normalized:
            digit = _radix_digit_value(char)
            if char not in "+-." and (digit is None or digit >= base):
                ctx.report("FINALIZE_INVALID_RADIX_BASE", f"Radix literal exceeds declared radix {base}: %{normalized}", path)
                break
    return normalized


def _declared_radix_base(record: Mapping[str, object]) -> int | None:
    datatype = record.get("datatype")
    fixed = {"decimal": 10, "radix2": 2, "radix6": 6, "radix8": 8, "radix12": 12}
    if datatype in fixed:
        return fixed[str(datatype)]
    if datatype != "radix":
        return None
    clarifiers = record.get("clarifiers")
    if not isinstance(clarifiers, list) or not clarifiers or not isinstance(clarifiers[0], Mapping):
        return None
    first = clarifiers[0]
    if first.get("kind") != "NumberLiteral":
        return None
    try:
        value = int(str(first.get("value")))
    except ValueError:
        return None
    return value if 2 <= value <= 64 else None


def _radix_digit_value(char: str) -> int | None:
    if "0" <= char <= "9":
        return ord(char) - ord("0")
    if "A" <= char <= "Z":
        return ord(char) - ord("A") + 10
    if "a" <= char <= "z":
        return ord(char) - ord("a") + 36
    return 62 if char == "&" else 63 if char == "!" else None


def _safe_member(key: str, path: str, ctx: _Context) -> bool:
    if key not in RESERVED_OBJECT_KEYS:
        return True
    ctx.report("FINALIZE_RESERVED_KEY", f"Reserved key: {key}", path, True)
    return False


def _reference_token(prefix: str, target: str) -> str:
    return prefix + (target[2:] if target.startswith("$.") else target)
