#!/usr/bin/env python3
"""Small repeatable CLI benchmark helper.

Examples:
  python3 scripts/bench-cli.py --cwd implementations/rust -- ./target/release/aeon-rust check /tmp/file.aeon
  python3 scripts/bench-cli.py --iterations 10 --warmup 2 -- pnpm --dir implementations/typescript cli check /tmp/file.aeon
"""

from __future__ import annotations

import argparse
import json
import statistics
import subprocess
import sys
import time
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Benchmark a CLI command repeatedly.")
    parser.add_argument("--cwd", default=".", help="Working directory for the command.")
    parser.add_argument("--iterations", type=int, default=5, help="Measured runs.")
    parser.add_argument("--warmup", type=int, default=1, help="Warmup runs.")
    parser.add_argument(
        "--timeout",
        type=float,
        default=15.0,
        help="Per-run timeout in seconds.",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Emit machine-readable JSON instead of a text summary.",
    )
    parser.add_argument(
        "command",
        nargs=argparse.REMAINDER,
        help="Command to run, prefixed by -- to stop option parsing.",
    )
    args = parser.parse_args()
    if args.command and args.command[0] == "--":
        args.command = args.command[1:]
    if not args.command:
        parser.error("missing command; pass it after --")
    if args.iterations <= 0:
        parser.error("--iterations must be > 0")
    if args.warmup < 0:
        parser.error("--warmup must be >= 0")
    if args.timeout <= 0:
        parser.error("--timeout must be > 0")
    return args


def run_once(command: list[str], cwd: Path, timeout: float) -> float:
    start = time.perf_counter()
    subprocess.run(
        command,
        cwd=str(cwd),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=True,
        timeout=timeout,
    )
    return time.perf_counter() - start


def main() -> int:
    args = parse_args()
    cwd = Path(args.cwd).resolve()

    try:
        for _ in range(args.warmup):
            run_once(args.command, cwd, args.timeout)

        samples = [run_once(args.command, cwd, args.timeout) for _ in range(args.iterations)]
    except subprocess.TimeoutExpired:
        print(
            f"Command timed out after {args.timeout:.3f}s: {' '.join(args.command)}",
            file=sys.stderr,
        )
        return 124
    except KeyboardInterrupt:
        print("Benchmark interrupted.", file=sys.stderr)
        return 130

    result = {
        "cwd": str(cwd),
        "command": args.command,
        "iterations": args.iterations,
        "warmup": args.warmup,
        "timeout_seconds": args.timeout,
        "avg_seconds": statistics.mean(samples),
        "min_seconds": min(samples),
        "max_seconds": max(samples),
        "samples_seconds": samples,
    }

    if args.json:
        json.dump(result, sys.stdout, indent=2)
        sys.stdout.write("\n")
        return 0

    print(f"cwd: {result['cwd']}")
    print(f"command: {' '.join(args.command)}")
    print(f"warmup: {args.warmup}")
    print(f"timeout_seconds: {args.timeout}")
    print(f"iterations: {args.iterations}")
    print(f"avg_seconds: {result['avg_seconds']:.6f}")
    print(f"min_seconds: {result['min_seconds']:.6f}")
    print(f"max_seconds: {result['max_seconds']:.6f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
