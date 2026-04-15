#!/usr/bin/env python3
"""Run fuzz artifacts across AEON implementations and summarize agreement.

Run from repo root.
Examples:
  python3 ./scripts/stress-fuzz-artifacts.py
  python3 ./scripts/stress-fuzz-artifacts.py --artifact implementations/rust/fuzz/artifacts/token_parse/oom-...
  python3 ./scripts/stress-fuzz-artifacts.py --only-interesting --impl all
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_ARTIFACT_DIRS = (
    ROOT / "implementations" / "rust" / "fuzz" / "artifacts" / "compile",
    ROOT / "implementations" / "rust" / "fuzz" / "artifacts" / "token_parse",
)

TS_CMD = [
    "node",
    str(ROOT / "implementations" / "typescript" / "packages" / "cli" / "dist" / "main.js"),
    "inspect",
]
PY_CMD = [str(ROOT / "implementations" / "python" / "bin" / "aeon-python"), "inspect"]
RUST_CMD = [str(ROOT / "implementations" / "rust" / "target" / "debug" / "aeon-rust"), "inspect"]


@dataclass(frozen=True)
class InspectSummary:
    exit_code: int
    accepted: bool
    diagnostic_codes: tuple[str, ...]
    raw_output: str


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run Rust fuzz artifacts through Rust, TypeScript, and Python inspect flows."
    )
    parser.add_argument(
        "--impl",
        choices=["typescript", "python", "rust", "all"],
        default="all",
        help="Which implementation(s) to run.",
    )
    parser.add_argument(
        "--artifact",
        action="append",
        default=[],
        help="Artifact file to test. Repeat to add multiple explicit files.",
    )
    parser.add_argument(
        "--artifact-dir",
        action="append",
        default=[],
        help="Directory of artifacts to scan. Repeat to add multiple directories.",
    )
    parser.add_argument(
        "--only-interesting",
        action="store_true",
        help="Only print files where implementations disagree on acceptance or primary diagnostic code.",
    )
    parser.add_argument(
        "--brief",
        action="store_true",
        help="Print concise summaries only.",
    )
    parser.add_argument(
        "--timeout",
        type=float,
        default=10.0,
        help="Per-implementation timeout in seconds (default: 10.0).",
    )
    return parser.parse_args()


def implementation_command(name: str) -> list[str]:
    if name == "typescript":
        return TS_CMD
    if name == "python":
        return PY_CMD
    if name == "rust":
        return RUST_CMD
    raise ValueError(f"unknown implementation: {name}")


def implementation_available(name: str) -> bool:
    command = implementation_command(name)
    target = Path(command[1]) if name == "typescript" else Path(command[0])
    return target.is_file() and (name == "typescript" or bool(target.stat().st_mode & 0o111))


def collect_artifacts(args: argparse.Namespace) -> list[Path]:
    artifacts: set[Path] = set()
    for artifact in args.artifact:
        path = Path(artifact)
        if path.is_file():
            artifacts.add(path.resolve())

    if args.artifact_dir:
        dirs = [Path(raw) for raw in args.artifact_dir]
    elif args.artifact:
        dirs = []
    else:
        dirs = list(DEFAULT_ARTIFACT_DIRS)
    for directory in dirs:
        if not directory.is_dir():
            continue
        for path in sorted(directory.iterdir()):
            if path.is_file():
                artifacts.add(path.resolve())

    return sorted(artifacts)


def run_inspect(impl: str, artifact: Path, timeout: float) -> InspectSummary:
    try:
        completed = subprocess.run(
            [*implementation_command(impl), str(artifact), "--json"],
            cwd=str(ROOT),
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired as error:
        output = (error.stdout or "") + (error.stderr or "")
        return InspectSummary(124, False, ("TIMEOUT",), output)
    output = (completed.stdout or "") + (completed.stderr or "")
    if completed.returncode != 0:
        try:
            parsed = json.loads(completed.stdout)
        except json.JSONDecodeError:
            return InspectSummary(completed.returncode, False, tuple(), output)
        errors = parsed.get("errors")
        codes = tuple(
            error.get("code", "")
            for error in errors
            if isinstance(error, dict) and isinstance(error.get("code"), str)
        ) if isinstance(errors, list) else tuple()
        return InspectSummary(completed.returncode, False, codes, output)

    try:
        parsed = json.loads(completed.stdout)
    except json.JSONDecodeError:
        return InspectSummary(completed.returncode, False, tuple(), output)

    errors = parsed.get("errors")
    codes = tuple(
        error.get("code", "")
        for error in errors
        if isinstance(error, dict) and isinstance(error.get("code"), str)
    ) if isinstance(errors, list) else tuple()
    accepted = isinstance(errors, list) and not errors
    return InspectSummary(completed.returncode, accepted, codes, output)


def is_interesting(results: dict[str, InspectSummary]) -> bool:
    accepted = {summary.accepted for summary in results.values()}
    if len(accepted) > 1:
        return True
    primary_codes = {
        summary.diagnostic_codes[0] if summary.diagnostic_codes else ""
        for summary in results.values()
    }
    return len(primary_codes) > 1


def render_summary(artifact: Path, results: dict[str, InspectSummary], brief: bool) -> str:
    lines = [str(artifact.relative_to(ROOT))]
    for impl, summary in results.items():
        first_code = summary.diagnostic_codes[0] if summary.diagnostic_codes else "-"
        lines.append(
            f"  {impl}: exit={summary.exit_code} accepted={'yes' if summary.accepted else 'no'} first_code={first_code}"
        )
        if not brief and summary.raw_output.strip():
            snippet = "\n".join(summary.raw_output.strip().splitlines()[:8])
            for line in snippet.splitlines():
                lines.append(f"    {line}")
    return "\n".join(lines)


def main() -> int:
    args = parse_args()
    implementations = ["typescript", "python", "rust"] if args.impl == "all" else [args.impl]
    available = [impl for impl in implementations if implementation_available(impl)]

    if len(available) < 1:
        print("No requested implementation binaries are available.", file=sys.stderr)
        return 2

    artifacts = collect_artifacts(args)
    if not artifacts:
        print("No artifact files found.", file=sys.stderr)
        return 2

    interesting_count = 0
    for artifact in artifacts:
        results = {impl: run_inspect(impl, artifact, args.timeout) for impl in available}
        interesting = is_interesting(results)
        if args.only_interesting and not interesting:
            continue
        if interesting:
            interesting_count += 1
        print(render_summary(artifact, results, args.brief))
        print()

    if args.only_interesting:
        print(f"Interesting artifacts: {interesting_count}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
