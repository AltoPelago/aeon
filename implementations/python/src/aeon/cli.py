from __future__ import annotations

import json
from pathlib import Path
import sys

from .aeos import validate_cts_payload
from .annotations import build_annotation_stream, sort_annotation_records
from .canonical import canonicalize
from .core import CompileOptions, compile_source
from .finalize import FinalizeOptions, finalize_json, finalize_map
from .limits import aeon_compile_limits, finalization_limits, load_aeonic_limits, telex_limits
from .portable import export_telex, project_portable_events
from .portable_finalize import PortableFinalizeOptions, finalize_portable_json
from .telex import TelexSyntaxError, canonicalize_telex, parse_telex, validate_telex_records


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if "--cts-validate" in args:
        return cts_validate()
    if not args or args[0] in {"help", "--help", "-h"}:
        print_help()
        return 0
    command = args[0]
    if command in {"version", "--version", "-v"}:
        print("aeon-python 0.12.1")
        return 0
    if command == "fmt":
        return fmt(args[1:])
    if command == "inspect":
        return inspect(args[1:])
    if command == "finalize":
        return finalize(args[1:])
    if command == "telex":
        return telex(args[1:])
    print(f"Error: Unknown command: {command}", file=sys.stderr)
    return 2


def cts_validate() -> int:
    try:
        payload = sys.stdin.read()
        if not payload.strip():
            print("Error: Empty input", file=sys.stderr)
            return 1
        print(validate_cts_payload(payload))
        return 0
    except json.JSONDecodeError:
        print("Error: Invalid JSON input", file=sys.stderr)
        return 1
    except ValueError as error:
        print(f"Error: {error}", file=sys.stderr)
        return 1


