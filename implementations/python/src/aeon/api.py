from __future__ import annotations

from dataclasses import replace
import json
from pathlib import Path
import re

from ._compat import dataclass
from .aeos import validate_events, validate_telex_records as validate_aeos_telex_records
from .core import CompileOptions, CompileResult, compile_source
from .finalize import FinalizeOptions, finalize_json
from .portable import export_telex
from .portable_finalize import PortableFinalizeOptions, finalize_portable_json
from .telex import (
    ParsedTelex,
    TelexSyntaxError,
    encode_telex,
    parse_telex,
    validate_telex_records as validate_portable_telex_records,
)


@dataclass(slots=True)
class LoadOptions:
    compile: CompileOptions | None = None
    finalize: FinalizeOptions | None = None
    schema: dict[str, object] | None = None
    schema_file: str | Path | None = None
    validation_options: dict[str, object] | None = None
    datatype_policy: str | None = None


class AeonLoadError(Exception):
    pass


@dataclass(slots=True)
class TelexLoadOptions:
    finalize: PortableFinalizeOptions | None = None
    schema: dict[str, object] | None = None
    schema_file: str | Path | None = None
    validation_options: dict[str, object] | None = None
    limits: object = None
    registered_fields: tuple[str, ...] = ()


@dataclass(slots=True)
class LoadedTelexDocument:
    source: str
    parsed: ParsedTelex | None
    portable_validation: dict[str, object] | None
    finalized: dict[str, object] | None
    validation: dict[str, object] | None = None
    decode_error: dict[str, object] | None = None

    @property
    def ok(self) -> bool:
        return not self.errors

    @property
    def document(self) -> object | None:
        return self.finalized.get("document") if self.finalized is not None else None

    @property
    def errors(self) -> list[dict[str, object]]:
        errors: list[dict[str, object]] = []
        if self.decode_error is not None:
            errors.append(self.decode_error)
        if self.portable_validation is not None:
            diagnostics = self.portable_validation.get("diagnostics", [])
            if isinstance(diagnostics, list):
                errors.extend(item for item in diagnostics if isinstance(item, dict))
        if self.finalized is not None:
            meta = self.finalized.get("meta", {})
            if isinstance(meta, dict) and isinstance(meta.get("errors"), list):
                errors.extend(item for item in meta["errors"] if isinstance(item, dict))
        if self.validation is not None and isinstance(self.validation.get("errors"), list):
            errors.extend(item for item in self.validation["errors"] if isinstance(item, dict))
        return errors

    @property
    def warnings(self) -> list[dict[str, object]]:
        warnings: list[dict[str, object]] = []
        if self.finalized is not None:
            meta = self.finalized.get("meta", {})
            if isinstance(meta, dict) and isinstance(meta.get("warnings"), list):
                warnings.extend(item for item in meta["warnings"] if isinstance(item, dict))
        if self.validation is not None and isinstance(self.validation.get("warnings"), list):
            warnings.extend(item for item in self.validation["warnings"] if isinstance(item, dict))
        return warnings

    def require_ok(self) -> "LoadedTelexDocument":
        if self.ok:
            return self
        messages = [
            f"{error.get('code', 'ERROR')}: {error.get('message', 'Telex load failed')}"
            for error in self.errors
        ]
        raise AeonLoadError("\n".join(messages))


