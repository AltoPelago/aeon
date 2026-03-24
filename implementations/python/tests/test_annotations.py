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
