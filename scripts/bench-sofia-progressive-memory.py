#!/usr/bin/env python3
"""Capture Stage 4 compact-progressive retention and fresh-process peak RSS."""

from __future__ import annotations

import argparse
import hashlib
import json
import platform
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[1]
MANIFEST = REPO_ROOT / "benchmarks" / "sofia" / "corpus.json"
GENERATED_DIR = Path("/tmp/aeon-sofia-corpus")
PROBE = (
    REPO_ROOT
    / "implementations"
    / "rust"
    / "target"
    / "release"
    / "examples"
    / "sofia_progressive_probe"
)
RSS_HELPER = REPO_ROOT / "scripts" / "measure-peak-rss.py"


def positive_int(raw: str) -> int:
    value = int(raw)
    if value <= 0:
        raise argparse.ArgumentTypeError("value must be greater than zero")
    return value


def positive_float(raw: str) -> float:
    value = float(raw)
    if value <= 0:
        raise argparse.ArgumentTypeError("value must be greater than zero")
    return value


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--generated-dir", type=Path, default=GENERATED_DIR)
    parser.add_argument("--probe", type=Path, default=PROBE)
    parser.add_argument("--chunk-bytes", type=positive_int, default=4096)
    parser.add_argument("--max-batch-events", type=positive_int, default=256)
    parser.add_argument("--max-pending-batches", type=positive_int, default=2)
    parser.add_argument("--timeout", type=positive_float, default=300.0)
    parser.add_argument(
        "--case",
        action="append",
        dest="cases",
        help="Measure only the named selected corpus case; may be repeated.",
    )
    parser.add_argument("--output", type=Path)
    return parser.parse_args()


def run_json(command: list[str]) -> dict[str, Any]:
    completed = subprocess.run(
        command,
        cwd=REPO_ROOT,
        check=True,
        stdout=subprocess.PIPE,
        text=True,
    )
    return json.loads(completed.stdout)


def command_output(command: list[str]) -> str:
    return subprocess.run(
        command,
        cwd=REPO_ROOT,
        check=True,
        stdout=subprocess.PIPE,
        text=True,
    ).stdout.strip()


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def manifest_cases(generated_dir: Path) -> list[dict[str, Any]]:
    manifest = json.loads(MANIFEST.read_text())
    selected = []
    for case in manifest["cases"]:
        if not ({"memory", "hostile", "early-failure"} & set(case["categories"])):
            continue
        source = case["source"]
        path = (
            REPO_ROOT / source["path"]
            if source["kind"] == "repository"
            else generated_dir / source["fixture"]
        )
        actual_digest = digest(path)
        if actual_digest != case["sha256"]:
            raise RuntimeError(
                f"corpus digest mismatch for {case['id']}: "
                f"expected {case['sha256']}, got {actual_digest}"
            )
        selected.append({**case, "path": path})
    return selected


def measure(case: dict[str, Any], args: argparse.Namespace) -> dict[str, Any]:
    command = [
        sys.executable,
        str(RSS_HELPER),
        "--timeout",
        str(args.timeout),
        "--parse-json",
        "--",
        str(args.probe),
        "--expected",
        case["expected"],
        "--chunk-bytes",
        str(args.chunk_bytes),
        "--max-batch-events",
        str(args.max_batch_events),
        "--max-pending-batches",
        str(args.max_pending_batches),
        str(case["path"]),
    ]
    measured = run_json(command)
    measured.pop("command", None)
    measured["child"]["input"] = case["source"]
    measured["id"] = case["id"]
    measured["sha256"] = digest(case["path"])
    return measured


def main() -> int:
    args = parse_args()
    subprocess.run(
        [
            sys.executable,
            str(REPO_ROOT / "scripts" / "generate-sofia-corpus.py"),
            str(args.generated_dir),
        ],
        cwd=REPO_ROOT,
        check=True,
        stdout=subprocess.DEVNULL,
    )
    if not args.probe.is_file():
        raise RuntimeError(
            "progressive probe is missing; build it with "
            "`cargo build --release -p aeon-core --example "
            "sofia_progressive_probe --features sofia-bench --locked`"
        )

    empty_path = args.generated_dir / "empty.aeon"
    empty_case = {
        "id": "runtime-empty",
        "source": {"kind": "generated", "fixture": "empty.aeon"},
        "path": empty_path,
        "sha256": digest(empty_path),
        "expected": "valid",
    }
    selected_cases = manifest_cases(args.generated_dir)
    if args.cases:
        requested = set(args.cases)
        known = {case["id"] for case in selected_cases}
        unknown = sorted(requested - known)
        if unknown:
            raise RuntimeError(f"unknown or non-memory corpus cases: {', '.join(unknown)}")
        selected_cases = [case for case in selected_cases if case["id"] in requested]
    cases = [empty_case, *selected_cases]
    measurements = [measure(case, args) for case in cases]
    baseline_rss = measurements[0]["maximum_rss_bytes"]
    for measurement in measurements:
        child = measurement["child"]
        input_bytes = child["retention"]["peaks"]["accepted_input_bytes"]
        events = child["result"]["delivered_event_count"]
        incremental = max(0, measurement["maximum_rss_bytes"] - baseline_rss)
        measurement["incremental_rss_over_empty_bytes"] = incremental
        measurement["incremental_rss_per_input_byte"] = (
            incremental / input_bytes if input_bytes else None
        )
        measurement["incremental_rss_per_delivered_event"] = (
            incremental / events if events else None
        )

    output = {
        "schema": "aeon.sofia.progressive-memory.v1",
        "captured_at": datetime.now(timezone.utc).isoformat(),
        "implementation_revision": command_output(["git", "rev-parse", "HEAD"]),
        "environment": {
            "os": platform.platform(),
            "machine": platform.machine(),
            "python": platform.python_version(),
            "rustc": command_output(["rustc", "--version"]),
        },
        "configuration": {
            "mode": "compact-validation",
            "input_chunk_bytes": args.chunk_bytes,
            "max_batch_events": args.max_batch_events,
            "max_pending_batches": args.max_pending_batches,
            "per_case_timeout_seconds": args.timeout,
            "selected_cases": args.cases,
        },
        "method": {
            "peak_rss": "Fresh child process; getrusage(RUSAGE_CHILDREN).ru_maxrss normalized to bytes.",
            "input_retention": "The probe streams directly from the file in fixed byte chunks and never constructs a complete source string.",
            "allocation_proxy": "Peak RSS above the empty-input process, divided by accepted input bytes and delivered events.",
            "retention_snapshot": "Maximum post-operation value for each instrumented engine category; peak_accounted_shallow_bytes is the maximum simultaneous shallow-byte total.",
            "output_retention": "Delivered batches are counted and dropped while backpressure is active; terminal compact results remain live through serialization.",
        },
        "empty_process_peak_rss_bytes": baseline_rss,
        "measurements": measurements,
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