def inspect(args: list[str]) -> int:
    json_output = "--json" in args
    telex_output = "--telex" in args
    include_headers = "--include-headers" in args
    portable_aes = "--portable-aes" in args
    recovery = "--recovery" in args
    annotations_only = "--annotations-only" in args
    include_annotations = "--annotations" in args or annotations_only
    sort_annotations = "--sort-annotations" in args
    datatype_policy = resolve_datatype_policy(args)
    mode = "strict" if "--strict" in args else "transport" if "--transport" in args else None
    if datatype_policy is None and "--datatype-policy" in args:
        print(
            "Error: Invalid value for --datatype-policy (expected reserved_only or allow_custom)",
            file=sys.stderr,
        )
        return 2
    max_attribute_depth = numeric_flag_value(args, "--max-attribute-depth")
    max_clarifier_values = numeric_flag_value(args, "--max-clarifier-values")
    max_separator_depth = numeric_flag_value(args, "--max-separator-depth")
    max_generic_depth = numeric_flag_value(args, "--max-generic-depth")
    max_generic_arguments = numeric_flag_value(args, "--max-generic-arguments")
    max_datatype_components = numeric_flag_value(args, "--max-datatype-components")
    max_value_nesting_depth = numeric_flag_value(args, "--max-value-nesting-depth")
    max_nesting_depth = numeric_flag_value(args, "--max-nesting-depth")
    max_input_bytes = numeric_flag_value(args, "--max-input-bytes")
    max_events = numeric_flag_value(args, "--max-events")
    limits_file = flag_value(args, "--limits-file")
    if max_attribute_depth is None and "--max-attribute-depth" in args:
        print("Error: Invalid value for --max-attribute-depth (expected a non-negative integer)", file=sys.stderr)
        return 2
    if max_clarifier_values is None and "--max-clarifier-values" in args:
        print("Error: Invalid value for --max-clarifier-values (expected a non-negative integer)", file=sys.stderr)
        return 2
    if max_separator_depth is None and "--max-separator-depth" in args:
        print("Error: Invalid value for --max-separator-depth (expected a non-negative integer)", file=sys.stderr)
        return 2
    if max_generic_depth is None and "--max-generic-depth" in args:
        print("Error: Invalid value for --max-generic-depth (expected a non-negative integer)", file=sys.stderr)
        return 2
    if max_generic_arguments is None and "--max-generic-arguments" in args:
        print("Error: Invalid value for --max-generic-arguments (expected a non-negative integer)", file=sys.stderr)
        return 2
    if max_datatype_components is None and "--max-datatype-components" in args:
        print("Error: Invalid value for --max-datatype-components (expected a non-negative integer)", file=sys.stderr)
        return 2
    if max_value_nesting_depth is None and "--max-value-nesting-depth" in args:
        print("Error: Invalid value for --max-value-nesting-depth (expected a non-negative integer)", file=sys.stderr)
        return 2
    if max_nesting_depth is None and "--max-nesting-depth" in args:
        print("Error: Invalid value for --max-nesting-depth (expected a non-negative integer)", file=sys.stderr)
        return 2
    if max_input_bytes is None and "--max-input-bytes" in args:
        print("Error: Invalid value for --max-input-bytes (expected a non-negative integer)", file=sys.stderr)
        return 2
    if max_events is None and "--max-events" in args:
        print("Error: Invalid value for --max-events (expected a non-negative integer)", file=sys.stderr)
        return 2
    if limits_file is None and "--limits-file" in args:
        print("Error: --limits-file requires a path", file=sys.stderr)
        return 2
    if telex_output and (json_output or portable_aes or include_annotations):
        print("Error: --telex cannot be combined with JSON or annotation output flags", file=sys.stderr)
        return 2
    if include_headers and not telex_output:
        print("Error: --include-headers requires --telex", file=sys.stderr)
        return 2
    if portable_aes and not json_output:
        print("Error: --portable-aes requires --json", file=sys.stderr)
        return 2
    file_arg = first_non_flag(args)
    if file_arg is None:
        print("Error: No file specified", file=sys.stderr)
        return 2
    source = Path(file_arg).read_text(encoding="utf-8")
    compile_kwargs: dict[str, object] = {}
    if limits_file is not None:
        loaded = load_aeonic_limits(Path(limits_file).read_text(encoding="utf-8"))
        if loaded.limits is None:
            for error in loaded.errors:
                print(f"[{error.code}] {error.path}: {error.message}", file=sys.stderr)
            return 2
        try:
            compile_kwargs.update(aeon_compile_limits(loaded.limits))
        except ValueError as error:
            print(f"Error: {error}", file=sys.stderr)
            return 2
    compile_kwargs.update({"recovery": recovery, "datatype_policy": datatype_policy, "mode": mode})
    if max_attribute_depth is not None:
        compile_kwargs["max_attribute_depth"] = max_attribute_depth
    if max_clarifier_values is not None:
        compile_kwargs["max_clarifier_values"] = max_clarifier_values
    elif max_separator_depth is not None:
        compile_kwargs["max_separator_depth"] = max_separator_depth
    if max_generic_depth is not None:
        compile_kwargs["max_generic_depth"] = max_generic_depth
    if max_generic_arguments is not None:
        compile_kwargs["max_generic_arguments"] = max_generic_arguments
    if max_datatype_components is not None:
        compile_kwargs["max_datatype_components"] = max_datatype_components
    if max_value_nesting_depth is not None:
        compile_kwargs["max_value_nesting_depth"] = max_value_nesting_depth
    elif max_nesting_depth is not None:
        compile_kwargs["max_nesting_depth"] = max_nesting_depth
    if max_input_bytes is not None:
        compile_kwargs["max_input_bytes"] = max_input_bytes
    if max_events is not None:
        compile_kwargs["max_events"] = max_events
    result = compile_source(
        source,
        CompileOptions(**compile_kwargs),
    )
    annotation_events = result.internal_events if result.internal_events is not None else result.events
    annotations = build_annotation_stream(source, annotation_events) if include_annotations else []
    if result.errors and not annotation_events:
        annotations = []
    if sort_annotations:
        annotations = sort_annotation_records(annotations)
    if telex_output and not result.errors:
        sys.stdout.write(export_telex(result.events, header=result.header, include_headers=include_headers))
    elif json_output:
        if annotations_only:
            print(json.dumps({"annotations": annotations}, indent=2))
            return 0
        payload = {
            "events": project_portable_events(result.events) if portable_aes else result.events,
            "errors": [error.to_json() for error in result.errors],
        }
        if include_annotations:
            payload["annotations"] = annotations
        print(json.dumps(payload, indent=2))
    else:
        for error in result.errors:
            print(error.message)
    return 1 if result.errors else 0


