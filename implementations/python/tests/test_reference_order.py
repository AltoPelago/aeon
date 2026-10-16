import json
from pathlib import Path
import unittest

from aeon.core import CompileOptions, compile_source


class ReferenceOrderTests(unittest.TestCase):
    def test_retained_bindings_and_source_planes(self):
        cases = [
            ('header collision forward', 'aeon:version = 2.0\ncopy = ~["aeon:version"]\n"aeon:version" = 7', ['FORWARD_REFERENCE']),
            ('header collision backward', 'aeon:version = 2.0\n"aeon:version" = 7\ncopy = ~["aeon:version"]', []),
            ('header only', 'aeon:version = 2.0\ncopy = ~["aeon:version"]', []),
            ('body hides header attributes', 'aeon:header = {version@{z = 1} = 2.0}\n"aeon:version" = 7\ncopy = ~["aeon:version"].@.z', ['MISSING_REFERENCE_TARGET']),
            ('body attribute forward', 'aeon:header = {version@{z = 1} = 2.0}\ncopy = ~["aeon:version"].@.z\n"aeon:version"@{z = 2} = 7', ['FORWARD_REFERENCE']),
            ('header attribute only', 'aeon:header = {version@{z = 1} = 2.0}\ncopy = ~["aeon:version"].@.z', []),
            ('discarded duplicate target', 'a = {b = 1, b = {z = 2}}\ncopy = ~a.b.z', ['DUPLICATE_KEY', 'MISSING_REFERENCE_TARGET']),
            ('discarded duplicate claim', 'a = {b = 1, b = {z = ~missing}}', ['DUPLICATE_KEY']),
            ('retained first duplicate', 'a = {b = {z = 2}, b = 1}\ncopy = ~a.b.z', ['DUPLICATE_KEY']),
            ('discarded duplicate metadata', 'a = {b = 1, b@{z = 2} = 2}\ncopy = ~a.b.@.z', ['DUPLICATE_KEY', 'MISSING_REFERENCE_TARGET']),
        ]
        for name, source, expected in cases:
            with self.subTest(case=name):
                result = compile_source(source, CompileOptions(recovery=True))
                self.assertEqual(expected, [error.code for error in result.errors])

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
