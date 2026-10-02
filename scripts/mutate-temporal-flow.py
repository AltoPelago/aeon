#!/usr/bin/env python3
"""Bounded source-mutation audit of the temporal flow suite (Python backend).

Only disposable copies are changed. Each worker imports a fresh copied package,
runs the actual CLI main in-process, and reuses the flow suite's assertions.
Import/build/runtime failures are invalid experiments, never detected bugs.
"""
from __future__ import annotations

import argparse
from contextlib import redirect_stderr, redirect_stdout
from dataclasses import asdict, dataclass
import hashlib
import io
import json
from pathlib import Path
import runpy
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
FLOW_PATH = ROOT / "scripts/stress-temporal-flow.py"


@dataclass(frozen=True)
class Mutation:
    name: str
    file: str
    old: str
    new: str
    occurrences: int = 1
    # A separate witness establishes non-equivalence without counting as a
    # matrix detection. Useful when an existing matrix misses this boundary.
    witness: str = ""


def mutations():
    def lex(name, old, new, occurrences=1, witness=""):
        return Mutation(name, "lexer.py", old, new, occurrences, witness)

    def canon(name, expression):
        # Both block and inline rendering paths intentionally change together.
        return Mutation(name, "canonical.py", "value.value", expression)

    return [
        lex("hour-24-accepted", "return 0 <= value <= 23", "return 0 <= value <= 24"),
        lex("hour-23-rejected", "return 0 <= value <= 23", "return 0 <= value < 23"),
        lex("hour-only-unbounded", "return value.isascii() and value.isdigit() and Lexer.is_valid_hour(int(value))", "return value.isascii() and value.isdigit()"),
        lex("minute-60-accepted", "return 0 <= value <= 59", "return 0 <= value <= 60"),
        lex("minute-59-rejected", "return 0 <= value <= 59", "return 0 <= value < 59"),
        lex("second-60-rejected", "return 0 <= value <= 60", "return 0 <= value < 60"),
        lex("second-61-accepted", "return 0 <= value <= 60", "return 0 <= value <= 61"),
        lex("year-zero-accepted", "return 1 <= year <= 9999\n", "return 0 <= year <= 9999\n"),
        lex("century-leap-accepted", "year % 4 == 0 and (year % 100 != 0 or year % 400 == 0)", "year % 4 == 0"),
        lex("400-year-leap-rejected", "year % 4 == 0 and (year % 100 != 0 or year % 400 == 0)", "year % 4 == 0 and year % 100 != 0"),
        lex("april-31-accepted", "else 28, 31, 30, 31", "else 28, 31, 31, 31"),
        lex("september-31-accepted", "31, 31, 30, 31, 30, 31]", "31, 31, 31, 31, 30, 31]", witness="2024-09-31"),
        lex("common-february-28-rejected", "29 if Lexer.is_leap_year(year) else 28", "29 if Lexer.is_leap_year(year) else 27", witness="2023-02-28"),
        lex("unicode-calendar-accepted", "        if not value.isascii():\n            return False\n", "", 2),
        lex("unicode-clock-accepted", "return value.isascii() and (cls.matches_time_core(value, allow_hour_precision_marker=True) or cls.matches_zoned_time(value))", "return cls.matches_time_core(value, allow_hour_precision_marker=True) or cls.matches_zoned_time(value)"),
        lex("local-case-aliases", 'and (reference == "local" or reference.lower() != "local")', "and True"),
        lex("context-double-slash", 'and "//" not in reference', "and True"),
        lex("context-trailing-slash", 'and not reference.endswith("/")', "and True"),
        lex("fraction-capped-at-nine", 'if separator and (not fraction or not fraction.isdigit() or "." in fraction):', 'if separator and (not fraction or not fraction.isdigit() or "." in fraction or len(fraction) > 9):'),
        lex("lowercase-z-accepted", '"Z"', '("Z", "z")', 4),
        canon("canonical-negative-zero-to-z", 'value.value.replace("-00:00", "Z")'),
        canon("canonical-negative-zero-to-positive", 'value.value.replace("-00:00", "+00:00")'),
        canon("canonical-fill-calendar", 'value.value.replace("-T", "-01-01T")'),
        canon("canonical-drop-context", 'value.value.split("&", 1)[0]'),
        canon("canonical-quote-temporal", 'json.dumps(value.value)'),
        canon("canonical-drop-fraction-zeroes", 're.sub(r"(\\.\\d+?)0+(?=Z|[+&-]|$)", r"\\1", value.value)'),
        canon("canonical-truncate-fraction", 're.sub(r"(\\.\\d{9})\\d+", r"\\1", value.value)'),
        canon("canonical-non-idempotent-fraction", 're.sub(r"\\.\\d+", lambda m: m[0] + "0", value.value)'),
        Mutation("canonical-time-container-layout", "canonical.py", "            TimeLiteral,\n", ""),
    ]


