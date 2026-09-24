#!/usr/bin/env python3
"""CTS CLI adapter that deliberately imports the installed native wheel."""

from __future__ import annotations

import json
import sys
from pathlib import Path

from altopelago.aeon import _native


VALUE_FLAGS = {
    "--datatype-policy": "datatype_policy",
    "--limits-file": "limits_file",
    "--max-attribute-depth": "max_attribute_depth",
    "--max-separator-depth": "max_separator_depth",
    "--max-generic-depth": "max_generic_depth",
    "--max-events": "max_events",
}
BOOLEAN_FLAGS = {"--json", "--strict", "--transport", "--rich"}


def fail(message: str) -> None:
    print(message, file=sys.stderr)
    raise SystemExit(2)


def parse_arguments(arguments: list[str]) -> tuple[Path, dict[str, object]]:
    if not arguments or arguments[0] != "inspect":
        fail("installed-wheel CTS adapter only supports 'inspect'")
    options: dict[str, object] = {}
    source_path: Path | None = None
    index = 1
    while index < len(arguments):
        argument = arguments[index]
        if argument in BOOLEAN_FLAGS:
            options[argument.removeprefix("--").replace("-", "_")] = True
            index += 1
            continue
        option_name = VALUE_FLAGS.get(argument)
        if option_name is not None:
            if index + 1 >= len(arguments):
                fail(f"{argument} requires a value")
            options[option_name] = arguments[index + 1]
            index += 2
            continue
        if argument.startswith("--"):
            fail(f"unsupported installed-wheel CTS option: {argument}")
        if source_path is not None:
            fail("installed-wheel CTS adapter accepts exactly one source file")
        source_path = Path(argument)
        index += 1
    if source_path is None:
        fail("installed-wheel CTS adapter requires a source file")
    if not options.pop("json", False):
        fail("installed-wheel CTS adapter requires --json")
    return source_path, options


def optional_integer(options: dict[str, object], name: str) -> int | None:
    value = options.get(name)
    return None if value is None else int(str(value))


def main() -> None:
    source_path, options = parse_arguments(sys.argv[1:])
    strict = bool(options.pop("strict", False))
    transport = bool(options.pop("transport", False))
    if strict and transport:
        fail("cannot use both --strict and --transport")
    limits_file = options.get("limits_file")
    limits_source = Path(str(limits_file)).read_text() if limits_file is not None else None
    payload = _native.compile_cts_json(
        source_path.read_text(),
        mode="strict" if strict else "transport" if transport else None,
        datatype_policy=options.get("datatype_policy"),
        rich=bool(options.get("rich", False)),
        limits_source=limits_source,
        max_attribute_depth=optional_integer(options, "max_attribute_depth"),
        max_separator_depth=optional_integer(options, "max_separator_depth"),
        max_generic_depth=optional_integer(options, "max_generic_depth"),
        max_events=optional_integer(options, "max_events"),
    )
    parsed = json.loads(payload)
    for event in parsed.get("events", []):
        event["value"] = {"type": event.get("valueType")}
    print(json.dumps(parsed, separators=(",", ":")))


if __name__ == "__main__":
    main()
