from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import difflib
import json
import subprocess
import sys


@dataclass(frozen=True)
class CommandResult:
    code: int
    stdout: str
    stderr: str


def main() -> int:
    repo_root = Path(__file__).resolve().parents[3]
    python_root = repo_root / "implementations" / "python"
    python_sut = python_root / "bin" / "aeon-python"
    typescript_sut = repo_root / "implementations" / "typescript" / "packages" / "cli" / "dist" / "main.js"

    fixture_args = [Path(arg).resolve() if Path(arg).is_absolute() else (Path.cwd() / arg).resolve() for arg in sys.argv[1:]]
    fixtures = fixture_args if fixture_args else discover_fixtures(repo_root)
    if not fixtures:
        print("No AEON fixtures found to compare.", file=sys.stderr)
        return 2

    failures = 0
    for fixture in fixtures:
        relative = fixture.relative_to(repo_root)
        print(f"\n== Comparing {relative} ==")
        ts_result = run_typescript(typescript_sut, fixture)
        py_result = run_python(python_sut, fixture)

        if ts_result.code != py_result.code:
            print(f"Exit code mismatch: ts={ts_result.code} py={py_result.code}")
            emit_stderr(ts_result, py_result)
            failures += 1
            continue

        ts_json = parse_json(ts_result.stdout, "TypeScript")
        py_json = parse_json(py_result.stdout, "Python")
        if ts_json is None or py_json is None:
            emit_stderr(ts_result, py_result)
            failures += 1
            continue

        if ts_json != py_json:
            print("JSON mismatch detected.")
            print(render_diff(ts_json, py_json))
            emit_stderr(ts_result, py_result)
            failures += 1
            continue

        print("Match")

    if failures:
        print(f"\nComparison failed for {failures} fixture(s).", file=sys.stderr)
        return 1

    print(f"\nAll {len(fixtures)} fixture comparisons matched.")
    return 0


def discover_fixtures(repo_root: Path) -> list[Path]:
    roots = [repo_root / "examples", repo_root / "stress-tests"]
    fixtures: list[Path] = []
    for root in roots:
        if not root.exists():
            continue
        fixtures.extend(sorted(root.rglob("*.aeon")))
    return fixtures


def run_typescript(sut: Path, fixture: Path) -> CommandResult:
    command = [
        "node",
        str(sut),
        "inspect",
        str(fixture),
        "--json",
        "--annotations",
        "--sort-annotations",
    ]
    completed = subprocess.run(command, capture_output=True, text=True)
    return CommandResult(code=completed.returncode, stdout=completed.stdout.strip(), stderr=completed.stderr.strip())


def run_python(sut: Path, fixture: Path) -> CommandResult:
    command = [
        str(sut),
        "inspect",
        str(fixture),
        "--json",
        "--annotations",
        "--sort-annotations",
    ]
    completed = subprocess.run(command, capture_output=True, text=True)
    return CommandResult(code=completed.returncode, stdout=completed.stdout.strip(), stderr=completed.stderr.strip())


def parse_json(payload: str, label: str) -> object | None:
    try:
        return json.loads(payload)
    except json.JSONDecodeError as error:
        print(f"{label} output is not valid JSON: {error}")
        return None


def render_diff(left: object, right: object) -> str:
    left_text = json.dumps(left, indent=2, sort_keys=True)
    right_text = json.dumps(right, indent=2, sort_keys=True)
    return "\n".join(
        difflib.unified_diff(
            left_text.splitlines(),
            right_text.splitlines(),
            fromfile="typescript",
            tofile="python",
            lineterm="",
        )
    )


def emit_stderr(ts_result: CommandResult, py_result: CommandResult) -> None:
    if ts_result.stderr:
        print("TypeScript stderr:")
        print(ts_result.stderr)
    if py_result.stderr:
        print("Python stderr:")
        print(py_result.stderr)


if __name__ == "__main__":
    raise SystemExit(main())