from __future__ import annotations

import json
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from aeon._radix import radix_base_from_number, resolve_radix_base_from_datatype
from aeon.core import compile_source
from aeon.finalize import finalize_json, FinalizeOptions
from aeon.portable_finalize import finalize_portable_json, PortableFinalizeOptions
from aeon.portable import adapt_python_assignment_events_to_portable_aes
from aeon.aeos import validate_events, validate_telex_records

FIXTURES = json.loads((ROOT.parents[1] / "test-fixtures/radix-bases.json").read_text())


class ExactRadixTests(unittest.TestCase):
    def test_exact_numeric_resolution(self):
        for fixture in FIXTURES:
            with self.subTest(literal=fixture["literal"]):
                self.assertEqual(fixture["base"], radix_base_from_number(fixture["literal"]))

    def test_input_sized_bounds(self):
        self.assertEqual(2, radix_base_from_number("2e" + "0" * 100_000))
        self.assertIsNone(radix_base_from_number("2e" + "9" * 100_000))
        self.assertIsNone(radix_base_from_number("2e-" + "9" * 100_000))
        self.assertEqual(2, radix_base_from_number("2" + "0" * 100_000 + "e-100000"))

    def test_independent_rational_oracle(self):
        for coefficient in range(0, 1000, 7):
            for exponent in range(-5, 6):
                numerator = coefficient * 10 ** max(0, exponent)
                denominator = 10 ** max(0, -exponent)
                quotient, remainder = divmod(numerator, denominator)
                expected = quotient if remainder == 0 and 2 <= quotient <= 64 else None
                self.assertEqual(expected, radix_base_from_number(f"{coefficient}e{exponent}"))

    def test_finalization_and_aeos(self):
        for fixture in (f for f in FIXTURES if f["testSource"]):
            literal, base = fixture["literal"], fixture["base"]
            for payload in ("1", "2"):
                with self.subTest(literal=literal, payload=payload):
                    compiled = compile_source(f"mask:radix[{literal}]=%{payload}")
                    self.assertEqual([], compiled.errors)
                    records = adapt_python_assignment_events_to_portable_aes(compiled.events)["events"]
                    for mode in ("strict", "loose"):
                        legacy = finalize_json(compiled.events, FinalizeOptions(mode=mode))
                        portable = finalize_portable_json(records, PortableFinalizeOptions(mode=mode))
                        key = "errors" if mode == "strict" else "warnings"
                        diagnostics = lambda r: [(d["code"], d["path"]) for d in r.get("meta", {}).get(key, [])]
                        self.assertEqual(legacy["document"], portable["document"])
                        self.assertEqual(diagnostics(legacy), diagnostics(portable))
                        self.assertEqual(base is None or int(payload) >= base, bool(diagnostics(legacy)))
                        self.assertTrue(all(code == "FINALIZE_INVALID_RADIX_BASE" for code, _ in diagnostics(legacy)))
                    if payload == "1":
                        for allow in (False, True):
                            schema = {"rules": [{"path": "$.mask", "constraints": {"radix": base or 2, "allow_unspecified_radix": allow}}]}
                            legacy = validate_events(compiled.events, schema)
                            portable = validate_telex_records(records, schema)
                            self.assertEqual(base is not None, legacy["ok"], legacy)
                            self.assertEqual(legacy["ok"], portable["ok"], portable)

    def test_absent_is_not_invalid(self):
        self.assertFalse(resolve_radix_base_from_datatype("radix").invalid)
        self.assertTrue(resolve_radix_base_from_datatype('radix["2"]').invalid)
        self.assertTrue(resolve_radix_base_from_datatype("radix[2, 10]").invalid)
        for clarifiers in ([], [{"kind": "StringLiteral", "value": "2"}], [{"kind": "NumberLiteral", "value": "2"}, {"kind": "NumberLiteral", "value": "10"}]):
            records = [{"path": "$.mask", "kind": "RadixLiteral", "value": "1", "datatype": "radix", "generics": [], "clarifiers": clarifiers}]
            result = finalize_portable_json(records, PortableFinalizeOptions(limits={"max_clarifier_values": 2}))
            self.assertEqual(bool(clarifiers), bool(result.get("meta", {}).get("errors")))

    def test_attributes_and_any_of(self):
        for literal in ("2.00", "2e0", "2.0000000000000001"):
            constraints = {"type": "RadixLiteral", "radix": 2, "allow_unspecified_radix": True}
            for source, schema in (
                (f"x@{{mask:radix[{literal}]=%1}}=0", {"rules": [{"path": "$.x", "constraints": {"attributes": {"mask": constraints}}}]}),
                (f"mask:radix[{literal}]=%1", {"rules": [{"path": "$.mask", "constraints": {"any_of": [constraints]}}]}),
            ):
                compiled = compile_source(source)
                self.assertEqual([], compiled.errors)
                records = adapt_python_assignment_events_to_portable_aes(compiled.events)["events"]
                self.assertEqual(literal != "2.0000000000000001", validate_events(compiled.events, schema)["ok"], source)
                self.assertEqual(literal != "2.0000000000000001", validate_telex_records(records, schema)["ok"], source)


if __name__ == "__main__":
    unittest.main()
