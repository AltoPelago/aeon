from __future__ import annotations
import copy
import json
from pathlib import Path
import unittest
from aeon.aeos import validate

FIXTURES = Path(__file__).resolve().parents[3] / "test-fixtures/aeos-child-identity-selectors.json"

class AeosChildIdentityTests(unittest.TestCase):
    def test_shared_vectors(self):
        suite = json.loads(FIXTURES.read_text())
        for case in suite["tests"]:
            with self.subTest(case=case["id"]):
                events, schema = copy.deepcopy(case["events"]), copy.deepcopy(case["schema"])
                before = copy.deepcopy(events)
                result = validate(events, schema, case.get("options"))
                e = case["expected"]
                self.assertEqual(result["ok"], e["ok"], result)
                self.assertEqual(events,before)
                if not result["ok"]:
                    self.assertEqual(result["guarantees"],{})
                    self.assertTrue(any(d["code"]==e["error"] and ("errorPath" not in e or d["path"]==e["errorPath"]) for d in result["errors"]),result)
                    if "errorCount" in e:self.assertEqual(len(result["errors"]),e["errorCount"])
                # New invocation must never reuse a prior document's snapshot or budget.
                self.assertEqual(validate(events,schema,case.get("options"))["ok"],e["ok"])

    def test_source_and_telex_targets(self):
        from aeon.core import compile_source
        from aeon.aeos import validate_events, validate_telex
        from aeon.portable import export_telex
        compiled=compile_source('items=[\\first\\={name\\label\\="hello"}]')
        self.assertEqual(compiled.errors,[])
        schema={"rules":[{"selector":"$.items.\\first\\.\\label\\","constraints":{"required":True,"type":"StringLiteral"}}]}
        self.assertTrue(validate_events(compiled.events,schema)["ok"])
        wire=export_telex(compiled.events)
        self.assertTrue(validate_telex(wire,schema)["ok"])
        schema["rules"][0]["constraints"]["type"]="NumberLiteral"
        for result in [validate_events(compiled.events,schema),validate_telex(wire,schema)]:
            self.assertFalse(result["ok"])
            self.assertTrue(any(e["path"]=="$.items[0].name" and e["code"]=="type_mismatch" for e in result["errors"]))