@dataclass(slots=True)
class LoadedDocument:
    source: str
    compile: CompileResult
    finalized: dict[str, object] | None
    validation: dict[str, object] | None = None

    @property
    def ok(self) -> bool:
        return not self.compile.errors and not self.validation_errors

    @property
    def document(self) -> object | None:
        if self.finalized is None:
            return None
        return self.finalized.get("document")

    @property
    def compile_errors(self) -> list[object]:
        return list(self.compile.errors)

    @property
    def validation_errors(self) -> list[dict[str, object]]:
        if self.validation is None:
            return []
        errors = self.validation.get("errors", [])
        return list(errors) if isinstance(errors, list) else []

    @property
    def warnings(self) -> list[dict[str, object]]:
        if self.validation is None:
            return []
        warnings = self.validation.get("warnings", [])
        return list(warnings) if isinstance(warnings, list) else []

    def require_ok(self) -> "LoadedDocument":
        if self.ok:
            return self

        messages: list[str] = []
        for error in self.compile.errors:
            code = getattr(error, "code", "ERROR")
            message = getattr(error, "message", str(error))
            messages.append(f"{code}: {message}")
        for error in self.validation_errors:
            code = str(error.get("code", "ERROR"))
            path = str(error.get("path", "$"))
            message = str(error.get("message", "validation failed"))
            messages.append(f"{code} at {path}: {message}")
        raise AeonLoadError("\n".join(messages))

    def get(self, path: str, default: object | None = None) -> object | None:
        document = self.document
        if document is None:
            return default
        current: object = document
        for segment in parse_document_path(path):
            if isinstance(segment, int):
                if not isinstance(current, list) or segment >= len(current):
                    return default
                current = current[segment]
                continue
            if not isinstance(current, dict) or segment not in current:
                return default
            current = current[segment]
        return current

    def require(self, path: str) -> object:
        value = self.get(path, default=None)
        if value is None:
            raise AeonLoadError(f"Missing required value at {path}")
        return value


def load_text(source: str, options: LoadOptions | None = None) -> LoadedDocument:
    opts = options or LoadOptions()
    compile_options = materialize_compile_options(opts)
    compile_result = compile_source(source, compile_options)

    finalized: dict[str, object] | None = None
    validation: dict[str, object] | None = None

    if not compile_result.errors:
        finalized = finalize_json(compile_result.events, opts.finalize)
        schema = opts.schema
        if schema is None and opts.schema_file is not None:
            schema = load_schema_file(opts.schema_file)
        if schema is not None:
            validation = validate_events(compile_result.events, schema, opts.validation_options)

    return LoadedDocument(
        source=source,
        compile=compile_result,
        finalized=finalized,
        validation=validation,
    )


def load_file(file_path: str | Path, options: LoadOptions | None = None) -> LoadedDocument:
    source = Path(file_path).read_text(encoding="utf-8")
    return load_text(source, options)


def load_telex_text(source: str, options: TelexLoadOptions | None = None) -> LoadedTelexDocument:
    opts = options or TelexLoadOptions()
    try:
        parsed = parse_telex(source, opts.limits)
    except TelexSyntaxError as error:
        return LoadedTelexDocument(
            source=source,
            parsed=None,
            portable_validation=None,
            finalized=None,
            decode_error={
                "code": error.code,
                "message": str(error),
                **({"line": error.line} if error.line is not None else {}),
            },
        )

    portable_validation = validate_portable_telex_records(
        parsed.records,
        profile=parsed.profile,
        projection=parsed.projection,
        limits=opts.limits,
        registered_fields=opts.registered_fields,
    )
    finalized: dict[str, object] | None = None
    validation: dict[str, object] | None = None
    if portable_validation["valid"]:
        finalize_options = opts.finalize or PortableFinalizeOptions()
        finalized = finalize_portable_json(
            parsed.records,
            replace(
                finalize_options,
                profile=parsed.profile,
                projection=parsed.projection,
                registered_fields=list(opts.registered_fields),
                limits=opts.limits if opts.limits is not None else finalize_options.limits,
            ),
        )
        schema = opts.schema
        if schema is None and opts.schema_file is not None:
            schema = load_schema_file(opts.schema_file)
        if schema is not None:
            validation = validate_aeos_telex_records(parsed.records, schema, opts.validation_options)
    return LoadedTelexDocument(
        source=source,
        parsed=parsed,
        portable_validation=portable_validation,
        finalized=finalized,
        validation=validation,
    )


