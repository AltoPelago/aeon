#!/usr/bin/env python3
"""Independent number/temporal dispatch and delimited-literal flow probes.

Public CLI acceptance, exact decoded payload, canonical parity, and semantic
round trips. The oracle imports no production AEON code. Quiet by default.
"""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from decimal import Decimal
import json
from pathlib import Path
import re
import runpy

FLOW = runpy.run_path(str(Path(__file__).with_name("stress-temporal-flow.py")))
DIGITS = r"[0-9](?:_?[0-9])*"
INTEGER = r"(?:0|[1-9](?:_?[0-9])*)"
NUMBER = re.compile(rf"[+-]?(?:{INTEGER}(?:\.{DIGITS})?|\.{DIGITS})(?:[eE][+-]?{DIGITS})?\Z")
ESCAPES = {"\\": "\\", '"': '"', "'": "'", "`": "`", "n": "\n", "r": "\r", "t": "\t", "b": "\b", "f": "\f"}


def numeric_dispatch(literal):
    for root in ("year0", "time-hour0"):
        if FLOW["oracle"](literal, root):
            kind = "WTCDateTimeLiteral" if "&" in literal else "DateTimeLiteral" if "T" in literal else "TimeLiteral" if root == "time-hour0" else "DateLiteral"
            return kind, literal
    if NUMBER.fullmatch(literal):
        return "NumberLiteral", literal.replace("_", "")
    return None


def decode(literal):
    """Decode a complete delimited literal, requiring full consumption."""
    if not literal or literal[0] not in "\"'`|":
        return None
    quote = literal[0]
    index, chars = 1, []
    while index < len(literal):
        char = literal[index]
        index += 1
        if char == quote:
            if index != len(literal) or (quote == "|" and not chars):
                return None
            return "".join(chars)
        if char in "\r\n" and quote != "`":
            return None
        if char != "\\":
            chars.append(char)
            continue
        if index == len(literal):
            return None
        escape = literal[index]
        index += 1
        if escape == "|" and quote == "|":
            chars.append("|")
        elif escape in ESCAPES:
            chars.append(ESCAPES[escape])
        elif escape == "u":
            if index < len(literal) and literal[index] == "{":
                end = literal.find("}", index + 1)
                raw = literal[index + 1:end] if end != -1 else ""
                if not re.fullmatch(r"[0-9A-Fa-f]{1,6}", raw):
                    return None
                scalar = int(raw, 16)
                index = end + 1
                if scalar > 0x10FFFF or 0xD800 <= scalar <= 0xDFFF:
                    return None
            else:
                raw = literal[index:index + 4]
                if not re.fullmatch(r"[0-9A-Fa-f]{4}", raw):
                    return None
                scalar = int(raw, 16)
                index += 4
                if 0xD800 <= scalar <= 0xDBFF:
                    tail = literal[index:index + 6]
                    if not re.fullmatch(r"\\u[Dd][CcDdEeFf][0-9A-Fa-f]{2}", tail):
                        return None
                    scalar = 0x10000 + ((scalar - 0xD800) << 10) + int(tail[2:], 16) - 0xDC00
                    index += 6
                elif 0xDC00 <= scalar <= 0xDFFF:
                    return None
            chars.append(chr(scalar))
        else:
            return None
    return None


@dataclass(frozen=True)
class LiteralCase:
    name: str
    group: str
    literal: str
    source: str
    accepted: bool
    kind: str | None
    expected_value: str | None
    path: str = "$.v"


def numeric_semantics(event):
    if event["kind"] != "NumberLiteral":
        return event
    spelling = event["value"]
    # Strip coefficient trailing zeroes without Decimal.normalize(), which
    # would round through the active decimal context. Preserve -0 and family.
    sign, digits, exponent = Decimal(spelling).as_tuple()
    digits = list(digits)
    if not any(digits):
        digits, exponent = [0], 0
    else:
        while len(digits) > 1 and digits[-1] == 0:
            digits.pop()
            exponent += 1
    family = "exponent" if "e" in spelling.lower() else "decimal" if "." in spelling else "integer"
    return {**event, "value": [sign, digits, exponent, family]}


