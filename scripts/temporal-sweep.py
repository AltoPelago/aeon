#!/usr/bin/env python3
"""Quiet, seeded numeric temporal sweep through the three Core compilers.

Exit 0: all expectations matched; 1: mismatches; 2: infrastructure error.
Only mismatches/errors are printed. Metadata, timings, completion, and benchmark
estimates go to the required JSON report. No claim of actual leap-second events
or GP validity is made. Use Python 3.12+.
"""
from __future__ import annotations

import argparse
import calendar
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime, timezone
import hashlib
import itertools
import json
from pathlib import Path
import queue
import random
import secrets
import subprocess
import sys
import tempfile
import threading
import time

ROOT = Path(__file__).resolve().parents[1]
MINUTES = (*range(0, 60, 6), 59, 60)
SECONDS = (0, 59, 60, 61)
DIMENSIONS = (2, 14, 33, 25, len(MINUTES), len(SECONDS))
GRID_COUNT = 2 * 14 * 33 * 25 * len(MINUTES) * len(SECONDS)
HEADER = 'aeon:mode = "strict"\nv:datetime = '
OUTPUT_LOCK = threading.Lock()


def expected(year, month, day, hour, minute, second):
    # Independent calendar oracle: do not import any AEON implementation here.
    try:
        date(year, month, day)
    except ValueError:
        return False
    return 0 <= hour <= 23 and 0 <= minute <= 59 and 0 <= second <= 60


def select_years(seed):
    rng = random.Random(seed)
    leap = [year for year in range(1, 10000) if calendar.isleap(year)]
    common = [year for year in range(1, 10000) if not calendar.isleap(year)]
    return rng.choice(leap), rng.choice(common)


def make_case(year, month, day, hour, minute, second):
    literal = f"{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}"
    return literal, expected(year, month, day, hour, minute, second)


def grid_case(index, years):
    if not 0 <= index < GRID_COUNT:
        raise ValueError("grid index out of bounds")
    coordinates = []
    for size in reversed(DIMENSIONS):
        index, coordinate = divmod(index, size)
        coordinates.append(coordinate)
    year, month, day, hour, minute, second = reversed(coordinates)
    return make_case(years[year], month, day, hour, MINUTES[minute], SECONDS[second])


def century_cases():
    return [make_case(year, 2, day, 23, 59, second)
            for year in (1900, 2000) for day in (28, 29, 30) for second in SECONDS]


def case_stream(seed, years, benchmark):
    # A benchmark must sample the WHOLE grid, not its invalid month-zero prefix.
    indices = (sorted(random.Random(seed ^ 0xAE014).sample(range(GRID_COUNT), benchmark))
               if benchmark else range(GRID_COUNT))
    for index in indices:
        yield grid_case(index, years)
    yield from century_cases()


def python_worker():
    sys.path.insert(0, str(ROOT / "implementations/python/src"))
    from aeon.core import compile_source
    print(json.dumps({"ready": True}), flush=True)
    for line in sys.stdin:
        cases = json.loads(line)
        mismatches = []
        accepted = 0
        for index, (literal, want) in enumerate(cases):
            result = compile_source(HEADER + literal)
            actual = not result.errors
            accepted += actual
            if actual != want:
                mismatches.append([index, actual, [error.code for error in result.errors]])
        print(json.dumps({"checked": len(cases), "accepted": accepted, "mismatches": mismatches}), flush=True)


def validate_response(response, batch):
    if type(response.get("checked")) is not int or response.get("checked") != len(batch) or type(response.get("accepted")) is not int:
        raise ValueError("worker returned invalid counts")
    mismatches = response.get("mismatches")
    if not isinstance(mismatches, list):
        raise ValueError("worker omitted mismatch list")
    seen = set()
    accepted = sum(want for _, want in batch)
    for index, actual, codes in mismatches:
        if type(index) is not int or not 0 <= index < len(batch) or index in seen:
            raise ValueError("worker returned invalid/duplicate mismatch index")
        if type(actual) is not bool or actual == batch[index][1] or not isinstance(codes, list):
            raise ValueError("worker returned inconsistent mismatch")
        seen.add(index)
        accepted += int(actual) - int(batch[index][1])
    if response["accepted"] != accepted:
        raise ValueError("worker acceptance count contradicts its mismatches")
    return mismatches


