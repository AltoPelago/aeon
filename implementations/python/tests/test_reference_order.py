import json
from pathlib import Path
import unittest

from aeon.core import CompileOptions, compile_source


class ReferenceOrderTests(unittest.TestCase):
    def test_authored_reference_occurrences(self):
        fixtures = Path(__file__).resolve().parents[3] / 'test-fixtures/reference-authored-order.json'
        for fixture in json.loads(fixtures.read_text(encoding='utf-8')):
            with self.subTest(case=fixture['id']):
                options = CompileOptions(max_attribute_depth=fixture.get('maxAttributeDepth', 1))
                result = compile_source(fixture['source'], options)
                self.assertEqual(fixture['errors'], [error.code for error in result.errors])
                if fixture['errors']:
                    self.assertEqual([], result.events)
                    for error in result.errors:
                        self.assertTrue(fixture['source'][error.span.start.offset:error.span.end.offset].startswith('~'))
                    options.recovery = True
                    recovered = compile_source(fixture['source'], options)
                    self.assertTrue(recovered.events)
                    self.assertEqual(fixture['errors'], [error.code for error in recovered.errors])
