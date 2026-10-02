#!/usr/bin/env python3
"""Grammar-derived temporal transition, boundary, and canonical parity checks.

The oracle below imports no implementation code. See docs/scripts/temporal-flow.md.
"""
from __future__ import annotations

import argparse
from calendar import monthrange
from collections import Counter, deque
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import asdict, dataclass
from datetime import date
import json
from pathlib import Path
import re
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
DIGITS = "0123456789"
CONTEXT = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_+-."
# Grammar-significant letters remain distinct from the ordinary letter class.
REPRESENTATIVES = ("1", "A", "a", "T", "t", "Z", "z", ":", "-", "+", ".", "&", "/", "_", "é", "١")
HEADER = 'aeon:mode = "strict"\n'
COMMANDS = {
    "typescript": ["node", str(ROOT / "implementations/typescript/packages/cli/dist/main.js")],
    "python": [str(ROOT / "implementations/python/bin/aeon-python")],
    "rust": [str(ROOT / "implementations/rust/target/debug/aeon-rust")],
}


def grammar():
    edges: dict[str, dict[str, str]] = {}
    terminals: set[str] = set()

    def edge(start, chars, end):
        edges.setdefault(start, {}).update({char: end for char in chars})

    for i in range(4):
        edge(f"year{i}", DIGITS, f"year{i + 1}")
    edge("year4", "-", "year-end")
    edge("year-end", DIGITS, "month1")
    edge("month1", DIGITS, "month-end")
    edge("month-end", "-", "day0")
    edge("day0", DIGITS, "day1")
    edge("day1", DIGITS, "day-end")
    for state in ("year-end", "month-end", "day-end"):
        terminals.add(state)
        edge(state, "T", "dt-hour0")
    for prefix in ("time", "dt"):
        def s(name):
            return f"{prefix}-{name}"
        edge(s("hour0"), DIGITS, s("hour1"))
        edge(s("hour1"), DIGITS, s("hour2"))
        edge(s("hour2"), ":", s("hour-end"))
        edge(s("hour-end"), DIGITS, s("minute1"))
        edge(s("minute1"), DIGITS, s("minute-end"))
        edge(s("minute-end"), ":", s("second0"))
        edge(s("second0"), DIGITS, s("second1"))
        edge(s("second1"), DIGITS, s("second-end"))
        edge(s("second-end"), ".", s("fraction0"))
        edge(s("fraction0"), DIGITS, s("fraction-end"))
        edge(s("fraction-end"), DIGITS, s("fraction-end"))
        clock_ends = [s(n) for n in ("hour-end", "minute-end", "second-end", "fraction-end")]
        if prefix == "dt":
            clock_ends.append(s("hour2"))
        for state in clock_ends:
            terminals.add(state)
            edge(state, "Z", s("utc-end"))
            edge(state, "+-", s("offset0"))
        edge(s("offset0"), DIGITS, s("offset1"))
        edge(s("offset1"), DIGITS, s("offset2"))
        edge(s("offset2"), ":", s("offset-minute0"))
        edge(s("offset-minute0"), DIGITS, s("offset-minute1"))
        edge(s("offset-minute1"), DIGITS, s("offset-end"))
        terminals.update((s("utc-end"), s("offset-end")))
        if prefix == "dt":
            for state in clock_ends + [s("utc-end"), s("offset-end")]:
                edge(state, "&", "context0")
    edge("context0", CONTEXT, "context-end")
    edge("context-end", CONTEXT, "context-end")
    edge("context-end", "/", "context0")
    terminals.add("context-end")
    return edges, terminals


EDGES, TERMINALS = grammar()


def completion(start: str) -> str:
    """Shortest representative suffix proving a valid transition can finish."""
    queue = deque([(start, "")])
    visited = set()
    while queue:
        state, suffix = queue.popleft()
        if state in TERMINALS:
            return suffix
        if state in visited:
            continue
        visited.add(state)
        for char in REPRESENTATIVES:
            target = EDGES.get(state, {}).get(char)
            if target is not None:
                queue.append((target, suffix + char))
    raise ValueError(f"no completion for {start}")


