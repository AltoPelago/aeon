from __future__ import annotations

from copy import deepcopy
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
        source = 'aeon:mode = "transport"\r\na = 1'
        result = compile_source(source)
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

        source_backed = adapt_python_assignment_events_to_portable_aes(
            result.events,
            header=result.header,
            include_headers=True,
            source_bytes=source.encode("utf-8"),
        )
        self.assertEqual("0:23", source_backed["events"][0]["span"])
        self.assertEqual("25:30", source_backed["events"][1]["span"])
        self.assertTrue(source_backed["report"]["provenanceLossless"])

    def test_converts_code_point_ranges_to_exact_utf8_byte_spans(self) -> None:
        source = (
            "\ufeff"
            + r'a = <tag\HEAD\@{role = "café"}:node("😀")>'
            + "\r\n"
            + 'b = "nai\u0308ve"'
        )
        result = compile_source(source, CompileOptions(max_attribute_depth=8))
        self.assertEqual([], result.errors)

        local = project_portable_events(result.events)
        head = next(event for event in local if event["path"] == "$.a[0]")
        head_span = head["span"]
        self.assertIsInstance(head_span, dict)
        assert isinstance(head_span, dict)
        start = head_span["start"]
        end = head_span["end"]
        assert isinstance(start, dict) and isinstance(end, dict)
        self.assertEqual(
            r'tag\HEAD\@{role = "café"}:node',
            source[start["offset"]:end["offset"]],
        )

        converted = adapt_python_assignment_events_to_portable_aes(
            result.events,
            source_bytes=source.encode("utf-8"),
        )
        origin = "sha256:c9063ff2481e76331f175afa8a6bd4d7f850048591e737047d8a0b6fc2a701b7"
        expected_lexemes = {
            "$.a": r'a = <tag\HEAD\@{role = "café"}:node("😀")>',
            "$.a[0]": r'tag\HEAD\@{role = "café"}:node',
            "$.a[0].@.role": 'role = "café"',
            "$.a[0][0]": '"😀"',
            "$.b": 'b = "nai\u0308ve"',
        }
        self.assertTrue(converted["report"]["provenanceLossless"])
        self.assertNotIn(
            "AES_COMPAT_PROVENANCE_OMITTED",
            {change["code"] for change in converted["report"]["changes"]},
        )
        for event in converted["events"]:
            path = event["path"]
            lexeme = expected_lexemes[path]
            code_point_start = source.index(lexeme)
            byte_start = len(source[:code_point_start].encode("utf-8"))
            byte_end = byte_start + len(lexeme.encode("utf-8"))
            self.assertEqual(origin, event["origin"])
            self.assertEqual(f"{byte_start}:{byte_end}", event["span"], path)

    def test_rejects_invalid_utf8_and_invalid_native_ranges(self) -> None:
        source = 'a = "😀"'
        result = compile_source(source)
        self.assertEqual([], result.errors)

        with self.assertRaisesRegex(ValueError, "valid UTF-8 artifact") as invalid_utf8:
            adapt_python_assignment_events_to_portable_aes(
                result.events,
                source_bytes=b"\xff",
            )
        self.assertEqual("AES_SOURCE_INVALID_UTF8", invalid_utf8.exception.code)

        invalid_events = deepcopy(result.events)
        invalid_span = invalid_events[0]["span"]
        assert isinstance(invalid_span, dict)
        invalid_end = invalid_span["end"]
        assert isinstance(invalid_end, dict)
        invalid_end["offset"] = 99
        with self.assertRaisesRegex(ValueError, "outside the exact UTF-8 artifact") as invalid_range:
            adapt_python_assignment_events_to_portable_aes(
                invalid_events,
                source_bytes=source.encode("utf-8"),
            )
        self.assertEqual("AES_COMPAT_SOURCE_RANGE_INVALID", invalid_range.exception.code)

    def project(self, source: str) -> list[dict[str, object]]:
        result = compile_source(source, CompileOptions(max_attribute_depth=8))
        self.assertEqual([], result.errors)
        return project_portable_events(result.events)

    def shapes(self, events: list[dict[str, object]]) -> list[tuple[object, object, object]]:
        return [(event["path"], event["kind"], event.get("identity")) for event in events]

    def test_separates_node_identities_at_expanded_paths(self) -> None:
        source = r'a\BINDING\ = <tag\HEAD\(\CHILD\ = "value")>'
        events = self.project(source)
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
        span = events[1]["span"]
        self.assertIsInstance(span, dict)
        assert isinstance(span, dict)
        start = span["start"]
        end = span["end"]
        assert isinstance(start, dict) and isinstance(end, dict)
        self.assertEqual(
            "tag\\HEAD\\",
            source[start["offset"]:end["offset"]],
        )

    def test_node_head_span_excludes_layout_after_datatype(self) -> None:
        source = "a = <tag:node\n(\"value\")>"
        events = self.project(source)
        head = next(event for event in events if event["path"] == "$.a[0]")
        span = head["span"]
        assert isinstance(span, dict)
        start = span["start"]
        end = span["end"]
        assert isinstance(start, dict) and isinstance(end, dict)
        self.assertEqual("tag:node", source[start["offset"]:end["offset"]])

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