def telex(args: list[str]) -> int:
    usage = "Usage: aeon-python telex <decode|canonicalize|materialize> <file> [--scope <payload|header|full>] [--strict|--loose] [--limits-file <path>] [--max-materialized-weight <n>] [--max-reference-depth <n>]"
    if len(args) < 2 or args[0] not in {"decode", "canonicalize", "materialize"} or args[1].startswith("--"):
        print(usage, file=sys.stderr)
        return 2
    action, file_arg = args[0], args[1]
    scope = flag_value(args, "--scope") or "payload"
    if scope not in {"payload", "header", "full"}:
        print("Error: Invalid value for --scope (expected payload, header, or full)", file=sys.stderr)
        return 2
    max_materialized_weight = numeric_flag_value(args, "--max-materialized-weight")
    max_reference_depth = numeric_flag_value(args, "--max-reference-depth")
    for flag, value in (("--max-materialized-weight", max_materialized_weight), ("--max-reference-depth", max_reference_depth)):
        if flag in args and value is None:
            print(f"Error: Invalid value for {flag} (expected a non-negative integer)", file=sys.stderr)
            return 2
    limits_file = flag_value(args, "--limits-file")
    if "--limits-file" in args and limits_file is None:
        print("Error: --limits-file requires a path", file=sys.stderr)
        return 2
    codec_limits: object = None
    finalize_kwargs: dict[str, int] = {}
    if limits_file is not None:
        loaded = load_aeonic_limits(Path(limits_file).read_text(encoding="utf-8"))
        if loaded.limits is None:
            for error in loaded.errors:
                print(f"[{error.code}] {error.path}: {error.message}", file=sys.stderr)
            return 2
        try:
            codec_limits = telex_limits(loaded.limits)
            finalize_kwargs.update(finalization_limits(loaded.limits))
        except ValueError as error:
            print(f"Error: {error}", file=sys.stderr)
            return 2
    if max_materialized_weight is not None:
        finalize_kwargs["max_materialized_weight"] = max_materialized_weight
    if max_reference_depth is not None:
        finalize_kwargs["max_reference_depth"] = max_reference_depth
    source = Path(file_arg).read_text(encoding="utf-8")
    try:
        if action == "canonicalize":
            sys.stdout.write(canonicalize_telex(source, codec_limits))
            return 0
        parsed = parse_telex(source, codec_limits)
    except TelexSyntaxError as error:
        print(f"[{error.code}] {error.detail}", file=sys.stderr)
        return 1
    validation = validate_telex_records(
        parsed.records,
        profile=parsed.profile,
        projection=parsed.projection,
        limits=codec_limits,
    )
    if action == "decode":
        print(json.dumps({**parsed.to_dict(), "validation": validation}, indent=2))
        return 0 if validation["valid"] else 1
    finalized = finalize_portable_json(
        parsed.records,
        PortableFinalizeOptions(
            mode="loose" if "--loose" in args else "strict",
            scope=scope,
            profile=parsed.profile,
            projection=parsed.projection,
            limits=codec_limits,
            **finalize_kwargs,
        ),
    )
    print(json.dumps(finalized, indent=2))
    meta = finalized.get("meta", {})
    errors = meta.get("errors", []) if isinstance(meta, dict) else []
    return 0 if validation["valid"] and not errors else 1


