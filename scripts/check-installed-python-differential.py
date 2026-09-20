#!/usr/bin/env python3
"""Compare installed-native and pure-Python behavior through the Core CTS oracle."""

from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
RUNNER = REPO_ROOT / "scripts" / "cts-source-lane-runner.mjs"
NATIVE_SUT = (
    REPO_ROOT
    / "implementations"
    / "rust"
    / "crates"
    / "aeon-python"
    / "tests"
    / "installed_wheel_cts_sut.py"
)
PURE_PYTHON_SUT = REPO_ROOT / "implementations" / "python" / "bin" / "aeon-python"
SUMMARY_PATTERN = re.compile(r"Summary: pass=(\d+) fail=(\d+)")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cts", required=True, type=Path, help="Core CTS JSON snapshot")
    parser.add_argument(
        "--node",
        default="node",
        help="Node.js executable used to run the shared CTS runner",
    )
    return parser.parse_args()


def run_lane(label: str, sut: Path, *, node: str, cts: Path) -> int:
    command = [
        node,
        str(RUNNER),
        "--sut",
        str(sut),
        "--cts",
        str(cts),
        "--lane",
        "core",
    ]
    result = subprocess.run(
        command,
        cwd=REPO_ROOT,
        env=os.environ.copy(),
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
    )
    match = SUMMARY_PATTERN.search(result.stdout)
    if result.returncode != 0 or match is None:
        print(f"{label} CTS lane failed:\n{result.stdout}", file=sys.stderr)
        raise SystemExit(result.returncode or 1)

    passed, failed = (int(value) for value in match.groups())
    if failed:
        print(f"{label} CTS lane failed:\n{result.stdout}", file=sys.stderr)
        raise SystemExit(1)
    print(f"{label}: pass={passed} fail={failed}")
    return passed


def main() -> int:
    args = parse_args()
    cts = args.cts.resolve()
    if not cts.is_file():
        raise SystemExit(f"Core CTS snapshot not found: {cts}")

    native_count = run_lane("installed native wheel", NATIVE_SUT, node=args.node, cts=cts)
    oracle_count = run_lane("pure-Python implementation", PURE_PYTHON_SUT, node=args.node, cts=cts)
    if native_count != oracle_count:
        raise SystemExit(
            "CTS coverage differed between implementations: "
            f"native={native_count} pure-python={oracle_count}"
        )

    print(
        "Differential conformance passed: both implementations matched "
        f"the same {native_count} normalized Core CTS vectors."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
