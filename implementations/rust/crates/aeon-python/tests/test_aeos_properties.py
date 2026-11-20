from __future__ import annotations
import json
from pathlib import Path
import unittest
import altopelago.aeon as aeon


class NativeAeosPropertyTests(unittest.TestCase):
    def test_source_content_does_not_fabricate_direct_heads(self):
        for source in ['n=<book("x", "y")>', 'n=<book("x", "y", "z")>']:
            schema = {'schema_id':'test.actual.targets', 'schema_version':'1', 'rules':[
                {'selector':'$.n&key("n")[1]', 'constraints':{'required':True, 'type':'StringLiteral'}}]}
            result = aeon.load_telex_text(aeon.compile_to_telex(source).decode(), mode='loose', schema=json.dumps(schema))
            self.assertIsNotNone(result.validation, result.error)
            self.assertEqual([(error['code'], error['path']) for error in result.validation_errors],
                             [('missing_required_field','$.n&key("n")[1]')])
            self.assertEqual(result.validation['guarantees'], {})

    def test_qa_regressions_through_actual_telex_loader(self):
        fixture_root = Path(__file__).resolve().parents[5] / 'test-fixtures'
        cases = []
        for name in (
            'aeos-property-regressions.json',
            'aeos-property-context-regressions.json',
            'aeos-property-range-attribute-regressions.json',
        ):
            cases.extend(json.loads((fixture_root / name).read_text(encoding='utf-8'))['tests'])
        for case in cases:
            # Sparse positions exercise the low-level validators, not the JSON
            # materializer. Loader policy overrides remain outside its schema API.
            if case['id'].startswith('sparse-head-') or 'resource_policy' in case['schema']:
                continue
            with self.subTest(case=case['id']):
                schema = {'schema_id':'qa.properties', 'schema_version':'1', **case['schema']}
                for _ in range(2):
                    loaded = aeon.load_telex_text(case['telex'], mode='loose', schema=json.dumps(schema))
                    self.assertIsNotNone(loaded.validation, loaded.error)
                    self.assertEqual(loaded.validation['ok'], case['expected']['ok'], loaded.validation_errors)
                    self.assertEqual(sorted((error['code'], error['path']) for error in loaded.validation_errors),
                                     sorted((error['code'], error['path']) for error in case['expected']['errors']))
                    if not loaded.validation['ok']:
                        self.assertEqual(loaded.validation['guarantees'], {})

    def test_portable_keys_and_native_boundary(self):
        source = 'value=1'
        schema = {'schema_id':'test.properties', 'schema_version':'1', 'rules':[{'selector':'$.*&key("value")', 'constraints':{'required':True, 'type':'NumberLiteral'}}]}
        wire = aeon.compile_to_telex(source).decode()
        loaded = aeon.load_telex_text(wire, schema=json.dumps(schema))
        self.assertTrue(loaded.ok, loaded.validation_errors)
        self.assertTrue(loaded.validation['ok'])
        native = aeon.load_text(source, schema=json.dumps(schema))
        self.assertFalse(native.ok)
        self.assertTrue(any(error['code'] == 'invalid_schema_policy' for error in native.validation_errors))
        # The loader's existing schema-contract format does not admit resource
        # policy overrides. Exercise the default allowance through that API.
        wide_wire = aeon.compile_to_telex('\n'.join(f'k{i}=1' for i in range(10_001))).decode()
        schema['rules'][0]['selector'] = '$.*&key("missing")'
        failed = aeon.load_telex_text(wide_wire, schema=json.dumps(schema))
        self.assertFalse(failed.ok)
        self.assertEqual(failed.validation['guarantees'], {})
        self.assertTrue(any(error['code'] == 'invalid_schema_policy' for error in failed.validation_errors))

    def test_portable_node_and_head_validation_targets(self):
        wire = aeon.compile_to_telex('n=<book("yes")>').decode()
        schema = {'schema_id':'test.property.nodes', 'schema_version':'1', 'rules':[
            {'selector':'$.*&tag("book")', 'constraints':{'required':True, 'type':'NodeLiteral'}},
            {'selector':'$.n[0]&headTag("book")', 'constraints':{'required':True, 'type':'NodeHead'}},
        ]}
        loaded = aeon.load_telex_text(wire, mode='loose', schema=json.dumps(schema))
        self.assertIsNotNone(loaded.validation)
        self.assertTrue(loaded.validation['ok'], loaded.validation_errors)
        schema['rules'][1]['constraints']['type'] = 'NumberLiteral'
        failed = aeon.load_telex_text(wire, mode='loose', schema=json.dumps(schema))
        self.assertFalse(failed.validation['ok'])
        self.assertEqual([(error['code'], error['path']) for error in failed.validation_errors], [('type_mismatch','$.n[0]')])
