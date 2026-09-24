#!/usr/bin/env python3
"""Run one command and report its child-process peak resident memory."""

from __future__ import annotations

import argparse
import json
import platform
import resource
import subprocess
import sys
from typing import Any


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--timeout", type=float, default=60.0)
    parser.add_argument("--parse-json", action="store_true")
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    if args.command and args.command[0] == "--":
        args.command = args.command[1:]
    if not args.command:
        parser.error("missing command; pass it after --")
    if args.timeout <= 0:
        parser.error("--timeout must be greater than zero")
    return args


def rss_bytes(raw: int) -> int:
    if platform.system() == "Darwin":
        return raw
    return raw * 1024


def main() -> int:
    args = parse_args()
    before = resource.getrusage(resource.RUSAGE_CHILDREN)
    completed = subprocess.run(
        args.command,
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=args.timeout,
    )
    after = resource.getrusage(resource.RUSAGE_CHILDREN)
    if completed.returncode != 0:
        sys.stderr.write(completed.stderr)
        return completed.returncode

    child_output: Any = completed.stdout
    if args.parse_json:
        child_output = json.loads(completed.stdout)
    json.dump(
        {
            "schema": "aeon.sofia.peak-rss.v1",
            "platform": platform.system(),
            "command": args.command,
            "maximum_rss_bytes": rss_bytes(after.ru_maxrss),
            "user_cpu_seconds": after.ru_utime - before.ru_utime,
            "system_cpu_seconds": after.ru_stime - before.ru_stime,
            "minor_page_faults": after.ru_minflt - before.ru_minflt,
            "major_page_faults": after.ru_majflt - before.ru_majflt,
            "voluntary_context_switches": after.ru_nvcsw - before.ru_nvcsw,
            "involuntary_context_switches": after.ru_nivcsw - before.ru_nivcsw,
            "child": child_output,
        },
        sys.stdout,
        indent=2,
    )
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except subprocess.TimeoutExpired as error:
        print(f"command timed out after {error.timeout} seconds", file=sys.stderr)
        raise SystemExit(124) from error