def fmt(args: list[str]) -> int:
    write_output = "--write" in args
    max_input_bytes = numeric_flag_value(args, "--max-input-bytes")
    if max_input_bytes is None and "--max-input-bytes" in args:
        print("Error: Invalid value for --max-input-bytes (expected a non-negative integer)", file=sys.stderr)
        return 2
    file_arg = first_non_flag(args)
    if write_output and file_arg is None:
        print("Error: --write requires a file path", file=sys.stderr)
        return 2
    source = Path(file_arg).read_text(encoding="utf-8") if file_arg is not None else sys.stdin.read()
    actual_bytes = len(source.encode("utf-8"))
    if max_input_bytes is not None and actual_bytes > max_input_bytes:
        print(
            f"Error: Input size {actual_bytes} bytes exceeds configured limit of {max_input_bytes} bytes",
            file=sys.stderr,
        )
        return 1
    result = canonicalize(source)
    if result.errors:
        for error in result.errors:
            print(f"[{error.code}] {error.message}")
        return 1
    formatted = ensure_trailing_newline(result.text)
    if write_output:
        Path(file_arg).write_text(formatted, encoding="utf-8")
        return 0
    sys.stdout.write(formatted)
    return 0


def finalize(args: list[str]) -> int:
    recovery = "--recovery" in args
    datatype_policy = resolve_datatype_policy(args)
    mode = "strict" if "--strict" in args else "transport" if "--transport" in args else None
    if datatype_policy is None and "--datatype-policy" in args:
        print(
            "Error: Invalid value for --datatype-policy (expected reserved_only or allow_custom)",
            file=sys.stderr,
        )
        return 2
    map_output = "--map" in args
    scope = flag_value(args, "--scope") or "payload"
    if scope not in {"payload", "header", "full"}:
        print("Error: Invalid value for --scope (expected payload, header, or full)", file=sys.stderr)
        return 2
    include_paths = flag_values(args, "--include-path")
    projected = "--projected" in args or bool(include_paths)
    if "--projected" in args and not include_paths:
        print("Error: --projected requires at least one --include-path <$.path>", file=sys.stderr)
        return 2
    max_input_bytes = numeric_flag_value(args, "--max-input-bytes")
    max_materialized_weight = numeric_flag_value(args, "--max-materialized-weight")
    max_reference_depth = numeric_flag_value(args, "--max-reference-depth")
    limits_file = flag_value(args, "--limits-file")
    if max_input_bytes is None and "--max-input-bytes" in args:
        print("Error: Invalid value for --max-input-bytes (expected a non-negative integer)", file=sys.stderr)
        return 2
    if max_materialized_weight is None and "--max-materialized-weight" in args:
        print("Error: Invalid value for --max-materialized-weight (expected a non-negative integer)", file=sys.stderr)
        return 2
    if max_reference_depth is None and "--max-reference-depth" in args:
        print("Error: Invalid value for --max-reference-depth (expected a non-negative integer)", file=sys.stderr)
        return 2
    if limits_file is None and "--limits-file" in args:
        print("Error: --limits-file requires a path", file=sys.stderr)
        return 2
    file_arg = first_non_flag(args)
    if file_arg is None:
        print("Error: No file specified", file=sys.stderr)
        return 2

    compile_kwargs: dict[str, object] = {
        "recovery": recovery,
        "datatype_policy": datatype_policy,
        "mode": mode,
    }
    finalize_kwargs: dict[str, int] = {}
    if limits_file is not None:
        loaded = load_aeonic_limits(Path(limits_file).read_text(encoding="utf-8"))
        if loaded.limits is None:
            for error in loaded.errors:
                print(f"[{error.code}] {error.path}: {error.message}", file=sys.stderr)
            return 2
        try:
            compile_kwargs.update(aeon_compile_limits(loaded.limits))
            finalize_kwargs.update(finalization_limits(loaded.limits))
        except ValueError as error:
            print(f"Error: {error}", file=sys.stderr)
            return 2
    if max_input_bytes is not None:
        compile_kwargs["max_input_bytes"] = max_input_bytes
    if max_materialized_weight is not None:
        finalize_kwargs["max_materialized_weight"] = max_materialized_weight
    if max_reference_depth is not None:
        finalize_kwargs["max_reference_depth"] = max_reference_depth

    source = Path(file_arg).read_text(encoding="utf-8")
    result = compile_source(
        source,
        CompileOptions(**compile_kwargs),
    )
    finalize_options = FinalizeOptions(
        mode="loose" if "--loose" in args else "strict",
        materialization="projected" if projected else "all",
        include_paths=include_paths or None,
        scope=scope,
        **finalize_kwargs,
    )
    finalized = finalize_map(result, finalize_options) if map_output else finalize_json(result, finalize_options)
    print(json.dumps(finalized, indent=2))

    meta = finalized.get("meta", {})
    finalize_errors = meta.get("errors", []) if isinstance(meta, dict) else []
    return 1 if result.errors or finalize_errors else 0


