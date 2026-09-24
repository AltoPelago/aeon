#!/usr/bin/env python3
"""Capture reproducible native Rust and pure-Python Sofia baselines."""

from __future__ import annotations

import argparse
import hashlib
import json
import platform
import statistics
import subprocess
import sys
import time
import tomllib
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[1]
CORPUS_MANIFEST = REPO_ROOT / "benchmarks" / "sofia" / "corpus.json"
DEFAULT_GENERATED_DIR = Path("/tmp/aeon-sofia-corpus")
DEFAULT_NATIVE_BINARY = (
    REPO_ROOT
    / "implementations"
    / "rust"
    / "target"
    / "release"
    / "examples"
    / "sofia_baseline"
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--case", action="append", dest="cases", help="Case ID; repeat to select several.")
    parser.add_argument(
        "--implementation",
        choices=("native", "python", "all"),
        default="native",
        help="Implementation surface to measure.",
    )
    parser.add_argument(
        "--profile",
        choices=("full", "check", "both"),
        default="full",
        help="Native CompileOptions profile; Python always measures its full result.",
    )
    parser.add_argument(
        "--native-parser",
        choices=("baseline", "sofia"),
        default="baseline",
        help="Native parser implementation to measure.",
    )
    parser.add_argument("--iterations", type=positive_integer, default=30)
    parser.add_argument("--warmup", type=non_negative_integer, default=5)
    parser.add_argument("--generated-dir", type=Path, default=DEFAULT_GENERATED_DIR)
    parser.add_argument("--native-binary", type=Path, default=DEFAULT_NATIVE_BINARY)
    parser.add_argument("--output", type=Path, help="Write JSON here instead of stdout.")
    return parser.parse_args()


def positive_integer(raw: str) -> int:
    value = int(raw)
    if value <= 0:
        raise argparse.ArgumentTypeError("must be greater than zero")
    return value


def non_negative_integer(raw: str) -> int:
    value = int(raw)
    if value < 0:
        raise argparse.ArgumentTypeError("must be zero or greater")
    return value


def command_output(command: list[str], cwd: Path = REPO_ROOT) -> str:
    return subprocess.run(
        command,
        cwd=cwd,
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    ).stdout.strip()


def git_revision(path: Path) -> str:
    return command_output(["git", "rev-parse", "HEAD"], cwd=path)


def telex_dependency() -> str:
    lock_path = REPO_ROOT / "implementations" / "rust" / "Cargo.lock"
    lock = tomllib.loads(lock_path.read_text())
    packages = [
        package
        for package in lock.get("package", [])
        if package.get("name") == "altopelago-aes-telex"
    ]
    if len(packages) != 1:
        raise RuntimeError(
            "expected exactly one altopelago-aes-telex package in the Rust lockfile"
        )

    package = packages[0]
    version = package.get("version")
    source = package.get("source")
    checksum = package.get("checksum")
    if not isinstance(version, str) or not isinstance(source, str):
        raise RuntimeError("altopelago-aes-telex lockfile entry is incomplete")
    if not source.startswith("registry+"):
        raise RuntimeError("altopelago-aes-telex is not locked to a registry source")
    if not (
        isinstance(checksum, str)
        and len(checksum) == 64
        and all(character in "0123456789abcdef" for character in checksum)
    ):
        raise RuntimeError("altopelago-aes-telex lockfile checksum is invalid")
    return f"registry:altopelago-aes-telex@{version}#sha256:{checksum}"


def repository_metadata() -> dict[str, Any]:
    family_root = REPO_ROOT.parents[1]
    aes_checkout = family_root / "altopelago" / "aes"
    specs_checkout = family_root / "aeonite-org" / "aeonite-specs"
    cts_checkout = family_root / "aeonite-org" / "aeonite-cts"
    return {
        "aeon": git_revision(REPO_ROOT),
        "aes_telex_dependency": telex_dependency(),
        "aes_checkout": git_revision(aes_checkout),
        "aeonite_specs": git_revision(specs_checkout),
        "aeonite_cts": git_revision(cts_checkout),
    }


def hardware_metadata() -> dict[str, str]:
    hardware: dict[str, str] = {
        "machine": platform.machine(),
        "processor": platform.processor(),
    }
    if platform.system() != "Darwin":
        return hardware
    try:
        raw = command_output(["system_profiler", "SPHardwareDataType"])
    except (OSError, subprocess.CalledProcessError):
        return hardware
    allowed = {
        "Model Name": "model_name",
        "Model Identifier": "model_identifier",
        "Chip": "chip",
        "Total Number of Cores": "cores",
        "Memory": "memory",
    }
    for line in raw.splitlines():
        key, separator, value = line.strip().partition(":")
        if separator and key in allowed:
            hardware[allowed[key]] = value.strip()
    return hardware


def environment_metadata() -> dict[str, Any]:
    return {
        "os": platform.platform(),
        "hardware": hardware_metadata(),
        "rustc": command_output(["rustc", "-Vv"]),
        "cargo": command_output(["cargo", "-V"]),
        "python": command_output([sys.executable, "--version"]),
        "node": command_output(["node", "--version"]),
        "release_profile": "Cargo default release profile",
    }


def generate_fixtures(directory: Path) -> None:
    subprocess.run(
        [sys.executable, str(REPO_ROOT / "scripts" / "generate-sofia-corpus.py"), str(directory)],
        cwd=REPO_ROOT,
        check=True,
        stdout=subprocess.DEVNULL,
    )


def load_cases(generated_dir: Path, selected: list[str] | None) -> list[dict[str, Any]]:
    manifest = json.loads(CORPUS_MANIFEST.read_text())
    cases = manifest["cases"]
    known = {case["id"] for case in cases}
    if selected:
        unknown = sorted(set(selected) - known)
        if unknown:
            raise RuntimeError(f"unknown corpus case(s): {', '.join(unknown)}")
        cases = [case for case in cases if case["id"] in selected]

    result = []
    for case in cases:
        source = case["source"]
        if source["kind"] == "repository":
            path = REPO_ROOT / source["path"]
        else:
            path = generated_dir / source["fixture"]
        data = path.read_bytes()
        actual_digest = hashlib.sha256(data).hexdigest()
        expected_digest = case["sha256"]
        if actual_digest != expected_digest:
            raise RuntimeError(
                f"corpus digest mismatch for {case['id']}: "
                f"expected {expected_digest}, got {actual_digest}"
            )
        result.append(
            {
                **case,
                "path": path,
                "bytes": len(data),
                "sha256": actual_digest,
            }
        )
    return result


def native_measurement(
    case: dict[str, Any],
    binary: Path,
    parser_name: str,
    profile_name: str,
    iterations: int,
    warmup: int,
) -> dict[str, Any]:
    command = [
        str(binary),
        "--parser",
        parser_name,
        "--profile",
        profile_name,
        "--expected",
        case["expected"],
        "--iterations",
        str(iterations),
        "--warmup",
        str(warmup),
        str(case["path"]),
    ]
    measured = json.loads(command_output(command))
    measured["input"] = case["source"]
    return measured


def percentile(sorted_samples: list[int], percentage: int) -> int:
    index = max(0, (len(sorted_samples) * percentage + 99) // 100 - 1)
    return sorted_samples[index]


def timing_summary(samples: list[int]) -> dict[str, Any]:
    ordered = sorted(samples)
    return {
        "unit": "nanoseconds",
        "min_ns": ordered[0],
        "median_ns": int(statistics.median(ordered)),
        "p95_ns": percentile(ordered, 95),
        "max_ns": ordered[-1],
        "mean_ns": int(statistics.mean(ordered)),
        "samples_ns": samples,
    }


def measure_python_operation(operation: Any, iterations: int, warmup: int) -> dict[str, Any]:
    for _ in range(warmup):
        result = operation()
        del result
    samples = []
    for _ in range(iterations):
        started = time.perf_counter_ns()
        result = operation()
        samples.append(time.perf_counter_ns() - started)
        # Object teardown is deliberately outside the construction interval.
        del result
    return timing_summary(samples)


def python_phase_measurements(source: str, iterations: int, warmup: int) -> dict[str, Any]:
    from aeon.core import (  # pylint: disable=import-outside-toplevel
        CompileOptions,
        resolve_paths,
        resolved_binding_to_event,
    )
    from aeon.lexer import tokenize  # pylint: disable=import-outside-toplevel
    from aeon.parser import parse_tokens  # pylint: disable=import-outside-toplevel

    options = CompileOptions()

    def lex_and_parse() -> Any:
        lex_result = tokenize(source)
        return parse_tokens(
            source,
            lex_result.tokens,
            max_clarifier_values=options.effective_max_clarifier_values(),
            max_generic_depth=options.max_generic_depth,
            max_generic_arguments=options.max_generic_arguments,
            max_datatype_components=options.max_datatype_components,
            max_attribute_depth=options.max_attribute_depth,
            max_value_nesting_depth=options.effective_max_value_nesting_depth(),
        )

    parsed = lex_and_parse()
    if parsed.errors or parsed.document is None:
        raise RuntimeError("phase preflight failed for a valid Python corpus case")
    resolved, path_errors = resolve_paths(parsed.document)
    if path_errors:
        raise RuntimeError("path-resolution preflight failed for a valid Python corpus case")

    return {
        "method": "Isolated in-memory phases; object teardown occurs outside each timed interval.",
        "resolved_bindings": len(resolved),
        "lex_and_parse": measure_python_operation(lex_and_parse, iterations, warmup),
        "path_resolution": measure_python_operation(
            lambda: resolve_paths(parsed.document), iterations, warmup
        ),
        "event_construction": measure_python_operation(
            lambda: [
                resolved_binding_to_event(binding, include_annotations=True)
                for binding in resolved
            ],
            iterations,
            warmup,
        ),
    }


def python_measurements(cases: list[dict[str, Any]], iterations: int, warmup: int) -> list[dict[str, Any]]:
    python_source = REPO_ROOT / "implementations" / "python" / "src"
    sys.path.insert(0, str(python_source))
    from aeon import compile_source  # pylint: disable=import-outside-toplevel

    measurements = []
    for case in cases:
        source = case["path"].read_text()
        preflight = compile_source(source)
        valid = not preflight.errors
        expected_valid = case["expected"] == "valid"
        if valid != expected_valid:
            names = ", ".join(type(error).__name__ for error in preflight.errors)
            raise RuntimeError(
                f"pure Python classified {case['id']} as {'valid' if valid else 'invalid'}"
                f" ({names or 'no errors'})"
            )
        for _ in range(warmup):
            compile_source(source)
        samples = []
        last = preflight
        for _ in range(iterations):
            started = time.perf_counter_ns()
            last = compile_source(source)
            samples.append(time.perf_counter_ns() - started)
        summary = timing_summary(samples)
        median_ns = summary["median_ns"]
        measurements.append(
            {
                "schema": "aeon.sofia.python-baseline.v1",
                "input": case["source"],
                "bytes": case["bytes"],
                "expected": case["expected"],
                "iterations": iterations,
                "warmup": warmup,
                "preflight": {
                    "valid": valid,
                    "events": len(last.events),
                    "errors": [type(error).__name__ for error in last.errors],
                    "warnings": len(last.warnings),
                },
                "compile": summary,
                "phases": (
                    python_phase_measurements(source, iterations, warmup) if valid else None
                ),
                "throughput_mib_per_second": (
                    (case["bytes"] / (1024 * 1024)) / (median_ns / 1_000_000_000)
                    if median_ns
                    else 0.0
                ),
            }
        )
    return measurements


def serializable_case(case: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in case.items() if key != "path"}


def main() -> int:
    args = parse_args()
    generate_fixtures(args.generated_dir)
    cases = load_cases(args.generated_dir, args.cases)
    implementations = ("native", "python") if args.implementation == "all" else (args.implementation,)

    native = []
    if "native" in implementations:
        if not args.native_binary.is_file():
            raise RuntimeError(
                "native benchmark binary is missing; run "
                "`cargo build --release -p altopelago-aeon-core --example "
                "sofia_baseline --features sofia-bench --locked` "
                "from implementations/rust"
            )
        profiles = ("full", "check") if args.profile == "both" else (args.profile,)
        for case in cases:
            for profile_name in profiles:
                native.append(
                    native_measurement(
                        case,
                        args.native_binary,
                        args.native_parser,
                        profile_name,
                        args.iterations,
                        args.warmup,
                    )
                )

    python = []
    if "python" in implementations:
        python = python_measurements(cases, args.iterations, args.warmup)

    output = {
        "schema": "aeon.sofia.baseline.v1",
        "captured_at": datetime.now(timezone.utc).isoformat(),
        "repositories": repository_metadata(),
        "environment": environment_metadata(),
        "corpus_manifest": str(CORPUS_MANIFEST.relative_to(REPO_ROOT)),
        "corpus": [serializable_case(case) for case in cases],
        "settings": {
            "implementations": implementations,
            "native_parser": args.native_parser,
            "native_profile": args.profile,
            "iterations": args.iterations,
            "warmup": args.warmup,
        },
        "measurements": {"native": native, "python": python},
    }
    rendered = json.dumps(output, indent=2) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered)
    else:
        sys.stdout.write(rendered)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, RuntimeError, subprocess.CalledProcessError) as error:
        print(f"error: {error}", file=sys.stderr)
        raise SystemExit(2) from error
