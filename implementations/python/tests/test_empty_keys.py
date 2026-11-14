import json
from pathlib import Path
import unittest
from aeon.core import compile_source
from aeon.canonical import canonicalize
from aeon.telex import parse_canonical_path

CASES = json.loads((Path(__file__).resolve().parents[3] / "test-fixtures/empty-keys.json").read_text())

class EmptyKeysTests(unittest.TestCase):
    def test_shared_vectors(self):
        for fixture in CASES:
            with self.subTest(fixture=fixture["id"]):
                result = compile_source(fixture["source"])
                if "error" in fixture:
                    self.assertIn(fixture["error"], [error.code for error in result.errors])
                else:
                    self.assertEqual([], result.errors)
                    self.assertEqual(fixture["paths"], [event["path"] for event in result.events])
                    for path in fixture["paths"]:
                        parse_canonical_path(path)

    def test_canonical_round_trips(self):
        for fixture in CASES:
            if "error" in fixture:
                continue
            with self.subTest(fixture=fixture["id"]):
                first = canonicalize(fixture["source"])
                self.assertEqual([], first.errors)
                second = canonicalize(first.text)
                self.assertEqual([], second.errors)
                self.assertEqual(first.text, second.text)
                self.assertEqual([], compile_source(first.text).errors)

    def test_empty_node_tag_remains_invalid(self):
        for source in ['value = <"">', "value = <''>"]:
            with self.subTest(source=source):
                result = compile_source(source)
                self.assertIn("SYNTAX_ERROR", [error.code for error in result.errors])
