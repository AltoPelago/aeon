from __future__ import annotations

from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from aeon.core import CompileOptions, compile_source
from aeon.portable import project_portable_events


class PortableProjectionTests(unittest.TestCase):
    def project(self, source: str) -> list[dict[str, object]]:
        result = compile_source(source, CompileOptions(max_attribute_depth=8))
        self.assertEqual([], result.errors)
        return project_portable_events(result.events)

    def shapes(self, events: list[dict[str, object]]) -> list[tuple[object, object, object]]:
        return [(event["path"], event["kind"], event.get("identity")) for event in events]

    def test_separates_node_identities_at_expanded_paths(self) -> None:
        events = self.project(r'a\BINDING\ = <tag\HEAD\(\CHILD\ = "value")>')
        self.assertEqual(
            [
                ("$.a", "NodeLiteral", "BINDING"),
                ("$.a[0]", "NodeHead", "HEAD"),
                ("$.a[0][0]", "StringLiteral", "CHILD"),
            ],
            self.shapes(events),
        )
        self.assertNotIn("value", events[0])
        self.assertEqual("tag", events[1]["value"])
        self.assertNotIn("span", events[1])

    def test_expands_nested_nodes_and_reference_targets(self) -> None:
        events = self.project('a = <outer(<inner("leaf")>)>\ncopy = ~a[0]\nalias = ~>a[0]')
        self.assertEqual(
            [
                ("$.a", "NodeLiteral"),
                ("$.a[0]", "NodeHead"),
                ("$.a[0][0]", "NodeLiteral"),
                ("$.a[0][0][0]", "NodeHead"),
                ("$.a[0][0][0][0]", "StringLiteral"),
            ],
            [(event["path"], event["kind"]) for event in events[:5]],
        )
        self.assertEqual("$.a[0][0]", events[5]["value"])
        self.assertEqual("$.a[0][0]", events[6]["value"])

    def test_translates_quoted_node_paths_and_reference_targets(self) -> None:
        events = self.project('"a.b" = <outer("leaf")>\ncopy = ~["a.b"][0]')
        self.assertEqual(
            ['$.["a.b"]', '$.["a.b"][0]', '$.["a.b"][0][0]', "$.copy"],
            [event["path"] for event in events],
        )
        self.assertEqual('$.["a.b"][0][0]', events[3]["value"])

    def test_flattens_attributes_in_source_preorder(self) -> None:
        events = self.project(
            r'a\ROOT\@{x\X\@{deep\D\ = 3} = { b\B\ = 2 }} = '
            r'<tag\HEAD\@{role\R\ = "button"}(\CHILD\@{unit\U\ = "cm"} = "value")>'
        )
        self.assertEqual(
            [
                ("$.a", "NodeLiteral", "ROOT"),
                ("$.a.@.x", "ObjectNode", "X"),
                ("$.a.@.x.@.deep", "NumberLiteral", "D"),
                ("$.a.@.x.b", "NumberLiteral", "B"),
                ("$.a[0]", "NodeHead", "HEAD"),
                ("$.a[0].@.role", "StringLiteral", "R"),
                ("$.a[0][0]", "StringLiteral", "CHILD"),
                ("$.a[0][0].@.unit", "StringLiteral", "U"),
            ],
            self.shapes(events),
        )

    def test_expands_nodes_and_quoted_members_inside_attribute_space(self) -> None:
        events = self.project(r'a@{"x.y" = <inner\HEAD\(\CHILD\ = "value")>} = 1')
        self.assertEqual(
            [
                "$.a",
                '$.a.@.["x.y"]',
                '$.a.@.["x.y"][0]',
                '$.a.@.["x.y"][0][0]',
            ],
            [event["path"] for event in events],
        )

    def test_uses_canonical_quoted_object_members_in_attribute_space(self) -> None:
        events = self.project('a@{"x.y" = { "deep key" = 1 }} = 0')
        self.assertEqual(
            ["$.a", '$.a.@.["x.y"]', '$.a.@.["x.y"].["deep key"]'],
            [event["path"] for event in events],
        )

    def test_normalizes_number_payloads_at_the_portable_boundary(self) -> None:
        events = self.project("a = +.50\nb = 1.00E+2")
        self.assertEqual(["0.5", "1e+2"], [events[0]["value"], events[1]["value"]])

    def test_preserves_attribute_declaration_order(self) -> None:
        events = self.project("a@{z = 1, a = 2} = 0")
        self.assertEqual(
            ["$.a", "$.a.@.z", "$.a.@.a"],
            [event["path"] for event in events],
        )

    def test_distinguishes_datetime_and_wtc_representation_kinds(self) -> None:
        events = self.project("ordinary = 2025-01-01T09:30Z\nworld = 2025-01-01T09:30&local")
        self.assertEqual(
            ["DateTimeLiteral", "WTCDateTimeLiteral"],
            [event["kind"] for event in events],
        )


if __name__ == "__main__":
    unittest.main()
