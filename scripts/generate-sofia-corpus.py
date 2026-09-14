#!/usr/bin/env python3
"""Generate deterministic synthetic fixtures for the Sofia baseline corpus."""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path


HEADER = """aeon:header = {
  encoding:string = \"utf-8\"
  mode:string = \"transport\"
}

"""


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path, help="Directory to receive generated .aeon files.")
    parser.add_argument(
        "--json",
        action="store_true",
        help="Emit a machine-readable inventory after generation.",
    )
    return parser.parse_args()


def flat_bindings(count: int) -> str:
    return HEADER + "".join(f"v{index:05d}:int32 = {index}\n" for index in range(count))


def fixtures() -> dict[str, str]:
    return {
        "tiny-typed.aeon": HEADER + 'message:string = "hello, Sofia"\n',
        "large-flat-50000.aeon": flat_bindings(50_000),
        "wide-object-20000.aeon": HEADER
        + "root = {\n"
        + "".join(f"  v{index:05d}:int32 = {index}\n" for index in range(20_000))
        + "}\n",
        "wide-list-50000.aeon": HEADER
        + "root:list<int32> = [\n"
        + "".join(f"  {index}\n" for index in range(50_000))
        + "]\n",
        "wide-tuple-20000.aeon": HEADER
        + "root:tuple = (\n"
        + ",\n".join(f"  {index}" for index in range(20_000))
        + "\n)\n",
        "wide-node-20000.aeon": HEADER
        + "root:node = <row(\n"
        + ",\n".join(f"  {index}" for index in range(20_000))
        + "\n)>\n",
        "unicode-10000.aeon": HEADER
        + "".join(
            f'"κλειδί{index:05d}":string = "🌊 София 東京 café {index}"\n'
            for index in range(10_000)
        ),
        "references-10000.aeon": HEADER
        + "".join(
            f"source{index:05d}:int32 = {index}\nclone{index:05d} = ~source{index:05d}\n"
            for index in range(10_000)
        ),
        "datatypes-10000.aeon": HEADER.replace('"transport"', '"strict"')
        + "".join(
            f"value{index:05d}:list<int32> = [0, 1, 2]\n"
            f"number{index:05d}:n[10] = 22\n"
            f'label{index:05d}:string[333] = "value"\n'
            f"radix{index:05d}:radix2[4] = %111\n"
            for index in range(10_000)
        ),
        "attributes-10000.aeon": HEADER
        + "".join(
            f"value{index:05d}@{{ordinal:int32 = {index}}} = {index}\n"
            for index in range(10_000)
        ),
        "comments-10000.aeon": HEADER
        + "".join(
            f"//# binding {index}\nvalue{index:05d}:int32 = {index} //? measured\n"
            for index in range(10_000)
        ),
        "invalid-late-20000.aeon": flat_bindings(20_000) + "trailing garbage ???\n",
    }


def main() -> int:
    args = parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    inventory: list[dict[str, object]] = []
    for name, source in fixtures().items():
        data = source.encode("utf-8")
        path = args.output / name
        path.write_bytes(data)
        inventory.append(
            {
                "fixture": name,
                "bytes": len(data),
                "sha256": hashlib.sha256(data).hexdigest(),
            }
        )

    if args.json:
        json.dump(
            {
                "schema": "aeon.sofia.generated-corpus.v1",
                "generator_version": 1,
                "output": str(args.output.resolve()),
                "fixtures": inventory,
            },
            fp=sys.stdout,
            indent=2,
        )
        print()
    else:
        print(f"generated {len(inventory)} Sofia fixtures in {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
