from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import subprocess
import sys

repo_root = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(repo_root / "scripts"))

from repo_paths import repo_path_env


@dataclass(frozen=True)
class LaneCommand:
    name: str
    command: list[str]


def main() -> int:
    python_root = repo_root / "implementations" / "python"
    sut = python_root / "bin" / "aeon-python"
    env = repo_path_env()

    lanes = [
        LaneCommand(
            name="core",
            command=[
                "node",
                str(repo_root / "scripts" / "cts-source-lane-runner.mjs"),
                "--sut",
                str(sut),
                "--cts",
                str(repo_root / "cts" / "core" / "v1" / "core-cts.v1.json"),
                "--lane",
                "core",
            ],
        ),
        LaneCommand(
            name="aes",
            command=[
                "node",
                str(repo_root / "scripts" / "cts-source-lane-runner.mjs"),
                "--sut",
                str(sut),
                "--cts",
                str(repo_root / "cts" / "aes" / "v1" / "aes-cts.v1.json"),
                "--lane",
                "aes",
            ],
        ),
        LaneCommand(
            name="annotations",
            command=[
                "node",
                str(repo_root / "implementations" / "typescript" / "tools" / "annotation-cts-runner" / "dist" / "index.js"),
                "--sut",
                str(sut),
                "--cts",
                str(repo_root / "cts" / "annotations" / "v1" / "annotation-stream-cts.v1.json"),
            ],
        ),
        LaneCommand(
            name="aeos",
            command=[
                "node",
                str(repo_root / "implementations" / "typescript" / "tools" / "cts-runner" / "dist" / "index.js"),
                "--sut",
                str(sut),
                "--cts",
                str(repo_root / "cts" / "aeos" / "v1" / "aeos-validator-cts.v1.json"),
            ],
        ),
    ]

    requested = set(sys.argv[1:])
    if requested:
        unknown = sorted(requested.difference({lane.name for lane in lanes}))
        if unknown:
            print(f"Unknown lane(s): {', '.join(unknown)}", file=sys.stderr)
            print("Valid lanes: core aes annotations aeos", file=sys.stderr)
            return 2
        lanes = [lane for lane in lanes if lane.name in requested]

    for lane in lanes:
        print(f"\n== Running {lane.name} CTS ==")
        completed = subprocess.run(lane.command, cwd=repo_root, env=env)
        if completed.returncode != 0:
            return completed.returncode

    print("\nAll requested CTS lanes passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
