#!/usr/bin/env python3
"""Run Baseline/Sofia parser parity over the frozen Sofia corpus manifest."""

from __future__ import annotations

import os
import subprocess
import sys
import tempfile
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
RUST_MANIFEST = REPO_ROOT / "implementations" / "rust" / "Cargo.toml"
GENERATOR = REPO_ROOT / "scripts" / "generate-sofia-corpus.py"
TEST_NAME = "parser_selector_matches_full_baseline_corpus"


def main() -> int:
    with tempfile.TemporaryDirectory(prefix="aeon-sofia-differential-") as raw_directory:
        generated_directory = Path(raw_directory)
        subprocess.run(
            [sys.executable, str(GENERATOR), str(generated_directory)],
            cwd=REPO_ROOT,
            check=True,
        )

        environment = os.environ.copy()
        environment["AEON_SOFIA_GENERATED_CORPUS"] = str(generated_directory)
        subprocess.run(
            [
                "cargo",
                "test",
                "--manifest-path",
                str(RUST_MANIFEST),
                "-p",
                "aeon-core",
                TEST_NAME,
                "--",
                "--ignored",
                "--nocapture",
            ],
            cwd=REPO_ROOT,
            env=environment,
            check=True,
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
