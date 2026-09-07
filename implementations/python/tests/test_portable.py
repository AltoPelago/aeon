from __future__ import annotations

from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from aeon.core import CompileOptions, compile_source
from aeon.portable import (
    PYTHON_ASSIGNMENT_EVENTS_CONTRACT_V0,
    PYTHON_PORTABLE_AES_ADAPTER_V0,
    adapt_python_assignment_events_to_portable_aes,
    project_portable_events,
)


class PortableProjectionTests(unittest.TestCase):
    def test_named_legacy_adapter_returns_an_explicit_conversion_report(self) -> None:
        result = compile_source(
            'a@{role = "root"} = <tag("child")>\ncopy = ~a[0]\nitems:list<int> = [1]',
            CompileOptions(max_attribute_depth=8),
        )
        self.assertEqual([], result.errors)

        converted = adapt_python_assignment_events_to_portable_aes(result.events)
        report = converted["report"]
        self.assertIsInstance(report, dict)
        assert isinstance(report, dict)
        self.assertEqual(PYTHON_ASSIGNMENT_EVENTS_CONTRACT_V0, report["sourceContract"])
        self.assertEqual("aes.events.v0", report["targetContract"])
        self.assertEqual(PYTHON_PORTABLE_AES_ADAPTER_V0, report["adapter"])
        self.assertEqual("aes.complete.v0", report["profile"])
        self.assertIsNone(report["projection"])
        self.assertTrue(report["semanticLossless"])
        self.assertFalse(report["recordLossless"])
        self.assertFalse(report["provenanceLossless"])
        events = converted["events"]
        self.assertIsInstance(events, list)
        assert isinstance(events, list)
        self.assertFalse(any("span" in event for event in events))
        changes = report["changes"]
        self.assertIsInstance(changes, list)
        assert isinstance(changes, list)
        codes = {change["code"] for change in changes}
        self.assertTrue({
            "AES_COMPAT_NODE_HEAD_SYNTHESIZED",
            "AES_COMPAT_ATTRIBUTE_FLATTENED",
            "AES_COMPAT_DATATYPE_EXPANDED",
            "AES_COMPAT_REFERENCE_TRANSLATED",
            "AES_COMPAT_PROVENANCE_OMITTED",
        }.issubset(codes))

    def test_named_legacy_adapter_keeps_headers_opt_in(self) -> None:
        result = compile_source('aeon:mode = "transport"\na = 1')
        self.assertEqual([], result.errors)
        body = adapt_python_assignment_events_to_portable_aes(result.events, header=result.header)
        self.assertEqual(["$.a"], [event.get("path") for event in body["events"]])
        self.assertIn("AES_COMPAT_HEADER_EXCLUDED", [
            change["code"] for change in body["report"]["changes"]
        ])
        document = adapt_python_assignment_events_to_portable_aes(
            result.events,
            header=result.header,
            include_headers=True,
        )
        self.assertEqual("aeon.document.v0", document["report"]["projection"])
        self.assertEqual('$.["aeon:mode"]', document["events"][0]["header"])
        self.assertEqual("$.a", document["events"][1]["path"])

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
