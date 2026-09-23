#!/usr/bin/env python3
"""Measure an installed Sofia Python wheel against matching native Rust."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import platform
import statistics
import subprocess
import sys
import time
from datetime import datetime, timezone
from importlib.metadata import distribution
from pathlib import Path
from typing import Any, Callable


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
    parser.add_argument("--variant", required=True, choices=("exact", "abi3-py312"))
    parser.add_argument("--wheel", required=True, type=Path)
    parser.add_argument("--case", action="append", dest="cases")
    parser.add_argument("--generated-dir", type=Path, default=DEFAULT_GENERATED_DIR)
    parser.add_argument("--native-binary", type=Path, default=DEFAULT_NATIVE_BINARY)
    parser.add_argument("--large-iterations", type=positive_integer, default=3)
    parser.add_argument("--large-warmup", type=non_negative_integer, default=1)
    parser.add_argument("--small-iterations", type=positive_integer, default=10)
    parser.add_argument("--small-warmup", type=non_negative_integer, default=2)
    parser.add_argument("--output", type=Path)
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


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


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

    loaded = []
    for case in cases:
        source_spec = case["source"]
        path = (
            REPO_ROOT / source_spec["path"]
            if source_spec["kind"] == "repository"
            else generated_dir / source_spec["fixture"]
        )
        digest = file_sha256(path)
        if digest != case["sha256"]:
            raise RuntimeError(
                f"corpus digest mismatch for {case['id']}: expected {case['sha256']}, got {digest}"
            )
        loaded.append({**case, "path": path, "bytes": path.stat().st_size})
    return loaded


def percentile(ordered: list[int], percentage: int) -> int:
    index = max(0, math.ceil(len(ordered) * percentage / 100) - 1)
    return ordered[index]


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


def measure(operation: Callable[[], Any], iterations: int, warmup: int) -> dict[str, Any]:
    for _ in range(warmup):
        result = operation()
        del result
    samples = []
    for _ in range(iterations):
        started = time.perf_counter_ns()
        result = operation()
        samples.append(time.perf_counter_ns() - started)
        del result
    return timing_summary(samples)


def telex_phase_profile(
    operation: Callable[[], tuple[int, int, int, int, int, int]],
    iterations: int,
    warmup: int,
) -> dict[str, Any]:
    for _ in range(warmup):
        operation()

    compile_samples = []
    projection_samples = []
    validation_samples = []
    encode_samples = []
    resident_pipeline_samples = []
    record_count = None
    encoded_bytes = None
    for _ in range(iterations):
        compile_ns, projection_ns, validation_ns, encode_ns, records, byte_count = (
            operation()
        )
        compile_samples.append(compile_ns)
        projection_samples.append(projection_ns)
        validation_samples.append(validation_ns)
        encode_samples.append(encode_ns)
        resident_pipeline_samples.append(compile_ns + projection_ns + encode_ns)
        if record_count is not None and record_count != records:
            raise RuntimeError("Telex phase profiler returned inconsistent record counts")
        if encoded_bytes is not None and encoded_bytes != byte_count:
            raise RuntimeError("Telex phase profiler returned inconsistent byte counts")
        record_count = records
        encoded_bytes = byte_count

    projection = timing_summary(projection_samples)
    validation = timing_summary(validation_samples)
    encode = timing_summary(encode_samples)
    return {
        "method": "rust-internal-resident-record-phases",
        "compile": timing_summary(compile_samples),
        "projection": projection,
        "resident_validation": validation,
        "resident_encode_including_validation": encode,
        "resident_pipeline": timing_summary(resident_pipeline_samples),
        "approximate_wire_emission_ns": max(
            0, encode["median_ns"] - validation["median_ns"]
        ),
        "records": record_count,
        "encoded_bytes": encoded_bytes,
    }


def native_measurement(
    case: dict[str, Any], binary: Path, iterations: int, warmup: int
) -> dict[str, Any]:
    command = [
        str(binary),
        "--parser",
        "sofia",
        "--profile",
        "full",
        "--expected",
        case["expected"],
        "--iterations",
        str(iterations),
        "--warmup",
        str(warmup),
        str(case["path"]),
    ]
    return json.loads(command_output(command))


def throughput_mib_per_second(byte_count: int, median_ns: int) -> float:
    return (byte_count / (1024 * 1024)) / (median_ns / 1_000_000_000)


def measure_case(
    case: dict[str, Any], native_binary: Path, iterations: int, warmup: int
) -> dict[str, Any]:
    import altopelago.aeon as aeon  # pylint: disable=import-outside-toplevel
    from altopelago.aeon import _native  # pylint: disable=import-outside-toplevel
    from altopelago.aeon._api import (  # pylint: disable=import-outside-toplevel
        _compile_result,
        _compile_result_packed,
    )

    source = case["path"].read_text()
    raw_preflight = _native.compile_json(source)
    decoded_preflight = json.loads(raw_preflight)
    result_preflight = _compile_result(decoded_preflight)
    packed_preflight = _native.compile_packed(source)
    packed_result_preflight = _compile_result_packed(packed_preflight)
    native_object_preflight = _native.compile_native(source)
    public_preflight = aeon.compile(source)
    expected_valid = case["expected"] == "valid"
    if result_preflight.ok != expected_valid or public_preflight.ok != expected_valid:
        raise RuntimeError(f"installed wheel misclassified {case['id']}")
    if (
        result_preflight != packed_result_preflight
        or packed_result_preflight != native_object_preflight
        or native_object_preflight != public_preflight
    ):
        raise RuntimeError(f"private protocols and public compile result differ for {case['id']}")

    event_count = len(public_preflight.events)
    native = native_measurement(case, native_binary, iterations, warmup)
    if native["preflight"]["events"] != event_count:
        raise RuntimeError(f"native and Python event counts differ for {case['id']}")

    native_json = measure(lambda: _native.compile_json(source), iterations, warmup)
    native_packed = measure(lambda: _native.compile_packed(source), iterations, warmup)
    native_object = measure(lambda: _native.compile_native(source), iterations, warmup)
    json_conversion = measure(
        lambda: _compile_result(json.loads(raw_preflight)), iterations, warmup
    )
    conversion = measure(
        lambda: _compile_result_packed(packed_preflight), iterations, warmup
    )
    ergonomic = measure(lambda: aeon.compile(source), iterations, warmup)
    encoded = (
        measure(lambda: aeon.compile_to_telex(source), iterations, warmup)
        if expected_valid
        else None
    )
    telex_phases = (
        telex_phase_profile(
            lambda: _native.compile_telex_profile(source), iterations, warmup
        )
        if expected_valid
        else None
    )

    native_median = native["compile"]["median_ns"]
    raw_median = native_json["median_ns"]
    packed_median = native_packed["median_ns"]
    native_object_median = native_object["median_ns"]
    json_conversion_median = json_conversion["median_ns"]
    conversion_median = conversion["median_ns"]
    ergonomic_median = ergonomic["median_ns"]
    encoded_median = encoded["median_ns"] if encoded is not None else None
    resident_pipeline_median = (
        telex_phases["resident_pipeline"]["median_ns"]
        if telex_phases is not None
        else None
    )
    return {
        "id": case["id"],
        "input": case["source"],
        "sha256": case["sha256"],
        "bytes": case["bytes"],
        "categories": case["categories"],
        "expected": case["expected"],
        "iterations": iterations,
        "warmup": warmup,
        "preflight": {
            "valid": public_preflight.ok,
            "events": event_count,
            "warnings": len(public_preflight.warnings),
            "errors": [diagnostic.code for diagnostic in public_preflight.errors],
            "native_json_bytes": len(raw_preflight),
            "telex_bytes": len(aeon.compile_to_telex(source)) if expected_valid else None,
        },
        "native_full_result": native["compile"],
        "native_json_envelope": {
            **native_json,
            "median_over_native_ratio": raw_median / native_median,
            "throughput_mib_per_second": throughput_mib_per_second(case["bytes"], raw_median),
        },
        "native_packed_envelope": {
            **native_packed,
            "median_over_native_ratio": packed_median / native_median,
            "throughput_mib_per_second": throughput_mib_per_second(
                case["bytes"], packed_median
            ),
        },
        "native_object_result": {
            **native_object,
            "median_over_native_ratio": native_object_median / native_median,
            "throughput_mib_per_second": throughput_mib_per_second(
                case["bytes"], native_object_median
            ),
        },
        "python_json_result_conversion": {
            **json_conversion,
            "median_ns_per_event": (
                json_conversion_median / event_count if event_count else None
            ),
        },
        "python_result_conversion": {
            **conversion,
            "method": "cached-packed-python-constructor-upper-bound",
            "median_ns_per_event": conversion_median / event_count if event_count else None,
        },
        "ergonomic_compile": {
            **ergonomic,
            "median_over_native_ratio": ergonomic_median / native_median,
            "throughput_mib_per_second": throughput_mib_per_second(
                case["bytes"], ergonomic_median
            ),
        },
        "encoded_telex": (
            {
                **encoded,
                "median_over_native_ratio": encoded_median / native_median,
                "median_over_resident_pipeline_ratio": (
                    encoded_median / resident_pipeline_median
                    if resident_pipeline_median
                    else None
                ),
                "throughput_mib_per_second": throughput_mib_per_second(
                    case["bytes"], encoded_median
                ),
            }
            if encoded is not None and encoded_median is not None
            else None
        ),
        "telex_phase_profile": telex_phases,
    }


def gate_summary(measurements: list[dict[str, Any]]) -> dict[str, Any]:
    valid = [item for item in measurements if item["preflight"]["valid"]]
    flat = next((item for item in valid if item["id"] == "large-flat-50000"), None)
    tiny = next((item for item in valid if item["id"] == "tiny-typed"), None)
    encoded_ratios = [item["encoded_telex"]["median_over_native_ratio"] for item in valid]
    encoded_resident_ratios = [
        item["encoded_telex"]["median_over_resident_pipeline_ratio"]
        for item in valid
        if item["encoded_telex"]["median_over_resident_pipeline_ratio"] is not None
    ]
    ergonomic_ratios = [item["ergonomic_compile"]["median_over_native_ratio"] for item in valid]
    conversion_rates = [
        item["python_result_conversion"]["median_ns_per_event"]
        for item in valid
        if item["python_result_conversion"]["median_ns_per_event"] is not None
    ]
    return {
        "encoded_maximum_ratio": max(encoded_ratios, default=None),
        "encoded_at_or_below_2_25x": (
            all(ratio <= 2.25 for ratio in encoded_ratios) if encoded_ratios else None
        ),
        "encoded_resident_pipeline_maximum_ratio": max(
            encoded_resident_ratios, default=None
        ),
        "encoded_resident_pipeline_at_or_below_1_40x": (
            all(ratio <= 1.40 for ratio in encoded_resident_ratios)
            if encoded_resident_ratios
            else None
        ),
        "ergonomic_maximum_ratio": max(ergonomic_ratios, default=None),
        "ergonomic_at_or_below_3x": (
            all(ratio <= 3.0 for ratio in ergonomic_ratios) if ergonomic_ratios else None
        ),
        "large_flat_conversion_ns": (
            flat["python_result_conversion"]["median_ns"] if flat is not None else None
        ),
        "large_flat_conversion_ns_per_event": (
            flat["python_result_conversion"]["median_ns_per_event"] if flat is not None else None
        ),
        "large_flat_conversion_at_or_below_200ms": (
            flat["python_result_conversion"]["median_ns"] <= 200_000_000
            if flat is not None
            else None
        ),
        "conversion_at_or_below_4us_per_event": (
            all(rate <= 4_000 for rate in conversion_rates) if conversion_rates else None
        ),
        "tiny_typed_ns": tiny["ergonomic_compile"]["median_ns"] if tiny is not None else None,
        "tiny_typed_at_or_below_0_250ms": (
            tiny["ergonomic_compile"]["median_ns"] <= 250_000
            if tiny is not None
            else None
        ),
    }


def main() -> int:
    args = parse_args()
    if not args.wheel.is_file():
        raise RuntimeError(f"wheel does not exist: {args.wheel}")
    if not args.native_binary.is_file():
        raise RuntimeError(f"native benchmark binary does not exist: {args.native_binary}")
    generate_fixtures(args.generated_dir)
    cases = load_cases(args.generated_dir, args.cases)
    measurements = []
    for case in cases:
        large = "large" in case["categories"]
        iterations = args.large_iterations if large else args.small_iterations
        warmup = args.large_warmup if large else args.small_warmup
        measurements.append(
            measure_case(case, args.native_binary, iterations, warmup)
        )

    package = distribution("altopelago-aeon")
    from altopelago.aeon import _native  # pylint: disable=import-outside-toplevel

    if _native.ENGINE != "sofia":
        raise RuntimeError(f"installed wheel uses unexpected engine: {_native.ENGINE}")
    output = {
        "schema": "aeon.sofia.python-boundary.v5",
        "captured_at": datetime.now(timezone.utc).isoformat(),
        "variant": args.variant,
        "aeon_revision": command_output(["git", "rev-parse", "HEAD"]),
        "environment": {
            "python": sys.version,
            "implementation": platform.python_implementation(),
            "platform": platform.platform(),
            "machine": platform.machine(),
        },
        "package": {
            "name": package.metadata["Name"],
            "version": package.version,
            "engine": _native.ENGINE,
            "ergonomic_protocol": "native-objects-v1",
            "wheel": args.wheel.name,
            "wheel_bytes": args.wheel.stat().st_size,
            "wheel_sha256": file_sha256(args.wheel),
        },
        "settings": {
            "large_iterations": args.large_iterations,
            "large_warmup": args.large_warmup,
            "small_iterations": args.small_iterations,
            "small_warmup": args.small_warmup,
        },
        "measurements": measurements,
    }
    output["gates"] = gate_summary(measurements)
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