def oracle(value: str, root: str) -> bool:
    state = root
    for char in value:
        state = EDGES.get(state, {}).get(char)
        if state is None:
            return False
    if state not in TERMINALS:
        return False
    base, _, context = value.partition("&")
    if context.lower() == "local" and context != "local":
        return False
    if root == "year0":
        calendar, _, clock = base.partition("T")
        parts = calendar.rstrip("-").split("-")
        try:
            date(int(parts[0]), int(parts[1]) if len(parts) > 1 else 1,
                 int(parts[2]) if len(parts) > 2 else 1)
        except ValueError:
            return False
        if not clock:
            return True
    else:
        clock = base
    # The DFA already checked spelling/width; these are independent range guards.
    fields = re.split(r"[:.Z+-]", clock)
    if int(fields[0]) > 23:
        return False
    main = re.split(r"[Z+-]", clock)[0].split(":")
    if len(main) > 1 and main[1] and int(main[1]) > 59:
        return False
    if len(main) > 2 and int(main[2].split(".")[0]) > 60:
        return False
    offset = re.search(r"[+-]([0-9]{2}):([0-9]{2})$", clock)
    return offset is None or (int(offset[1]) <= 23 and int(offset[2]) <= 59)


@dataclass(frozen=True)
class Case:
    name: str
    group: str
    literal: str
    source: str
    accepted: bool
    path: str = "$.v"


def datatype(value, root):
    if root == "time-hour0":
        return "time"
    return "wtc" if "&" in value else "datetime" if "T" in value else "date"


def duplication_cases():
    """Duplicate each character independently (two and three total copies).

    Keep the seed and first triggering position in the case name, but collapse
    identical results produced by positions within an existing repeated run.
    The oracle decides validity: fraction digits and context characters can
    legally repeat, unlike fixed-width fields and most structural punctuation.
    """
    seeds = {
        "year0": (
            "0001-", "2002-", "2002-02", "2002-03-02", "2024-02-29", "9999-12-31",
            "2021-T20:", "2024-02T10", "2002-03-02T10:10:32.010Z", "2024-T10:10-00:00",
            "2024-T10&local", "2024-02-29T10:10:32+02:30&Europe/Belgium/Brussels",
            "2024-T10&+/Antarctica/Elisabeth", "2024-T10&-36.75/144.28", "2024-T10&A_A-A+A.A",
        ),
        "time-hour0": ("00:", "10:10", "10:10:32", "23:59:60.0100", "10:10:32Z",
                       "10:10:32+02:30", "10:10:32-00:00"),
    }
    for root, values in seeds.items():
        for seed in values:
            if not oracle(seed, root):
                raise ValueError(f"invalid duplication seed: {seed}")
            seen = set()
            for index, char in enumerate(seed):
                for copies in (2, 3):
                    value = seed[:index] + char * copies + seed[index + 1:]
                    if value in seen:
                        continue
                    seen.add(value)
                    yield f"{seed}/index-{index}/{copies}-copies", root, value