def cases():
    output = []

    def add(name, group, literal, expected, datatype=None, template=None, path="$.v"):
        kind, value = expected if expected is not None else (None, None)
        head = f"v:{datatype}" if datatype else "v"
        source = (f'aeon:mode = "strict"\n' if datatype else "") + (
            template.format(literal=literal, datatype=datatype) if template else f"{head} = {literal}")
        output.append(LiteralCase(name, group, literal, source, expected is not None, kind, value, path))

    prefixes = ("", "0", "11", "2024", "+11", "-11", ".1", "+.1", "-.1", "1.1", "1e", "1e+", "1_",
                "2024-", "2024-02", "2024-02-29", "11:", "11:11", "11:11:60.100", "2024-T11", "2024-T11Z", "2024-T11-00:00", "2024-T11&A")
    representatives = ("", "1", "0", "A", "e", "E", "T", "Z", "+", "-", ".", ":", "_", "&", "/")
    for prefix in prefixes:
        for char in representatives:
            literal = prefix + char
            add(repr(prefix) + "/" + repr(char), "numeric-dispatch", literal, numeric_dispatch(literal))
    for literal in ("1e1_0", "0e+01", "0e-01", "1e01", "1e0_1", "0_1", "0_0", "-0_1.2", "0_1e2", "00", "01.2", "1._2", "1_.2", "1__2", "1e_2", "1e1_", "-2024-02", "+2024-02", "2024-02-29Z", "11:11&local", "1 2", "1e+2.3", "1.2:34"):
        add(literal, "numeric-dispatch-edges", literal, numeric_dispatch(literal))

    bodies = ("", "a", " ", " a ", "a\tb", "é🌊", "//not a comment", "/*not a comment*/", "{}[]():;&^>",
              'say "yes"', "don't", "a`b", "a|b",
              r"\n", r"\r", r"\t", r"\b", r"\f", r"\\", r"\'", r'\"', r"\`", r"\|", r"\q", r"\0", r"\x41",
              r"\u0041", r"\u0000", r"\u{41}", r"\u{000041}", r"\u{10FFFF}", r"\uD83D\uDE00",
              r"\uD800", r"\uDC00", r"\u{D800}", r"\u{110000}", r"\u{0000041}", r"\u{}", r"\u{G}",
              r"\u", r"\u0", r"\u00", r"\u000", r"\u{", r"\u{41", r"\uD800\u0041", r"\uD800\u{DC00}",
              "a\nb", "a\rb", "a\r\nb")
    for quote in ('"', "'", "|", "`"):
        datatype = "symbol" if quote == "|" else "string"
        for body in bodies:
            # Backtick raw CR/CRLF preservation is separate transport policy;
            # this lane covers LF payloads and escaped carriage returns.
            if quote == "`" and "\r" in body:
                continue
            literal = quote + body + quote
            value = decode(literal)
            expected = ("SymbolicLiteral" if quote == "|" else "StringLiteral", value) if value is not None else None
            add(repr(literal), "delimited-transitions", literal, expected, datatype)
        for suffix in ("", "a", "\\", "a\\", "a\\u", "a\\u{", "a\\uD800"):
            add(repr(quote + suffix), "delimited-eof", quote + suffix, None, datatype)
        for suffix in (quote, "1", "a", "|a|", '"b"', "`b`"):
            add(repr(quote + "a" + quote + suffix), "delimited-adjacency", quote + "a" + quote + suffix, None, datatype)

    # Explicit fixtures derived from the normative gutter rules, not the
    # implementation trim function. Expected payloads deliberately retain tabs.
    gutters = (
        ("", ""), (" abc ", " abc "), ("\n    first\n  second\n", "  first\nsecond"),
        ("first\n  second\n", "first\n  second"), ("\n\t\tfirst\n\tsecond\n", "\tfirst\nsecond"),
        ("\n\tfirst\n second\n", "\tfirst\n second"), ("\n first\n\tsecond\n", " first\n\tsecond"),
        ("\n \tfirst\n  second\n", "\tfirst\n second"), ("\n\t first\n\t\tsecond\n", " first\n\tsecond"),
        ("\n  first  \n \t \n  second\t\n\n", "first  \n\nsecond\t"), ("\n \t\n\n", ""),
    )
    for index, (payload, expected) in enumerate(gutters):
        for datatype in ("trimtick", "prose"):
            for gap in ("", " "):
                literal = ">" + gap + "`" + payload + "`"
                add(f"gutter-{index}/{datatype}/{len(gap)}", "trimtick-gutters", literal, ("StringLiteral", expected), datatype)
    for first in ("", " ", "  ", "\t", "\t\t", " \t", "\t "):
        for second in ("", " ", "  ", "\t", "\t\t", " \t", "\t "):
            gutter = "\t" if first.startswith("\t") else " "
            depth = min(len(indent) - len(indent.lstrip(gutter)) for indent in (first, second))
            literal = ">`\n" + first + "a\n \t\n" + second + "b\n`"
            expected = first[depth:] + "a\n\n" + second[depth:] + "b"
            add(repr(first) + "/" + repr(second), "trimtick-gutter-transitions", literal, ("StringLiteral", expected), "trimtick")
    for marker in (">>", ">>>", ">>>>"):
        for gap in ("", " "):
            add(marker + gap, "trimtick-openers", marker + gap + "`a`", None, "trimtick")
    for literal in (">", ">`", '>"a"', ">'a'", ">|a|", "> >`a`"):
        add(literal, "trimtick-openers", literal, None, "trimtick")
    for literal, datatype in (('"a"', "symbol"), ("|a|", "string"), ('"a"', "trimtick"), ('"a"', "prose"), (">`a`", "string"), ("`a`", "trimtick")):
        add(literal + "/" + datatype, "literal-family", literal, None, datatype)
        add(literal + "/" + datatype + "/typed-list", "literal-family", literal, None, datatype,
            "v:list = [:{datatype} = {literal}]", "$.v[0]")

    anchors = (("11", "number", ("NumberLiteral", "11")), ("2024-", "date", ("DateLiteral", "2024-")),
               ("11:", "time", ("TimeLiteral", "11:")), ("2024-T11", "datetime", ("DateTimeLiteral", "2024-T11")),
               ('"a\\nb"', "string", ("StringLiteral", "a\nb")), ("`a\nb`", "string", ("StringLiteral", "a\nb")),
               ("|a\\|b|", "symbol", ("SymbolicLiteral", "a|b")), (">`\n  a\n  b\n`", "prose", ("StringLiteral", "a\nb")))
    wrappers = {
        "following": ("v:{datatype} = {literal}\nnext:number = 1", "$.v"),
        "comma": ("v:{datatype} = {literal},next:number = 1", "$.v"),
        "line-comment": ("v:{datatype} = {literal}//comment\nnext:number = 1", "$.v"),
        "block-comment": ("v:{datatype} = {literal}/*comment*/\nnext:number = 1", "$.v"),
        "list": ("v:list<{datatype}> = [{literal}]", "$.v[0]"),
        "tuple": ("v:tuple<{datatype}> = ({literal},)", "$.v[0]"),
        "typed-list": ("v:list = [:{datatype} = {literal}]", "$.v[0]"),
        "typed-tuple": ("v:tuple = (:{datatype} = {literal},)", "$.v[0]"),
        "object": ("v:object = {{x:{datatype} = {literal}}}", "$.v.x"),
        "attribute": ("v@{{x:{datatype} = {literal}}}:number = 1", "$.v.@.x"),
    }
    for literal, datatype, expected in anchors:
        for wrapper, (template, path) in wrappers.items():
            add(datatype + "/" + repr(literal) + "/" + wrapper, "boundaries", literal, expected, datatype, template, path)
    return output


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--group", action="append")
    parser.add_argument("--list", action="store_true")
    parser.add_argument("--jobs", type=int, default=6)
    parser.add_argument("--timeout", type=float, default=20)
    parser.add_argument("--report", type=Path)
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args()
    matrix = cases()
    if args.group:
        unknown = set(args.group) - {case.group for case in matrix}
        if unknown:
            parser.error(f"unknown groups: {sorted(unknown)}")
        matrix = [case for case in matrix if case.group in args.group]
    if args.jobs < 1 or args.timeout <= 0:
        parser.error("jobs and timeout must be positive")
    if args.list:
        print(json.dumps([FLOW["asdict"](case) for case in matrix], indent=2))
        return 0
    for impl, command in FLOW["COMMANDS"].items():
        executable = command[1] if impl == "typescript" else command[0]
        if not Path(executable).is_file():
            parser.error(f"missing {impl} executable; build all implementations first")
    results = []
    with ThreadPoolExecutor(max_workers=args.jobs) as pool:
        futures = [pool.submit(FLOW["run_case"], case, args.timeout, semantic_key=numeric_semantics) for case in matrix]
        for future in as_completed(futures):
            result = future.result()
            results.append(result)
            if result["failures"]:
                print("FAIL " + result["group"] + " " + result["name"] + ": " + " | ".join(result["failures"]), flush=True)
    failed = sum(bool(result["failures"]) for result in results)
    report = {"total": len(results), "failed": failed, "passed": len(results) - failed,
              "cases": sorted(results, key=lambda result: (result["group"], result["name"]))}
    if args.report:
        args.report.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    if args.verbose:
        print(f"Literal flow: total={len(results)} failed={failed} passed={len(results) - failed}")
    return int(bool(failed))


if __name__ == "__main__":
    raise SystemExit(main())
