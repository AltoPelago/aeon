from __future__ import annotations

from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from aeon.sansa import resolve_address


class SansaResolveTests(unittest.TestCase):
    def test_preserves_identity_as_metadata_without_using_it_for_paths(self) -> None:
        child = {
            "address": "$.item",
            "identity": "ITEM",
            "name": "item",
            "children": [],
        }
        root = {
            "address": "$",
            "identity": "ROOT",
            "children": [child],
        }

        result = resolve_address("$.item", {"root": root})

        self.assertTrue(result["ok"])
        self.assertIs(child, result["bindings"][0])
        self.assertEqual("$.item", result["bindings"][0]["address"])
        self.assertEqual("ITEM", result["bindings"][0]["identity"])


if __name__ == "__main__":
    unittest.main()
