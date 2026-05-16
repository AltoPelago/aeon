#!/usr/bin/env python3
"""Inject structured comments at legal trivia slots and compare implementations.

Run from repo root.
Example:
  python3 ./scripts/stress-comment-injection.py
"""

from __future__ import annotations

import argparse
import difflib
import json
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
TS_FMT_CMD = ["node", str(ROOT / "implementations" / "typescript" / "packages" / "cli" / "dist" / "main.js"), "fmt"]
PY_FMT_CMD = [str(ROOT / "implementations" / "python" / "bin" / "aeon-python"), "fmt"]
RUST_FMT_CMD = [str(ROOT / "implementations" / "rust" / "target" / "debug" / "aeon-rust"), "fmt"]
TS_INSPECT_CMD = ["node", str(ROOT / "implementations" / "typescript" / "packages" / "cli" / "dist" / "main.js"), "inspect"]
PY_INSPECT_CMD = [str(ROOT / "implementations" / "python" / "bin" / "aeon-python"), "inspect"]
RUST_INSPECT_CMD = [str(ROOT / "implementations" / "rust" / "target" / "debug" / "aeon-rust"), "inspect"]

MARKER = "§"
TEMPLATE = """aeon:header§=§{
encoding§:§string§=§"utf-8",
mode§:§string§=§"transport",
profile§:§string§=§"core"
}
name§:§string§=§"alignment playground"
enabled§:§toggle§=§on
settings§:§object§=§{port:number=8080,tags:list<string>=["browser","wasm","aeon"]}
pair:tuple<number,string>=(1,"one")
view§:§node§=§<page(§
§<section§ @{§type§:§string §= §"feature", §level§:§string §=§ "1"§} (
<kicker§("Design Board")>§
<title("Keep the recurring blocks visible in one place."§)>§
)>§
)§>
"""


@dataclass(frozen=True)
class CommandResult:
    code: int
    stdout: str
    stderr: str


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Compact a grammar-rich AEON fixture, inject structured comments at legal trivia slots, and compare implementations.",
    )
    parser.add_argument(
        "--brief",
        action="store_true",
        help="Print concise mismatch output.",
    )
    parser.add_argument(
        "--keep-fixture",
        action="store_true",
        help="Print the generated fixture path and keep it after the run.",
    )
    return parser.parse_args()


def implementation_available(name: str) -> bool:
    if name == "typescript":
        return Path(TS_FMT_CMD[1]).is_file()
    if name == "python":
        return Path(PY_FMT_CMD[0]).is_file() and bool(Path(PY_FMT_CMD[0]).stat().st_mode & 0o111)
    if name == "rust":
        return Path(RUST_FMT_CMD[0]).is_file() and bool(Path(RUST_FMT_CMD[0]).stat().st_mode & 0o111)
    return False


def fmt_command(name: str) -> list[str]:
    if name == "typescript":
        return TS_FMT_CMD
    if name == "python":
        return PY_FMT_CMD
    if name == "rust":
        return RUST_FMT_CMD
    raise ValueError(f"unknown implementation: {name}")


def inspect_command(name: str) -> list[str]:
    if name == "typescript":
        return TS_INSPECT_CMD
    if name == "python":
        return PY_INSPECT_CMD
    if name == "rust":
        return RUST_INSPECT_CMD
    raise ValueError(f"unknown implementation: {name}")


def injected_source() -> str:
    index = 0
    parts: list[str] = []
    for char in TEMPLATE:
        if char != MARKER:
            parts.append(char)
            continue
        index += 1
        parts.append(f"/#ws{index}#/")
    return "".join(parts)


def run_command(command: list[str], fixture: Path) -> CommandResult:
    completed = subprocess.run(
        [*command, str(fixture)],
        cwd=str(ROOT),
        capture_output=True,
        text=True,
    )
    return CommandResult(completed.returncode, completed.stdout, completed.stderr)


def run_inspect(impl: str, fixture: Path) -> tuple[CommandResult, dict[str, Any] | None]:
    completed = subprocess.run(
        [*inspect_command(impl), str(fixture), "--json", "--annotations"],
        cwd=str(ROOT),
        capture_output=True,
        text=True,
    )
    result = CommandResult(completed.returncode, completed.stdout, completed.stderr)
    if result.code != 0:
        return result, None
    try:
        return result, json.loads(result.stdout)
    except json.JSONDecodeError:
        return result, None


