from __future__ import annotations

import json
import re
from typing import Iterable, Mapping

from ._compat import dataclass


TELEX_VERSION = "0"
COMPLETE_AES_PROFILE = "aes.complete.v0"
PARTIAL_AES_PROFILE = "aes.partial.v0"
AEON_DOCUMENT_PROJECTION = "aeon.document.v0"

VERSION_LINE = "telex.aes=0"
FIELD_NAME = re.compile(r"^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$")
BARE_MEMBER = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
DATATYPE_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
NUMBER = re.compile(r"^[+-]?(?:(?:[0-9]+(?:\.[0-9]*)?)|(?:\.[0-9]+))(?:[eE][+-]?[0-9]+)?$")
FIELD_ORDER = {
    name: index
    for index, name in enumerate(("header", "path", "kind", "datatype", "identity", "value", "origin", "span"))
}
CORE_FIELDS = {
    "header", "path", "kind", "datatype", "generics", "clarifiers", "identity", "value", "origin", "span"
}
VALUE_KINDS = {
    "StringLiteral", "NumberLiteral", "InfinityLiteral", "NaNLiteral", "NullLiteral",
    "BooleanLiteral", "ToggleLiteral", "HexLiteral", "RadixLiteral", "EncodingLiteral",
    "SeparatorLiteral", "SansaAddressLiteral", "DateLiteral", "TimeLiteral", "DateTimeLiteral",
    "WTCDateTimeLiteral", "ObjectNode", "ListNode", "TupleLiteral", "NodeLiteral", "NodeHead",
    "CloneReference", "PointerReference",
}
VALUELESS_KINDS = {"ObjectNode", "ListNode", "TupleLiteral", "NodeLiteral"}
INDEX_CONTAINER_KINDS = {"ListNode", "TupleLiteral", "NodeHead"}
EXACT_VALUES = {
    "InfinityLiteral": {"Infinity", "-Infinity"},
    "NaNLiteral": {"NaN", "-NaN"},
    "BooleanLiteral": {"true", "false"},
    "ToggleLiteral": {"yes", "no", "on", "off"},
}


@dataclass(slots=True, frozen=True)
class TelexLimits:
    max_input_bytes: int = 67_108_864
    max_line_bytes: int = 1_048_576
    max_fields_per_event: int = 64
    max_events: int = 100_000
    max_decoded_payload_bytes: int = 33_554_432
    max_path_depth: int = 1_024
    max_path_characters: int = 8_192
    max_generic_depth: int = 1
    max_generic_arguments: int = 32
    max_clarifier_values: int = 1
    max_datatype_components: int = 64


DEFAULT_TELEX_LIMITS = TelexLimits()


class TelexSyntaxError(ValueError):
    def __init__(
        self,
        message: str,
        line: int | None = None,
        code: str = "TELEX_SYNTAX_ERROR",
        *,
        counter: str | None = None,
        observed: int | None = None,
        limit: int | None = None,
    ) -> None:
        super().__init__(f"Line {line}: {message}" if line is not None else message)
        self.detail = message
        self.line = line
        self.code = code
        self.counter = counter
        self.observed = observed
        self.limit = limit

    def to_dict(self) -> dict[str, object]:
        result: dict[str, object] = {"code": self.code, "line": self.line, "message": self.detail}
        if self.counter is not None:
            result.update(counter=self.counter, observed=self.observed, limit=self.limit)
        return result