def flag_value(args: list[str], flag: str) -> str | None:
    if flag not in args:
        return None
    index = args.index(flag)
    if index + 1 >= len(args):
        return None
    return args[index + 1]


def flag_values(args: list[str], flag: str) -> list[str]:
    values: list[str] = []
    index = 0
    while index < len(args):
        if args[index] == flag and index + 1 < len(args):
            values.append(args[index + 1])
            index += 2
            continue
        index += 1
    return values


def resolve_datatype_policy(args: list[str]) -> str | None:
    value = flag_value(args, "--datatype-policy")
    if value is None:
        if "--datatype-policy" in args:
            return None
        return "allow_custom" if "--rich" in args else None
    if value in {"reserved_only", "allow_custom"}:
        return value
    return None


def first_non_flag(args: list[str]) -> str | None:
    skip_next = False
    for index, item in enumerate(args):
        if skip_next:
            skip_next = False
            continue
        if item in {"--datatype-policy", "--limits-file", "--max-attribute-depth", "--max-clarifier-values", "--max-separator-depth", "--max-generic-depth", "--max-generic-arguments", "--max-datatype-components", "--max-value-nesting-depth", "--max-nesting-depth", "--max-input-bytes", "--max-events", "--max-materialized-weight", "--max-reference-depth", "--scope", "--include-path"}:
            skip_next = True
            continue
        if item.startswith("--"):
            continue
        if index > 0 and args[index - 1] in {"--datatype-policy", "--limits-file", "--max-attribute-depth", "--max-clarifier-values", "--max-separator-depth", "--max-generic-depth", "--max-generic-arguments", "--max-datatype-components", "--max-value-nesting-depth", "--max-nesting-depth", "--max-input-bytes", "--max-events", "--max-materialized-weight", "--max-reference-depth", "--scope", "--include-path"}:
            continue
        return item
    return None


def numeric_flag_value(args: list[str], flag: str) -> int | None:
    value = flag_value(args, flag)
    if value is None:
        return None
    if not value.isdigit():
        return None
    return int(value)


def print_help() -> None:
    print(
        "Usage: aeon-python fmt [file] [--write] [--max-input-bytes <n>] | aeon-python inspect <file> [--json|--telex] [--portable-aes] [--include-headers] [--recovery] [--annotations] [--annotations-only] [--sort-annotations] [--datatype-policy <reserved_only|allow_custom>] [--limits-file <path>] [--max-attribute-depth <n>] [--max-clarifier-values <n>] [--max-generic-depth <n>] [--max-generic-arguments <n>] [--max-datatype-components <n>] [--max-value-nesting-depth <n>] [--max-input-bytes <n>] [--max-events <n>] | aeon-python finalize <file> [--json] [--recovery] [--strict|--loose] [--scope <payload|header|full>] [--projected --include-path <$.path>] [--datatype-policy <reserved_only|allow_custom>] [--limits-file <path>] [--max-input-bytes <n>] [--max-materialized-weight <n>] [--max-reference-depth <n>] | aeon-python telex <decode|canonicalize|materialize> <file> [--scope <payload|header|full>] [--strict|--loose] [--limits-file <path>] | aeon-python --cts-validate"
    )


def ensure_trailing_newline(text: str) -> str:
    return text if text.endswith("\n") else f"{text}\n"


if __name__ == "__main__":
    raise SystemExit(main())
