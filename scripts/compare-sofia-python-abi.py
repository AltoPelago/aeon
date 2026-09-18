#!/usr/bin/env python3
"""Compare repeated exact-CPython and abi3 Sofia benchmark captures."""

from __future__ import annotations

import argparse
import json
import math
import statistics
import sys
from pathlib import Path
from typing import Any


METRICS_BY_SCHEMA = {
    "aeon.sofia.python-boundary.v1": (
        "native_json_envelope",
        "ergonomic_compile",
        "encoded_telex",
    ),
    "aeon.sofia.python-boundary.v2": (
        "native_packed_envelope",
        "ergonomic_compile",
        "encoded_telex",
    ),
    "aeon.sofia.python-boundary.v3": (
        "native_object_result",
        "ergonomic_compile",
        "encoded_telex",
    ),
}
MINIMUM_CAPTURES = 3


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--exact", action="append", type=Path, required=True)
    parser.add_argument("--abi3", action="append", type=Path, required=True)
    parser.add_argument("--output", type=Path)
    return parser.parse_args()


def load(paths: list[Path], expected_variant: str) -> list[dict[str, Any]]:
    captures = [json.loads(path.read_text()) for path in paths]
    if any(capture["schema"] not in METRICS_BY_SCHEMA for capture in captures):
        raise RuntimeError("unexpected capture schema")
    if any(capture["variant"] != expected_variant for capture in captures):
        raise RuntimeError(f"capture variant does not match {expected_variant}")
    return captures


def case_map(capture: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {measurement["id"]: measurement for measurement in capture["measurements"]}


def validate_capture_group(captures: list[dict[str, Any]], label: str) -> None:
    first = captures[0]
    first_cases = case_map(first)
    for index, capture in enumerate(captures[1:], start=2):
        cases = case_map(capture)
        if cases.keys() != first_cases.keys():
            raise RuntimeError(f"{label} capture {index} case set differs")
        for case_id, first_case in first_cases.items():
            if cases[case_id]["sha256"] != first_case["sha256"]:
                raise RuntimeError(f"{label} capture {index} digest differs for {case_id}")
        if capture["aeon_revision"] != first["aeon_revision"]:
            raise RuntimeError(f"{label} captures use different AEON revisions")
        if capture["environment"] != first["environment"]:
            raise RuntimeError(f"{label} captures use different environments")
        if capture["package"]["wheel_sha256"] != first["package"]["wheel_sha256"]:
            raise RuntimeError(f"{label} captures use different wheel artifacts")


def geometric_mean(values: list[float]) -> float:
    return math.exp(sum(math.log(value) for value in values) / len(values))


def aggregate_metric(
    captures: list[dict[str, Any]], case_id: str, metric: str
) -> int | None:
    values = []
    for capture in captures:
        measured = case_map(capture)[case_id][metric]
        if measured is None:
            return None
        values.append(measured["median_ns"])
    return int(statistics.median(values))


def main() -> int:
    args = parse_args()
    exact = load(args.exact, "exact")
    abi3 = load(args.abi3, "abi3-py312")
    if len(exact) != len(abi3):
        raise RuntimeError("exact and abi3 capture counts differ")
    if len(exact) < MINIMUM_CAPTURES:
        raise RuntimeError(
            f"ABI decision requires at least {MINIMUM_CAPTURES} captures per variant"
        )
    validate_capture_group(exact, "exact")
    validate_capture_group(abi3, "abi3")
    if exact[0]["aeon_revision"] != abi3[0]["aeon_revision"]:
        raise RuntimeError("exact and abi3 captures use different AEON revisions")
    if exact[0]["environment"] != abi3[0]["environment"]:
        raise RuntimeError("exact and abi3 captures use different environments")
    if exact[0]["schema"] != abi3[0]["schema"]:
        raise RuntimeError("exact and abi3 captures use different schemas")

    metrics_to_compare = METRICS_BY_SCHEMA[exact[0]["schema"]]

    exact_cases = case_map(exact[0])
    abi3_cases = case_map(abi3[0])
    if exact_cases.keys() != abi3_cases.keys():
        raise RuntimeError("exact and abi3 case sets differ")
    for case_id in exact_cases:
        if exact_cases[case_id]["sha256"] != abi3_cases[case_id]["sha256"]:
            raise RuntimeError(f"corpus digest differs for {case_id}")

    comparisons = []
    metric_ratios: dict[str, list[float]] = {metric: [] for metric in metrics_to_compare}
    large_ratios: dict[str, list[float]] = {metric: [] for metric in metrics_to_compare}
    for case_id, exact_case in exact_cases.items():
        metrics = {}
        is_large = "large" in exact_case["categories"]
        for metric in metrics_to_compare:
            exact_ns = aggregate_metric(exact, case_id, metric)
            abi3_ns = aggregate_metric(abi3, case_id, metric)
            ratio = abi3_ns / exact_ns if exact_ns is not None and abi3_ns is not None else None
            metrics[metric] = {
                "exact_median_of_medians_ns": exact_ns,
                "abi3_median_of_medians_ns": abi3_ns,
                "abi3_over_exact_ratio": ratio,
            }
            if ratio is not None:
                metric_ratios[metric].append(ratio)
                if is_large:
                    large_ratios[metric].append(ratio)
        comparisons.append(
            {"id": case_id, "categories": exact_case["categories"], "metrics": metrics}
        )

    summary = {}
    for metric in metrics_to_compare:
        geomean = geometric_mean(metric_ratios[metric])
        maximum_large = max(large_ratios[metric]) if large_ratios[metric] else None
        summary[metric] = {
            "geometric_mean_ratio": geomean,
            "geometric_mean_at_or_below_1_03x": geomean <= 1.03,
            "maximum_large_case_ratio": maximum_large,
            "large_cases_at_or_below_1_05x": maximum_large is None or maximum_large <= 1.05,
        }
    accepted = all(
        item["geometric_mean_at_or_below_1_03x"] and item["large_cases_at_or_below_1_05x"]
        for item in summary.values()
    )
    output = {
        "schema": "aeon.sofia.python-abi-comparison.v1",
        "aeon_revision": exact[0]["aeon_revision"],
        "policy": {
            "maximum_geometric_mean_ratio": 1.03,
            "maximum_large_case_ratio": 1.05,
        },
        "capture_count_per_variant": len(exact),
        "exact_wheels": [capture["package"] for capture in exact],
        "abi3_wheels": [capture["package"] for capture in abi3],
        "comparisons": comparisons,
        "summary": summary,
        "accepted": accepted,
        "recommendation": "abi3-py312" if accepted else "exact-version",
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
    except (OSError, RuntimeError, KeyError, ValueError) as error:
        print(f"error: {error}", file=sys.stderr)
        raise SystemExit(2) from error
