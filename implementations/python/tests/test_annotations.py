from __future__ import annotations

from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from aeon.annotations import build_annotation_stream, format_attribute_path
from aeon.core import CompileOptions, compile_source


class AnnotationStreamTests(unittest.TestCase):
    def annotations_for(self, source: str) -> list[dict[str, object]]:
        result = compile_source(source)
        return build_annotation_stream(source, result.events)

    def test_no_structured_comments_returns_no_annotations(self) -> None:
        annotations = self.annotations_for("a = 1\n// plain\nb = 2")
        self.assertEqual([], annotations)

    def test_inline_trailing_binds_backward(self) -> None:
        annotations = self.annotations_for("a = 1 //? x: number = [>0]")
        self.assertEqual("$.a", annotations[0]["target"]["path"])

    def test_standalone_doc_binds_forward(self) -> None:
        annotations = self.annotations_for("//# docs\na = 1")
        self.assertEqual("doc", annotations[0]["kind"])
        self.assertEqual("$.a", annotations[0]["target"]["path"])

    def test_reserved_subtype_is_presented_next_to_kind(self) -> None:
        annotations = self.annotations_for("/{ structure }/\na = 1")
        self.assertEqual(["kind", "subtype", "form"], list(annotations[0])[:3])
        self.assertEqual("structure", annotations[0]["subtype"])

    def test_infix_container_comment_binds_to_nearest_element(self) -> None:
        annotations = self.annotations_for("a = [1, /? in-list ?/ 2]")
        self.assertEqual("$.a[1]", annotations[0]["target"]["path"])

    def test_block_comment_between_equals_and_value_reports_placement(self) -> None:
        annotations = self.annotations_for(
            "app:object = {\n"
            '  name:string = "alignment playground"\n'
            "  enabled:boolean = /# h #/ true\n"
            "  port:number = 8080\n"
            "}\n"
        )
        self.assertEqual("$.app.enabled", annotations[0]["target"]["path"])
        self.assertEqual({"after": "equals", "before": "value"}, annotations[0]["placement"])

    def test_forward_and_trailing_comments_report_placement(self) -> None:
        annotations = self.annotations_for("//# docs\na = 1 //? required\n")
        self.assertEqual({"before": "key"}, annotations[0]["placement"])
        self.assertEqual({"after": "value"}, annotations[1]["placement"])

    def test_at_sign_inside_comment_does_not_become_attribute_landmark(self) -> None:
        annotations = self.annotations_for('a/#@#/ :string = "hello"')
        self.assertEqual({"kind": "path", "path": "$.a"}, annotations[0]["target"])
        self.assertEqual({"after": "key", "before": "datatype-colon"}, annotations[0]["placement"])

    def test_non_ascii_attribute_key_uses_quoted_path_segment(self) -> None:
        self.assertEqual('$.a.@.["é"]', format_attribute_path("$.a", "é"))

    def test_node_comments_follow_its_tag_attributes_and_direct_children(self) -> None:
        source = (
            '/#before#/</#open#/a/#tag#/@{b/#key#/:n/#type#/=3, '
            '<"x.y"/#meta#/@{n/#leaf#/:n=1}>}/#scope#/:node/#dtype#/'
            '(/#children#/"hello"/#first#/,"world"/#second#/) >/#end#/'
        )
        compiled = compile_source(source, CompileOptions(max_attribute_depth=2))
        self.assertEqual([], compiled.errors)
        annotations = build_annotation_stream(source, compiled.events)
        by_comment = {item["raw"][2:-2]: item for item in annotations}
        for marker, path in {
            "before":"$.a", "open":"$.a", "tag":"$.a", "key":"$.a.@.b", "type":"$.a.@.b",
            "meta":'$.a.@.["x.y"]', "leaf":'$.a.@.["x.y"].@.n', "scope":"$.a",
            "dtype":"$.a", "children":"$.a", "first":"$.a[0]", "second":"$.a[1]", "end":"$.a",
        }.items():
            self.assertEqual({"kind": "path", "path": path}, by_comment[marker]["target"], marker)
        self.assertEqual({"after": "node-open", "before": "node-tag"}, by_comment["open"]["placement"])
        self.assertEqual({"after": "node-tag", "before": "attribute-marker"}, by_comment["meta"]["placement"])
        self.assertEqual({"after": "attribute-close", "before": "node-datatype-colon"}, by_comment["scope"]["placement"])

    def test_metadata_node_comments_use_real_token_boundaries(self) -> None:
        source = '<root@\n{<doc(|a<b|/#first#/, "right"/#second#/ )>, leaf/#key#/="leaf"}>'
        annotations = self.annotations_for(source)
        self.assertEqual(
            ["$.root.@.doc[0]", "$.root.@.doc[1]", "$.root.@.leaf"],
            [annotation["target"]["path"] for annotation in annotations],
        )

    def test_binding_head_gap_comments_report_placement(self) -> None:
        annotations = self.annotations_for(
            'aname/#A#/ :string = "alignment playground"\n'
            'bname:/#B#/ string = "alignment playground"\n'
            'cname:string/#C#/= "alignment playground"\n'
            'dname:string = /#D#/ "alignment playground"\n'
        )
        self.assertEqual({"after": "key", "before": "datatype-colon"}, annotations[0]["placement"])
        self.assertEqual({"after": "datatype-colon", "before": "datatype"}, annotations[1]["placement"])
        self.assertEqual({"after": "datatype", "before": "equals"}, annotations[2]["placement"])
        self.assertEqual({"after": "equals", "before": "value"}, annotations[3]["placement"])

    def test_eof_comment_is_unbound(self) -> None:
        annotations = self.annotations_for("a = 1\n//? x")
        self.assertEqual({"kind": "unbound", "reason": "eof"}, annotations[0]["target"])

    def test_no_bindable_document_is_unbound(self) -> None:
        annotations = self.annotations_for("//@ lonely")
        self.assertEqual({"kind": "unbound", "reason": "no_bindable"}, annotations[0]["target"])

    def test_shebang_and_host_directive_do_not_emit_annotations(self) -> None:
        annotations = self.annotations_for("#!/usr/bin/env aeon\n//! format:aeon.test.v1\na = 1")
        self.assertEqual([], annotations)


if __name__ == "__main__":
    unittest.main()