def apply_mutation(source, mutation):
    if mutation.name.startswith("canonical-") and mutation.old == "value.value":
        for old, new in (
            ("if isinstance(value, (DateLiteral, DateTimeLiteral, TimeLiteral)):\n        return [value.value]",
             f"if isinstance(value, (DateLiteral, DateTimeLiteral, TimeLiteral)):\n        return [{mutation.new}]"),
            ("if isinstance(value, (DateLiteral, DateTimeLiteral, TimeLiteral)):\n        return value.value",
             f"if isinstance(value, (DateLiteral, DateTimeLiteral, TimeLiteral)):\n        return {mutation.new}"),
        ):
            if source.count(old) != 1:
                raise ValueError(f"stale canonical mutation anchor: {mutation.name}")
            source = source.replace(old, new)
        return source
    if source.count(mutation.old) != mutation.occurrences:
        raise ValueError(f"stale mutation anchor: {mutation.name}")
    if mutation.name == "lowercase-z-accepted":
        # Scanner equality and validator endswith must both admit lowercase z.
        return source.replace('self.peek() == "Z"', 'self.peek() in {"Z", "z"}').replace('value.endswith("Z")', 'value.endswith(("Z", "z"))')
    return source.replace(mutation.old, mutation.new)


def worker(package, output, baseline, witness):
    sys.path.insert(0, str(package))
    from aeon.cli import main as cli_main
    import aeon.cli
    if not Path(aeon.cli.__file__).resolve().is_relative_to(package.resolve()):
        raise RuntimeError("worker imported the working package instead of isolated copy")
    flow = runpy.run_path(str(FLOW_PATH))

    def invoke(argv, **kwargs):
        stdout, stderr = io.StringIO(), io.StringIO()
        with redirect_stdout(stdout), redirect_stderr(stderr):
            code = cli_main(argv[1:])
        return subprocess.CompletedProcess(argv, code, stdout.getvalue(), stderr.getvalue())

    reference = json.loads(baseline.read_text()) if baseline else None
    cases = flow["cases"]()
    if witness:
        kind = flow["datatype"](witness, "year0")
        cases = [flow["Case"]("witness", "witness", witness, flow["HEADER"] + f"v:{kind} = {witness}", flow["oracle"](witness, "year0"))]
    results = []
    for case in cases:
        result = flow["run_case"](case, 20, commands={"python": ["isolated-python"]}, process_runner=invoke)
        if any("harness failure" in failure for failure in result["failures"]):
            raise RuntimeError(result["failures"])
        if reference and not witness:
            expected = reference[case.group + "/" + case.name]
            if result["canonical"] != expected["canonical"]:
                result["failures"].append("canonical bytes differ from unmutated baseline")
        results.append(result)
    output.write_text(json.dumps(results), encoding="utf-8")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--only", action="append", help="Run named mutations only")
    parser.add_argument("--worker", type=Path, help=argparse.SUPPRESS)
    parser.add_argument("--baseline", type=Path, help=argparse.SUPPRESS)
    parser.add_argument("--witness", default="", help=argparse.SUPPRESS)
    args = parser.parse_args()
    if sys.version_info < (3, 12):
        parser.error("Python 3.12+ required")
    if args.worker:
        worker(args.worker, args.report, args.baseline, args.witness)
        return 0
    selected = mutations()
    if args.only:
        unknown = set(args.only) - {m.name for m in selected}
        if unknown:
            parser.error(f"unknown mutations: {sorted(unknown)}")
        selected = [m for m in selected if m.name in args.only]
    source_root = ROOT / "implementations/python/src"
    hashes = {path.name: hashlib.sha256(path.read_bytes()).hexdigest() for path in (source_root / "aeon").glob("*.py")}
    results = []
    with tempfile.TemporaryDirectory(prefix="aeon-temporal-mutants-") as temp:
        scratch = Path(temp)
        package = scratch / "src"
        shutil.copytree(source_root, package, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
        output = scratch / "results.json"
        baseline_path = scratch / "baseline.json"

        def execute(witness="", baseline=False):
            command = [sys.executable, str(Path(__file__).resolve()), "--worker", str(package), "--report", str(output)]
            if baseline:
                command += ["--baseline", str(baseline_path)]
            if witness:
                command += ["--witness", witness]
            completed = subprocess.run(command, capture_output=True, text=True, timeout=120)
            if completed.returncode:
                raise RuntimeError(completed.stderr or completed.stdout)
            return json.loads(output.read_text())

        baseline = execute()
        if any(r["failures"] for r in baseline):
            raise RuntimeError("unmutated baseline fails; cannot score mutations")
        baseline_path.write_text(json.dumps({r["group"] + "/" + r["name"]: r for r in baseline}), encoding="utf-8")
        print(f"Baseline: {len(baseline)} passed; {len(selected)} source mutations", flush=True)
        for mutation in selected:
            target = package / "aeon" / mutation.file
            original = target.read_text()
            record = {**asdict(mutation), "status": "invalid"}
            try:
                if mutation.witness:
                    witness_baseline = execute(witness=mutation.witness)
                    if any(r["failures"] for r in witness_baseline):
                        raise RuntimeError("unmutated witness fails; cannot establish non-equivalence")
                changed = apply_mutation(original, mutation)
                compile(changed, str(target), "exec")
                record["mutated_source_sha256"] = hashlib.sha256(changed.encode()).hexdigest()
                target.write_text(changed, encoding="utf-8")
                # Avoid timestamp/size-based bytecode reuse between mutants.
                completed = execute(baseline=True)
                failures = [r for r in completed if r["failures"]]
                record.update(status="killed" if failures else "survived", detected_cases=len(failures), evidence=failures[:3])
                if not failures and mutation.witness:
                    witness_result = execute(witness=mutation.witness)
                    record["witness_evidence"] = witness_result
            except (ValueError, RuntimeError, SyntaxError, subprocess.TimeoutExpired) as exc:
                record["error"] = str(exc)
            finally:
                target.write_text(original, encoding="utf-8")
            results.append(record)
            print(f"{record['status'].upper()}: {mutation.name} ({record.get('detected_cases', 0)} cases)", flush=True)
        report = {"backend": "Python source mutations; actual CLI main in isolated workers", "matrix_cases": len(baseline),
                  "flow_sha256": hashlib.sha256(FLOW_PATH.read_bytes()).hexdigest(), "source_sha256": hashes,
                  "killed": sum(r["status"] == "killed" for r in results),
                  "survived": sum(r["status"] == "survived" for r in results),
                  "invalid": sum(r["status"] == "invalid" for r in results), "mutations": results}
        args.report.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
        print(f"Summary: killed={report['killed']} survived={report['survived']} invalid={report['invalid']}")
    return int(bool(report["survived"] or report["invalid"]))


if __name__ == "__main__":
    # Fresh source, not a cached .pyc, is required for every mutation.
    sys.dont_write_bytecode = True
    raise SystemExit(main())