class DatatypeError(ValueError):
    def __init__(
        self,
        message: str,
        code: str = "TELEX_INVALID_DATATYPE",
        *,
        counter: str | None = None,
        observed: int | None = None,
        limit: int | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.counter = counter
        self.observed = observed
        self.limit = limit


@dataclass(slots=True)
class ParsedTelex:
    version: str
    profile: str
    profile_explicit: bool
    projection: str | None
    projection_explicit: bool
    records: list[dict[str, object]]
    canonical: bool

    def to_dict(self) -> dict[str, object]:
        return {
            "version": self.version,
            "profile": self.profile,
            "profile_explicit": self.profile_explicit,
            "projection": self.projection,
            "projection_explicit": self.projection_explicit,
            "canonical": self.canonical,
            "records": self.records,
        }


@dataclass(slots=True)
class _PathDetails:
    prefixes: list[str]
    segments: list[tuple[str, str | int]]


@dataclass(slots=True)
class _Candidate:
    event: dict[str, object]
    index: int
    address_field: str | None
    address: str | None
    path_details: _PathDetails | None


def normalize_telex_limits(limits: TelexLimits | Mapping[str, object] | None = None) -> TelexLimits:
    if limits is None:
        return DEFAULT_TELEX_LIMITS
    if isinstance(limits, TelexLimits):
        return limits
    if not isinstance(limits, Mapping):
        raise TypeError("Telex limits must be a mapping or TelexLimits")
    values = {name: getattr(DEFAULT_TELEX_LIMITS, name) for name in TelexLimits.__dataclass_fields__}
    aliases = {
        "maxInputBytes": "max_input_bytes", "maxLineBytes": "max_line_bytes",
        "maxFieldsPerEvent": "max_fields_per_event", "maxEvents": "max_events",
        "maxDecodedPayloadBytes": "max_decoded_payload_bytes", "maxPathDepth": "max_path_depth",
        "maxPathCharacters": "max_path_characters", "maxGenericDepth": "max_generic_depth",
        "maxGenericArguments": "max_generic_arguments", "maxClarifierValues": "max_clarifier_values",
        "maxDatatypeComponents": "max_datatype_components",
    }
    for raw_name, raw_value in limits.items():
        name = aliases.get(str(raw_name), str(raw_name))
        if name not in values:
            continue
        if isinstance(raw_value, bool) or not isinstance(raw_value, int) or raw_value < 0:
            raise TypeError(f"{name} must be a non-negative integer")
        values[name] = raw_value
    return TelexLimits(**values)


class _DatatypeParser:
    def __init__(self, source: str, limits: TelexLimits) -> None:
        self.source = source
        self.limits = limits
        self.cursor = 0
        self.items = 0

    def parse(self) -> dict[str, object]:
        result = self.parse_descriptor(0)
        self.skip_space()
        if self.cursor != len(self.source):
            self.fail("Unexpected trailing datatype syntax")
        return result

    def parse_descriptor(self, depth: int) -> dict[str, object]:
        self.count_item()
        self.skip_space()
        match = re.match(r"[A-Za-z_][A-Za-z0-9_]*", self.source[self.cursor :])
        if match is None:
            self.fail("Expected datatype name")
        datatype = match.group(0)
        self.cursor += len(datatype)
        self.skip_space()
        if self.peek() == "<" and depth > self.limits.max_generic_depth:
            self.fail_limit("max_generic_depth", depth, self.limits.max_generic_depth)
        generics = self.parse_generics(depth) if self.peek() == "<" else []
        self.skip_space()
        clarifiers = self.parse_clarifiers() if self.peek() == "[" else []
        return {"datatype": datatype, "generics": generics, "clarifiers": clarifiers}

    def parse_generics(self, depth: int) -> list[dict[str, object]]:
        self.consume("<")
        self.skip_space()
        if self.peek() == ">":
            self.fail("Generic argument list must not be empty")
        values: list[dict[str, object]] = []
        while True:
            self.skip_space()
            if re.match(r"[A-Za-z_]", self.peek() or ""):
                values.append(self.parse_descriptor(depth + 1))
            else:
                self.count_item()
                values.append({"kind": "NumberLiteral", "value": self.parse_number(",>")})
            if len(values) > self.limits.max_generic_arguments:
                self.fail_limit("max_generic_arguments", len(values), self.limits.max_generic_arguments)
            self.skip_space()
            if self.peek() == ">":
                self.cursor += 1
                return values
            self.consume(",")

    def parse_clarifiers(self) -> list[dict[str, str]]:
        self.consume("[")
        self.skip_space()
        if self.peek() == "]":
            self.fail("Clarifier list must not be empty")
        values: list[dict[str, str]] = []
        while True:
            self.count_item()
            if self.peek() == '"':
                values.append({"kind": "StringLiteral", "value": self.parse_string()})
            else:
                values.append({"kind": "NumberLiteral", "value": self.parse_number(",]")})
            if len(values) > self.limits.max_clarifier_values:
                self.fail_limit("max_clarifier_values", len(values), self.limits.max_clarifier_values)
            self.skip_space()
            if self.peek() == "]":
                self.cursor += 1
                return values
            self.consume(",")

    def parse_string(self) -> str:
        decoder = json.JSONDecoder()
        try:
            value, consumed = decoder.raw_decode(self.source[self.cursor :])
        except (json.JSONDecodeError, ValueError):
            self.fail("Invalid string clarifier")
        if not isinstance(value, str):
            self.fail("Expected string clarifier")
        _assert_unicode_scalars(value, "Datatype string clarifier")
        self.cursor += consumed
        return value

    def parse_number(self, delimiters: str) -> str:
        start = self.cursor
        while self.cursor < len(self.source):
            char = self.source[self.cursor]
            if char in delimiters or char.isspace():
                break
            self.cursor += 1
        value = self.source[start : self.cursor]
        if NUMBER.fullmatch(value) is None:
            self.fail("Expected numeric datatype argument")
        return value

    def consume(self, expected: str) -> None:
        self.skip_space()
        if self.peek() != expected:
            self.fail(f"Expected '{expected}'")
        self.cursor += 1
        self.skip_space()

    def skip_space(self) -> None:
        while self.cursor < len(self.source) and self.source[self.cursor] in " \t\r\n":
            self.cursor += 1

    def peek(self) -> str | None:
        return self.source[self.cursor] if self.cursor < len(self.source) else None

    def count_item(self) -> None:
        self.items += 1
        if self.items > self.limits.max_datatype_components:
            self.fail_limit("max_datatype_components", self.items, self.limits.max_datatype_components)

    def fail_limit(self, counter: str, observed: int, limit: int) -> None:
        raise DatatypeError(
            _limit_message(counter, observed, limit), "TELEX_DATATYPE_LIMIT",
            counter=counter, observed=observed, limit=limit,
        )

    def fail(self, message: str) -> None:
        raise DatatypeError(f"{message} at datatype offset {self.cursor}")


def parse_datatype_descriptor(source: str, limits: TelexLimits | Mapping[str, object] | None = None) -> dict[str, object]:
    if not isinstance(source, str):
        raise TypeError("Datatype descriptor must be a string")
    return _DatatypeParser(source, normalize_telex_limits(limits)).parse()


def format_datatype_descriptor(
    descriptor: Mapping[str, object], limits: TelexLimits | Mapping[str, object] | None = None
) -> str:
    normalized_limits = normalize_telex_limits(limits)
    _assert_datatype_descriptor(descriptor, normalized_limits, [0], 0)
    return _format_datatype(descriptor)


def _format_datatype(descriptor: Mapping[str, object]) -> str:
    generics = descriptor["generics"]
    clarifiers = descriptor["clarifiers"]
    generic_text = ""
    if isinstance(generics, list) and generics:
        generic_text = "<" + ", ".join(
            _format_datatype(item) if isinstance(item, Mapping) and "datatype" in item else str(item["value"])
            for item in generics
        ) + ">"
    clarifier_text = ""
    if isinstance(clarifiers, list) and clarifiers:
        clarifier_text = "[" + ", ".join(
            json.dumps(item["value"], ensure_ascii=False, separators=(",", ":"))
            if item["kind"] == "StringLiteral" else str(item["value"])
            for item in clarifiers
        ) + "]"
    return f"{descriptor['datatype']}{generic_text}{clarifier_text}"


def _assert_datatype_descriptor(
    descriptor: Mapping[str, object], limits: TelexLimits, state: list[int], depth: int
) -> None:
    if not isinstance(descriptor, Mapping) or set(descriptor) != {"datatype", "generics", "clarifiers"}:
        raise DatatypeError("Datatype descriptor has unknown or missing fields", "AES_INVALID_DATATYPE")
    datatype = descriptor.get("datatype")
    generics = descriptor.get("generics")
    clarifiers = descriptor.get("clarifiers")
    if not isinstance(datatype, str) or DATATYPE_NAME.fullmatch(datatype) is None:
        raise DatatypeError("Datatype must be an ASCII identifier", "AES_INVALID_DATATYPE")
    if not isinstance(generics, list) or not isinstance(clarifiers, list):
        raise DatatypeError("Datatype components must be arrays", "AES_INVALID_DATATYPE")
    _count_datatype_item(state, limits)
    if len(generics) > limits.max_generic_arguments:
        raise DatatypeError(_limit_message("max_generic_arguments", len(generics), limits.max_generic_arguments), "AES_DATATYPE_LIMIT")
    if len(clarifiers) > limits.max_clarifier_values:
        raise DatatypeError(_limit_message("max_clarifier_values", len(clarifiers), limits.max_clarifier_values), "AES_DATATYPE_LIMIT")
    if generics and depth > limits.max_generic_depth:
        raise DatatypeError(_limit_message("max_generic_depth", depth, limits.max_generic_depth), "AES_DATATYPE_DEPTH")
    for item in generics:
        if isinstance(item, Mapping) and "datatype" in item:
            _assert_datatype_descriptor(item, limits, state, depth + 1)
        else:
            _count_datatype_item(state, limits)
            _assert_tagged_literal(item, {"NumberLiteral"})
    for item in clarifiers:
        _count_datatype_item(state, limits)
        _assert_tagged_literal(item, {"StringLiteral", "NumberLiteral"})


def _count_datatype_item(state: list[int], limits: TelexLimits) -> None:
    state[0] += 1
    if state[0] > limits.max_datatype_components:
        raise DatatypeError(
            _limit_message("max_datatype_components", state[0], limits.max_datatype_components),
            "AES_DATATYPE_LIMIT",
        )


def _assert_tagged_literal(value: object, allowed: set[str]) -> None:
    if not isinstance(value, Mapping) or set(value) != {"kind", "value"}:
        raise DatatypeError("Datatype component must be a tagged literal", "AES_INVALID_DATATYPE")
    kind = value.get("kind")
    payload = value.get("value")
    if kind not in allowed or not isinstance(payload, str):
        raise DatatypeError("Invalid datatype component", "AES_INVALID_DATATYPE")
    _assert_unicode_scalars(payload, "Datatype component")
    if kind == "NumberLiteral" and NUMBER.fullmatch(payload) is None:
        raise DatatypeError("Invalid numeric datatype component", "AES_INVALID_DATATYPE")


def parse_telex(source: str, limits: TelexLimits | Mapping[str, object] | None = None) -> ParsedTelex:
    if not isinstance(source, str):
        raise TypeError("Telex input must be a string")
    opts = normalize_telex_limits(limits)
    _assert_physical_input(source, opts)
    if source.startswith("\ufeff"):
        raise TelexSyntaxError("UTF-8 byte-order marks are not allowed", 1, "TELEX_BOM")
    if re.search(r"\r(?!\n)", source):
        raise TelexSyntaxError("Bare carriage returns are not allowed", None, "TELEX_BARE_CR")
    _assert_unicode_scalars(source, "Telex input")

    canonical_line_endings = "\r\n" not in source
    normalized = source.replace("\r\n", "\n")
    has_final_lf = normalized.endswith("\n")
    lines = normalized.split("\n")
    if has_final_lf:
        lines.pop()
    if not lines or lines[0] != VERSION_LINE:
        raise TelexSyntaxError(f"Expected {VERSION_LINE}", 1, "TELEX_INVALID_PREAMBLE")
    if len(lines) == 1:
        return ParsedTelex(TELEX_VERSION, COMPLETE_AES_PROFILE, False, None, False, [], canonical_line_endings and has_final_lf)

    profile = COMPLETE_AES_PROFILE
    profile_explicit = False
    projection: str | None = None
    projection_explicit = False
    header_canonical = True
    event_start = 1
    last_rank = -1
    decoded_bytes = 0
    while event_start < len(lines) and lines[event_start] != "":
        raw = lines[event_start]
        delimiter = raw.find("=")
        name = raw[:delimiter] if delimiter >= 0 else ""
        if name not in {"profile", "projection"}:
            break
        rank = 0 if name == "profile" else 1
        header_canonical = header_canonical and rank >= last_rank
        last_rank = rank
        value, payload_canonical = _decode_payload(raw[delimiter + 1 :], event_start + 1)
        decoded_bytes = _add_payload_bytes(decoded_bytes, value, opts, event_start + 1)
        header_canonical = header_canonical and payload_canonical
        if not value:
            code = "TELEX_EMPTY_PROFILE" if name == "profile" else "TELEX_EMPTY_PROJECTION"
            raise TelexSyntaxError(f"{name.title()} identifier must not be empty", event_start + 1, code)
        if name == "profile":
            if profile_explicit:
                raise TelexSyntaxError("Duplicate stream field: profile", event_start + 1, "TELEX_DUPLICATE_STREAM_FIELD")
            profile, profile_explicit = value, True
        else:
            if projection_explicit:
                raise TelexSyntaxError("Duplicate stream field: projection", event_start + 1, "TELEX_DUPLICATE_STREAM_FIELD")
            projection, projection_explicit = value, True
        event_start += 1

    if event_start == len(lines):
        return ParsedTelex(
            TELEX_VERSION, profile, profile_explicit, projection, projection_explicit, [],
            canonical_line_endings and has_final_lf and header_canonical,
        )
    if lines[event_start] != "":
        raise TelexSyntaxError("Expected a blank line after the stream header", event_start + 1, "TELEX_MISSING_HEADER_SEPARATOR")
    event_start += 1

    records: list[dict[str, object]] = []
    fields: list[tuple[str, str]] | None = None
    datatype_line: int | None = None
    datatype_component_line: int | None = None
    canonical = canonical_line_endings and has_final_lf and header_canonical
    separator_width = 1
    for index in range(event_start, len(lines)):
        line_number = index + 1
        raw = lines[index]
        if raw == "":
            separator_width += 1
            if fields is not None:
                _assert_limit("max_events", len(records) + 1, opts.max_events, line_number)
                record, record_canonical = _decode_wire_record(fields, datatype_line, datatype_component_line, opts)
                canonical = canonical and record_canonical and _canonical_field_order(fields)
                records.append(record)
                fields = None
                datatype_line = None
                datatype_component_line = None
            continue
        if separator_width > 1:
            canonical = False
        separator_width = 0
        if fields is None:
            fields = []
        delimiter = raw.find("=")
        if delimiter < 1:
            raise TelexSyntaxError("Expected field=value", line_number, "TELEX_INVALID_FIELD_LINE")
        name = raw[:delimiter]
        if FIELD_NAME.fullmatch(name) is None:
            raise TelexSyntaxError(f"Invalid field name: {name}", line_number, "TELEX_INVALID_FIELD_NAME")
        if any(existing == name for existing, _ in fields):
            raise TelexSyntaxError(f"Duplicate field: {name}", line_number, "TELEX_DUPLICATE_FIELD")
        _assert_limit("max_fields_per_event", len(fields) + 1, opts.max_fields_per_event, line_number)
        value, payload_canonical = _decode_payload(raw[delimiter + 1 :], line_number)
        decoded_bytes = _add_payload_bytes(decoded_bytes, value, opts, line_number)
        canonical = canonical and payload_canonical
        fields.append((name, value))
        if name == "datatype":
            datatype_line = line_number
        elif name in {"generics", "clarifiers"} and datatype_component_line is None:
            datatype_component_line = line_number
    if fields is not None:
        _assert_limit("max_events", len(records) + 1, opts.max_events, len(lines))
        record, record_canonical = _decode_wire_record(fields, datatype_line, datatype_component_line, opts)
        canonical = canonical and record_canonical and _canonical_field_order(fields)
        records.append(record)
    if separator_width > 0:
        canonical = False
    return ParsedTelex(TELEX_VERSION, profile, profile_explicit, projection, projection_explicit, records, canonical)


def encode_telex(
    records: Iterable[Mapping[str, object]], *, profile: str | None = None,
    projection: str | None = None, limits: TelexLimits | Mapping[str, object] | None = None,
) -> str:
    items = list(records)
    opts = normalize_telex_limits(limits)
    _assert_limit("max_events", len(items), opts.max_events)
    if profile is not None and (not isinstance(profile, str) or not profile):
        raise TypeError("Telex profile must be a non-empty string")
    if projection is not None and (not isinstance(projection, str) or not projection):
        raise TypeError("Telex projection must be a non-empty string")
    header = VERSION_LINE
    decoded_bytes = 0
    if profile is not None:
        decoded_bytes = _add_payload_bytes(decoded_bytes, profile, opts)
        header += f"\nprofile={_encode_payload(profile)}"
    if projection is not None:
        decoded_bytes = _add_payload_bytes(decoded_bytes, projection, opts)
        header += f"\nprojection={_encode_payload(projection)}"
    if not items:
        output = f"{header}\n"
        _assert_physical_input(output, opts)
        return output
    stanzas: list[str] = []
    for index, record in enumerate(items):
        entries = _encode_wire_record(record, index, opts)
        if not entries:
            raise TypeError(f"Telex record {index + 1} must not be empty")
        _assert_limit("max_fields_per_event", len(entries), opts.max_fields_per_event)
        for name, value in entries:
            if FIELD_NAME.fullmatch(name) is None:
                raise TypeError(f"Invalid Telex field name: {name}")
            if not isinstance(value, str):
                raise TypeError(f"Telex field {name} must have a string payload")
            decoded_bytes = _add_payload_bytes(decoded_bytes, value, opts)
        entries.sort(key=lambda item: (FIELD_ORDER.get(item[0], len(FIELD_ORDER)), item[0] if item[0] not in FIELD_ORDER else ""))
        stanzas.append("\n".join(f"{name}={_encode_payload(value)}" for name, value in entries))
    output = f"{header}\n\n" + "\n\n".join(stanzas) + "\n"
    _assert_physical_input(output, opts)
    return output


def canonicalize_telex(source: str, limits: TelexLimits | Mapping[str, object] | None = None) -> str:
    parsed = parse_telex(source, limits)
    return encode_telex(
        parsed.records,
        profile=parsed.profile if parsed.profile_explicit else None,
        projection=parsed.projection if parsed.projection_explicit else None,
        limits=limits,
    )


def check_telex_completeness(
    source: str, limits: TelexLimits | Mapping[str, object] | None = None
) -> dict[str, object]:
    parsed = parse_telex(source, limits)
    return check_prefix_completeness(parsed.records, projection=parsed.projection)


def check_prefix_completeness(
    records: Iterable[Mapping[str, object]], *, projection: str | None = None
) -> dict[str, object]:
    items = list(records)
    paths = {"path": set(), "header": set()}
    for index, record in enumerate(items):
        address_field = _record_address_field(record)
        if address_field is None:
            raise TypeError(f"Telex record {index + 1} must have exactly one string address field")
        if address_field == "header" and projection != AEON_DOCUMENT_PROJECTION:
            raise TypeError(f"Telex record {index + 1} requires projection '{AEON_DOCUMENT_PROJECTION}'")
        paths[address_field].add(record[address_field])
    missing: list[dict[str, object]] = []
    reported: set[tuple[str, str]] = set()
    for record in items:
        address_field = _record_address_field(record)
        if address_field is None:
            continue
        address = str(record[address_field])
        for prefix in parse_canonical_path(address).prefixes[:-1]:
            marker = (address_field, prefix)
            if prefix in paths[address_field] or marker in reported:
                continue
            reported.add(marker)
            item: dict[str, object] = {"path": prefix, "requiredBy": address}
            if address_field == "header":
                item["field"] = "header"
            missing.append(item)
    return {"complete": not missing, "missing": missing}


def validate_telex(
    source: str | ParsedTelex, *, limits: TelexLimits | Mapping[str, object] | None = None,
    registered_fields: Iterable[str] = (),
) -> dict[str, object]:
    parsed = parse_telex(source, limits) if isinstance(source, str) else source
    if not isinstance(parsed, ParsedTelex):
        raise TypeError("Expected Telex text or ParsedTelex")
    return validate_telex_records(
        parsed.records, profile=parsed.profile, projection=parsed.projection,
        limits=limits, registered_fields=registered_fields,
    )


def validate_telex_records(
    records: Iterable[Mapping[str, object]], *, profile: str = COMPLETE_AES_PROFILE,
    projection: str | None = None, limits: TelexLimits | Mapping[str, object] | None = None,
    registered_fields: Iterable[str] = (),
) -> dict[str, object]:
    items = list(records)
    opts = normalize_telex_limits(limits)
    registered = set(registered_fields)
    for name in registered:
        if not isinstance(name, str) or FIELD_NAME.fullmatch(name) is None or name in CORE_FIELDS:
            raise TypeError(f"Invalid registered extension field: {name}")
    diagnostics: list[dict[str, object]] = []
    candidates: list[_Candidate] = []
    if len(items) > opts.max_events:
        diagnostics.append(_limit_diagnostic("max_events", len(items), opts.max_events))
    if profile not in {COMPLETE_AES_PROFILE, PARTIAL_AES_PROFILE}:
        diagnostics.append(_diagnostic("AES_UNSUPPORTED_PROFILE", f"Unsupported AES profile: {profile}"))
    if projection not in {None, AEON_DOCUMENT_PROJECTION}:
        diagnostics.append(_diagnostic("AES_UNSUPPORTED_PROJECTION", f"Unsupported AES projection: {projection}"))
    body_seen = False
    for index, source in enumerate(items):
        if not isinstance(source, Mapping):
            diagnostics.append(_diagnostic("AES_INVALID_EVENT", "An AES event must be an object", record=index))
            continue
        event = dict(source)
        address_field = _record_address_field(event)
        address = event.get(address_field) if address_field is not None else None
        context: dict[str, object] = {"record": index}
        if isinstance(address, str):
            context["path"] = address
        for name, payload in event.items():
            if name not in {"generics", "clarifiers"} and not isinstance(payload, str):
                diagnostics.append(_diagnostic("AES_INVALID_PAYLOAD", f"Field '{name}' must have a string payload", **context, field=name))
            if name not in CORE_FIELDS and name not in registered:
                diagnostics.append(_diagnostic("AES_UNKNOWN_FIELD", f"Field '{name}' is not registered by profile '{profile}'", **context, field=name))
        has_path, has_header = "path" in event, "header" in event
        if not has_path and not has_header:
            diagnostics.append(_diagnostic("AES_MISSING_ADDRESS", "AES records require exactly one of 'path' or 'header'", **context))
        elif has_path and has_header:
            diagnostics.append(_diagnostic("AES_MULTIPLE_ADDRESSES", "AES records cannot carry both 'path' and 'header'", **context))
        if "kind" not in event:
            diagnostics.append(_diagnostic("AES_MISSING_FIELD", "AES records require 'kind'", **context, field="kind"))
        path_details: _PathDetails | None = None
        if isinstance(address, str):
            try:
                path_details = parse_canonical_path(address)
                if address == "$":
                    raise ValueError("The root is not an event path")
                _validate_path_limits(address, path_details, opts, diagnostics, context, address_field or "path")
            except ValueError as error:
                code = "AES_INVALID_HEADER_PATH" if address_field == "header" else "AES_INVALID_PATH"
                diagnostics.append(_diagnostic(code, str(error), **context, field=address_field or "path"))
                path_details = None
        if address_field == "header":
            if projection != AEON_DOCUMENT_PROJECTION:
                diagnostics.append(_diagnostic("AES_HEADER_REQUIRES_PROJECTION", f"Header records require projection '{AEON_DOCUMENT_PROJECTION}'", **context, field="header"))
            if body_seen:
                diagnostics.append(_diagnostic("AES_HEADER_ORDER", "Header records must precede body events", **context, field="header"))
            if path_details is not None and not _is_aeon_header_path(address or "", path_details):
                diagnostics.append(_diagnostic("AES_INVALID_HEADER_PATH", "Header paths must begin with a quoted 'aeon:' member", **context, field="header"))
                path_details = None
        elif address_field == "path":
            body_seen = True
        kind = event.get("kind")
        known_kind = isinstance(kind, str) and kind in VALUE_KINDS
        if isinstance(kind, str) and not known_kind:
            diagnostics.append(_diagnostic("AES_UNKNOWN_KIND", f"Unknown AES value kind: {kind}", **context, field="kind"))
        if known_kind:
            _validate_event_value(event, index, diagnostics, opts)
        _validate_optional_fields(event, index, diagnostics, opts)
        candidates.append(_Candidate(event, index, address_field, address if isinstance(address, str) else None, path_details))
    body = [candidate for candidate in candidates if candidate.address_field == "path"]
    header = [candidate for candidate in candidates if candidate.address_field == "header"]
    if profile == COMPLETE_AES_PROFILE:
        _validate_complete_stream(body, diagnostics)
        _validate_reference_targets(body + (header if projection == AEON_DOCUMENT_PROJECTION else []), body, diagnostics)
    if projection == AEON_DOCUMENT_PROJECTION:
        _validate_complete_stream(header, diagnostics)
    identity_events = body + (header if projection == AEON_DOCUMENT_PROJECTION else []) if profile == COMPLETE_AES_PROFILE else (header if projection == AEON_DOCUMENT_PROJECTION else [])
    _validate_identity_uniqueness(identity_events, diagnostics)
    return {"valid": not diagnostics, "profile": profile, "diagnostics": diagnostics}


def parse_canonical_path(path: str) -> _PathDetails:
    if not isinstance(path, str) or not path.startswith("$"):
        raise ValueError(f"Expected an absolute canonical path: {path}")
    if path == "$":
        return _PathDetails([], [])
    cursor = 1
    prefixes: list[str] = []
    segments: list[tuple[str, str | int]] = []
    while cursor < len(path):
        start = cursor
        if path.startswith(".@.", cursor):
            cursor += 3
            member, cursor = _read_member(path, cursor)
            segments.append(("attribute", member))
        elif path[cursor] == ".":
            cursor += 1
            member, cursor = _read_member(path, cursor)
            segments.append(("member", member))
        elif path[cursor] == "[":
            match = re.match(r"\[(0|[1-9][0-9]*)\]", path[cursor :])
            if match is None:
                raise ValueError(f"Invalid canonical index in path: {path}")
            cursor += len(match.group(0))
            segments.append(("index", int(match.group(1))))
        else:
            raise ValueError(f"Invalid canonical path segment in: {path}")
        prefixes.append(f"{prefixes[-1] if prefixes else '$'}{path[start:cursor]}")
    return _PathDetails(prefixes, segments)


def _read_member(path: str, cursor: int) -> tuple[str, int]:
    if cursor < len(path) and path[cursor] == "[":
        if cursor + 1 >= len(path) or path[cursor + 1] != '"':
            raise ValueError(f"Expected a quoted canonical member in path: {path}")
        decoder = json.JSONDecoder()
        try:
            value, consumed = decoder.raw_decode(path[cursor + 1 :])
        except json.JSONDecodeError as error:
            raise ValueError(f"Invalid quoted canonical member in path: {path}") from error
        end = cursor + 1 + consumed
        encoded = path[cursor + 1 : end]
        if end >= len(path) or path[end] != "]" or not isinstance(value, str):
            raise ValueError(f"Unterminated quoted canonical member in path: {path}")
        canonical = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
        if not value or BARE_MEMBER.fullmatch(value) is not None or canonical != encoded:
            raise ValueError(f"Non-canonical quoted member in path: {path}")
        _assert_unicode_scalars(value, "Canonical path member")
        return value, end + 1
    match = re.match(r"[A-Za-z_][A-Za-z0-9_]*", path[cursor :])
    if match is None:
        raise ValueError(f"Invalid canonical member in path: {path}")
    value = match.group(0)
    return value, cursor + len(value)


def _decode_wire_record(
    fields: list[tuple[str, str]], datatype_line: int | None,
    component_line: int | None, limits: TelexLimits,
) -> tuple[dict[str, object], bool]:
    result: dict[str, object] = {}
    canonical = True
    for name, value in fields:
        if name in {"generics", "clarifiers"}:
            raise TelexSyntaxError(
                f"Logical AES field '{name}' must be encoded through the Telex datatype line",
                component_line, "TELEX_INVALID_DATATYPE",
            )
        if name != "datatype":
            result[name] = value
            continue
        try:
            descriptor = parse_datatype_descriptor(value, limits)
        except DatatypeError as error:
            raise TelexSyntaxError(
                str(error), datatype_line, error.code, counter=error.counter,
                observed=error.observed, limit=error.limit,
            ) from error
        canonical = canonical and format_datatype_descriptor(descriptor, limits) == value
        result.update(descriptor)
    return result, canonical


def _encode_wire_record(
    source: Mapping[str, object], record_index: int, limits: TelexLimits
) -> list[tuple[str, str]]:
    if not isinstance(source, Mapping):
        raise TypeError(f"Telex record {record_index + 1} must be an object")
    has_datatype = "datatype" in source
    has_generics = "generics" in source
    has_clarifiers = "clarifiers" in source
    if not has_datatype and (has_generics or has_clarifiers):
        raise TypeError(f"Telex record {record_index + 1} has datatype components without datatype")
    if has_datatype and (not has_generics or not has_clarifiers):
        raise TypeError(f"Telex record {record_index + 1} requires generics and clarifiers arrays with datatype")
    wire_datatype = None
    if has_datatype:
        wire_datatype = format_datatype_descriptor(
            {"datatype": source["datatype"], "generics": source["generics"], "clarifiers": source["clarifiers"]}, limits
        )
    return [
        (str(name), wire_datatype if name == "datatype" else value)  # type: ignore[arg-type]
        for name, value in source.items() if name not in {"generics", "clarifiers"}
    ]


def _validate_event_value(event: dict[str, object], index: int, diagnostics: list[dict[str, object]], limits: TelexLimits) -> None:
    context = _event_context(event, index)
    kind = event.get("kind")
    if kind in VALUELESS_KINDS:
        if "value" in event:
            diagnostics.append(_diagnostic("AES_UNEXPECTED_VALUE", f"Kind '{kind}' must not carry 'value'", **context, field="value"))
        return
    if "value" not in event:
        diagnostics.append(_diagnostic("AES_MISSING_VALUE", f"Kind '{kind}' requires 'value'", **context, field="value"))
        return
    value = event.get("value")
    if not isinstance(value, str):
        return
    if kind in EXACT_VALUES and value not in EXACT_VALUES[str(kind)]:
        diagnostics.append(_diagnostic("AES_INVALID_VALUE", f"Invalid '{kind}' payload: {value}", **context, field="value"))
    if kind == "HexLiteral" and re.fullmatch(r"[0-9a-f]+", value) is None:
        diagnostics.append(_diagnostic("AES_INVALID_VALUE", "Hex payloads require one or more lowercase hexadecimal digits", **context, field="value"))
    if kind == "NodeHead" and not value:
        diagnostics.append(_diagnostic("AES_INVALID_VALUE", "Node tags must not be empty", **context, field="value"))
    if kind == "WTCDateTimeLiteral" and "&" in value:
        reference = value.rsplit("&", 1)[1]
        if reference.lower() == "local" and reference != "local":
            diagnostics.append(_diagnostic("AES_INVALID_VALUE", "The reserved WTC reference must be exact lowercase 'local'", **context, field="value"))
    if kind in {"CloneReference", "PointerReference"}:
        try:
            details = parse_canonical_path(value)
            if value == "$":
                raise ValueError("The root is not an event path")
            _validate_path_limits(value, details, limits, diagnostics, context, "value")
        except ValueError as error:
            diagnostics.append(_diagnostic("AES_INVALID_REFERENCE", str(error), **context, field="value"))


def _validate_optional_fields(event: dict[str, object], index: int, diagnostics: list[dict[str, object]], limits: TelexLimits) -> None:
    context = _event_context(event, index)
    for name in ("datatype", "identity"):
        if name in event and event[name] == "":
            diagnostics.append(_diagnostic("AES_EMPTY_FIELD", f"Field '{name}' must not be empty when present", **context, field=name))
    has_datatype, has_generics, has_clarifiers = "datatype" in event, "generics" in event, "clarifiers" in event
    if not has_datatype and (has_generics or has_clarifiers):
        diagnostics.append(_diagnostic("AES_DATATYPE_COMPONENTS", "Fields 'generics' and 'clarifiers' require 'datatype'", **context, field="generics" if has_generics else "clarifiers"))
    elif has_datatype and (not has_generics or not has_clarifiers):
        diagnostics.append(_diagnostic("AES_DATATYPE_COMPONENTS", "A datatype requires explicit 'generics' and 'clarifiers' arrays", **context, field="generics" if not has_generics else "clarifiers"))
    elif has_datatype:
        try:
            _assert_datatype_descriptor(
                {"datatype": event.get("datatype"), "generics": event.get("generics"), "clarifiers": event.get("clarifiers")}, limits, [0], 0
            )
        except DatatypeError as error:
            diagnostics.append(_diagnostic(error.code, str(error), **context, field="datatype"))
    origin = event.get("origin")
    if isinstance(origin, str) and re.fullmatch(r"sha256:[0-9a-f]{64}", origin) is None:
        diagnostics.append(_diagnostic("AES_INVALID_ORIGIN", "Origin must be 'sha256:' followed by 64 lowercase hexadecimal digits", **context, field="origin"))
    span = event.get("span")
    if not isinstance(span, str):
        return
    if "origin" not in event:
        diagnostics.append(_diagnostic("AES_SPAN_REQUIRES_ORIGIN", "Field 'span' requires source identity in 'origin'", **context, field="span"))
    match = re.fullmatch(r"(0|[1-9][0-9]*):(0|[1-9][0-9]*)", span)
    if match is None or int(match.group(1)) >= int(match.group(2)):
        diagnostics.append(_diagnostic("AES_INVALID_SPAN", "Span must be canonical 'start-byte:end-byte' with start-byte < end-byte", **context, field="span"))


def _validate_complete_stream(events: list[_Candidate], diagnostics: list[dict[str, object]]) -> None:
    by_path: dict[str, _Candidate] = {}
    for candidate in events:
        if candidate.path_details is None or candidate.address is None:
            continue
        if candidate.address in by_path:
            diagnostics.append(_diagnostic("AES_DUPLICATE_PATH", f"Duplicate record address '{candidate.address}'", record=candidate.index, path=candidate.address, firstRecord=by_path[candidate.address].index))
        else:
            by_path[candidate.address] = candidate
    for candidate in events:
        details = candidate.path_details
        if details is None or candidate.address is None:
            continue
        kind = candidate.event.get("kind")
        if len(details.segments) == 1:
            if details.segments[0][0] != "member":
                diagnostics.append(_diagnostic("AES_MISSING_PARENT", "Only a member event can be a direct child of the unrepresented '$' root", record=candidate.index, path=candidate.address, requiredPath="$"))
            if kind == "NodeHead":
                diagnostics.append(_invalid_node_head(candidate))
            continue
        segment_kind = details.segments[-1][0]
        parent_path = details.prefixes[-2]
        parent = by_path.get(parent_path)
        if parent is None:
            diagnostics.append(_diagnostic("AES_MISSING_PARENT", f"Missing parent event '{parent_path}'", record=candidate.index, path=candidate.address, requiredPath=parent_path))
            continue
        parent_kind = parent.event.get("kind")
        if segment_kind == "member" and parent_kind != "ObjectNode":
            diagnostics.append(_incompatible_parent(candidate, parent_path, str(parent_kind), "ObjectNode"))
        elif segment_kind == "index":
            if parent_kind == "NodeLiteral" and kind != "NodeHead":
                diagnostics.append(_incompatible_parent(candidate, parent_path, "NodeLiteral", "NodeHead child"))
            elif parent_kind != "NodeLiteral" and parent_kind not in INDEX_CONTAINER_KINDS:
                diagnostics.append(_incompatible_parent(candidate, parent_path, str(parent_kind), "ListNode, TupleLiteral, NodeLiteral, or NodeHead"))
        if kind == "NodeHead" and (segment_kind != "index" or parent_kind != "NodeLiteral"):
            diagnostics.append(_invalid_node_head(candidate))


def _validate_reference_targets(reference_events: list[_Candidate], body_events: list[_Candidate], diagnostics: list[dict[str, object]]) -> None:
    paths = {item.address for item in body_events if item.path_details is not None}
    for candidate in reference_events:
        if candidate.event.get("kind") not in {"CloneReference", "PointerReference"}:
            continue
        target = candidate.event.get("value")
        if not isinstance(target, str) or target == "$":
            continue
        try:
            parse_canonical_path(target)
        except ValueError:
            continue
        if target not in paths:
            diagnostics.append(_diagnostic("AES_MISSING_REFERENCE_TARGET", f"Missing reference target '{target}'", record=candidate.index, path=candidate.address, field="value", requiredPath=target))


def _validate_identity_uniqueness(events: list[_Candidate], diagnostics: list[dict[str, object]]) -> None:
    identities: dict[str, int] = {}
    for candidate in events:
        identity = candidate.event.get("identity")
        if not isinstance(identity, str) or not identity:
            continue
        if identity in identities:
            diagnostics.append(_diagnostic("AES_DUPLICATE_IDENTITY", f"Duplicate structural identity '{identity}'", record=candidate.index, path=candidate.address, field="identity", firstRecord=identities[identity]))
        else:
            identities[identity] = candidate.index


def _event_context(event: Mapping[str, object], index: int) -> dict[str, object]:
    address_field = _record_address_field(event)
    result: dict[str, object] = {"record": index}
    if address_field is not None and isinstance(event.get(address_field), str):
        result["path"] = event[address_field]
    return result


def _record_address_field(record: Mapping[str, object]) -> str | None:
    has_path = isinstance(record.get("path"), str)
    has_header = isinstance(record.get("header"), str)
    if has_path == has_header:
        return None
    return "header" if has_header else "path"


def _is_aeon_header_path(path: str, details: _PathDetails) -> bool:
    return bool(details.segments and details.segments[0][0] == "member" and str(details.segments[0][1]).startswith("aeon:") and len(str(details.segments[0][1])) > 5 and path.startswith('$.['))


def _incompatible_parent(candidate: _Candidate, parent: str, actual: str, expected: str) -> dict[str, object]:
    return _diagnostic("AES_INCOMPATIBLE_PARENT", f"Parent '{parent}' has kind '{actual}'; expected {expected}", record=candidate.index, path=candidate.address, requiredPath=parent)


def _invalid_node_head(candidate: _Candidate) -> dict[str, object]:
    return _diagnostic("AES_INVALID_NODE_HEAD", "A 'NodeHead' must be an indexed direct child of a 'NodeLiteral'", record=candidate.index, path=candidate.address)


def _validate_path_limits(path: str, details: _PathDetails, limits: TelexLimits, diagnostics: list[dict[str, object]], context: Mapping[str, object], field_name: str) -> None:
    if len(details.segments) > limits.max_path_depth:
        diagnostics.append(_limit_diagnostic("max_path_depth", len(details.segments), limits.max_path_depth, **context, field=field_name))
    if len(path) > limits.max_path_characters:
        diagnostics.append(_limit_diagnostic("max_path_characters", len(path), limits.max_path_characters, **context, field=field_name))


def _diagnostic(code: str, message: str, **context: object) -> dict[str, object]:
    return {"code": code, "message": message, **context}


def _limit_diagnostic(counter: str, observed: int, limit: int, **context: object) -> dict[str, object]:
    return _diagnostic("AES_LIMIT_EXCEEDED", _limit_message(counter, observed, limit), **context, counter=counter, observed=observed, limit=limit)


def _decode_payload(payload: str, line: int) -> tuple[str, bool]:
    output: list[str] = []
    canonical = True
    cursor = 0
    short = {"\\": "\\", "n": "\n", "r": "\r", "t": "\t", "0": "\0"}
    while cursor < len(payload):
        char = payload[cursor]
        scalar = ord(char)
        if char != "\\":
            if scalar <= 0x1F or scalar == 0x7F:
                raise TelexSyntaxError("Unescaped control character in payload", line, "TELEX_UNESCAPED_CONTROL")
            if 0xD800 <= scalar <= 0xDFFF:
                raise TelexSyntaxError("Payload contains a surrogate instead of a Unicode scalar", line, "TELEX_INVALID_UNICODE_SCALAR")
            output.append(char)
            cursor += 1
            continue
        cursor += 1
        if cursor >= len(payload):
            raise TelexSyntaxError("Incomplete escape", line, "TELEX_INCOMPLETE_ESCAPE")
        escape = payload[cursor]
        if escape in short:
            output.append(short[escape])
            cursor += 1
            continue
        if escape != "u" or cursor + 1 >= len(payload) or payload[cursor + 1] != "{":
            raise TelexSyntaxError(f"Unknown escape: \\{escape}", line, "TELEX_UNKNOWN_ESCAPE")
        close = payload.find("}", cursor + 2)
        if close < 0:
            raise TelexSyntaxError("Unterminated Unicode escape", line, "TELEX_UNTERMINATED_UNICODE_ESCAPE")
        digits = payload[cursor + 2 : close]
        if re.fullmatch(r"[0-9A-Fa-f]{1,6}", digits) is None:
            raise TelexSyntaxError("Invalid Unicode escape", line, "TELEX_INVALID_UNICODE_ESCAPE")
        scalar = int(digits, 16)
        if scalar > 0x10FFFF or 0xD800 <= scalar <= 0xDFFF:
            raise TelexSyntaxError("Unicode escape is not a scalar value", line, "TELEX_INVALID_UNICODE_SCALAR")
        if digits != f"{scalar:X}" or scalar in {0, 9, 10, 13}:
            canonical = False
        output.append(chr(scalar))
        cursor = close + 1
    return "".join(output), canonical


def _encode_payload(payload: str) -> str:
    _assert_unicode_scalars(payload, "Telex payload")
    output: list[str] = []
    short = {"\\": "\\\\", "\n": "\\n", "\r": "\\r", "\t": "\\t", "\0": "\\0"}
    for char in payload:
        if char in short:
            output.append(short[char])
        elif ord(char) < 0x20 or ord(char) == 0x7F:
            output.append(f"\\u{{{ord(char):X}}}")
        else:
            output.append(char)
    return "".join(output)


def _canonical_field_order(fields: list[tuple[str, str]]) -> bool:
    sorted_names = [name for name, _ in sorted(fields, key=lambda item: (FIELD_ORDER.get(item[0], len(FIELD_ORDER)), item[0] if item[0] not in FIELD_ORDER else ""))]
    return [name for name, _ in fields] == sorted_names


def _assert_physical_input(source: str, limits: TelexLimits) -> None:
    try:
        byte_length = len(source.encode("utf-8"))
    except UnicodeEncodeError as error:
        raise TelexSyntaxError("Payload contains a surrogate instead of a Unicode scalar", None, "TELEX_INVALID_UNICODE_SCALAR") from error
    _assert_limit("max_input_bytes", byte_length, limits.max_input_bytes)
    for index, raw in enumerate(source.split("\n"), start=1):
        physical = raw[:-1] if raw.endswith("\r") else raw
        _assert_limit("max_line_bytes", len(physical.encode("utf-8")), limits.max_line_bytes, index)


def _add_payload_bytes(current: int, value: str, limits: TelexLimits, line: int | None = None) -> int:
    observed = current + len(value.encode("utf-8"))
    _assert_limit("max_decoded_payload_bytes", observed, limits.max_decoded_payload_bytes, line)
    return observed


def _assert_limit(counter: str, observed: int, limit: int, line: int | None = None) -> None:
    if observed > limit:
        raise TelexSyntaxError(_limit_message(counter, observed, limit), line, "TELEX_LIMIT_EXCEEDED", counter=counter, observed=observed, limit=limit)


def _limit_message(counter: str, observed: int, limit: int) -> str:
    return f"{counter} observed value {observed} exceeds configured limit {limit}"


def _assert_unicode_scalars(value: str, label: str) -> None:
    if any(0xD800 <= ord(char) <= 0xDFFF for char in value):
        raise ValueError(f"{label} must contain only Unicode scalar values")
