#!/usr/bin/env python3
"""Compare canonical output across AEON implementations over real documents."""

from __future__ import annotations

import argparse
import difflib
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CORPUS = ROOT / "stress-tests" / "canonical-corpus"
PHP_ROOT = ROOT.parent / "aeon-php"


@dataclass(frozen=True)
class Implementation:
    name: str
    command: tuple[str, ...]
    artifact: Path
    build_hint: str
    arguments_after_input: tuple[str, ...] = ()


@dataclass(frozen=True)
class CommandResult:
    code: int
    stdout: str
    stderr: str


FORMAT_IMPLEMENTATIONS = (
    Implementation(
        name="typescript",
        command=(
            "node",
            str(ROOT / "implementations" / "typescript" / "packages" / "cli" / "dist" / "main.js"),
            "fmt",
        ),
        artifact=(
            ROOT / "implementations" / "typescript" / "packages" / "cli" / "dist" / "main.js"
        ),
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

TELEX_IMPLEMENTATIONS = (
    Implementation(
        name="typescript",
        command=(
            "node",
            str(ROOT / "implementations" / "typescript" / "packages" / "cli" / "dist" / "main.js"),
            "inspect",
        ),
        artifact=ROOT / "implementations" / "typescript" / "packages" / "cli" / "dist" / "main.js",
        build_hint="pnpm --dir implementations/typescript build",
        arguments_after_input=("--telex",),
    ),
    Implementation(
        name="php",
        command=(str(PHP_ROOT / "bin" / "aeon-php"), "inspect"),
        artifact=PHP_ROOT / "bin" / "aeon-php",
        build_hint="composer --working-dir ../aeon-php install",
        arguments_after_input=("--telex",),
    ),
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Canonicalize every .aeon document in a corpus with TypeScript, Python, "
            "and Rust, then require byte-identical output. Optionally compare PHP's "
            "canonical Telex stream with TypeScript's."
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
    parser.add_argument(
        "--php",
        action="store_true",
        help="Also require PHP and TypeScript to emit byte-identical canonical Telex.",
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


def validate_implementations(implementations: tuple[Implementation, ...]) -> list[str]:
    problems: list[str] = []
    checked_artifacts: set[Path] = set()
    for implementation in implementations:
        if implementation.artifact in checked_artifacts:
            continue
        checked_artifacts.add(implementation.artifact)
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
        [*implementation.command, str(fixture), *implementation.arguments_after_input],
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


def emit_failure_details(
    implementations: tuple[Implementation, ...],
    results: dict[str, CommandResult],
) -> None:
    for implementation in implementations:
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

    required_implementations = (
        (*FORMAT_IMPLEMENTATIONS, *TELEX_IMPLEMENTATIONS)
        if args.php
        else FORMAT_IMPLEMENTATIONS
    )
    problems = validate_implementations(required_implementations)
    if problems:
        print("The requested canonical implementations are required:", file=sys.stderr)
        for problem in problems:
            print(f"- {problem}", file=sys.stderr)
        return 2

    failures = 0
    for fixture in fixtures:
        label = fixture.relative_to(corpus)
        format_results = {
            implementation.name: run_formatter(implementation, fixture)
            for implementation in FORMAT_IMPLEMENTATIONS
        }
        failed = [name for name, result in format_results.items() if result.code != 0]
        if failed:
            failures += 1
            print(f"FAIL  {label} (formatter rejection: {', '.join(failed)})")
            if not args.brief:
                emit_failure_details(FORMAT_IMPLEMENTATIONS, format_results)
            continue

        baseline_name = FORMAT_IMPLEMENTATIONS[0].name
        baseline = format_results[baseline_name].stdout
        mismatches = [
            implementation.name
            for implementation in FORMAT_IMPLEMENTATIONS[1:]
            if format_results[implementation.name].stdout != baseline
        ]
        if mismatches:
            failures += 1
            print(
                f"FAIL  {label} (canonical output mismatch: "
                f"{baseline_name} != {', '.join(mismatches)})"
            )
            if not args.brief:
                for mismatch in mismatches:
                    print(
                        render_diff(
                            baseline,
                            format_results[mismatch].stdout,
                            baseline_name,
                            mismatch,
                        )
                    )
            continue

        if args.php:
            telex_results = {
                implementation.name: run_formatter(implementation, fixture)
                for implementation in TELEX_IMPLEMENTATIONS
            }
            rejected = [name for name, result in telex_results.items() if result.code != 0]
            if rejected:
                failures += 1
                print(f"FAIL  {label} (Telex rejection: {', '.join(rejected)})")
                if not args.brief:
                    emit_failure_details(TELEX_IMPLEMENTATIONS, telex_results)
                continue

            typescript_telex = telex_results["typescript"].stdout
            php_telex = telex_results["php"].stdout
            if php_telex != typescript_telex:
                failures += 1
                print(f"FAIL  {label} (canonical Telex mismatch: typescript != php)")
                if not args.brief:
                    print(render_diff(typescript_telex, php_telex, "typescript-telex", "php-telex"))
                continue

        print(f"PASS  {label}")

    print()
    print(
        f"Canonical corpus summary: total={len(fixtures)} "
        f"failed={failures} passed={len(fixtures) - failures}"
    )
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
