from __future__ import annotations
import json
import unittest
import altopelago.aeon as aeon


class NativeAeosPropertyTests(unittest.TestCase):
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
