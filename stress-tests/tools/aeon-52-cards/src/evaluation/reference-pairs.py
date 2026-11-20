"""Batch adapter for the pure Python half of the 52-Cards paired pilot."""

import json
from pathlib import Path
import sys

if sys.version_info < (3, 12):
    sys.exit("The 52-Cards paired pilot needs Python 3.12 or newer. Set PYTHON to its executable.")

sys.path.insert(0, str(Path(__file__).resolve().parents[5] / "implementations/python/src"))

from aeon.canonical import canonicalize
from aeon.core import compile_source
from aeon.portable import adapt_python_assignment_events_to_portable_aes


def compile_graph(source):
    result = compile_source(source)
    if result.errors:
        return {"errors": [error.to_json() for error in result.errors]}
    records = adapt_python_assignment_events_to_portable_aes(
        result.events, header=result.header, include_headers=True
    )["events"]
    return {"errors": [], "records": records}


def format_source(source):
    result = canonicalize(source)
    return {"text": result.text, "errors": [error.to_json() for error in result.errors]}


def inspect(source):
    authored = compile_graph(source)
    canonical = format_source(source)
    result = {"authored": authored, "canonical": canonical}
    if not canonical["errors"]:
        result["reparsed"] = compile_graph(canonical["text"])
        result["fixed"] = format_source(canonical["text"])
    return result


def main():
    pairs = json.load(sys.stdin.buffer)
    json.dump(
        {"version": sys.version.split()[0], "pairs": [[inspect(source) for source in pair] for pair in pairs]},
        sys.stdout,
    )


if __name__ == "__main__":
    main()
