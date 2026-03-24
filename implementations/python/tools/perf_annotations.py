#!/usr/bin/env python3
from __future__ import annotations

import statistics
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from aeon.annotations import build_annotation_stream  # noqa: E402
from aeon.core import compile_source  # noqa: E402


SIZES = (1000, 2000, 4000, 8000)
ITERATIONS = 5
RATIO_LIMIT = 2.6


def make_comment_rich(count: int) -> str:
    lines = ["/# top doc #/"]
    for index in range(count):
        lines.append(f"k{index}:number = {index} /? hint-{index} ?/")
    return "\n".join(lines) + "\n"


def median_runtime_seconds(source: str) -> float:
    compiled = compile_source(source)
    if compiled.errors:
        raise RuntimeError(f"fixture failed to compile: {[error.code for error in compiled.errors]}")

    samples: list[float] = []
    for _ in range(ITERATIONS):
        start = time.perf_counter()
        build_annotation_stream(source, compiled.events)
        samples.append(time.perf_counter() - start)
    return statistics.median(samples)


def main() -> int:
    results: list[tuple[int, int, float]] = []
    for size in SIZES:
        source = make_comment_rich(size)
        elapsed = median_runtime_seconds(source)
        results.append((size, len(source.encode("utf-8")), elapsed))

    print("Python annotation perf regression check")
    print("size\tbytes\tmedian_ms\tratio_vs_prev")
    previous: float | None = None
    violations: list[str] = []
    for size, byte_count, elapsed in results:
        ratio_text = "-"
        if previous is not None:
            ratio = elapsed / previous if previous > 0 else float("inf")
            ratio_text = f"{ratio:.2f}"
            if ratio > RATIO_LIMIT:
                violations.append(f"{size} comments grew {ratio:.2f}x over previous size")
        print(f"{size}\t{byte_count}\t{elapsed * 1000:.3f}\t{ratio_text}")
        previous = elapsed

    if violations:
        print("\nFAIL: annotation runtime scaling exceeded threshold", file=sys.stderr)
        for violation in violations:
            print(f"- {violation}", file=sys.stderr)
        return 1

    print(f"\nOK: all growth ratios stayed <= {RATIO_LIMIT:.2f}x")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
