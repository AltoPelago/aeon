from __future__ import annotations

from dataclasses import dataclass, replace
from pathlib import Path
import re

from .aeos import validate_events
from .core import CompileOptions, CompileResult, compile_source
from .finalize import FinalizeOptions, finalize_json


@dataclass(slots=True)
class LoadOptions:
    compile: CompileOptions | None = None
    finalize: FinalizeOptions | None = None
    schema: dict[str, object] | None = None
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
        if opts.schema is not None:
            validation = validate_events(compile_result.events, opts.schema, opts.validation_options)

    return LoadedDocument(
        source=source,
        compile=compile_result,
        finalized=finalized,
        validation=validation,
    )


def load_file(file_path: str | Path, options: LoadOptions | None = None) -> LoadedDocument:
    source = Path(file_path).read_text(encoding="utf-8")
    return load_text(source, options)


def materialize_compile_options(options: LoadOptions) -> CompileOptions:
    compile_options = options.compile or CompileOptions()
    if options.datatype_policy is None:
        return compile_options
    return replace(compile_options, datatype_policy=options.datatype_policy)


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
