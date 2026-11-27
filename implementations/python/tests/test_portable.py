from __future__ import annotations

from copy import deepcopy
import hashlib
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
            '<a@{role = "root"}("child")>\ncopy = ~a[0]\nitems:list<int> = [1]',
            CompileOptions(max_attribute_depth=8),
        )
        self.assertEqual([], result.errors)

        converted = adapt_python_assignment_events_to_portable_aes(result.events)
        report = converted["report"]
        self.assertIsInstance(report, dict)
        assert isinstance(report, dict)
        self.assertEqual(PYTHON_ASSIGNMENT_EVENTS_CONTRACT_V0, report["sourceContract"])
        self.assertEqual("aes.events.v1", report["targetContract"])
        self.assertEqual(PYTHON_PORTABLE_AES_ADAPTER_V0, report["adapter"])
        self.assertEqual("aes.complete.v1", report["profile"])
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
            "AES_COMPAT_ATTRIBUTE_FLATTENED",
            "AES_COMPAT_DATATYPE_EXPANDED",
            "AES_COMPAT_PROVENANCE_OMITTED",
        }.issubset(codes))
        self.assertTrue(codes.isdisjoint({"AES_COMPAT_NODE_HEAD_SYNTHESIZED",
                                          "AES_COMPAT_PATH_TRANSLATED", "AES_COMPAT_REFERENCE_TRANSLATED"}))

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
        self.assertEqual("aeon.document.v1", document["report"]["projection"])
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

    def test_document_projection_completes_structured_header_containers(self) -> None:
        result = compile_source(
            'aeon:header = {\n  mode = "transport"\n'
            '  conventions = ["one", "two"]\n}\na = 1\n',
            CompileOptions(mode="transport"),
        )
        self.assertEqual([], result.errors)

        document = adapt_python_assignment_events_to_portable_aes(
            result.events,
            header=result.header,
            include_headers=True,
        )
        self.assertEqual(
            [
                '$.["aeon:mode"]',
                '$.["aeon:conventions"]',
                '$.["aeon:conventions"][0]',
                '$.["aeon:conventions"][1]',
            ],
            [event.get("header") for event in document["events"][:4]],
        )
        self.assertEqual(
            ["StringLiteral", "ListNode", "StringLiteral", "StringLiteral"],
            [event["kind"] for event in document["events"][:4]],
        )
        self.assertEqual("$.a", document["events"][4]["path"])

    def test_same_name_quoted_aeon_prefix_key_remains_in_the_body_plane(self) -> None:
        result = compile_source('aeon:mode = "transport"\n"aeon:mode" = 1\n')
        self.assertEqual([], result.errors)
        self.assertEqual(["aeon:mode"], [event["key"] for event in result.events])
        self.assertEqual(["body"], [event["sourcePlane"] for event in result.events])

        document = adapt_python_assignment_events_to_portable_aes(
            result.events,
            header=result.header,
            include_headers=True,
        )
        self.assertEqual(
            ['$.["aeon:mode"]', '$.["aeon:mode"]'],
            [event.get("header") or event.get("path") for event in document["events"]],
        )

    def test_converts_code_point_ranges_to_exact_utf8_byte_spans(self) -> None:
        source = (
            "\ufeff"
            + r'<a\HEAD\@{role = "café"}:node("😀")>'
            + "\r\n"
            + 'b = "nai\u0308ve"'
        )
        result = compile_source(source, CompileOptions(max_attribute_depth=8))
        self.assertEqual([], result.errors)

        local = project_portable_events(result.events)
        head = next(event for event in local if event["path"] == "$.a")
        head_span = head["span"]
        self.assertIsInstance(head_span, dict)
        assert isinstance(head_span, dict)
        start = head_span["start"]
        end = head_span["end"]
        assert isinstance(start, dict) and isinstance(end, dict)
        self.assertEqual(
            r'<a\HEAD\@{role = "café"}:node("😀")>',
            source[start["offset"]:end["offset"]],
        )

        converted = adapt_python_assignment_events_to_portable_aes(
            result.events,
            source_bytes=source.encode("utf-8"),
        )
        origin = "sha256:" + hashlib.sha256(source.encode("utf-8")).hexdigest()
        expected_lexemes = {
            "$.a": r'<a\HEAD\@{role = "café"}:node("😀")>',
            "$.a.@.role": 'role = "café"',
            "$.a[0]": '"😀"',
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

    def test_preserves_intrinsic_node_and_child_identities(self) -> None:
        source = r'<a\HEAD\(\CHILD\ = "value")>'
        events = self.project(source)
        self.assertEqual(
            [
                ("$.a", "NodeLiteral", "HEAD"),
                ("$.a[0]", "StringLiteral", "CHILD"),
            ],
            self.shapes(events),
        )
        self.assertNotIn("value", events[0])
        self.assertEqual("a", events[0]["tag"])
        span = events[0]["span"]
        self.assertIsInstance(span, dict)
        assert isinstance(span, dict)
        start = span["start"]
        end = span["end"]
        assert isinstance(start, dict) and isinstance(end, dict)
        self.assertEqual(
            source,
            source[start["offset"]:end["offset"]],
        )

    def test_whole_node_span_includes_layout_after_datatype(self) -> None:
        source = "<a:node\n(\"value\")>"
        events = self.project(source)
        head = next(event for event in events if event["path"] == "$.a")
        span = head["span"]
        assert isinstance(span, dict)
        start = span["start"]
        end = span["end"]
        assert isinstance(start, dict) and isinstance(end, dict)
        self.assertEqual(source, source[start["offset"]:end["offset"]])

    def test_expands_nested_nodes_and_reference_targets(self) -> None:
        events = self.project('<a(<inner("leaf")>)>\ncopy = ~a[0]\nalias = ~>a[0]')
        self.assertEqual(
            [
                ("$.a", "NodeLiteral"),
                ("$.a[0]", "NodeLiteral"),
                ("$.a[0][0]", "StringLiteral"),
            ],
            [(event["path"], event["kind"]) for event in events[:3]],
        )
        self.assertEqual("$.a[0]", events[3]["value"])
        self.assertEqual("$.a[0]", events[4]["value"])

    def test_preserves_quoted_node_paths_and_reference_targets(self) -> None:
        events = self.project('<"a.b"("leaf")>\ncopy = ~["a.b"][0]')
        self.assertEqual(
            ['$.["a.b"]', '$.["a.b"][0]', "$.copy"],
            [event["path"] for event in events],
        )
        self.assertEqual('$.["a.b"][0]', events[2]["value"])

    def test_flattens_attributes_in_source_preorder(self) -> None:
        events = self.project(
            r'<a\HEAD\@{x\X\@{deep\D\ = 3} = { b\B\ = 2 }, '
            r'role\R\ = "button"}(\CHILD\@{unit\U\ = "cm"} = "value")>'
        )
        self.assertEqual(
            [
                ("$.a", "NodeLiteral", "HEAD"),
                ("$.a.@.x", "ObjectNode", "X"),
                ("$.a.@.x.@.deep", "NumberLiteral", "D"),
                ("$.a.@.x.b", "NumberLiteral", "B"),
                ("$.a.@.role", "StringLiteral", "R"),
                ("$.a[0]", "StringLiteral", "CHILD"),
                ("$.a[0].@.unit", "StringLiteral", "U"),
            ],
            self.shapes(events),
        )

    def test_expands_nodes_and_quoted_members_inside_attribute_space(self) -> None:
        events = self.project(r'a@{<"x.y"\HEAD\(\CHILD\ = "value")>} = 1')
        self.assertEqual(
            [
                "$.a",
                '$.a.@.["x.y"]',
                '$.a.@.["x.y"][0]',
            ],
            [event["path"] for event in events],
        )

    def test_named_header_tags_are_qualified_in_the_header_plane(self) -> None:
        source = 'aeon:header = { <"aeon:custom"("header")>, <"aeon:"> }\n<"aeon:custom"("body")>'
        compiled = compile_source(source)
        self.assertEqual([], compiled.errors)
        for events in (compiled.events, compiled.internal_events):
            records = adapt_python_assignment_events_to_portable_aes(
                events, header=compiled.header, include_headers=True, source_bytes=source.encode(),
            )["events"]
            tagged = [
                (record.get("header"), record.get("path"), record["tag"])
                for record in records if record["kind"] == "NodeLiteral"
            ]
            self.assertEqual([
                ('$.["aeon:custom"]', None, "aeon:custom"),
                ('$.["aeon:aeon:"]', None, "aeon:aeon:"),
                (None, '$.["aeon:custom"]', "aeon:custom"),
            ], tagged)
        for fields in ('<custom>, <"aeon:custom">', 'custom=1, <"aeon:custom">'):
            collided = compile_source(f"aeon:header = {{ {fields} }}")
            self.assertEqual(["DUPLICATE_KEY"], [error.code for error in collided.errors])

    def test_uses_canonical_quoted_object_members_in_attribute_space(self) -> None:
        events = self.project('a@{"x.y" = { "deep key" = 1 }} = 0')
        self.assertEqual(
            ["$.a", '$.a.@.["x.y"]', '$.a.@.["x.y"].["deep key"]'],
            [event["path"] for event in events],
        )

    def test_normalizes_number_payloads_at_the_portable_boundary(self) -> None:
        events = self.project(
            "a = +.50\nb = 1.00E+2\nc = 0e+01\nd = 0e-01\ne = -0e+01\nf = -0e-01"
        )
        self.assertEqual(
            ["0.5", "1e2", "0e0", "0e0", "-0e0", "-0e0"],
            [event["value"] for event in events],
        )

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