class Worker:
    def __init__(self, command, timeout):
        self.timeout = timeout
        self.errors = tempfile.TemporaryFile(mode="w+t")
        self.process = subprocess.Popen(command, cwd=ROOT, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                        stderr=self.errors, text=True, bufsize=1)
        self.responses = queue.Queue()

        def read():
            try:
                for line in self.process.stdout:
                    self.responses.put(line)
            finally:
                self.responses.put(None)
        self.reader = threading.Thread(target=read, daemon=True)
        self.reader.start()

    def receive(self):
        try:
            line = self.responses.get(timeout=self.timeout)
        except queue.Empty as exc:
            raise RuntimeError(f"worker exceeded {self.timeout}s response timeout") from exc
        if line is None:
            self.errors.seek(0)
            raise RuntimeError("worker exited unexpectedly: " + self.errors.read())
        return json.loads(line)

    def request(self, cases):
        self.process.stdin.write(json.dumps(cases) + "\n")
        self.process.stdin.flush()
        response = self.receive()
        validate_response(response, cases)
        return response

    def close(self):
        if self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait()
        self.process.stdin.close()
        self.reader.join(timeout=5)
        self.process.stdout.close()
        self.errors.close()


def check_worker(worker):
    if worker.receive() != {"ready": True}:
        raise RuntimeError("invalid worker handshake")
    # Both correct expectations and intentionally inverted expectations. These
    # control mismatches prove each worker executes and compares every case.
    batch = [("2000-02-29T23:59:60", True), ("1900-02-29T23:59:59", False),
             ("2000-02-29T23:59:60", False), ("1900-02-29T23:59:59", True)]
    response = worker.request(batch)
    if [entry[0] for entry in response["mismatches"]] != [2, 3]:
        raise RuntimeError("worker failed acceptance/rejection self-test")


def run_backend(name, command, args, years):
    worker = Worker(command, args.timeout)
    try:
        check_worker(worker)
        started = time.perf_counter()
        checked = accepted = expected_accepted = mismatch_count = 0
        examples = []
        cases = iter(case_stream(args.seed, years, args.benchmark))
        while batch := list(itertools.islice(cases, args.batch_size)):
            response = worker.request(batch)
            expected_accepted += sum(want for _, want in batch)
            accepted += response["accepted"]
            for index, actual, codes in response["mismatches"]:
                literal, want = batch[index]
                failure = {"backend": name, "literal": literal, "expected": want, "actual": actual,
                           "errors": codes, "seed": args.seed, "source": HEADER + literal}
                with OUTPUT_LOCK:
                    print(json.dumps(failure), flush=True)
                mismatch_count += 1
                if len(examples) < 20:
                    examples.append(failure)
            checked += len(batch)
        required = (args.benchmark or GRID_COUNT) + len(century_cases())
        if checked != required:
            raise RuntimeError(f"incomplete sweep: checked {checked}, required {required}")
        seconds = time.perf_counter() - started
        return {"checked": checked, "accepted": accepted, "rejected": checked - accepted,
                "expected_accepted": expected_accepted, "mismatches": mismatch_count, "examples": examples,
                "elapsed_seconds": seconds, "cases_per_second": checked / seconds,
                "estimated_full_seconds": (GRID_COUNT + len(century_cases())) * seconds / checked}
    finally:
        worker.close()


