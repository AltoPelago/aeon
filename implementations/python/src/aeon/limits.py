from __future__ import annotations

from typing import Any, Literal

from ._compat import dataclass
from .ast import Binding, ListNode, NullLiteral, NumberLiteral, ObjectNode, StringLiteral, Value
from .lexer import tokenize
from .parser import parse_tokens

AEONIC_LIMITS_ID = "altopelago.aeonic-limits.v1"
AEONIC_LIMITS_VERSION = "1.0.0"
LIMITS_BOOTSTRAP = {
    "max_input_bytes": 65_536,
    "max_events": 256,
    "max_path_depth": 8,
    "max_value_nesting_depth": 8,
    "max_attribute_depth": 0,
    "max_generic_depth": 0,
    "max_generic_arguments": 0,
    "max_clarifier_values": 0,
    "max_datatype_components": 1,
}

LimitSetting = int | Literal["unBound", "useImplementation"]


@dataclass(slots=True)
class LimitsDiagnostic:
    code: str
    path: str
    message: str


@dataclass(slots=True)
class AeonicLimitsV1:
    limits_id: str
    limits_version: str
    profile_claims: list[str]
    structure: dict[str, LimitSetting]
    processing: dict[str, LimitSetting]
    formats: dict[str, dict[str, LimitSetting]]
    transport: dict[str, LimitSetting]


@dataclass(slots=True)
class LimitsLoadResult:
    limits: AeonicLimitsV1 | None
    errors: list[LimitsDiagnostic]


def load_aeonic_limits(source: str) -> LimitsLoadResult:
    actual_bytes = len(source.encode("utf-8"))
    if actual_bytes > LIMITS_BOOTSTRAP["max_input_bytes"]:
        return _failure("LIMITS_BOOTSTRAP_EXCEEDED", "$", f"Limits input size {actual_bytes} exceeds bootstrap limit {LIMITS_BOOTSTRAP['max_input_bytes']}")
    lexed = tokenize(source)
    if lexed.errors:
        return LimitsLoadResult(None, [LimitsDiagnostic(error.code, "$", error.message) for error in lexed.errors])
    parsed = parse_tokens(
        source,
        lexed.tokens,
        max_attribute_depth=0,
        max_clarifier_values=0,
        max_generic_depth=0,
        max_generic_arguments=0,
        max_datatype_components=1,
        max_value_nesting_depth=8,
    )
    if parsed.errors or parsed.document is None:
        return LimitsLoadResult(None, [LimitsDiagnostic(getattr(error, "code", "INVALID_LIMITS_FILE"), "$", str(error)) for error in parsed.errors])
    if parsed.document.header is not None:
        return _failure("LIMITS_HEADER_NOT_ALLOWED", "$", "Limits files must not contain an AEON header")
    event_count = sum(_projected_event_count(binding.value) for binding in parsed.document.bindings)
    if event_count > LIMITS_BOOTSTRAP["max_events"]:
        return _failure("LIMITS_BOOTSTRAP_EXCEEDED", "$", f"Limits file projects {event_count} events; bootstrap limit is {LIMITS_BOOTSTRAP['max_events']}")

    errors: list[LimitsDiagnostic] = []
    decoded: dict[str, Any] = {}
    for binding in parsed.document.bindings:
        value = _decode_binding(binding, f"$.{binding.key}", errors)
        if value is not None:
            decoded[binding.key] = value
    if errors:
        return LimitsLoadResult(None, errors)
    try:
        return LimitsLoadResult(_validate_limits(decoded), [])
    except ValueError as error:
        return _failure("INVALID_LIMITS_FILE", "$", str(error))


