#!/usr/bin/env python3
from __future__ import annotations

import argparse
import itertools
import json
import re
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

try:
    import tomllib
except ModuleNotFoundError:  # pragma: no cover - fallback for older local Pythons
    import tomli as tomllib  # type: ignore[no-redef]


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_MATRIX = ROOT / "stress-tests" / "matrices" / "literal-mode-combinations.toml"
DEFAULT_OUTPUT_DIR = ROOT / "stress-tests" / "snippets" / "generated"
DEFAULT_MODE_ORDER = ("strict", "custom", "transport")
POSITIVE_RUNNER = ROOT / "scripts" / "stress-positive-snippets.py"
NEGATIVE_RUNNER = ROOT / "scripts" / "stress-negative-snippets.py"
PLACEHOLDER_PATTERN = re.compile(r"\|(KEY|TYPE|MODE|DESCRIPTION|\d+)\|")


@dataclass(frozen=True)
class GeneratedCase:
    family_index: int
    variant_index: int
    description: str
    mode: str
    outcome: str
    snippet: str
    values: tuple[str, ...]
    rendered_type: str


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Expand a mode-aware AEON stress matrix into generated positive/negative snippet corpora "
            "and optionally run the existing snippet harnesses."
        ),
    )
    parser.add_argument(
        "--matrix",
        default=str(DEFAULT_MATRIX),
        help=f"Matrix TOML file to expand (default: {DEFAULT_MATRIX}).",
    )
    parser.add_argument(
        "--output-dir",
        default=str(DEFAULT_OUTPUT_DIR),
        help=f"Directory for generated .aeon-cases files (default: {DEFAULT_OUTPUT_DIR}).",
    )
    parser.add_argument(
        "--run",
        choices=["none", "positive", "negative", "both"],
        default="none",
        help="After generation, run the existing snippet harnesses against the generated corpora.",
    )
    parser.add_argument(
        "--impl",
        choices=["typescript", "python", "rust", "all"],
        default="all",
        help="Implementation to use when --run is enabled (default: all).",
    )
    parser.add_argument(
        "--brief",
        action="store_true",
        help="Pass --brief through to the snippet harnesses when --run is enabled.",
    )
    parser.add_argument(
        "--no-color",
        action="store_true",
        help="Pass --no-color through to the snippet harnesses when --run is enabled.",
    )
    return parser.parse_args()


def normalize_mode_order(raw: Any) -> tuple[str, ...]:
    if raw is None:
        return DEFAULT_MODE_ORDER
    if not isinstance(raw, list) or not raw or not all(isinstance(item, str) and item for item in raw):
        raise ValueError("top-level 'mode_order' must be a non-empty array of strings")
    mode_order = tuple(raw)
    if len(set(mode_order)) != len(mode_order):
        raise ValueError("top-level 'mode_order' must not contain duplicates")
    return mode_order


def resolve_mode_value(raw: Any, mode_order: tuple[str, ...], mode: str, field_name: str, description: str) -> str:
    if isinstance(raw, str):
        return raw
    if isinstance(raw, list):
        if len(raw) != len(mode_order):
            raise ValueError(
                f"{description!r}: '{field_name}' array length must match mode_order "
                f"({len(mode_order)} items)"
            )
        value = raw[mode_order.index(mode)]
        if not isinstance(value, str):
            raise ValueError(f"{description!r}: '{field_name}' array values must be strings")
        return value
    if isinstance(raw, dict):
        if mode not in raw:
            raise ValueError(f"{description!r}: '{field_name}' is missing an entry for mode {mode!r}")
        value = raw[mode]
        if not isinstance(value, str):
            raise ValueError(f"{description!r}: '{field_name}.{mode}' must be a string")
        return value
    raise ValueError(
        f"{description!r}: '{field_name}' must be a string, mode-keyed table, or array matching mode_order"
    )


def normalize_outcome(raw: Any, mode_order: tuple[str, ...], mode: str, description: str) -> str:
    value = resolve_mode_value(raw, mode_order, mode, "outcome", description).strip().lower()
    if value not in {"pass", "fail"}:
        raise ValueError(f"{description!r}: outcome for mode {mode!r} must be 'pass' or 'fail'")
    return value