def annotation_projection(parsed: dict[str, Any]) -> list[dict[str, Any]]:
    projected = []
    for record in parsed.get("annotations") or []:
        target = record.get("target") or {}
        projected.append(
            {
                "kind": record.get("kind"),
                "form": record.get("form"),
                "raw": record.get("raw"),
                "target": target,
                "placement": record.get("placement") or None,
            }
        )
    return projected


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


def fail(message: str, *, details: str = "") -> int:
    print(f"FAIL: {message}", file=sys.stderr)
    if details:
        print(details, file=sys.stderr)
    return 1


def compare(args: argparse.Namespace, fixture: Path) -> int:
    implementations = [name for name in ("typescript", "python", "rust") if implementation_available(name)]
    if len(implementations) < 2:
        return fail("Need at least two available implementations to compare comment injection.")

    inspect_results = {impl: run_inspect(impl, fixture) for impl in implementations}
    accepted = {
        impl
        for impl, (command_result, parsed) in inspect_results.items()
        if command_result.code == 0 and parsed is not None and parsed.get("errors") == []
    }
    if accepted != set(implementations):
        details = "\n".join(
            f"{impl}: code={command_result.code} parsed={'yes' if parsed is not None else 'no'}"
            for impl, (command_result, parsed) in inspect_results.items()
        )
        if not args.brief:
            details += "\n\n" + "\n\n".join(
                f"{impl} stderr/stdout:\n{(command_result.stderr or command_result.stdout)[:4000]}"
                for impl, (command_result, _parsed) in inspect_results.items()
                if impl not in accepted
            )
        return fail("acceptance mismatch", details=details)

    baseline_impl = implementations[0]
    baseline_annotations = annotation_projection(inspect_results[baseline_impl][1] or {})
    for impl in implementations[1:]:
        current_annotations = annotation_projection(inspect_results[impl][1] or {})
        if current_annotations != baseline_annotations:
            details = f"annotation count: {baseline_impl}={len(baseline_annotations)} {impl}={len(current_annotations)}"
            if not args.brief:
                details += "\n" + render_diff(
                    json.dumps(baseline_annotations, indent=2, sort_keys=True),
                    json.dumps(current_annotations, indent=2, sort_keys=True),
                    f"{baseline_impl}-annotations",
                    f"{impl}-annotations",
                )
            return fail(f"annotation projection mismatch: {baseline_impl} vs {impl}", details=details)

    fmt_results = {impl: run_command(fmt_command(impl), fixture) for impl in implementations}
    baseline_fmt = fmt_results[baseline_impl]
    if baseline_fmt.code != 0:
        return fail(f"{baseline_impl} fmt failed", details=baseline_fmt.stderr)
    for impl in implementations[1:]:
        current = fmt_results[impl]
        if current.code != 0:
            return fail(f"{impl} fmt failed", details=current.stderr)
        if current.stdout != baseline_fmt.stdout:
            details = ""
            if not args.brief:
                details = render_diff(baseline_fmt.stdout, current.stdout, baseline_impl, impl)
            return fail(f"canonical mismatch: {baseline_impl} vs {impl}", details=details)

    print(
        "Comment injection parity passed: "
        f"implementations={','.join(implementations)} annotations={len(baseline_annotations)} "
        f"bytes={fixture.stat().st_size}"
    )
    return 0


def main() -> int:
    args = parse_args()
    source = injected_source()
    if args.keep_fixture:
        fixture = Path(tempfile.mkdtemp(prefix="aeon-comment-injection-")) / "comment-injection.aeon"
        fixture.write_text(source, encoding="utf-8")
        print(f"Generated fixture: {fixture}")
        return compare(args, fixture)

    with tempfile.TemporaryDirectory(prefix="aeon-comment-injection-") as tmpdir:
        fixture = Path(tmpdir) / "comment-injection.aeon"
        fixture.write_text(source, encoding="utf-8")
        return compare(args, fixture)


if __name__ == "__main__":
    raise SystemExit(main())
