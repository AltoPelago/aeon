from __future__ import annotations

import inspect
import json
from pathlib import Path
import unittest

import altopelago.aeon as aeon
from altopelago.aeon import _native

ROOT = Path(__file__).resolve().parents[5]


class ReferenceOrderingTests(unittest.TestCase):
    def canonical(self, source, **options):
        return aeon.canonicalize(source, ordering="reference-safe-v1", **options)

    def test_reference_safe_default_and_explicit_legacy(self):
        source = "z=1\na=~z"
        legacy = aeon.canonicalize(source, ordering="lexical-v1")
        self.assertTrue(legacy.endswith("a = ~z\nz = 1\n"), legacy)
        self.assertEqual(legacy, aeon.canonicalize(source, ordering="lexical-v1", max_ordering_edges=0))
        self.assertTrue(self.canonical(source).endswith("z = 1\na = ~z\n"))
        self.assertEqual(self.canonical(source), aeon.canonicalize(source))
        ok, payload = _native.canonicalize_native(source)
        self.assertTrue(ok)
        self.assertEqual(aeon.canonicalize(source), payload.decode("utf-8"))
        parameters = inspect.signature(aeon.canonicalize).parameters
        self.assertEqual("reference-safe-v1", parameters["ordering"].default)
        self.assertEqual(inspect.Parameter.KEYWORD_ONLY, parameters["ordering"].kind)
        with self.assertRaises(TypeError):
            aeon.canonicalize(source, "reference-safe-v1")

    def test_minimum_eligible_key_is_recalculated(self):
        output = self.canonical("d=3\nc=2\nb=~c\na=1")
        self.assertTrue(output.endswith("a = 1\nc = 2\nb = ~c\nd = 3\n"), output)
        self.assertTrue(aeon.compile(output).ok)
        self.assertEqual(output, self.canonical(output))

    def test_authored_invalid_references_raise_without_partial_text(self):
        for source, code in (
            ("a=~z\nz=1", "FORWARD_REFERENCE"),
            ("a=~missing", "MISSING_REFERENCE_TARGET"),
            ("a=~a", "SELF_REFERENCE"),
        ):
            with self.subTest(source=source):
                with self.assertRaises(aeon.CompileError) as raised:
                    self.canonical(source)
                self.assertIn(code, [error.code for error in raised.exception.diagnostics])
                self.assertEqual("$.a", raised.exception.diagnostics[0].path)
                self.assertFalse(hasattr(raised.exception, "text"))
                ok, payload = _native.canonicalize_native(source, "reference-safe-v1")
                self.assertFalse(ok)
                diagnostics = json.loads(payload)
                self.assertIsInstance(diagnostics, list)
                self.assertIn(code, [error["code"] for error in diagnostics])
                self.assertTrue(all("text" not in error for error in diagnostics))

    def test_edge_budget_and_metadata_limits_are_explicit(self):
        with self.assertRaises(aeon.CompileError) as raised:
            self.canonical("z=1\na=~z", max_ordering_edges=0)
        self.assertEqual(["CANONICAL_ORDERING_LIMIT_EXCEEDED"], [error.code for error in raised.exception.diagnostics])
        self.canonical("z=1\na={b=~z,c=~>z}", max_ordering_edges=1)
        self.canonical("z=1\na=0", max_ordering_edges=0)
        self.canonical("a=1", max_attribute_depth=0)
        source = "a@{z@{x=1}=1,b=~a.@.z.@.x}=0"
        with self.assertRaises(aeon.CompileError):
            self.canonical(source)
        output = self.canonical(source, max_attribute_depth=2)
        self.assertEqual(output, self.canonical(output, max_attribute_depth=2))

    def test_invalid_options_never_silently_fall_back(self):
        for ordering in ("unknown", "", None, 0, True):
            with self.subTest(ordering=ordering), self.assertRaises(ValueError):
                aeon.canonicalize("a=1", ordering=ordering)
        for name in ("max_ordering_edges", "max_attribute_depth"):
            for value in (-1, 0.5, float("inf"), float("nan"), 2**53, True, False, "1", None):
                with self.subTest(name=name, value=value), self.assertRaises(ValueError):
                    self.canonical("a=1", **{name: value})
        self.canonical("a=1", max_ordering_edges=2**53-1)

    def test_core_only_validation_does_not_impose_gp_policy(self):
        source = 'aeon:profile="aeon.gp.profile.v1"\nx:radix[2.0000000000000001]=%1'
        self.assertFalse(aeon.compile(source).ok)
        output = self.canonical(source)
        self.assertIn("radix[2.0000000000000001]", output)
        self.assertEqual(output, self.canonical(output))

    def test_shared_rendering_regressions_and_fixed_points(self):
        fixtures = json.loads((ROOT / "test-fixtures/canonical-rendering-boundaries.json").read_text())
        for fixture in fixtures:
            with self.subTest(fixture=fixture["id"]):
                output = self.canonical(fixture["source"], max_attribute_depth=2)
                self.assertIn(fixture["fragment"], output)
                self.assertEqual(output, self.canonical(output, max_attribute_depth=2))

    def test_exact_clarifiers_and_literal_families_remain_native(self):
        fixtures = json.loads((ROOT / "test-fixtures/numeric-clarifiers.json").read_text())
        for fixture in fixtures:
            with self.subTest(raw=fixture["raw"]):
                output = self.canonical(f"x:custom[{fixture['raw']}]={fixture['raw']}")
                self.assertIn(f"custom[{fixture['normalized']}]", output)
                self.assertEqual(output, self.canonical(output))
        for source, fragment in (
            ("x=|approved|", "|approved|"),
            ('x:prose=`line\nnext`', ':prose'),
            ("x=2024-T10:&Europe", "2024-T10:&Europe"),
            ('"z\\n"=1\na=~["z\\n"]', '~["z\\n"]'),
            ('a=[@{}=1]', 'a = [1]'),
            ('a@{m={}}=0', 'm = {  }'),
        ):
            with self.subTest(source=source):
                output = self.canonical(source)
                self.assertIn(fragment, output)
                self.assertEqual(output, self.canonical(output))


if __name__ == "__main__":
    unittest.main()
