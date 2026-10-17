#!/usr/bin/env python3
"""Test-only adapter for default and explicitly selected canonical source APIs."""
from pathlib import Path
import json
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "implementations/python/src"))

from aeon.canonical import CanonicalizeOptions, canonicalize


def main() -> None:
    request = json.load(sys.stdin)
    options = CanonicalizeOptions(max_attribute_depth=request.get("max_attribute_depth", 1))
    if "ordering" in request:
        options.ordering = request["ordering"]
    result = canonicalize(request["source"], options)
    errors = [error.to_json() for error in result.errors]
    # Match the existing TS/Rust test-adapter contract. Core's Python API
    # retains source/target paths; TS reference errors have no path field.
    for error in errors:
        if error["code"] in {"FORWARD_REFERENCE", "MISSING_REFERENCE_TARGET", "SELF_REFERENCE", "ATTRIBUTE_DEPTH_EXCEEDED"}:
            error["path"] = None
    print(json.dumps({"text": result.text, "errors": errors}))


if __name__ == "__main__":
    main()
