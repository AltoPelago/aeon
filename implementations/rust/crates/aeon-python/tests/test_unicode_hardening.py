from __future__ import annotations
import json
from pathlib import Path
import unittest
import altopelago.aeon as aeon
from altopelago.aeon import pytonic
VECTORS=json.loads((Path(__file__).resolve().parents[5]/"test-fixtures/unicode-hardening-v1.json").read_text(encoding="utf-8"))
class NativeUnicodeTests(unittest.TestCase):
    def test_unicode_length_matches_utf16_for_source_and_telex(self):
        for case in VECTORS["length_cases"]:
            value=json.dumps(case["value"],ensure_ascii=False); units=case["utf16"]
            source=f'value@{{label={value}}}={value}'
            for constraint,expected in [({"min_length":units,"max_length":units},True),({"max_length":units-1},False),({"min_length":units+1},False)]:
                for attribute in [False,True]:
                    schema={"schema_id":"unicode.units","schema_version":"1","rules":[{"path":"$.value","constraints":{"attributes":{"label":constraint}} if attribute else constraint}]}
                    for loader in [lambda:aeon.load_text(source,schema=json.dumps(schema)),lambda:aeon.load_telex_text(aeon.compile_to_telex(source).decode(),schema=json.dumps(schema))]:
                        with self.subTest(case=case["id"],constraint=constraint,attribute=attribute):
                            result=loader();self.assertEqual(expected,result.ok,result.validation_errors)
    def test_native_default_casing_exact_keys_and_profile_rejection(self):
        for pair in VECTORS["identity_pairs"]:
            left,right=json.dumps(pair["left"],ensure_ascii=False),json.dumps(pair["right"],ensure_ascii=False)
            doc=pytonic.loads(f'{left}="left"\n{right}="right"\nleftCopy=~[{left}]\nrightPointer=~>[{right}]')
            self.assertEqual("left",doc[pair["left"]].value.decoded)
            self.assertEqual("right",doc[pair["right"]].value.decoded)
        doc=pytonic.loads('value=1')
        for case in VECTORS["mapping_cases"]:
            if case["locale"]!="default":continue
            result=doc.query(f'from $.value\nselect {case["operation"]}({json.dumps(case["input"],ensure_ascii=False)})')
            self.assertTrue(result.ok);self.assertEqual(case["expected"],result.results[0].value.decoded)
        for profile in ["tr","az","aeon.value.string.intl.tr.v1"]:
            with self.assertRaises(ValueError):doc.query('from $.value\nselect lower("I")',profile=profile)

    def test_default_equality_preserves_all_dotted_i_pairs(self):
        doc=pytonic.loads('value=1')
        for a in VECTORS["exact_equality_values"]:
            for b in VECTORS["exact_equality_values"]:
                result=doc.query(f'from $.value\nselect {json.dumps(a,ensure_ascii=False)} == {json.dumps(b,ensure_ascii=False)}')
                self.assertTrue(result.ok);self.assertEqual(a==b,result.results[0].value.decoded)
