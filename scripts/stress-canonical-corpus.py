#!/usr/bin/env python3
"""Compare canonical output across all AEON implementations over real documents."""

from __future__ import annotations

import argparse
import difflib
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CORPUS = ROOT / "stress-tests" / "canonical-corpus"


@dataclass(frozen=True)
class Implementation:
    name: str
    command: tuple[str, ...]
    artifact: Path
    build_hint: str


@dataclass(frozen=True)
class CommandResult:
    code: int
    stdout: str
    stderr: str


IMPLEMENTATIONS = (
    Implementation(
        name="typescript",
        command=(
            "node",
            str(ROOT / "implementations" / "typescript" / "packages" / "cli" / "dist" / "main.js"),
            "fmt",
        ),
        artifact=ROOT / "implementations" / "typescript" / "packages" / "cli" / "dist" / "main.js",
        build_hint="pnpm --dir implementations/typescript build",
    ),
    Implementation(
        name="python",
        command=(str(ROOT / "implementations" / "python" / "bin" / "aeon-python"), "fmt"),
        artifact=ROOT / "implementations" / "python" / "bin" / "aeon-python",
        build_hint="the Python launcher is tracked and should not require a build",
    ),
    Implementation(
        name="rust",
        command=(str(ROOT / "implementations" / "rust" / "target" / "debug" / "aeon-rust"), "fmt"),
        artifact=ROOT / "implementations" / "rust" / "target" / "debug" / "aeon-rust",
        build_hint="cargo build --manifest-path implementations/rust/Cargo.toml -p aeon-cli",
    ),
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Canonicalize every .aeon document in a corpus with TypeScript, Python, "
            "and Rust, then require byte-identical output."
        ),
    )
    parser.add_argument(
        "--corpus",
        type=Path,
        default=DEFAULT_CORPUS,
        help=f"Corpus directory to scan recursively (default: {DEFAULT_CORPUS.relative_to(ROOT)}).",
    )
    parser.add_argument(
        "--brief",
        action="store_true",
        help="Print one line per failure without stderr or canonical diffs.",
    )
    return parser.parse_args()


def resolve_corpus(path: Path) -> Path:
    return path.resolve() if path.is_absolute() else (Path.cwd() / path).resolve()


def discover_fixtures(corpus: Path) -> list[Path]:
    if not corpus.is_dir():
        raise ValueError(f"Canonical corpus directory does not exist: {corpus}")
    fixtures = sorted(path for path in corpus.rglob("*.aeon") if path.is_file())
    if not fixtures:
        raise ValueError(f"Canonical corpus contains no .aeon files: {corpus}")
    return fixtures


def validate_implementations() -> list[str]:
    problems: list[str] = []
    for implementation in IMPLEMENTATIONS:
        if not implementation.artifact.is_file():
            problems.append(
                f"Missing {implementation.name} formatter at {implementation.artifact}\n"
                f"  Build hint: {implementation.build_hint}"
            )
        elif implementation.name != "typescript" and not implementation.artifact.stat().st_mode & 0o111:
            problems.append(f"Formatter is not executable: {implementation.artifact}")
    return problems


def run_formatter(implementation: Implementation, fixture: Path) -> CommandResult:
    completed = subprocess.run(
        [*implementation.command, str(fixture)],
        cwd=ROOT,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    return CommandResult(
        code=completed.returncode,
        stdout=completed.stdout,
        stderr=completed.stderr,
    )


def render_diff(left: str, right: str, left_name: str, right_name: str) -> str:
    return "\n".join(
        difflib.unified_diff(
            left.splitlines(),
            right.splitlines(),
            fromfile=left_name,
            tofile=right_name,
            lineterm="",
        )
    )


def emit_failure_details(results: dict[str, CommandResult]) -> None:
    for implementation in IMPLEMENTATIONS:
        result = results[implementation.name]
        print(f"  {implementation.name}: exit={result.code}")
        if result.stdout.strip():
            for line in result.stdout.strip().splitlines()[:20]:
                print(f"    stdout: {line}")
        if result.stderr.strip():
            for line in result.stderr.strip().splitlines()[:20]:
                print(f"    stderr: {line}")


def main() -> int:
    args = parse_args()
    corpus = resolve_corpus(args.corpus)
    try:
        fixtures = discover_fixtures(corpus)
    except ValueError as error:
        print(f"Error: {error}", file=sys.stderr)
        return 2

    problems = validate_implementations()
    if problems:
        print("All three canonical formatter implementations are required:", file=sys.stderr)
        for problem in problems:
            print(f"- {problem}", file=sys.stderr)
        return 2

    failures = 0
    for fixture in fixtures:
        label = fixture.relative_to(corpus)
        results = {
            implementation.name: run_formatter(implementation, fixture)
            for implementation in IMPLEMENTATIONS
        }
        failed = [name for name, result in results.items() if result.code != 0]
        if failed:
            failures += 1
            print(f"FAIL  {label} (formatter rejection: {', '.join(failed)})")
            if not args.brief:
                emit_failure_details(results)
            continue

        baseline_name = IMPLEMENTATIONS[0].name
        baseline = results[baseline_name].stdout
        mismatches = [
            implementation.name
            for implementation in IMPLEMENTATIONS[1:]
            if results[implementation.name].stdout != baseline
        ]
        if not mismatches:
            print(f"PASS  {label}")
            continue

        failures += 1
        print(
            f"FAIL  {label} (canonical output mismatch: "
            f"{baseline_name} != {', '.join(mismatches)})"
        )
        if not args.brief:
            for mismatch in mismatches:
                print(render_diff(baseline, results[mismatch].stdout, baseline_name, mismatch))

    print()
    print(
        f"Canonical corpus summary: total={len(fixtures)} "
        f"failed={failures} passed={len(fixtures) - failures}"
    )
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