def load_telex_file(file_path: str | Path, options: TelexLoadOptions | None = None) -> LoadedTelexDocument:
    source = Path(file_path).read_text(encoding="utf-8")
    return load_telex_text(source, options)


def aeon_to_telex(
    source: str,
    compile_options: CompileOptions | None = None,
    *,
    include_headers: bool = False,
    profile: str | None = None,
    limits: object = None,
) -> str:
    compiled = compile_source(source, compile_options)
    if compiled.errors:
        messages = [f"{error.code}: {error.message}" for error in compiled.errors]
        raise AeonLoadError("\n".join(messages))
    return export_telex(
        compiled.events,
        header=compiled.header,
        include_headers=include_headers,
        profile=profile,
        limits=limits,
    )


def write_telex_file(
    file_path: str | Path,
    records: list[dict[str, object]],
    *,
    profile: str | None = None,
    projection: str | None = None,
    limits: object = None,
) -> None:
    Path(file_path).write_text(
        encode_telex(records, profile=profile, projection=projection, limits=limits),
        encoding="utf-8",
    )


def load_schema_text(source: str, file_label: str = "<memory>") -> dict[str, object]:
    stripped = source.lstrip()
    if stripped.startswith("{"):
        return normalize_legacy_schema_contract_doc(json.loads(source), file_label)

    compile_result = compile_source(
        source,
        CompileOptions(datatype_policy="allow_custom"),
    )
    if compile_result.errors:
        raise AeonLoadError(f"Schema contract AEON file failed to parse: {file_label}")

    finalized = finalize_json(compile_result.events, FinalizeOptions(mode="strict"))
    errors = finalized.get("meta", {}).get("errors", [])
    if isinstance(errors, list) and errors:
        raise AeonLoadError(f"Schema contract AEON file failed to finalize: {file_label}")

    document = finalized.get("document")
    if not isinstance(document, dict):
        raise AeonLoadError(f"Schema file must materialize to an object document: {file_label}")
    root_event = find_aeos_schema_root_event(compile_result.events)
    if root_event is None:
        return normalize_legacy_schema_contract_doc(document, file_label)
    aeos_root = document.get("aeos")
    if not isinstance(aeos_root, dict):
        raise AeonLoadError(f"Schema document missing required '$.aeos' object: {file_label}")
    return normalize_aeos_schema_doc(aeos_root, file_label)


def load_schema_file(file_path: str | Path) -> dict[str, object]:
    path = Path(file_path)
    source = path.read_text(encoding="utf-8")
    if path.suffix.lower() == ".json":
        return normalize_legacy_schema_contract_doc(json.loads(source), str(path))
    return load_schema_text(source, str(path))


def materialize_compile_options(options: LoadOptions) -> CompileOptions:
    compile_options = options.compile or CompileOptions()
    if options.datatype_policy is None:
        return compile_options
    return replace(compile_options, datatype_policy=options.datatype_policy)


def find_aeos_schema_root_event(events: list[dict[str, object]]) -> dict[str, object] | None:
    for event in events:
        if event.get("key") != "aeos":
            continue
        if event.get("datatype") != "schema":
            continue
        path = event.get("path")
        if path == "$.aeos":
            return event
    return None


