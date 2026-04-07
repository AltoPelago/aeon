#!/usr/bin/env python3
"""Check diagnostic parity on curated syntax/error snippets.

Run from repo root.
Example:
  python3 ./scripts/stress-diagnostic-snippets.py --brief
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
TS_CMD = ["node", str(ROOT / "implementations" / "typescript" / "packages" / "cli" / "dist" / "main.js"), "inspect"]
PY_CMD = [str(ROOT / "implementations" / "python" / "bin" / "aeon-python"), "inspect"]
RUST_CMD = [str(ROOT / "implementations" / "rust" / "target" / "debug" / "aeon-rust"), "inspect"]
DEFAULT_CASES = ROOT / "stress-tests" / "snippets" / "diagnostic-parity.json"


@dataclass(frozen=True)
class CommandResult:
    code: int
    stdout: str
    stderr: str


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Compare diagnostic behavior for a curated syntax corpus.",
    )
    parser.add_argument(
        "--file",
        default=str(DEFAULT_CASES),
        help="Path to the diagnostic parity corpus JSON file.",
    )
    parser.add_argument(
        "--brief",
        action="store_true",
        help="Print concise mismatch summaries only.",
    )
    parser.add_argument(
        "--no-color",
        action="store_true",
        help="Disable ANSI color output.",
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
    binary = Path(command[1]) if name == "typescript" else Path(command[0])
    return binary.is_file() and (name == "typescript" or binary.stat().st_mode & 0o111 != 0)


def colorize(enabled: bool, text: str, code: str) -> str:
    return f"\033[{code}m{text}\033[0m" if enabled else text


def status_label(enabled: bool, label: str) -> str:
    colors = {
        "PASS": "32",
        "FAIL": "31",
        "SKIP": "33",
    }
    return colorize(enabled, label, colors.get(label, "0"))


def run_inspect(impl: str, source: str, index: int) -> CommandResult:
    command = implementation_command(impl)
    with tempfile.TemporaryDirectory(prefix="aeon-diagnostic-snippet-") as tmpdir:
        fixture = Path(tmpdir) / f"snippet-{index}.aeon"
        fixture.write_text(source, encoding="utf-8")
        completed = subprocess.run(
            [*command, str(fixture), "--json"],
            cwd=str(ROOT),
            capture_output=True,
            text=True,
        )
    return CommandResult(
        code=completed.returncode,
        stdout=completed.stdout,
        stderr=completed.stderr,
    )


def extract_first_error(result: CommandResult) -> dict[str, object] | None:
    try:
        parsed = json.loads(result.stdout)
    except json.JSONDecodeError:
        return None
    errors = parsed.get("errors")
    if not isinstance(errors, list) or not errors:
        return None
    first = errors[0]
    if not isinstance(first, dict):
        return None
    return {
        "code": first.get("code"),
        "message": first.get("message"),
        "path": first.get("path"),
        "span": first.get("span"),
    }


def format_json(value: object) -> str:
    return json.dumps(value, indent=2, sort_keys=True)


def load_cases(path: Path) -> list[dict[str, object]]:
    loaded = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(loaded, list):
        raise ValueError(f"diagnostic corpus must be a JSON array: {path}")
    return loaded


def main() -> int:
    args = parse_args()
    color = not args.no_color and sys.stdout.isatty()
    cases = load_cases(Path(args.file).resolve())
    implementations = [name for name in ("typescript", "python", "rust") if implementation_available(name)]
    if len(implementations) < 2:
        print("Need at least two available implementations to compare diagnostic behavior.", file=sys.stderr)
        return 2

    failures = 0
    total = 0

    for index, case in enumerate(cases, start=1):
        name = str(case.get("name") or f"case {index}")
        source = case.get("source")
        expected = case.get("expected")
        if not isinstance(source, str):
            print(f"{status_label(color, 'FAIL')}  {name}")
            print("  invalid case: missing string `source`")
            failures += 1
            total += 1
            continue

        total += 1
        results = {impl: run_inspect(impl, source, index) for impl in implementations}
        normalized = {impl: extract_first_error(result) for impl, result in results.items()}

        if any(result is None for result in normalized.values()):
            failures += 1
            print(f"{status_label(color, 'FAIL')}  {name}")
            if not args.brief:
                for impl in implementations:
                    print(f"  {impl}:")
                    print(f"    exit={results[impl].code}")
                    output = (results[impl].stdout or results[impl].stderr).strip()
                    for line in output.splitlines()[:20]:
                        print(f"    {line}")
            continue

        baseline_impl = implementations[0]
        baseline = normalized[baseline_impl]
        mismatch_impl = next((impl for impl in implementations[1:] if normalized[impl] != baseline), None)

        if mismatch_impl is not None:
            failures += 1
            print(f"{status_label(color, 'FAIL')}  {name}")
            if not args.brief:
                print(f"  {baseline_impl}:")
                print(format_json(baseline))
                print(f"  {mismatch_impl}:")
                print(format_json(normalized[mismatch_impl]))
            continue

        if expected is not None and baseline != expected:
            failures += 1
            print(f"{status_label(color, 'FAIL')}  {name}")
            if not args.brief:
                print("  expected:")
                print(format_json(expected))
                print(f"  actual ({baseline_impl} baseline):")
                print(format_json(baseline))
            continue

        print(f"{status_label(color, 'PASS')}  {name}")

    print()
    print(
        f"Diagnostic snippet summary: total={total} failed={failures} passed={total - failures}"
    )
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