def expand_compact_numeric_placeholders(template: str) -> str:
    parts: list[str] = []
    index = 0
    length = len(template)

    while index < length:
        if template[index] != "|":
            parts.append(template[index])
            index += 1
            continue

        cursor = index + 1
        numeric_tokens: list[str] = []
        while cursor < length and template[cursor].isdigit():
            start = cursor
            while cursor < length and template[cursor].isdigit():
                cursor += 1
            if cursor >= length or template[cursor] != "|":
                numeric_tokens = []
                break
            numeric_tokens.append(template[start:cursor])
            cursor += 1
            if cursor >= length or not template[cursor].isdigit():
                break

        if numeric_tokens:
            for token in numeric_tokens:
                parts.append(f"|{token}|")
            index = cursor
            continue

        parts.append("|")
        index += 1

    return "".join(parts)


def render_template(
    template: str,
    description: str,
    key: str,
    rendered_type: str,
    mode: str,
    values: tuple[str, ...],
) -> str:
    rendered = expand_compact_numeric_placeholders(template)
    replacements = {
        "|DESCRIPTION|": description,
        "|KEY|": key,
        "|TYPE|": rendered_type,
        "|MODE|": mode,
    }
    for token, value in replacements.items():
        rendered = rendered.replace(token, value)
    for index, value in enumerate(values):
        rendered = rendered.replace(f"|{index}|", value)
    unresolved = PLACEHOLDER_PATTERN.findall(rendered)
    if unresolved:
        raise ValueError(f"{description!r}: unresolved placeholders remain in rendered snippet: {rendered!r}")
    return rendered.rstrip() + "\n"


def ensure_value_rows(raw: Any, description: str) -> list[list[str]]:
    if not isinstance(raw, list):
        raise ValueError(f"{description!r}: 'value' must be an array of arrays")
    rows: list[list[str]] = []
    for index, row in enumerate(raw):
        if not isinstance(row, list) or not row:
            raise ValueError(f"{description!r}: value row {index} must be a non-empty array")
        if not all(isinstance(item, str) for item in row):
            raise ValueError(f"{description!r}: value row {index} must contain only strings")
        rows.append(list(row))
    return rows


def expand_matrix(matrix_path: Path) -> tuple[tuple[str, ...], list[GeneratedCase]]:
    with matrix_path.open("rb") as handle:
        raw = tomllib.load(handle)

    mode_order = normalize_mode_order(raw.get("mode_order"))
    stress_entries = raw.get("stress")
    if not isinstance(stress_entries, list) or not stress_entries:
        raise ValueError("top-level 'stress' must be a non-empty array/table list")

    generated: list[GeneratedCase] = []

    for family_index, entry in enumerate(stress_entries, start=1):
        if not isinstance(entry, dict):
            raise ValueError("each 'stress' entry must be a table/object")
        description = entry.get("description")
        key = entry.get("key")
        template = entry.get("string", entry.get("template"))
        type_value = entry.get("type")
        outcome_value = entry.get("outcome")
        mode_subset = entry.get("modes", list(mode_order))
        value_rows = ensure_value_rows(entry.get("value"), str(description))

        if not isinstance(description, str) or not description:
            raise ValueError("each stress entry must have a non-empty 'description'")
        if not isinstance(key, str) or not key:
            raise ValueError(f"{description!r}: 'key' must be a non-empty string")
        if not isinstance(template, str) or not template:
            raise ValueError(f"{description!r}: 'string' must be a non-empty string")
        if type_value is None:
            raise ValueError(f"{description!r}: missing required field 'type'")
        if outcome_value is None:
            raise ValueError(f"{description!r}: missing required field 'outcome'")
        if not isinstance(mode_subset, list) or not mode_subset or not all(isinstance(item, str) for item in mode_subset):
            raise ValueError(f"{description!r}: 'modes' must be a non-empty array of strings when provided")

        combinations = list(itertools.product(*value_rows)) if value_rows else [()]
        active_modes = []
        for mode in mode_subset:
            if mode not in mode_order:
                raise ValueError(f"{description!r}: mode {mode!r} is not present in mode_order")
            if mode not in active_modes:
                active_modes.append(mode)

        variant_index = 0
        for mode in active_modes:
            rendered_type = resolve_mode_value(type_value, mode_order, mode, "type", description)
            outcome = normalize_outcome(outcome_value, mode_order, mode, description)
            for values in combinations:
                variant_index += 1
                snippet = render_template(template, description, key, rendered_type, mode, values)
                generated.append(
                    GeneratedCase(
                        family_index=family_index,
                        variant_index=variant_index,
                        description=description,
                        mode=mode,
                        outcome=outcome,
                        snippet=snippet,
                        values=tuple(values),
                        rendered_type=rendered_type,
                    )
                )

    return mode_order, generated