def normalize_legacy_schema_contract_doc(doc: object, file_label: str) -> dict[str, object]:
    if not isinstance(doc, dict):
        raise AeonLoadError(f"Schema file must be a JSON object: {file_label}")

    schema_id = doc.get("schema_id")
    schema_version = doc.get("schema_version")
    rules_raw = doc.get("rules")
    world = doc.get("world")
    reference_policy = doc.get("reference_policy")
    datatype_allowlist = doc.get("datatype_allowlist")
    datatype_rules = doc.get("datatype_rules")
    allowed_top_level = {
        "schema_id",
        "schema_version",
        "rules",
        "world",
        "reference_policy",
        "datatype_allowlist",
        "datatype_rules",
    }
    for key in doc:
        if key not in allowed_top_level:
            raise AeonLoadError(f"Unknown schema contract key '{key}' in {file_label}")

    if not isinstance(schema_id, str) or not schema_id:
        raise AeonLoadError(f"Schema contract missing required string field 'schema_id': {file_label}")
    if not isinstance(schema_version, str) or not schema_version:
        raise AeonLoadError(f"Schema contract missing required string field 'schema_version': {file_label}")
    if not isinstance(rules_raw, list):
        raise AeonLoadError(f"Schema contract missing required array field 'rules': {file_label}")
    return materialize_schema_v1(
        rules_raw,
        world,
        reference_policy,
        datatype_allowlist,
        datatype_rules,
        file_label,
        allow_object_rules=False,
    )


def normalize_aeos_schema_doc(doc: dict[str, object], file_label: str) -> dict[str, object]:
    schema_id = doc.get("id")
    schema_version = doc.get("version")
    rules_raw = doc.get("rules")
    world = doc.get("world")
    reference_policy = doc.get("reference_policy")
    datatype_allowlist = doc.get("datatype_allowlist")
    datatype_rules = doc.get("datatype_rules")
    allowed_top_level = {
        "id",
        "version",
        "rules",
        "world",
        "reference_policy",
        "datatype_allowlist",
        "datatype_rules",
        "patterns",
        "charsets",
    }
    for key in doc:
        if key not in allowed_top_level:
            raise AeonLoadError(f"Unknown schema document key '{key}' in {file_label}")

    if not isinstance(schema_id, str) or not schema_id:
        raise AeonLoadError(f"Schema document missing required string field 'id': {file_label}")
    if not isinstance(schema_version, str) or not schema_version:
        raise AeonLoadError(f"Schema document missing required string field 'version': {file_label}")
    if rules_raw is None:
        raise AeonLoadError(f"Schema document missing required field 'rules': {file_label}")
    return materialize_schema_v1(
        rules_raw,
        world,
        reference_policy,
        datatype_allowlist,
        datatype_rules,
        file_label,
        allow_object_rules=True,
    )


