from __future__ import annotations

from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from aeon.sansa import parse_address, resolve_address


class SansaResolveTests(unittest.TestCase):
    def test_parses_pascal_case_representation_kind_filter(self) -> None:
        parsed = parse_address("$.document[0]%NodeHead")

        self.assertTrue(parsed["ok"])
        self.assertEqual("$.document[0]%NodeHead", parsed["address"]["canonical"])
        self.assertEqual("NodeHead", parsed["address"]["selectors"][-1]["name"])

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

    def test_navigates_portable_node_head_hierarchy(self) -> None:
        nested_text = {
            "address": "$.document[0][1][0][0]",
            "index": 0,
            "representationKind": "StringLiteral",
            "children": [],
        }
        nested_head = {
            "address": "$.document[0][1][0]",
            "index": 0,
            "representationKind": "NodeHead",
            "children": [nested_text],
        }
        nested_node = {
            "address": "$.document[0][1]",
            "index": 1,
            "representationKind": "NodeLiteral",
            "children": [nested_head],
        }
        text = {
            "address": "$.document[0][0]",
            "index": 0,
            "representationKind": "StringLiteral",
            "children": [],
        }
        head = {
            "address": "$.document[0]",
            "index": 0,
            "representationKind": "NodeHead",
            "children": [text, nested_node],
        }
        document = {
            "address": "$.document",
            "name": "document",
            "representationKind": "NodeLiteral",
            "children": [head],
        }
        root = {"address": "$", "representationKind": "ObjectNode", "children": [document]}
        head["parent"] = document
        text["parent"] = head
        nested_node["parent"] = head
        nested_head["parent"] = nested_node
        nested_text["parent"] = nested_head
        namespace = {
            "root": root,
            "children": lambda binding: binding.get("children", []),
            "parent": lambda binding: binding.get("parent"),
        }

        self.assertEqual(
            ["$.document[0]", "$.document[0][1][0]"],
            [binding["address"] for binding in resolve_address("$.document.**%NodeHead", namespace)["bindings"]],
        )
        self.assertEqual(
            ["$.document[0]"],
            [binding["address"] for binding in resolve_address("$.document[0][1].^%NodeHead", namespace)["bindings"]],
        )
        self.assertEqual([], resolve_address("$.document[1]", namespace)["bindings"])

    def test_binding_limit_fails_without_partial_results(self) -> None:
        children = [
            {"address": f"$.item{index}", "name": f"item{index}", "children": []}
            for index in range(3)
        ]
        result = resolve_address("$.*", {"root": {"address": "$", "children": children}}, {"maxBindings": 1})

        self.assertFalse(result["ok"])
        self.assertEqual([], result["bindings"])
        self.assertEqual("SANSA_RESOLVE_BINDING_LIMIT_EXCEEDED", result["errors"][0]["code"])
        self.assertEqual(1, result["errors"][0]["limit"])
        self.assertEqual(2, result["errors"][0]["observed"])


if __name__ == "__main__":
    unittest.main()
