from __future__ import annotations

from dataclasses import replace
import json
from pathlib import Path
import re

from ._compat import dataclass
from .aeos import validate_events
from .core import CompileOptions, CompileResult, compile_source
from .finalize import FinalizeOptions, finalize_json


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
            constraints = rule.get("constraints")
            if not isinstance(path, str) or not path:
                raise AeonLoadError(f"Schema contract rule at index {index} missing string 'path': {file_label}")
            if not isinstance(constraints, dict):
                raise AeonLoadError(f"Schema contract rule at index {index} missing object 'constraints': {file_label}")
            normalized_rules.append({"path": path, "constraints": project_constraints(constraints, file_label, path)})
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
    placeholder = "__AEOS_WILDCARD_INDEX__"
    if "*" in selector.replace("[*]", ""):
        raise AeonLoadError(f"Unsupported reference_target_path selector: {selector}")
    return "^" + re.escape(selector.replace("[*]", placeholder)).replace(
        re.escape(placeholder),
        r"\[\d+\]",
    ) + "$"


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
