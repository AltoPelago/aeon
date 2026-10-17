#!/usr/bin/env python3
"""Canonical API adapter: imports only the installed native Python package."""
from __future__ import annotations

import json
import sys

from altopelago.aeon import CompileError, canonicalize


def main() -> None:
    request = json.load(sys.stdin)
    try:
        text = canonicalize(
            request["source"], **({"ordering": request["ordering"]} if "ordering" in request else {}),
            max_attribute_depth=request.get("max_attribute_depth", 1),
        )
        result = {"text": text, "errors": []}
    except CompileError as error:
        def position(value):
            return {"line": value.line, "column": value.column, "offset": value.offset}

        # This API either returns text or raises diagnostics; its exception
        # channel has no partial-text payload. Do not invoke a fallback writer.
        result = {"text": "", "errors": [{
            "code": diagnostic.code,
            "message": diagnostic.message,
            # The TS reference-error DTO has no path; match the existing
            # Rust/pure-Python test adapters, not the public native API.
            "path": None if diagnostic.code in {
                "FORWARD_REFERENCE", "MISSING_REFERENCE_TARGET", "SELF_REFERENCE", "ATTRIBUTE_DEPTH_EXCEEDED",
            } else diagnostic.path,
            "phase": diagnostic.phase,
            "span": None if diagnostic.span is None else {
                "start": position(diagnostic.span.start),
                "end": position(diagnostic.span.end),
            },
        } for diagnostic in error.diagnostics]}
    print(json.dumps(result))


if __name__ == "__main__":
    main()
