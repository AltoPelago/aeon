from __future__ import annotations

import json
from pathlib import Path
import sys

from .aeos import validate_cts_payload
from .annotations import build_annotation_stream, sort_annotation_records
from .canonical import canonicalize
from .core import CompileOptions, compile_source
from .finalize import FinalizeOptions, finalize_json, finalize_map


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if "--cts-validate" in args:
        return cts_validate()
    if not args or args[0] in {"help", "--help", "-h"}:
        print_help()
        return 0
    command = args[0]
    if command in {"version", "--version", "-v"}:
        print("aeon-python 0.9.0")
        return 0
    if command == "fmt":
        return fmt(args[1:])
    if command == "inspect":
        return inspect(args[1:])
    if command == "finalize":
        return finalize(args[1:])
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
    recovery = "--recovery" in args
    annotations_only = "--annotations-only" in args
    include_annotations = "--annotations" in args or annotations_only
    sort_annotations = "--sort-annotations" in args
    datatype_policy = resolve_datatype_policy(args)
    if datatype_policy is None and "--datatype-policy" in args:
        print(
            "Error: Invalid value for --datatype-policy (expected reserved_only or allow_custom)",
            file=sys.stderr,
        )
        return 2
    max_attribute_depth = numeric_flag_value(args, "--max-attribute-depth")
    max_separator_depth = numeric_flag_value(args, "--max-separator-depth")
    max_generic_depth = numeric_flag_value(args, "--max-generic-depth")
    max_nesting_depth = numeric_flag_value(args, "--max-nesting-depth")
    max_input_bytes = numeric_flag_value(args, "--max-input-bytes")
    if max_attribute_depth is None and "--max-attribute-depth" in args:
        print("Error: Invalid value for --max-attribute-depth (expected a non-negative integer)", file=sys.stderr)
        return 2
    if max_separator_depth is None and "--max-separator-depth" in args:
        print("Error: Invalid value for --max-separator-depth (expected a non-negative integer)", file=sys.stderr)
        return 2
    if max_generic_depth is None and "--max-generic-depth" in args:
        print("Error: Invalid value for --max-generic-depth (expected a non-negative integer)", file=sys.stderr)
        return 2
    if max_nesting_depth is None and "--max-nesting-depth" in args:
        print("Error: Invalid value for --max-nesting-depth (expected a non-negative integer)", file=sys.stderr)
        return 2
    if max_input_bytes is None and "--max-input-bytes" in args:
        print("Error: Invalid value for --max-input-bytes (expected a non-negative integer)", file=sys.stderr)
        return 2
    file_arg = first_non_flag(args)
    if file_arg is None:
        print("Error: No file specified", file=sys.stderr)
        return 2
    source = Path(file_arg).read_text(encoding="utf-8")
    result = compile_source(
        source,
        CompileOptions(
            recovery=recovery,
            datatype_policy=datatype_policy,
            max_attribute_depth=1 if max_attribute_depth is None else max_attribute_depth,
            max_separator_depth=1 if max_separator_depth is None else max_separator_depth,
            max_generic_depth=1 if max_generic_depth is None else max_generic_depth,
            max_nesting_depth=256 if max_nesting_depth is None else max_nesting_depth,
            max_input_bytes=max_input_bytes,
        ),
    )
    annotation_events = result.internal_events if result.internal_events is not None else result.events
    annotations = build_annotation_stream(source, annotation_events) if include_annotations else []
    if result.errors and not annotation_events:
        annotations = []
    if sort_annotations:
        annotations = sort_annotation_records(annotations)
    if json_output:
        if annotations_only:
            print(json.dumps({"annotations": annotations}, indent=2))
            return 0
        payload = {
            "events": result.events,
            "errors": [error.to_json() for error in result.errors],
        }
        if include_annotations:
            payload["annotations"] = annotations
        print(json.dumps(payload, indent=2))
    else:
        for error in result.errors:
            print(error.message)
    return 1 if result.errors else 0


def fmt(args: list[str]) -> int:
    write_output = "--write" in args
    file_arg = first_non_flag(args)
    if write_output and file_arg is None:
        print("Error: --write requires a file path", file=sys.stderr)
        return 2
    source = Path(file_arg).read_text(encoding="utf-8") if file_arg is not None else sys.stdin.read()
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
    if max_input_bytes is None and "--max-input-bytes" in args:
        print("Error: Invalid value for --max-input-bytes (expected a non-negative integer)", file=sys.stderr)
        return 2
    if max_materialized_weight is None and "--max-materialized-weight" in args:
        print("Error: Invalid value for --max-materialized-weight (expected a non-negative integer)", file=sys.stderr)
        return 2
    file_arg = first_non_flag(args)
    if file_arg is None:
        print("Error: No file specified", file=sys.stderr)
        return 2

    source = Path(file_arg).read_text(encoding="utf-8")
    result = compile_source(
        source,
        CompileOptions(
            recovery=recovery,
            datatype_policy=datatype_policy,
            max_input_bytes=max_input_bytes,
        ),
    )
    finalize_options = FinalizeOptions(
        mode="loose" if "--loose" in args else "strict",
        materialization="projected" if projected else "all",
        include_paths=include_paths or None,
        scope=scope,
        max_materialized_weight=max_materialized_weight,
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
        if item in {"--datatype-policy", "--max-attribute-depth", "--max-separator-depth", "--max-generic-depth", "--max-nesting-depth", "--max-input-bytes", "--max-materialized-weight", "--scope", "--include-path"}:
            skip_next = True
            continue
        if item.startswith("--"):
            continue
        if index > 0 and args[index - 1] in {"--datatype-policy", "--max-attribute-depth", "--max-separator-depth", "--max-generic-depth", "--max-nesting-depth", "--max-input-bytes", "--max-materialized-weight", "--scope", "--include-path"}:
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
        "Usage: aeon-python fmt [file] [--write] | aeon-python inspect <file> [--json] [--recovery] [--annotations] [--annotations-only] [--sort-annotations] [--datatype-policy <reserved_only|allow_custom>] [--max-attribute-depth <n>] [--max-separator-depth <n>] [--max-generic-depth <n>] [--max-nesting-depth <n>] [--max-input-bytes <n>] | aeon-python finalize <file> [--json] [--recovery] [--strict|--loose] [--scope <payload|header|full>] [--projected --include-path <$.path>] [--datatype-policy <reserved_only|allow_custom>] [--max-input-bytes <n>] [--max-materialized-weight <n>] | aeon-python --cts-validate"
    )


def ensure_trailing_newline(text: str) -> str:
    return text if text.endswith("\n") else f"{text}\n"


if __name__ == "__main__":
    raise SystemExit(main())