def cases():
    result = []

    def add(name, group, value, root, *, accepted=None, template=None, path="$.v"):
        kind = datatype(value, root)
        body = (template or "v:{kind} = {value}").format(kind=kind, value=value)
        result.append(Case(name, group, value, HEADER + body,
                           oracle(value, root) if accepted is None else accepted, path))

    # Each state is reached by a shortest representative prefix. Test EOF and
    # every representative next character, including invalid transitions.
    for root in ("year0", "time-hour0"):
        queue = deque([(root, "")])
        visited = set()
        while queue:
            state, prefix = queue.popleft()
            if state in visited:
                continue
            visited.add(state)
            add(f"{root}/{state}/EOF", "transitions", prefix, root)
            for char in REPRESENTATIVES:
                add(f"{root}/{state}/{char}", "transitions", prefix + char, root)
                target = EDGES.get(state, {}).get(char)
                if target is not None and target not in TERMINALS:
                    add(f"{root}/{state}/{char}/complete", "transition-completions",
                        prefix + char + completion(target), root)
                if target is not None and target not in visited:
                    queue.append((target, prefix + char))

    # Complete routes cover compositions that shortest-prefix probes cannot.
    for calendar in ("1111-", "1111-11", "1111-11-11"):
        for clock in ("11", "11:", "11:11", "11:11:11", "11:11:11.1000000000"):
            for offset in ("", "Z", "+11:11", "-00:00"):
                for context in ("", "&A", "&+/A/A"):
                    value = calendar + "T" + clock + offset + context
                    add(value, "compositions", value, "year0")
    for value in ("0000-", "0001-", "9999-", "10000-", "2024-00", "2024-01", "2024-12", "2024-13",
                  "2024-02-00", "2024-02-29", "2023-02-29", "1900-02-29", "2000-02-29",
                  "2024-04-30", "2024-04-31", "2024-12-31", "2024-12-32"):
        add(value, "ranges", value, "year0")
    # Month-specific off-by-one faults can survive a single representative
    # 30/31-day month. Cover each month in a common and leap year.
    for year in (2023, 2024):
        for month in range(1, 13):
            last = monthrange(year, month)[1]
            for day in (last - 1, last, last + 1):
                value = f"{year:04}-{month:02}-{day:02}"
                add(value, "calendar-boundaries", value, "year0")
    clocks = ("00:", "23:", "24:", "99:", "23:59", "23:60", "23:59:59", "23:59:60", "23:59:61",
              "11:11:11.", "11:11:11.0", "11:11:11.000000000", "11:11:11." + "1" * 200,
              "11:11.1", "11:.1", "11:11:11.1.1", "11:11:11+23:59", "11:11:11+24:00",
              "11:11:11+00:60", "11:11:11+00:00:01")
    for clock in clocks:
        add(clock, "ranges", clock, "time-hour0")
        add("date/" + clock, "ranges", "2024-T" + clock, "year0")
    for hour in ("00", "23", "24", "99"):
        for suffix in ("", "Z", "+01:00", "&A"):
            add(hour + suffix, "hour-only", "2024-T" + hour + suffix, "year0")
    for context in ("A", "A/A", "A_A", "A-A", "A+A", "A.A", "1", "local", "Local", "LOCAL",
                    "UTC", "TAI", "GPS", "+/A/A", "-36.1/144.1", "", "/A", "A/", "A//A",
                    "A/*A*/", "A&", "A:A", "Aé", "A١"):
        value = "2024-T11:11:11-00:00&" + context
        add(context, "contexts", value, "year0")
    boundary_values = ("1111-", "1111-11", "1111-11-11", "11:", "11:11:60.100",
                       "1111-T11", "1111-11T11:11Z", "1111-11-11T11:11-00:00&A")
    wrappers = {
        "EOF": ("v:{kind} = {value}", "$.v"),
        "LF": ("v:{kind} = {value}\nnext:number = 1", "$.v"),
        "SPACE": ("v:{kind} = {value} \nnext:number = 1", "$.v"),
        "TAB": ("v:{kind} = {value}\t\nnext:number = 1", "$.v"),
        "CRLF": ("v:{kind} = {value}\r\nnext:number = 1", "$.v"),
        "comma": ("v:{kind} = {value},next:number = 1", "$.v"),
        "list": ("v:list<{kind}> = [{value}]", "$.v[0]"),
        "tuple": ("v:tuple<{kind}> = ({value},)", "$.v[0]"),
        "object": ("v:object = {{x:{kind} = {value}}}", "$.v.x"),
        "attribute": ("v@{{x:{kind} = {value}}}:number = 1", "$.v.@.x"),
        "comment": ("v:{kind} = {value} // A\nnext:number = 1", "$.v"),
        "block-comment": ("v:{kind} = {value} /* A */\nnext:number = 1", "$.v"),
    }
    for value in boundary_values:
        root = "year0" if "-" in value[:5] else "time-hour0"
        for name, (template, path) in wrappers.items():
            add(value + "/" + name, "boundaries", value, root, template=template, path=path)
        for separator in (" ", "\t"):
            add(value + repr(separator), "missing-separator", value, root, accepted=False,
                template="v:{kind} = {value}" + separator + "next:number = 1")
        for suffix in ("//A", "/*A*/"):
            add(value + suffix, "comment-adjacency", value, root,
                accepted="&" not in value, template="v:{kind} = {value}" + suffix)
    for name, root, value in duplication_cases():
        add(name, "character-duplication", value, root)
    return result


