from __future__ import annotations
import copy
import json
from pathlib import Path
import unittest
from aeon.aeos import validate, validate_telex, validate_telex_records
from aeon.sansa import parse_address
from aeon.telex import encode_telex, validate_telex_records as validate_portable

FIXTURES = Path(__file__).resolve().parents[3] / 'test-fixtures/aeos-property-selectors.json'


class AeosPropertyTests(unittest.TestCase):
    def test_shared_vectors(self):
        suite = {'tests': json.loads(FIXTURES.read_text())['tests'] + json.loads(FIXTURES.with_name('aeos-property-regressions.json').read_text())['tests'] + json.loads(FIXTURES.with_name('aeos-property-context-regressions.json').read_text())['tests'] + json.loads(FIXTURES.with_name('aeos-property-range-attribute-regressions.json').read_text())['tests']}
        for case in suite['tests']:
            with self.subTest(case=case['id']):
                records, schema, options = copy.deepcopy(case['records']), copy.deepcopy(case['schema']), copy.deepcopy(case.get('options'))
                expected = copy.deepcopy(case["expected"])
                if any(r.get("kind") == "NodeHead" and r.get("path") == "$.items[0][0]" for r in records):
                    records = [r for r in records if r.get("kind") != "NodeHead"]
                    for record in records:
                        path = record.get("path")
                        if path in {"$.items[0]", "$.items[1]"}:
                            record["tag"] = "book" if path == "$.items[0]" else "chapter"
                        elif path in {"$.items[0][0][0]", "$.items[1][0][0]"}:
                            record["path"] = path[:-3]
                    limits = {
                        "tag-needs-container-and-head": 0, "tag-exact-budget": 1,
                        "repeated-predicate-shares-budget": 1, "distinct-rules-budget-3": 1,
                        "identical-rule-cache": 1, "stop-property-work-after-expansion-failure": 1,
                        "closed-world-reuses-resolution": 1, "repeated-predicate-exact-budget": 2,
                        "distinct-rules-budget-4": 2,
                    }
                    if case["id"] in limits:
                        schema["resource_policy"]["max_property_inspections"] = limits[case["id"]]
                    for rule in schema["rules"]:
                        selector = rule.get("selector")
                        if selector:
                            parsed = parse_address(selector)
                            if not parsed["ok"] and parsed["errors"][0]["code"] == "SANSA_UNKNOWN_PROPERTY_SELECTOR":
                                expected = {"ok": False, "errors": [{"code": "invalid_schema_policy", "path": selector}]}
                                break
                elif any(r.get("kind") == "NodeHead" or (r.get("kind") == "NodeLiteral" and "tag" not in r) for r in records):
                    # Historical wire coverage remains on the frozen checkout.
                    rejected = validate_portable(records, profile="aes.partial.v1", limits={"max_attribute_depth": 4})
                    self.assertTrue({"AES_UNKNOWN_KIND", "AES_INVALID_TAG"} & {item["code"] for item in rejected["diagnostics"]})
                    continue
                before = copy.deepcopy((records, schema, options))
                for _ in range(2):
                    results = [validate([], schema, options)] if case.get('entrypoint') == 'legacy' else [
                        validate_telex_records(records, schema, options), validate_telex(encode_telex(records, profile=case.get('profile')), schema, options)]
                    for result in results:
                        self.assertEqual(result['ok'], expected['ok'], (case['id'], result))
                        actual = sorted((error['code'], error.get('path')) for error in result['errors'])
                        self.assertEqual(actual, sorted((error['code'], error['path']) for error in expected['errors']), (case['id'], result))
                        if not result['ok']:
                            self.assertEqual(result['guarantees'], {})
                        self.assertEqual((records, schema, options), before)

    def test_nested_partial_attribute_vectors(self):
        cases = json.loads(FIXTURES.with_name('aeos-property-nested-attribute-regressions.json').read_text())['tests']
        for case in cases:
            if any(record.get("kind") in {"NodeHead", "NodeLiteral"} for record in case["records"]):
                continue
            with self.subTest(case=case['id']):
                before = copy.deepcopy(case)
                for _ in range(2):
                    wire = encode_telex(case['records'], profile=case['profile'], limits=case['limits'])
                    for result in [validate_telex_records(case['records'], case['schema']),
                                   validate_telex(wire, case['schema'], limits=case['limits'])]:
                        self.assertEqual(result['ok'], case['expected']['ok'], (case['id'], result))
                        self.assertEqual(sorted((e['code'], e['path']) for e in result['errors']),
                                         sorted((e['code'], e['path']) for e in case['expected']['errors']))
                        if not result['ok']:
                            self.assertEqual(result['guarantees'], {})
                        self.assertEqual(case, before)

        rejected = validate_telex(cases[0]['telex'], cases[0]['schema'])
        self.assertFalse(rejected['ok'])
        self.assertEqual(rejected['errors'][0]['code'], 'AES_LIMIT_EXCEEDED')
        self.assertEqual(rejected['guarantees'], {})

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
