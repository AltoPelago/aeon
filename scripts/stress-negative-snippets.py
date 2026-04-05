#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
TS_CMD = ["node", str(ROOT / "implementations" / "typescript" / "packages" / "cli" / "dist" / "main.js"), "inspect"]
PY_CMD = [str(ROOT / "implementations" / "python" / "bin" / "aeon-python"), "inspect"]
RUST_CMD = [str(ROOT / "implementations" / "rust" / "target" / "debug" / "aeon-rust"), "inspect"]
DEFAULT_CASES_BY_MODE = {
    "transport": ROOT / "stress-tests" / "snippets" / "negative-transport.aeon-cases",
    "strict": ROOT / "stress-tests" / "snippets" / "negative-strict.aeon-cases",
    "custom": ROOT / "stress-tests" / "snippets" / "negative-custom.aeon-cases",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run negative AEON snippet cases split by --- delimiters.",
    )
    parser.add_argument(
        "--impl",
        choices=["typescript", "python", "rust", "all"],
        default="all",
        help="Implementation to test (default: all).",
    )
    parser.add_argument(
        "--file",
        default=None,
        help="Snippet corpus file to read (default depends on --mode).",
    )
    parser.add_argument(
        "--mode",
        choices=["transport", "strict", "custom"],
        default="transport",
        help="Behavior mode header to inject when a snippet does not declare one (default: transport).",
    )
    parser.add_argument(
        "--brief",
        action="store_true",
        help="On failure, print only the snippet and omit implementation output.",
    )
    parser.add_argument(
        "--failures-only",
        action="store_true",
        help="Suppress PASS lines and print only FAIL, SKIP, and the final summary.",
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
    if name == "typescript":
        return Path(TS_CMD[1]).is_file()
    if name == "python":
        return Path(PY_CMD[0]).is_file() and Path(PY_CMD[0]).stat().st_mode & 0o111 != 0
    if name == "rust":
        return Path(RUST_CMD[0]).is_file() and Path(RUST_CMD[0]).stat().st_mode & 0o111 != 0
    return False


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


def snippet_title(snippet: str, index: int) -> str:
    first = next((line.strip() for line in snippet.splitlines() if line.strip()), "")
    preview = first[:60]
    return f"case {index}: {preview}" if preview else f"case {index}"


def colorize(enabled: bool, text: str, code: str) -> str:
    return f"\033[{code}m{text}\033[0m" if enabled else text


def status_label(enabled: bool, label: str) -> str:
    colors = {
        "PASS": "32",
        "FAIL": "31",
        "SKIP": "33",
    }
    return colorize(enabled, label, colors.get(label, "0"))


def apply_mode(snippet: str, mode: str) -> str:
    stripped = snippet.lstrip()
    if stripped.startswith("aeon:mode") or stripped.startswith("aeon:header"):
        return snippet
    return f'aeon:mode = "{mode}"\n{snippet}'


def run_case(impl: str, snippet: str, index: int, mode: str) -> tuple[bool, str]:
    command = implementation_command(impl)
    with tempfile.TemporaryDirectory(prefix="aeon-negative-snippet-") as tmpdir:
        fixture = Path(tmpdir) / f"snippet-{index}.aeon"
        fixture.write_text(apply_mode(snippet, mode), encoding="utf-8")
        completed = subprocess.run(
            [*command, str(fixture), "--json"],
            cwd=str(ROOT),
            capture_output=True,
            text=True,
        )

    output = (completed.stdout or "") + (completed.stderr or "")
    if completed.returncode != 0:
        return True, output

    try:
        parsed = json.loads(completed.stdout)
    except json.JSONDecodeError:
        return False, output

    errors = parsed.get("errors")
    if isinstance(errors, list) and errors:
        return True, output
    return False, output


def main() -> int:
    args = parse_args()
    corpus_path = Path(args.file).resolve() if args.file else DEFAULT_CASES_BY_MODE[args.mode]
    raw = corpus_path.read_text(encoding="utf-8")
    cases = split_cases(raw)
    if not cases:
        print(f"No cases found in {corpus_path}", file=sys.stderr)
        return 2

    implementations = ["typescript", "python", "rust"] if args.impl == "all" else [args.impl]
    color = not args.no_color and sys.stdout.isatty()
    failures = 0
    total = 0
    skipped = 0

    for impl in implementations:
        if not implementation_available(impl):
            skipped += 1
            print(f"{status_label(color, 'SKIP')}  [{impl}] implementation binary/build is not available")
            continue

        for index, snippet in enumerate(cases, start=1):
            total += 1
            ok, output = run_case(impl, snippet, index, args.mode)
            title = snippet_title(snippet, index)
            if ok:
                if not args.failures_only:
                    print(f"{status_label(color, 'PASS')}  [{impl}] {title}")
            else:
                failures += 1
                print(f"{status_label(color, 'FAIL')}  [{impl}] {title}")
                print("  snippet:")
                for line in snippet.rstrip("\n").splitlines():
                    print(f"    {line}")
                if not args.brief:
                    print("  output:")
                    for line in output.strip().splitlines()[:80]:
                        print(f"    {line}")

    print()
    print(
        f"Negative snippet summary: mode={args.mode} total={total} failed={failures} skipped={skipped} "
        f"passed={total - failures}"
    )
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
