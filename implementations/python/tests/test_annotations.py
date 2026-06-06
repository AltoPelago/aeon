from __future__ import annotations

from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from aeon.annotations import build_annotation_stream
from aeon.core import compile_source


class AnnotationStreamTests(unittest.TestCase):
    def annotations_for(self, source: str) -> list[dict[str, object]]:
        result = compile_source(source)
        return build_annotation_stream(source, result.events)

    def test_inline_trailing_binds_backward(self) -> None:
        annotations = self.annotations_for("a = 1 //? x: number = [>0]")
        self.assertEqual("$.a", annotations[0]["target"]["path"])

    def test_standalone_doc_binds_forward(self) -> None:
        annotations = self.annotations_for("//# docs\na = 1")
        self.assertEqual("doc", annotations[0]["kind"])
        self.assertEqual("$.a", annotations[0]["target"]["path"])

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

    def test_binding_and_node_head_comments_stay_on_container_path(self) -> None:
        annotations = self.annotations_for(
            '/#1#/a/#a#/@/#@#/{/#{#/b/#b#/:/#:#/n/#n#/=/#=#/3/#3#/}/#}#/:/#:#/node/#node#/=/#=#/</#<#/tag/#tag#/(/#(#/"hello"/#"hello"#/,/#,#/"world"/#"world"#/)/#)#/>/#>#/'
        )

        self.assertEqual(21, len(annotations))
        for annotation in annotations[1:16]:
            self.assertEqual({"kind": "path", "path": "$.a"}, annotation["target"], annotation["raw"])
        self.assertEqual({"kind": "path", "path": "$.a[0]"}, annotations[16]["target"])
        self.assertEqual({"kind": "path", "path": "$.a[1]"}, annotations[17]["target"])
        self.assertEqual({"kind": "path", "path": "$.a[1]"}, annotations[18]["target"])
        self.assertEqual({"kind": "path", "path": "$.a"}, annotations[20]["target"])

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
