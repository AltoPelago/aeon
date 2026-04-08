#!/usr/bin/env python3
"""Check canonical snippet parity across implementations.

Run from repo root.
Example:
  python3 ./scripts/stress-canonical-snippets.py --mode all --brief
"""

from __future__ import annotations

import argparse
import difflib
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
TS_CMD = ["node", str(ROOT / "implementations" / "typescript" / "packages" / "cli" / "dist" / "main.js"), "fmt"]
PY_CMD = [str(ROOT / "implementations" / "python" / "bin" / "aeon-python"), "fmt"]
RUST_CMD = [str(ROOT / "implementations" / "rust" / "target" / "debug" / "aeon-rust"), "fmt"]

POSITIVE_CASES_BY_MODE = {
    "transport": ROOT / "stress-tests" / "snippets" / "positive-transport.aeon-cases",
    "strict": ROOT / "stress-tests" / "snippets" / "positive-strict.aeon-cases",
    "custom": ROOT / "stress-tests" / "snippets" / "positive-custom.aeon-cases",
}

@dataclass(frozen=True)
class CommandResult:
    code: int
    stdout: str
    stderr: str


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Compare canonical formatting behavior across snippet corpora.",
    )
    parser.add_argument(
        "--mode",
        choices=["transport", "strict", "custom", "all"],
        default="all",
        help="Snippet mode(s) to check (default: all).",
    )
    parser.add_argument(
        "--brief",
        action="store_true",
        help="On failure, print concise mismatch info only.",
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


def split_cases(raw: str) -> list[str]:
    cases: list[str] = []
    current: list[str] = []
    for line in raw.splitlines():
        if line.strip() == "---":
            snippet = "\n".join(current).strip()
            if snippet:
                cases.append(snippet + "\n")
            current = []
            continue
        current.append(line)
    snippet = "\n".join(current).strip()
    if snippet:
        cases.append(snippet + "\n")
    return cases


def apply_mode(snippet: str, mode: str) -> str:
    stripped = snippet.lstrip()
    if stripped.startswith("aeon:mode") or stripped.startswith("aeon:header"):
        return snippet
    return f'aeon:mode = "{mode}"\n{snippet}'


def snippet_title(snippet: str, index: int) -> str:
    first = next((line.strip() for line in snippet.splitlines() if line.strip()), "")
    preview = first[:60]
    return f"case {index}: {preview}" if preview else f"case {index}"


def run_fmt(impl: str, snippet: str, index: int, mode: str) -> CommandResult:
    command = implementation_command(impl)
    with tempfile.TemporaryDirectory(prefix="aeon-canonical-snippet-") as tmpdir:
        fixture = Path(tmpdir) / f"snippet-{index}.aeon"
        fixture.write_text(apply_mode(snippet, mode), encoding="utf-8")
        completed = subprocess.run(
            [*command, str(fixture)],
            cwd=str(ROOT),
            capture_output=True,
            text=True,
        )
    return CommandResult(
        code=completed.returncode,
        stdout=completed.stdout,
        stderr=completed.stderr,
    )


def render_diff(left: str, right: str, left_label: str, right_label: str) -> str:
    return "\n".join(
        difflib.unified_diff(
            left.splitlines(),
            right.splitlines(),
            fromfile=left_label,
            tofile=right_label,
            lineterm="",
        )
    )


def colorize(enabled: bool, text: str, code: str) -> str:
    return f"\033[{code}m{text}\033[0m" if enabled else text


def status_label(enabled: bool, label: str) -> str:
    colors = {
        "PASS": "32",
        "FAIL": "31",
        "SKIP": "33",
    }
    return colorize(enabled, label, colors.get(label, "0"))


def mode_values(selected: str) -> list[str]:
    return ["transport", "strict", "custom"] if selected == "all" else [selected]


def main() -> int:
    args = parse_args()
    color = not args.no_color and sys.stdout.isatty()
    implementations = [name for name in ("typescript", "python", "rust") if implementation_available(name)]
    if len(implementations) < 2:
        print("Need at least two available implementations to compare canonical behavior.", file=sys.stderr)
        return 2

    failures = 0
    total = 0

    for mode in mode_values(args.mode):
        cases = split_cases(POSITIVE_CASES_BY_MODE[mode].read_text(encoding="utf-8"))
        for index, snippet in enumerate(cases, start=1):
            total += 1
            title = snippet_title(snippet, index)
            results = {impl: run_fmt(impl, snippet, index, mode) for impl in implementations}

            succeeded = [impl for impl, result in results.items() if result.code == 0]
            if len(succeeded) != len(implementations):
                failures += 1
                print(f"{status_label(color, 'FAIL')}  [{mode}] {title}")
                if not args.brief:
                    for impl in implementations:
                        result = results[impl]
                        print(f"  {impl}: exit={result.code}")
                        if result.stderr.strip():
                            for line in result.stderr.strip().splitlines()[:20]:
                                print(f"    {line}")
                continue

            baseline_impl = implementations[0]
            baseline = results[baseline_impl].stdout
            mismatch = None
            for impl in implementations[1:]:
                if results[impl].stdout != baseline:
                    mismatch = impl
                    break

            if mismatch is None:
                print(f"{status_label(color, 'PASS')}  [{mode}] {title}")
                continue

            failures += 1
            print(f"{status_label(color, 'FAIL')}  [{mode}] {title}")
            if not args.brief:
                print(render_diff(baseline, results[mismatch].stdout, baseline_impl, mismatch))

    print()
    print(
        f"Canonical snippet summary: total={total} failed={failures} passed={total - failures}"
    )
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