def materialize_schema_v1(
    rules_raw: object,
    world: object,
    reference_policy: object,
    datatype_allowlist: object,
    datatype_rules: object,
    file_label: str,
    *,
    allow_object_rules: bool,
) -> dict[str, object]:
    if world is not None and world not in ("open", "closed"):
        raise AeonLoadError(f"Schema contract field 'world' must be 'open' or 'closed': {file_label}")
    if reference_policy is not None and reference_policy not in ("allow", "forbid"):
        raise AeonLoadError(f"Schema contract field 'reference_policy' must be 'allow' or 'forbid': {file_label}")
    if datatype_allowlist is not None:
        if not isinstance(datatype_allowlist, list) or any(not isinstance(v, str) for v in datatype_allowlist):
            raise AeonLoadError(f"Schema contract field 'datatype_allowlist' must be array<string>: {file_label}")
    normalized_rules: list[dict[str, object]]
    if allow_object_rules and isinstance(rules_raw, dict):
        normalized_rules = []
        for path, constraints in rules_raw.items():
            if not isinstance(path, str) or not path:
                raise AeonLoadError(f"Schema rule key must be a non-empty canonical path: {file_label}")
            if not isinstance(constraints, dict):
                raise AeonLoadError(f"Schema rule '{path}' must be an object of constraints: {file_label}")
            normalized_rules.append({"path": path, "constraints": project_constraints(constraints, file_label, path)})
    elif isinstance(rules_raw, list):
        normalized_rules = []
        for index, rule in enumerate(rules_raw):
            if not isinstance(rule, dict):
                raise AeonLoadError(f"Schema contract rule at index {index} is not an object: {file_label}")
            path = rule.get("path")
            selector = rule.get("selector")
            constraints = rule.get("constraints")
            has_path = isinstance(path, str) and bool(path)
            has_selector = isinstance(selector, str) and bool(selector)
            if not has_path and not has_selector:
                raise AeonLoadError(f"Schema contract rule at index {index} missing string 'path' or 'selector': {file_label}")
            if has_path and has_selector:
                raise AeonLoadError(f"Schema contract rule at index {index} must use either 'path' or 'selector': {file_label}")
            if not isinstance(constraints, dict):
                raise AeonLoadError(f"Schema contract rule at index {index} missing object 'constraints': {file_label}")
            owner = path if has_path else selector
            assert isinstance(owner, str)
            target = {"path": path} if has_path else {"selector": selector}
            normalized_rules.append({**target, "constraints": project_constraints(constraints, file_label, owner)})
    else:
        kind = "object or array" if allow_object_rules else "array"
        raise AeonLoadError(f"Schema contract field 'rules' must be {kind}: {file_label}")

    projected_datatype_rules: dict[str, object] | None = None
    if datatype_rules is not None:
        if not isinstance(datatype_rules, dict):
            raise AeonLoadError(f"Schema contract field 'datatype_rules' must be object<string, constraints>: {file_label}")
        projected_datatype_rules = {}
        for key, value in datatype_rules.items():
            if not isinstance(value, dict):
                raise AeonLoadError(f"Schema datatype rule '{key}' must be an object of constraints: {file_label}")
            projected_datatype_rules[key] = project_constraints(value, file_label, f"datatype_rules.{key}")

    result: dict[str, object] = {"rules": normalized_rules}
    if world is not None:
        result["world"] = world
    if reference_policy is not None:
        result["reference_policy"] = reference_policy
    if datatype_allowlist is not None:
        result["datatype_allowlist"] = datatype_allowlist
    if projected_datatype_rules is not None:
        result["datatype_rules"] = projected_datatype_rules
    return result


def project_constraints(constraints: dict[str, object], file_label: str, owner: str) -> dict[str, object]:
    projected = dict(constraints)
    path_selector = projected.pop("reference_target_path", None)
    if path_selector is not None:
        if "reference_target_pattern" in projected:
            raise AeonLoadError(
                f"Schema rule '{owner}' cannot declare both 'reference_target_path' and 'reference_target_pattern': {file_label}"
            )
        if not isinstance(path_selector, str) or not path_selector:
            raise AeonLoadError(
                f"Schema rule '{owner}' field 'reference_target_path' must be a non-empty string: {file_label}"
            )
        projected["reference_target_pattern"] = reference_target_path_to_pattern(path_selector)
    return projected


def reference_target_path_to_pattern(selector: str) -> str:
    if "*" in selector:
        raise AeonLoadError(f"Unsupported reference_target_path selector: {selector}")
    return "^" + re.escape(selector) + "$"


def parse_document_path(path: str) -> list[str | int]:
    if not path.startswith("$."):
        raise ValueError(f"Unsupported document path: {path}")

    segments: list[str | int] = []
    index = 1
    while index < len(path):
        if path[index] == ".":
            if path.startswith('.["', index):
                segment, index = parse_quoted_segment(path, index + 3)
                segments.append(segment)
                continue
            match = re.match(r"\.([A-Za-z_][A-Za-z0-9_]*)", path[index:])
            if match is None:
                raise ValueError(f"Unsupported document path: {path}")
            segments.append(match.group(1))
            index += len(match.group(0))
            continue
        if path[index] == "[":
            end = path.find("]", index)
            if end == -1:
                raise ValueError(f"Unsupported document path: {path}")
            segments.append(int(path[index + 1:end], 10))
            index = end + 1
            continue
        raise ValueError(f"Unsupported document path: {path}")
    return segments


def parse_quoted_segment(path: str, start: int) -> tuple[str, int]:
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
    raise ValueError(f"Unsupported document path: {path}")