def run_case(case: Case, timeout: float, *, commands=None, process_runner=subprocess.run):
    commands = COMMANDS if commands is None else commands
    failures = []
    canonical = {}
    with tempfile.TemporaryDirectory(prefix="aeon-temporal-flow-") as temp:
        fixture = Path(temp) / "input.aeon"
        def run(impl, source, command):
            fixture.write_text(source, encoding="utf-8")
            return process_runner([*commands[impl], *command[:1], str(fixture), *command[1:]],
                                  cwd=ROOT, capture_output=True, text=True, timeout=timeout)
        for impl in commands:
            try:
                inspected = run(impl, case.source, ["inspect", "--json", "--portable-aes"])
                envelope = json.loads(inspected.stdout)
                ok = inspected.returncode == 0 and not envelope.get("errors")
                if ok != case.accepted:
                    failures.append(f"{impl}: expected {'accept' if case.accepted else 'reject'}, got {'accept' if ok else 'reject'}: {envelope.get('errors')}")
                    continue
                if not ok:
                    continue
                events = envelope.get("events", [])
                event = next((e for e in events if e.get("path") == case.path), {})
                kind = "WTCDateTimeLiteral" if "&" in case.literal else "DateTimeLiteral" if "T" in case.literal else "TimeLiteral" if ":" in case.literal else "DateLiteral"
                if event.get("kind") != kind or event.get("value") != case.literal:
                    failures.append(f"{impl}: payload/kind mismatch at {case.path}: {event}")
                formatted = run(impl, case.source, ["fmt"])
                if formatted.returncode:
                    failures.append(f"{impl}: canonical rejection: {formatted.stdout or formatted.stderr}")
                    continue
                canonical[impl] = formatted.stdout
                again = run(impl, formatted.stdout, ["fmt"])
                if again.returncode or again.stdout != formatted.stdout:
                    failures.append(f"{impl}: canonical output is not idempotent")
                round_trip = run(impl, formatted.stdout, ["inspect", "--json", "--portable-aes"])
                after = json.loads(round_trip.stdout)
                # Ignore authored binding order: canonical output sorts object keys.
                def semantic(records):
                    return sorted(json.dumps(e, sort_keys=True) for e in records)
                if round_trip.returncode or after.get("errors") or semantic(events) != semantic(after.get("events", [])):
                    failures.append(f"{impl}: canonical reparse changed portable AES or failed")
            except (subprocess.TimeoutExpired, json.JSONDecodeError, OSError, KeyError) as exc:
                failures.append(f"{impl}: harness failure: {exc}")
    if len(set(canonical.values())) > 1:
        failures.append("cross-runtime canonical bytes differ")
    return {**asdict(case), "failures": failures, "canonical": canonical}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--list", action="store_true", help="Print the grammar-derived matrix without executing implementations")
    parser.add_argument("--group", action="append", help="Run only named groups (repeatable)")
    parser.add_argument("--jobs", type=int, default=6)
    parser.add_argument("--timeout", type=float, default=20)
    parser.add_argument("--report", type=Path, help="Write a machine-readable report including reproducible source for every case")
    parser.add_argument("--quiet", action="store_true", help="Print only failures/errors, not progress or successful summaries")
    args = parser.parse_args()
    matrix = cases()
    if args.group:
        unknown = set(args.group) - {c.group for c in matrix}
        if unknown:
            parser.error(f"unknown groups: {sorted(unknown)}")
        matrix = [c for c in matrix if c.group in args.group]
    if args.jobs < 1 or args.timeout <= 0:
        parser.error("jobs and timeout must be positive")
    if args.list:
        print(json.dumps([asdict(c) for c in matrix], indent=2, ensure_ascii=False))
        return 0
    for impl, cmd in COMMANDS.items():
        if not Path(cmd[1] if impl == "typescript" else cmd[0]).is_file():
            parser.error(f"missing {impl} executable; build all implementations first")
    if not args.quiet:
        print(f"Temporal flow: {len(matrix)} cases; {dict(Counter(c.group for c in matrix))}", flush=True)
    results = []
    with ThreadPoolExecutor(max_workers=args.jobs) as pool:
        pending = [pool.submit(run_case, c, args.timeout) for c in matrix]
        for future in as_completed(pending):
            result = future.result()
            results.append(result)
            if result["failures"]:
                print(f"FAIL {result['group']} {result['name']}: " + " | ".join(result["failures"]), flush=True)
            if not args.quiet and len(results) % 100 == 0:
                print(f"Progress {len(results)}/{len(matrix)}", flush=True)
    results.sort(key=lambda r: (r["group"], r["name"]))
    failed = sum(bool(r["failures"]) for r in results)
    report = {"total": len(results), "failed": failed, "passed": len(results) - failed, "cases": results}
    if args.report:
        args.report.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    if not args.quiet:
        print(f"Temporal flow summary: total={len(results)} failed={failed} passed={len(results) - failed}")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