def aeon_compile_limits(limits: AeonicLimitsV1) -> dict[str, int | None]:
    return {
        "max_attribute_depth": _bounded(limits.structure["max_attribute_depth"], 1, 64, "max_attribute_depth"),
        "max_clarifier_values": _bounded(limits.structure["max_clarifier_values"], 1, 4_096, "max_clarifier_values"),
        "max_generic_depth": _bounded(limits.structure["max_generic_depth"], 1, 64, "max_generic_depth"),
        "max_generic_arguments": _bounded(limits.structure["max_generic_arguments"], 32, 4_096, "max_generic_arguments"),
        "max_datatype_components": _bounded(limits.structure["max_datatype_components"], 64, 4_096, "max_datatype_components"),
        "max_value_nesting_depth": _bounded(limits.structure["max_value_nesting_depth"], 256, 512, "max_value_nesting_depth"),
        "max_path_depth": _bounded(limits.structure["max_path_depth"], 1024, 4096, "max_path_depth"),
        "max_string_codepoints": _bounded(limits.structure["max_string_codepoints"], 1_048_576, 16_777_216, "max_string_codepoints"),
        "max_key_segment_codepoints": _bounded(limits.structure["max_key_segment_codepoints"], 1024, 65_536, "max_key_segment_codepoints"),
        "max_list_items": _bounded(limits.structure["max_list_items"], 65_536, 1_000_000, "max_list_items"),
        "max_tuple_items": _bounded(limits.structure["max_tuple_items"], 65_536, 1_000_000, "max_tuple_items"),
        "max_path_characters": _bounded(limits.structure["max_path_characters"], 8192, 65_536, "max_path_characters"),
        "max_numeric_literal_characters": _bounded(limits.formats["aeon"]["max_numeric_literal_characters"], 1024, 65_536, "max_numeric_literal_characters"),
        "max_structured_comment_characters": _bounded(limits.formats["aeon"]["max_structured_comment_characters"], 1_048_576, 16_777_216, "max_structured_comment_characters"),
        "max_input_bytes": _optional(limits.formats["aeon"]["max_input_bytes"], 16_777_216),
        "max_events": _optional(limits.processing["max_events"], 100_000),
    }


def finalization_limits(limits: AeonicLimitsV1) -> dict[str, int]:
    result: dict[str, int] = {}
    reference_depth = limits.processing["max_reference_depth"]
    materialized_weight = limits.processing["max_materialized_weight"]
    if isinstance(reference_depth, int):
        result["max_reference_depth"] = reference_depth
    if isinstance(materialized_weight, int):
        result["max_materialized_weight"] = materialized_weight
    return result


def telex_limits(limits: AeonicLimitsV1) -> dict[str, int]:
    """Resolve the shared limits document for the Telex v0 codec."""

    format_limits = limits.formats["telex"]
    return {
        "max_input_bytes": _bounded(format_limits["max_input_bytes"], 67_108_864, 1_073_741_824, "max_input_bytes"),
        "max_line_bytes": _bounded(format_limits["max_line_bytes"], 1_048_576, 67_108_864, "max_line_bytes"),
        "max_fields_per_event": _bounded(format_limits["max_fields_per_event"], 64, 4_096, "max_fields_per_event"),
        "max_decoded_payload_bytes": _bounded(format_limits["max_decoded_payload_bytes"], 33_554_432, 1_073_741_824, "max_decoded_payload_bytes"),
        "max_events": _bounded(limits.processing["max_events"], 100_000, 1_000_000, "max_events"),
        "max_path_depth": _bounded(limits.structure["max_path_depth"], 1_024, 4_096, "max_path_depth"),
        "max_path_characters": _bounded(limits.structure["max_path_characters"], 8_192, 65_536, "max_path_characters"),
        "max_generic_depth": _bounded(limits.structure["max_generic_depth"], 1, 64, "max_generic_depth"),
        "max_generic_arguments": _bounded(limits.structure["max_generic_arguments"], 32, 4_096, "max_generic_arguments"),
        "max_clarifier_values": _bounded(limits.structure["max_clarifier_values"], 1, 4_096, "max_clarifier_values"),
        "max_datatype_components": _bounded(limits.structure["max_datatype_components"], 64, 4_096, "max_datatype_components"),
    }


def _decode_binding(binding: Binding, path: str, errors: list[LimitsDiagnostic]) -> Any:
    if binding.datatype is not None or binding.attributes or binding.structural_id is not None:
        errors.append(LimitsDiagnostic("LIMITS_DECORATION_NOT_ALLOWED", path, "Limits bindings may not use datatypes, attributes, or structural identities"))
        return None
    return _decode_value(binding.value, path, errors)


