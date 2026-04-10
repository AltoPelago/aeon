#!/usr/bin/env python3
"""Run curated stress fixtures across TS/Python/Rust CLIs.

Run from repo root.
Example:
  python3 ./scripts/stress-fixtures.py --impl all
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
TS_CMD = ["node", str(ROOT / "implementations" / "typescript" / "packages" / "cli" / "dist" / "main.js"), "inspect"]
PY_CMD = [str(ROOT / "implementations" / "python" / "bin" / "aeon-python"), "inspect"]
RUST_CMD = [str(ROOT / "implementations" / "rust" / "target" / "debug" / "aeon-rust"), "inspect"]


@dataclass(frozen=True)
class FixtureCase:
    name: str
    fixture: str
    expect_exit: int
    must_contain: str | None = None
    extra_args: tuple[str, ...] = ()
    known_red: bool = False
    note: str | None = None
    timeout_seconds: float = 10.0


FIXTURES: tuple[FixtureCase, ...] = (
    FixtureCase("full/full-feature-stress.aeon", "stress-tests/full/full-feature-stress.aeon", 0, '"errors": []', ("--json",)),
    FixtureCase("full/comment-stress-pass.aeon", "stress-tests/full/comment-stress-pass.aeon", 0, '"annotations":', ("--json", "--annotations")),
    FixtureCase("full/scenarios.aeon", "stress-tests/full/scenarios.aeon", 0, '"errors": []', ("--json",)),
    FixtureCase("canonical/node-introducer-singleline.aeon", "stress-tests/canonical/node-introducer-singleline.aeon", 0, '"errors": []', ("--json",)),
    FixtureCase("canonical/node-introducer-multiline.aeon", "stress-tests/canonical/node-introducer-multiline.aeon", 0, '"errors": []', ("--json",)),
    FixtureCase("canonical/node-mixed-separators.aeon", "stress-tests/canonical/node-mixed-separators.aeon", 0, '"errors": []', ("--json",)),
    FixtureCase("canonical/node-trailing-separator.aeon", "stress-tests/canonical/node-trailing-separator.aeon", 0, '"errors": []', ("--json",)),
    FixtureCase("canonical/node-legacy-reject.aeon", "stress-tests/canonical/node-legacy-reject.aeon", 1, "SYNTAX_ERROR", ("--json",)),
    FixtureCase("domain/addressing/escaped-quoted-keys.aeon", "stress-tests/domain/addressing/escaped-quoted-keys.aeon", 0, '"errors": []', ("--json",)),
    FixtureCase(
        "domain/addressing/escaped-decoded-identity.aeon",
        "stress-tests/domain/addressing/escaped-decoded-identity.aeon",
        0,
        '"errors": []',
        ("--json",),
        known_red=True,
        note="Rust still misdecodes escaped reference and selector identities instead of resolving their decoded canonical targets.",
    ),
    FixtureCase(
        "domain/addressing/escaped-decoded-identity-pointers.aeon",
        "stress-tests/domain/addressing/escaped-decoded-identity-pointers.aeon",
        0,
        '"errors": []',
        ("--json",),
    ),
    FixtureCase(
        "domain/addressing/escaped-decoded-identity-rooted.aeon",
        "stress-tests/domain/addressing/escaped-decoded-identity-rooted.aeon",
        0,
        '"errors": []',
        ("--json",),
    ),
    FixtureCase(
        "domain/addressing/escaped-normalization-distinct-keys.aeon",
        "stress-tests/domain/addressing/escaped-normalization-distinct-keys.aeon",
        0,
        '"errors": []',
        ("--json",),
    ),
    FixtureCase("domain/addressing/namespace-quoted-keys.aeon", "stress-tests/domain/addressing/namespace-quoted-keys.aeon", 0, '"errors": []', ("--json",)),
    FixtureCase("domain/addressing/nesting-addressing.aeon", "stress-tests/domain/addressing/nesting-addressing.aeon", 0, '"errors": []', ("--json",)),
    FixtureCase("domain/comments/comment-stress-slash-channels.aeon", "stress-tests/domain/comments/comment-stress-slash-channels.aeon", 0, '"errors": []', ("--json", "--annotations")),
    FixtureCase(
        "domain/literals/heterogeneous-inline-nesting.aeon",
        "stress-tests/domain/literals/heterogeneous-inline-nesting.aeon",
        0,
        '"errors": []',
        ("--json", "--datatype-policy", "allow_custom"),
    ),
    FixtureCase("domain/literals/inline-array-literals-pass.aeon", "stress-tests/domain/literals/inline-array-literals-pass.aeon", 0, '"errors": []', ("--json",)),
    FixtureCase("domain/literals/leading-dot-decimals.aeon", "stress-tests/domain/literals/leading-dot-decimals.aeon", 0, '"errors": []', ("--json",)),
    FixtureCase("domain/literals/trimticks-mixed-whitespace.aeon", "stress-tests/domain/literals/trimticks-mixed-whitespace.aeon", 0, '"errors": []', ("--json",)),
    FixtureCase("domain/literals/unicode-escape-pair.aeon", "stress-tests/domain/literals/unicode-escape-pair.aeon", 0, '"errors": []', ("--json",)),
    FixtureCase(
        "domain/literals/unicode-unpaired-surrogates.aeon",
        "stress-tests/domain/literals/unicode-unpaired-surrogates.aeon",
        1,
        "INVALID_ESCAPE",
        ("--json",),
        known_red=True,
        note="TypeScript now rejects unpaired surrogate escapes with INVALID_ESCAPE, while Python and Rust still surface them as generic syntax errors.",
    ),
    FixtureCase("edge/comment-stress-unterminated.aeon", "stress-tests/edge/comment-stress-unterminated.aeon", 1, "UNTERMINATED_BLOCK_COMMENT", ("--json", "--annotations")),
    FixtureCase(
        "edge/escaped-decoded-identity-duplicate.aeon",
        "stress-tests/edge/escaped-decoded-identity-duplicate.aeon",
        1,
        "DUPLICATE_CANONICAL_PATH",
        ("--json",),
        known_red=True,
        note="Rust still treats escaped-equivalent keys as distinct canonical identities.",
    ),
    FixtureCase(
        "edge/inline-array-separator-boundaries.aeon",
        "stress-tests/edge/inline-array-separator-boundaries.aeon",
        1,
        "INVALID_SEPARATOR_CHAR",
        ("--json",),
        known_red=True,
        note="Rust still fails early with a generic 'Expected key' syntax error instead of surfacing the separator-depth and invalid-separator diagnostics that TypeScript and Python report.",
    ),
    FixtureCase(
        "edge/string-literal-newline.aeon",
        "stress-tests/edge/string-literal-newline.aeon",
        1,
        "UNTERMINATED_STRING",
        ("--json",),
        known_red=True,
        note="Rust still accepts literal newlines inside quoted strings that TypeScript and Python reject as unterminated.",
    ),
    FixtureCase(
        "edge/unicode-braced-incomplete.aeon",
        "stress-tests/edge/unicode-braced-incomplete.aeon",
        1,
        "INVALID_ESCAPE",
        ("--json",),
        known_red=True,
        note="Python and Rust still surface incomplete braced Unicode escapes as generic syntax errors instead of the narrower INVALID_ESCAPE contract.",
    ),
    FixtureCase(
        "edge/unicode-braced-missing-close.aeon",
        "stress-tests/edge/unicode-braced-missing-close.aeon",
        1,
        "INVALID_ESCAPE",
        ("--json",),
        known_red=True,
        note="Python and Rust still surface unterminated braced Unicode escapes as generic syntax errors instead of the narrower INVALID_ESCAPE contract.",
    ),
    FixtureCase(
        "edge/unicode-braced-nonhex.aeon",
        "stress-tests/edge/unicode-braced-nonhex.aeon",
        1,
        "INVALID_ESCAPE",
        ("--json",),
        known_red=True,
        note="Python and Rust still surface non-hex braced Unicode escapes as generic syntax errors instead of the narrower INVALID_ESCAPE contract.",
    ),
    FixtureCase(
        "edge/unicode-invalid-escape.aeon",
        "stress-tests/edge/unicode-invalid-escape.aeon",
        1,
        "INVALID_ESCAPE",
        ("--json",),
        known_red=True,
        note="Rust still accepts malformed escapes and Python does not yet align on the dedicated INVALID_ESCAPE diagnostic contract.",
    ),
    FixtureCase(
        "edge/unicode-out-of-range-escape.aeon",
        "stress-tests/edge/unicode-out-of-range-escape.aeon",
        1,
        "INVALID_ESCAPE",
        ("--json",),
        known_red=True,
        note="Python still throws on out-of-range braced escapes and Rust still accepts them as ordinary text.",
    ),
    FixtureCase("edge/unicode-word-joiner-structural.aeon", "stress-tests/edge/unicode-word-joiner-structural.aeon", 1, None, ("--json",)),
    FixtureCase("edge/unicode-line-separator-structural.aeon", "stress-tests/edge/unicode-line-separator-structural.aeon", 1, None, ("--json",)),
    FixtureCase("edge/trailing-garbage-after-number.aeon", "stress-tests/edge/trailing-garbage-after-number.aeon", 1, "SYNTAX_ERROR", ("--json",)),
    FixtureCase("edge/trailing-garbage-after-string.aeon", "stress-tests/edge/trailing-garbage-after-string.aeon", 1, "SYNTAX_ERROR", ("--json",)),
    FixtureCase("edge/trailing-garbage-after-node.aeon", "stress-tests/edge/trailing-garbage-after-node.aeon", 1, "SYNTAX_ERROR", ("--json",)),
    FixtureCase("edge/trailing-garbage-after-object.aeon", "stress-tests/edge/trailing-garbage-after-object.aeon", 1, "SYNTAX_ERROR", ("--json",)),
    FixtureCase("edge/trailing-garbage-after-list.aeon", "stress-tests/edge/trailing-garbage-after-list.aeon", 1, "SYNTAX_ERROR", ("--json",)),
    FixtureCase("edge/trailing-garbage-after-reference.aeon", "stress-tests/edge/trailing-garbage-after-reference.aeon", 1, "SYNTAX_ERROR", ("--json",)),
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run the shared AEON stress fixture matrix.")
    parser.add_argument("--impl", choices=["typescript", "python", "rust", "all"], default="all")
    parser.add_argument(
        "--exclude-known-red",
        action="store_true",
        help="Skip known-red fixtures from the run.",
    )
    parser.add_argument(
        "--fail-known-red",
        action="store_true",
        help="Treat known-red fixtures as ordinary failures.",
    )
    parser.add_argument(
        "--brief",
        action="store_true",
        help="On failure, print only the fixture name and expectation, not command output.",
    )
    parser.add_argument(
        "--no-color",
        action="store_true",
        help="Disable ANSI color output.",
    )
    parser.add_argument(
        "--timeout",
        type=float,
        default=None,
        help="Override the per-fixture timeout in seconds.",
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
    return target.is_file() and (name == "typescript" or target.stat().st_mode & 0o111 != 0)


def colorize(enabled: bool, text: str, code: str) -> str:
    return f"\033[{code}m{text}\033[0m" if enabled else text


def status_label(enabled: bool, label: str) -> str:
    colors = {
        "PASS": "32",
        "FAIL": "31",
        "SKIP": "33",
        "KNOWN": "36",
    }
    return colorize(enabled, label, colors.get(label, "0"))


def run_case(impl: str, case: FixtureCase, timeout_override: float | None) -> tuple[bool, str, int]:
    fixture = ROOT / case.fixture
    timeout = timeout_override if timeout_override is not None else case.timeout_seconds
    try:
        completed = subprocess.run(
            [*implementation_command(impl), str(fixture), *case.extra_args],
            cwd=str(ROOT),
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired as error:
        output = (error.stdout or "") + (error.stderr or "")
        return False, f"TIMEOUT after {timeout:.1f}s\n{output}".rstrip(), 124
    output = (completed.stdout or "") + (completed.stderr or "")
    ok = completed.returncode == case.expect_exit
    if ok and case.must_contain is not None and case.must_contain not in output:
        ok = False
    return ok, output, completed.returncode


def main() -> int:
    args = parse_args()
    implementations = ["typescript", "python", "rust"] if args.impl == "all" else [args.impl]
    color = not args.no_color and sys.stdout.isatty()
    total = 0
    failed = 0
    skipped = 0
    known = 0

    cases = tuple(case for case in FIXTURES if not (args.exclude_known_red and case.known_red))

    for impl in implementations:
        if not implementation_available(impl):
            skipped += len(cases)
            print(f"{status_label(color, 'SKIP')}  [{impl}] implementation binary/build is not available")
            continue

        for case in cases:
            total += 1
            ok, output, code = run_case(impl, case, args.timeout)
            if ok:
                print(f"{status_label(color, 'PASS')}  [{impl}] {case.name} (exit={code})")
                continue

            if case.known_red and not args.fail_known_red:
                known += 1
                print(f"{status_label(color, 'KNOWN')} [{impl}] {case.name} (exit={code} expected={case.expect_exit})")
                if case.note:
                    print(f"  note: {case.note}")
                if not args.brief:
                    print("  output:")
                    for line in output.strip().splitlines()[:60]:
                        print(f"    {line}")
                continue

            failed += 1
            print(f"{status_label(color, 'FAIL')}  [{impl}] {case.name} (exit={code} expected={case.expect_exit})")
            if case.note:
                print(f"  note: {case.note}")
            if case.must_contain:
                print(f"  expected to contain: {case.must_contain}")
            if not args.brief:
                print("  output:")
                for line in output.strip().splitlines()[:60]:
                    print(f"    {line}")

    print()
    print(
        f"Stress fixture summary: total={total} failed={failed} known={known} "
        f"skipped={skipped} passed={total - failed - known - skipped}"
    )
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
