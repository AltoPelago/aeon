from __future__ import annotations

import json
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from aeon._radix import radix_base_from_number, resolve_radix_base_from_datatype
from aeon.core import CompileOptions, compile_source
from aeon.finalize import finalize_json, FinalizeOptions
from aeon.portable_finalize import finalize_portable_json, PortableFinalizeOptions
from aeon.portable import adapt_python_assignment_events_to_portable_aes
from aeon.aeos import validate_events, validate_telex_records

FIXTURES = json.loads((ROOT.parents[1] / "test-fixtures/radix-bases.json").read_text())
DATATYPE_NAMES = json.loads((ROOT.parents[1] / "test-fixtures/radix-datatype-names.json").read_text())


class ExactRadixTests(unittest.TestCase):
    def test_gp_validates_unprojected_occurrences_once_at_their_exact_paths(self):
        fixtures = json.loads((ROOT.parents[1] / "test-fixtures/gp-attribute-clarifiers.json").read_text())
        fixtures += json.loads((ROOT.parents[1] / "test-fixtures/gp-tag-head-clarifiers.json").read_text())
        for fixture in fixtures:
            with self.subTest(case=fixture["id"]):
                options = dict(max_attribute_depth=2, max_clarifier_values=2)
                self.assertEqual([], compile_source(fixture["source"], CompileOptions(**options)).errors, fixture["source"])
                for header in (False, True):
                    source = 'aeon:profile="aeon.gp.profile.v1"\n' + fixture["source"] if header else fixture["source"]
                    result = compile_source(source, CompileOptions(**options, profile=None if header else "aeon.gp.profile.v1"))
                    self.assertEqual(fixture["errors"], [{"code": e.code, "path": e.path} for e in result.errors], source)

    def test_gp_validates_exact_values_across_binding_generic_and_item_contexts(self):
        contexts = json.loads((ROOT.parents[1] / "test-fixtures/gp-radix-contexts.json").read_text())
        for fixture in (f for f in FIXTURES if f["testSource"]):
            for context in contexts:
                source = context["before"] + fixture["literal"] + context["after"]
                with self.subTest(source=source):
                    self.assertEqual([], compile_source(source).errors)
                    for header_profile in (False, True):
                        text = 'aeon:profile="aeon.gp.profile.v1"\n' + source if header_profile else source
                        result = compile_source(text, CompileOptions(profile=None if header_profile else "aeon.gp.profile.v1"))
                        self.assertEqual([] if fixture["base"] is not None else ["PROFILE_DATATYPE_CLARIFIER_INVALID"], [e.code for e in result.errors])

    def test_gp_preserves_name_and_clarifier_kind_distinctions(self):
        for fixture in DATATYPE_NAMES:
            source = f"mask:{fixture['datatype']}=%1"
            result = compile_source(source, CompileOptions(profile="aeon.gp.profile.v1"))
            self.assertEqual(["PROFILE_DATATYPE_CLARIFIER_INVALID"] if fixture["invalid"] else [], [e.code for e in result.errors], source)
        for clarifiers in ('"2"', '2, 10', '"2", 2'):
            result = compile_source(f"mask:radix[{clarifiers}]=%1", CompileOptions(profile="aeon.gp.profile.v1", max_clarifier_values=2))
            self.assertEqual(["PROFILE_DATATYPE_CLARIFIER_INVALID"], [e.code for e in result.errors])
        for literal in ('2_0', '2_0e-1', '6_4.0'):
            self.assertEqual([], compile_source(f"mask:radix[{literal}]=%1", CompileOptions(profile="aeon.gp.profile.v1")).errors)
        for source in ('mask:sep["a,b"]=^a1a', 'mask:sep["]"]=^a1a', r'mask:sep["a\"b"]=^a1a', 'mask:sep[".", ":"]=^1.2:3'):
            self.assertEqual([], compile_source(source, CompileOptions(profile="aeon.gp.profile.v1", max_clarifier_values=2)).errors, source)

    def test_reserved_datatype_names_are_case_sensitive(self):
        for fixture in DATATYPE_NAMES:
            datatype, base, invalid = fixture["datatype"], fixture["base"], fixture["invalid"]
            with self.subTest(datatype=datatype):
                resolved = resolve_radix_base_from_datatype(datatype)
                self.assertEqual(base, resolved.base)
                self.assertEqual(invalid, resolved.invalid)
                for payload, digit in (("1", 1), ("A", 10)):
                    compiled = compile_source(f"mask:{datatype}=%{payload}")
                    self.assertEqual([], compiled.errors)
                    records = adapt_python_assignment_events_to_portable_aes(compiled.events)["events"]
                    for mode in ("strict", "loose"):
                        legacy = finalize_json(compiled.events, FinalizeOptions(mode=mode))
                        portable = finalize_portable_json(records, PortableFinalizeOptions(mode=mode))
                        key = "errors" if mode == "strict" else "warnings"
                        diagnostics = lambda r: [(d["code"], d["path"]) for d in r.get("meta", {}).get(key, [])]
                        self.assertEqual(legacy["document"], portable["document"])
                        self.assertEqual(diagnostics(legacy), diagnostics(portable))
                        self.assertEqual(invalid or (base is not None and digit >= base), bool(diagnostics(legacy)))
                    if payload == "1":
                        for allow in (False, True):
                            schema = {"rules": [{"path": "$.mask", "constraints": {"radix": 2, "allow_unspecified_radix": allow}}]}
                            expected = not invalid and (base == 2 or (base is None and allow))
                            self.assertEqual(expected, validate_events(compiled.events, schema)["ok"])
                            self.assertEqual(expected, validate_telex_records(records, schema)["ok"])

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