def build(backends):
    commands = []
    if "typescript" in backends:
        commands.append(["pnpm", "-C", str(ROOT / "implementations/typescript"), "build"])
    if "rust" in backends:
        commands.append(["cargo", "build", "--manifest-path", str(ROOT / "implementations/rust/Cargo.toml"),
                         "--release", "-p", "altopelago-aeon-core", "--example", "temporal_sweep"])
    for command in commands:
        result = subprocess.run(command, cwd=ROOT, capture_output=True, text=True, timeout=600)
        if result.returncode:
            raise RuntimeError(f"build failed: {' '.join(command)}\n{result.stdout}\n{result.stderr}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", type=Path, help="Required JSON status/result file; must not already exist")
    parser.add_argument("--seed", type=int, help="Replay seed (default: randomly generated and recorded)")
    parser.add_argument("--benchmark", type=int, default=0, metavar="N", help="Sample N grid cases plus century cases; 0/default runs the full sweep")
    parser.add_argument("--impl", choices=("typescript", "python", "rust"), action="append", help="Default: all three")
    parser.add_argument("--batch-size", type=int, default=256)
    parser.add_argument("--timeout", type=float, default=60, help="Per-worker response timeout in seconds")
    parser.add_argument("--skip-build", action="store_true", help="Use existing builds; caller is responsible for freshness")
    parser.add_argument("--python-worker", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()
    if sys.version_info < (3, 12):
        parser.error("Python 3.12+ required")
    if args.python_worker:
        python_worker()
        return 0
    if not args.report:
        parser.error("--report is required")
    if not 0 <= args.benchmark <= GRID_COUNT or not 1 <= args.batch_size <= 256 or args.timeout <= 0:
        parser.error("benchmark must be 0..grid size; batch size 1..256; timeout positive")
    args.seed = secrets.randbits(64) if args.seed is None else args.seed
    years = select_years(args.seed)
    backends = list(dict.fromkeys(args.impl or ["typescript", "python", "rust"]))
    commands = {
        "typescript": ["node", str(ROOT / "scripts/temporal-sweep-worker.mjs")],
        "python": [sys.executable, str(Path(__file__).resolve()), "--python-worker"],
        "rust": [str(ROOT / "implementations/rust/target/release/examples/temporal_sweep")],
    }
    report = {"status": "building" if not args.skip_build else "running", "seed": args.seed,
              "years": {"leap": years[0], "common": years[1]}, "scope": "Core datetime acceptance; not GP or actual instants",
              "started_at": datetime.now(timezone.utc).isoformat(), "benchmark_grid_cases": args.benchmark,
              "full_cases_per_backend": GRID_COUNT + len(century_cases()), "minutes": MINUTES, "seconds": SECONDS,
              "runner_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
              "requested_backends": backends, "backends": {}}
    # Exclusive creation avoids overwriting earlier evidence. Persist seed before
    # builds/workers start, so even an interrupted run can be reproduced.
    try:
        with args.report.open("x", encoding="utf-8") as output:
            json.dump(report, output, indent=2)
    except OSError as exc:
        print(f"ERROR: cannot create report: {exc}", file=sys.stderr)
        return 2

    def save():
        with tempfile.NamedTemporaryFile(mode="w", dir=args.report.parent, delete=False, encoding="utf-8") as output:
            json.dump(report, output, indent=2)
            output.write("\n")
            temporary = Path(output.name)
        temporary.replace(args.report)

    started = time.perf_counter()
    try:
        build_started = time.perf_counter()
        if not args.skip_build:
            build(backends)
        report["build_seconds"] = time.perf_counter() - build_started
        report["status"] = "running"
        save()
        run_started = time.perf_counter()
        with ThreadPoolExecutor(max_workers=len(backends)) as pool:
            futures = {pool.submit(run_backend, name, commands[name], args, years): name for name in backends}
            for future in as_completed(futures):
                report["backends"][futures[future]] = future.result()
                save()
        report["run_wall_seconds"] = time.perf_counter() - run_started
        report["estimated_full_wall_seconds"] = max(r["estimated_full_seconds"] for r in report["backends"].values())
        report["status"] = "mismatches" if any(r["mismatches"] for r in report["backends"].values()) else "passed"
    except Exception as exc:
        report["status"] = "error"
        report["error"] = str(exc)
        print(f"ERROR: {exc}", file=sys.stderr, flush=True)
    finally:
        report["elapsed_seconds"] = time.perf_counter() - started
        report["finished_at"] = datetime.now(timezone.utc).isoformat()
        save()
    return 0 if report["status"] == "passed" else 1 if report["status"] == "mismatches" else 2


if __name__ == "__main__":
    raise SystemExit(main())