def _decode_value(value: Value, path: str, errors: list[LimitsDiagnostic]) -> Any:
    if isinstance(value, StringLiteral):
        return value.value
    if isinstance(value, NumberLiteral):
        normalized = value.value.replace("_", "")
        try:
            parsed = int(normalized, 10)
        except ValueError:
            errors.append(LimitsDiagnostic("INVALID_LIMIT_VALUE", path, "Limit values must be non-negative integers"))
            return None
        if parsed < 0 or parsed > 9_007_199_254_740_991:
            errors.append(LimitsDiagnostic("INVALID_LIMIT_VALUE", path, "Limit values must be non-negative safe integers"))
            return None
        return parsed
    if isinstance(value, NullLiteral):
        if value.mode == "reason" and value.value in {"unBound", "useImplementation"}:
            return value.value
        errors.append(LimitsDiagnostic("INVALID_LIMIT_VALUE", path, 'Only !"unBound" and !"useImplementation" are valid limit sentinels'))
        return None
    if isinstance(value, ListNode):
        return [_decode_value(item, f"{path}[{index}]", errors) for index, item in enumerate(value.elements)]
    if isinstance(value, ObjectNode):
        return {binding.key: _decode_binding(binding, f"{path}.{binding.key}", errors) for binding in value.bindings}
    errors.append(LimitsDiagnostic("INVALID_LIMIT_VALUE", path, f"Unsupported limits value {type(value).__name__}"))
    return None


def _projected_event_count(value: Value) -> int:
    if isinstance(value, ObjectNode):
        return 1 + sum(_projected_event_count(binding.value) for binding in value.bindings)
    if isinstance(value, ListNode):
        return 1 + sum(_projected_event_count(item) for item in value.elements)
    return 1


def _validate_limits(root: dict[str, Any]) -> AeonicLimitsV1:
    _assert_keys(root, "$", ["limits_id", "limits_version", "profile_claims", "structure", "processing", "formats", "transport"])
    if root["limits_id"] != AEONIC_LIMITS_ID:
        raise ValueError(f"Unsupported limits_id {root['limits_id']!r}")
    if root["limits_version"] != AEONIC_LIMITS_VERSION:
        raise ValueError(f"Unsupported limits_version {root['limits_version']!r}")
    claims = root["profile_claims"]
    if not isinstance(claims, list) or not all(isinstance(item, str) for item in claims):
        raise ValueError("$.profile_claims must be a list of strings")
    structure = _settings(root["structure"], "$.structure", ["max_attribute_depth", "max_generic_depth", "max_generic_arguments", "max_clarifier_values", "max_datatype_components", "max_value_nesting_depth", "max_path_depth", "max_string_codepoints", "max_key_segment_codepoints", "max_list_items", "max_tuple_items", "max_path_characters"])
    processing = _settings(root["processing"], "$.processing", ["max_events", "max_reference_depth", "max_materialized_weight"])
    formats = root["formats"]
    _assert_keys(formats, "$.formats", ["aeon", "telex"])
    aeon = _settings(formats["aeon"], "$.formats.aeon", ["max_input_bytes", "max_numeric_literal_characters", "max_structured_comment_characters"])
    telex = _settings(formats["telex"], "$.formats.telex", ["max_input_bytes", "max_line_bytes", "max_fields_per_event", "max_decoded_payload_bytes"])
    transport = _settings(root["transport"], "$.transport", ["max_frame_bytes", "max_buffer_bytes", "max_header_bytes"])
    return AeonicLimitsV1(AEONIC_LIMITS_ID, AEONIC_LIMITS_VERSION, claims, structure, processing, {"aeon": aeon, "telex": telex}, transport)


def _settings(value: Any, path: str, keys: list[str]) -> dict[str, LimitSetting]:
    if not isinstance(value, dict):
        raise ValueError(f"{path} must be an object")
    _assert_keys(value, path, keys)
    for key in keys:
        setting = value[key]
        if not ((isinstance(setting, int) and setting >= 0) or setting in {"unBound", "useImplementation"}):
            raise ValueError(f"{path}.{key} has an invalid limit value")
    return value


def _assert_keys(value: Any, path: str, expected: list[str]) -> None:
    if not isinstance(value, dict):
        raise ValueError(f"{path} must be an object")
    unknown = set(value) - set(expected)
    missing = set(expected) - set(value)
    if unknown:
        raise ValueError(f"Unknown field {path}.{sorted(unknown)[0]}")
    if missing:
        raise ValueError(f"Missing field {path}.{sorted(missing)[0]}")


def _bounded(setting: LimitSetting, implementation_default: int, ceiling: int, name: str) -> int:
    if setting == "useImplementation":
        return implementation_default
    if setting == "unBound":
        return ceiling
    if setting > ceiling:
        raise ValueError(f"{name} {setting} exceeds implementation safety ceiling {ceiling}")
    return setting


def _optional(setting: LimitSetting, implementation_default: int) -> int | None:
    if setting == "unBound":
        return None
    return implementation_default if setting == "useImplementation" else setting


def _failure(code: str, path: str, message: str) -> LimitsLoadResult:
    return LimitsLoadResult(None, [LimitsDiagnostic(code, path, message)])