def output_paths(matrix_stem: str, output_dir: Path, mode_order: tuple[str, ...]) -> dict[tuple[str, str], Path]:
    paths: dict[tuple[str, str], Path] = {}
    for mode in mode_order:
        for outcome in ("pass", "fail"):
            label = "positive" if outcome == "pass" else "negative"
            paths[(mode, outcome)] = output_dir / f"{matrix_stem}.{label}-{mode}.aeon-cases"
    return paths


def write_outputs(
    matrix_path: Path,
    output_dir: Path,
    mode_order: tuple[str, ...],
    generated: list[GeneratedCase],
) -> tuple[dict[tuple[str, str], Path], Path]:
    output_dir.mkdir(parents=True, exist_ok=True)
    paths = output_paths(matrix_path.stem, output_dir, mode_order)

    for path in paths.values():
        if path.exists():
            path.unlink()

    grouped: dict[tuple[str, str], list[GeneratedCase]] = {
        (mode, outcome): [] for mode in mode_order for outcome in ("pass", "fail")
    }
    for case in generated:
        grouped[(case.mode, case.outcome)].append(case)

    for key, cases in grouped.items():
        if not cases:
            continue
        contents = []
        for case in cases:
            contents.append("---\n")
            contents.append(case.snippet)
        paths[key].write_text("".join(contents), encoding="utf-8")

    manifest_path = output_dir / f"{matrix_path.stem}.manifest.json"
    manifest = [
        {
            "family_index": case.family_index,
            "variant_index": case.variant_index,
            "description": case.description,
            "mode": case.mode,
            "outcome": case.outcome,
            "type": case.rendered_type,
            "values": list(case.values),
            "snippet": case.snippet.rstrip("\n"),
        }
        for case in generated
    ]
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return paths, manifest_path


def print_summary(
    matrix_path: Path,
    mode_order: tuple[str, ...],
    generated: list[GeneratedCase],
    paths: dict[tuple[str, str], Path],
    manifest_path: Path,
) -> None:
    print(f"Generated combination corpora from {matrix_path}")
    total = 0
    for mode in mode_order:
        passed = sum(1 for case in generated if case.mode == mode and case.outcome == "pass")
        failed = sum(1 for case in generated if case.mode == mode and case.outcome == "fail")
        total += passed + failed
        positive_path = paths[(mode, "pass")]
        negative_path = paths[(mode, "fail")]
        positive_label = str(positive_path) if positive_path.exists() else "(none)"
        negative_label = str(negative_path) if negative_path.exists() else "(none)"
        print(f"  {mode}: pass={passed} fail={failed}")
        print(f"    positive: {positive_label}")
        print(f"    negative: {negative_label}")
    print(f"  total: {total}")
    print(f"  manifest: {manifest_path}")


def run_generated_corpora(
    matrix_path: Path,
    mode_order: tuple[str, ...],
    paths: dict[tuple[str, str], Path],
    args: argparse.Namespace,
) -> int:
    run_targets = []
    if args.run in {"positive", "both"}:
        run_targets.append(("positive", POSITIVE_RUNNER))
    if args.run in {"negative", "both"}:
        run_targets.append(("negative", NEGATIVE_RUNNER))

    exit_code = 0
    for mode in mode_order:
        for label, runner in run_targets:
            outcome = "pass" if label == "positive" else "fail"
            corpus_path = paths[(mode, outcome)]
            if not corpus_path.exists():
                continue
            command = [
                sys.executable,
                str(runner),
                "--file",
                str(corpus_path),
                "--mode",
                mode,
                "--impl",
                args.impl,
            ]
            if args.brief:
                command.append("--brief")
            if args.no_color:
                command.append("--no-color")
            print()
            print(f"Running {label} snippet lane for {mode} from {matrix_path.name}")
            completed = subprocess.run(command, cwd=str(ROOT))
            if completed.returncode != 0 and exit_code == 0:
                exit_code = completed.returncode
    return exit_code


def main() -> int:
    args = parse_args()
    matrix_path = Path(args.matrix).resolve()
    output_dir = Path(args.output_dir).resolve()

    try:
        mode_order, generated = expand_matrix(matrix_path)
    except (FileNotFoundError, tomllib.TOMLDecodeError, ValueError) as error:
        print(f"Error: {error}", file=sys.stderr)
        return 2

    paths, manifest_path = write_outputs(matrix_path, output_dir, mode_order, generated)
    print_summary(matrix_path, mode_order, generated, paths, manifest_path)

    if args.run == "none":
        return 0
    return run_generated_corpora(matrix_path, mode_order, paths, args)


if __name__ == "__main__":
    raise SystemExit(main())
