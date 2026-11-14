from __future__ import annotations
import json
from pathlib import Path
import sys
import unittest
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
from aeon import load_text
from aeon.canonical import canonicalize
from aeon.core import compile_source
from aeon.sansa import resolve_address
VECTORS = json.loads((ROOT.parents[1] / "test-fixtures/unicode-hardening-v1.json").read_text())

class UnicodeHardeningTests(unittest.TestCase):
    def test_exact_keys_references_and_canonical_fixed_points(self):
        for pair in VECTORS["identity_pairs"]:
            with self.subTest(case=pair["id"]):
                left, right = json.dumps(pair["left"], ensure_ascii=False), json.dumps(pair["right"], ensure_ascii=False)
                source = f'{left}="left"\n{right}="right"\nleftCopy=~[{left}]\nrightPointer=~>[{right}]'
                result=canonicalize(source);self.assertEqual([],result.errors)
                self.assertEqual(result.text,canonicalize(result.text).text)
                loaded=load_text(result.text);loaded.require_ok()
                self.assertEqual("left",loaded.require(f'$.[{left}]'))
                self.assertEqual("right",loaded.require(f'$.[{right}]'))
                self.assertEqual("left",loaded.require("$.leftCopy"))
                self.assertTrue(compile_source(f'{left}=1\n{left}=2').errors)
    def test_name_patterns_cover_unicode_codepoints_including_line_terminators(self):
        children=[{"name":name,"address":f'$[{i}]',"children":[]} for i,name in enumerate(VECTORS["wildcard_names"])]
        ns={"root":{"address":"$","children":children}}
        for pattern in ["?","*","plain","plain?","*\n"]:
            with self.subTest(pattern=pattern):
                wanted=[b for b in children if pattern=="*" or (len(b["name"])==1 if pattern=="?" else b["name"]=="plain" if pattern=="plain" else b["name"]=="plain\n" if pattern=="plain?" else b["name"].endswith("\n"))]
                result=resolve_address(f'$.({json.dumps(pattern)})',ns)
                self.assertTrue(result["ok"],result);self.assertEqual(wanted,result["bindings"])
                for actual,expected in zip(result["bindings"],wanted):self.assertIs(actual,expected)
