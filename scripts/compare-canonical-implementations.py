#!/usr/bin/env python3
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import difflib
import subprocess
import sys


@dataclass(frozen=True)
class CommandResult:
    code: int
    stdout: str
    stderr: str


@dataclass(frozen=True)
class FixtureResult:
    fixture: Path
    typescript: CommandResult
    python: CommandResult


@dataclass(frozen=True)
class SuiteCommand:
    label: str
    command: list[str]
    cwd: Path


def main() -> int:
    repo_root = Path(__file__).resolve().parents[1]
    ts_root = repo_root / "implementations" / "typescript"
    py_root = repo_root / "implementations" / "python"
    ts_sut = ts_root / "packages" / "cli" / "dist" / "main.js"
    py_sut = py_root / "bin" / "aeon-python"

    fixtures = resolve_fixtures(repo_root, sys.argv[1:])
    if not fixtures:
        print("No AEON fixtures found to compare.", file=sys.stderr)
        return 2

    if run_suite_commands(ts_root, py_root) != 0:
        return 1

    if not ts_sut.exists():
        print(f"Missing TypeScript CLI build at {ts_sut}", file=sys.stderr)
        return 2
    if not py_sut.exists():
        print(f"Missing Python CLI launcher at {py_sut}", file=sys.stderr)
        return 2

    print(f"\n== Canonical comparison across {len(fixtures)} fixture(s) ==")
    failures = 0
    ts_success = 0
    py_success = 0
    matched_rejections = 0

    for fixture in fixtures:
        relative = fixture.relative_to(repo_root)
        print(f"\n-- {relative}")
        result = FixtureResult(
            fixture=fixture,
            typescript=run_fmt(["node", str(ts_sut), "fmt", str(fixture)]),
            python=run_fmt([str(py_sut), "fmt", str(fixture)]),
        )

        ts_ok = result.typescript.code == 0
        py_ok = result.python.code == 0
        if ts_ok:
            ts_success += 1
        if py_ok:
            py_success += 1

        if ts_ok and py_ok:
            if result.typescript.stdout != result.python.stdout:
                failures += 1
                print("Canonical mismatch detected.")
                print(render_diff(result.typescript.stdout, result.python.stdout))
                emit_stderr(result)
            else:
                print("Canonical match")
            continue

        if ts_ok != py_ok:
            failures += 1
            print(f"Formatting success mismatch: ts={result.typescript.code} py={result.python.code}")
            emit_outputs(result)
            continue

        matched_rejections += 1
        print("Both implementations rejected this fixture during formatting.")
        emit_stderr(result)

    if failures:
        print(
            f"\nCanonical comparison failed for {failures} fixture(s). "
            f"TypeScript formatted {ts_success}, Python formatted {py_success}, "
            f"matched rejections {matched_rejections}.",
            file=sys.stderr,
        )
        return 1

    print(
        f"\nCanonical comparison passed. "
        f"TypeScript formatted {ts_success}, Python formatted {py_success}, "
        f"matched rejections {matched_rejections}.",
    )
    return 0


def resolve_fixtures(repo_root: Path, args: list[str]) -> list[Path]:
    fixture_args = [
        Path(arg).resolve() if Path(arg).is_absolute() else (Path.cwd() / arg).resolve()
        for arg in args
    ]
    if fixture_args:
        return sorted(dict.fromkeys(expand_fixture_path(path) for path in fixture_args))
    return discover_fixtures(repo_root)


def expand_fixture_path(path: Path) -> Path:
    if path.is_file():
        return path
    raise FileNotFoundError(f"Fixture path does not exist or is not a file: {path}")


def discover_fixtures(repo_root: Path) -> list[Path]:
    fixtures: list[Path] = []
    for root in (repo_root / "examples", repo_root / "stress-tests"):
        if not root.exists():
            continue
        fixtures.extend(sorted(root.rglob("*.aeon")))
    return fixtures


def run_suite_commands(ts_root: Path, py_root: Path) -> int:
    python = sys.executable or "python3"
    commands = [
        SuiteCommand(
            label="TypeScript build",
            command=["pnpm", "build"],
            cwd=ts_root,
        ),
        SuiteCommand(
            label="TypeScript tests",
            command=["pnpm", "test"],
            cwd=ts_root,
        ),
        SuiteCommand(
            label="TypeScript CTS",
            command=["pnpm", "test:cts:all"],
            cwd=ts_root,
        ),
        SuiteCommand(
            label="Python unit tests",
            command=[python, "-m", "unittest", "discover", "-s", "tests", "-p", "test_*.py"],
            cwd=py_root,
        ),
        SuiteCommand(
            label="Python CTS",
            command=[python, "tools/run_cts.py"],
            cwd=py_root,
        ),
    ]
    for suite in commands:
        print(f"\n== {suite.label} ==")
        completed = subprocess.run(suite.command, cwd=suite.cwd)
        if completed.returncode != 0:
            print(f"{suite.label} failed with exit code {completed.returncode}.", file=sys.stderr)
            return completed.returncode
    return 0


def run_fmt(command: list[str]) -> CommandResult:
    completed = subprocess.run(command, capture_output=True, text=True)
    return CommandResult(
        code=completed.returncode,
        stdout=completed.stdout,
        stderr=completed.stderr,
    )


def render_diff(left: str, right: str) -> str:
    return "\n".join(
        difflib.unified_diff(
            left.splitlines(),
            right.splitlines(),
            fromfile="typescript",
            tofile="python",
            lineterm="",
        )
    )


def emit_outputs(result: FixtureResult) -> None:
    if result.typescript.stdout:
        print("TypeScript stdout:")
        print(result.typescript.stdout.rstrip())
    if result.typescript.stderr:
        print("TypeScript stderr:")
        print(result.typescript.stderr.rstrip())
    if result.python.stdout:
        print("Python stdout:")
        print(result.python.stdout.rstrip())
    if result.python.stderr:
        print("Python stderr:")
        print(result.python.stderr.rstrip())


def emit_stderr(result: FixtureResult) -> None:
    if result.typescript.stderr:
        print("TypeScript stderr:")
        print(result.typescript.stderr.rstrip())
    if result.python.stderr:
        print("Python stderr:")
        print(result.python.stderr.rstrip())


if __name__ == "__main__":
    raise SystemExit(main())
