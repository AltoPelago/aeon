#!/usr/bin/env python3
"""Capture fresh-process RSS, failure, and nesting baselines for Sofia."""

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
    / "sofia_probe"
)
RSS_HELPER = REPO_ROOT / "scripts" / "measure-peak-rss.py"
DEPTHS = (1, 8, 16, 32, 64, 128, 192, 256, 257)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--generated-dir", type=Path, default=GENERATED_DIR)
    parser.add_argument("--probe", type=Path, default=PROBE)
    parser.add_argument(
        "--native-parser",
        choices=("baseline", "sofia"),
        default="baseline",
        help="Native parser implementation to measure.",
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


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def git_revision(ref: str) -> str:
    return subprocess.run(
        ["git", "rev-parse", ref],
        cwd=REPO_ROOT,
        check=True,
        stdout=subprocess.PIPE,
        text=True,
    ).stdout.strip()


def manifest_cases(generated_dir: Path) -> list[dict[str, Any]]:
    manifest = json.loads(MANIFEST.read_text())
    selected = []
    for case in manifest["cases"]:
        if not ({"memory", "hostile", "early-failure"} & set(case["categories"])):
            continue
        source = case["source"]
        path = REPO_ROOT / source["path"] if source["kind"] == "repository" else generated_dir / source["fixture"]
        selected.append({**case, "path": path})
    return selected


def measure(case: dict[str, Any], probe: Path, parser_name: str) -> dict[str, Any]:
    command = [
        sys.executable,
        str(RSS_HELPER),
        "--parse-json",
        "--",
        str(probe),
        "--parser",
        parser_name,
        "--expected",
        case["expected"],
        str(case["path"]),
    ]
    measured = run_json(command)
    measured.pop("command", None)
    measured["child"]["input"] = case["source"]
    measured["id"] = case["id"]
    measured["sha256"] = digest(case["path"])
    return measured


def depth_cases(generated_dir: Path) -> list[dict[str, Any]]:
    return [
        {
            "id": f"depth-list-{depth}",
            "source": {"kind": "generated", "fixture": f"depth-list-{depth}.aeon"},
            "path": generated_dir / f"depth-list-{depth}.aeon",
            "expected": "valid" if depth <= 256 else "invalid",
            "depth": depth,
        }
        for depth in DEPTHS
    ]


def main() -> int:
    args = parse_args()
    subprocess.run(
        [sys.executable, str(REPO_ROOT / "scripts" / "generate-sofia-corpus.py"), str(args.generated_dir)],
        cwd=REPO_ROOT,
        check=True,
        stdout=subprocess.DEVNULL,
    )
    if not args.probe.is_file():
        raise RuntimeError(
            "native probe is missing; build it with "
            "`cargo build --release -p aeon-core --example sofia_probe --locked`"
        )

    empty_case = {
        "id": "runtime-empty",
        "source": {"kind": "generated", "fixture": "empty.aeon"},
        "path": args.generated_dir / "empty.aeon",
        "expected": "valid",
    }
    cases = [empty_case, *manifest_cases(args.generated_dir), *depth_cases(args.generated_dir)]
    measurements = [measure(case, args.probe, args.native_parser) for case in cases]
    baseline_rss = measurements[0]["maximum_rss_bytes"]
    for measurement in measurements:
        input_bytes = measurement["child"]["bytes"]
        events = measurement["child"]["result"]["events"]
        incremental = max(0, measurement["maximum_rss_bytes"] - baseline_rss)
        measurement["incremental_rss_over_empty_bytes"] = incremental
        measurement["incremental_rss_per_input_byte"] = incremental / input_bytes if input_bytes else None
        measurement["incremental_rss_per_event"] = incremental / events if events else None

    output = {
        "schema": "aeon.sofia.native-memory-baseline.v1",
        "captured_at": datetime.now(timezone.utc).isoformat(),
        "measurement_harness_revision": git_revision("HEAD"),
        "semantic_baseline_revision": git_revision("main"),
        "native_parser": args.native_parser,
        "environment": {
            "os": platform.platform(),
            "machine": platform.machine(),
            "python": platform.python_version(),
        },
        "method": {
            "peak_rss": "Fresh child process; getrusage(RUSAGE_CHILDREN).ru_maxrss normalized to bytes.",
            "allocation_proxy": "Peak RSS above the empty-input process, divided by input bytes and emitted events.",
            "result_retention": "The full CompileResult remains live through probe serialization.",
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
