from __future__ import annotations
import copy
import json
from pathlib import Path
import unittest
from aeon.aeos import validate, validate_telex, validate_telex_records
from aeon.telex import encode_telex

FIXTURES = Path(__file__).resolve().parents[3] / 'test-fixtures/aeos-property-selectors.json'


class AeosPropertyTests(unittest.TestCase):
    def test_shared_vectors(self):
        suite = json.loads(FIXTURES.read_text())
        for case in suite['tests']:
            with self.subTest(case=case['id']):
                records, schema, options = copy.deepcopy(case['records']), copy.deepcopy(case['schema']), copy.deepcopy(case.get('options'))
                before = copy.deepcopy((records, schema, options))
                for _ in range(2):
                    results = [validate([], schema, options)] if case['entrypoint'] == 'legacy' else [
                        validate_telex_records(records, schema, options), validate_telex(encode_telex(records), schema, options)]
                    for result in results:
                        self.assertEqual(result['ok'], case['expected']['ok'], (case['id'], result))
                        actual = sorted((error['code'], error.get('path')) for error in result['errors'])
                        expected = sorted((error['code'], error['path']) for error in case['expected']['errors'])
                        self.assertEqual(actual, expected, (case['id'], result))
                        if not result['ok']:
                            self.assertEqual(result['guarantees'], {})
                        self.assertEqual((records, schema, options), before)

    def test_property_limit_does_not_coerce(self):
        calls = []
        class Index:
            def __index__(self):
                calls.append('index')
                raise AssertionError('must not execute')
            def __int__(self):
                calls.append('int')
                raise AssertionError('must not execute')
        class Integer(int):
            pass
        class Float(float):
            pass
        schema = {'rules':[{'selector':'$.missing', 'constraints':{}}]}
        for value in [Index(), Integer(1), Float(1), float('inf'), float('nan')]:
            result = validate_telex_records([], schema, {'resourcePolicy':{'max_property_inspections':value}})
            self.assertFalse(result['ok'], value)
            self.assertEqual(result['errors'][0]['code'], 'invalid_schema_policy')
        self.assertEqual(calls, [])
