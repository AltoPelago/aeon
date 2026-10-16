from __future__ import annotations

import json
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from aeon.ast import NumberLiteral
from aeon.canonical import CanonicalizeOptions, canonicalize
from aeon.core import CompileOptions, compile_source
from aeon.finalize import render_datatype
from aeon.lexer import tokenize
from aeon.parser import parse_tokens
from aeon.portable import adapt_python_assignment_events_to_portable_aes

FIXTURES = json.loads((ROOT.parents[1] / "test-fixtures/numeric-clarifiers.json").read_text())


class NumericClarifierTests(unittest.TestCase):
    def test_invalid_number_syntax_is_not_accepted_as_a_numeric_clarifier(self) -> None:
        for raw in ["1.", "1e", "1e+", "1__0", "--1", "1..2", "0x10"]:
            for source in [f"x={raw}", f"x:custom[{raw}]=0"]:
                with self.subTest(source=source):
                    result = canonicalize(source)
                    self.assertTrue(result.errors)
                    self.assertEqual("", result.text)

    def test_clarifiers_use_value_number_rules_through_parsing_and_events(self) -> None:
        for fixture in FIXTURES:
            raw, normalized = fixture["raw"], fixture["normalized"]
            with self.subTest(raw=raw):
                source = f"x:custom[{raw}]={raw}"
                parsed = parse_tokens(source, tokenize(source).tokens)
                self.assertEqual([], parsed.errors)
                binding = parsed.document.bindings[0]
                clarifier = binding.datatype.clarifiers[0]
                self.assertIsInstance(clarifier, NumberLiteral)
                self.assertEqual(raw, clarifier.raw)
                self.assertEqual(normalized, clarifier.value)
                self.assertEqual(binding.value.value, clarifier.value)
                compiled = compile_source(source)
                self.assertEqual([], compiled.errors)
                # Legacy serialized ASTs must remain JSON-serializable too.
                events = json.loads(json.dumps(compiled.events))
                projected = adapt_python_assignment_events_to_portable_aes(events)["events"]
                self.assertEqual([{"kind": "NumberLiteral", "value": normalized}], projected[0]["clarifiers"])
                self.assertEqual(normalized, projected[0]["value"])

    def test_canonicalization_preserves_exact_clarifiers_in_all_head_contexts(self) -> None:
        for fixture in FIXTURES:
            raw, normalized = fixture["raw"], fixture["normalized"]
            sources = [
                f"x:custom[{raw}]={raw}",
                f"x={{n:custom[{raw}]={raw}}}",
                f"x@{{n:custom[{raw}]={raw}}}=0",
                f"x=[:custom[{raw}]={raw}]",
                f"x=(:custom[{raw}]={raw})",
                f"x=<tag(:custom[{raw}]={raw})>",
                f"x:list<custom[{raw}]>=[{raw}]",
                f"aeon:header={{x:custom[{raw}]={raw}}}",
            ]
            for source in sources:
                with self.subTest(source=source):
                    output = canonicalize(source)
                    self.assertEqual([], output.errors)
                    self.assertIn(f"custom[{normalized}]", output.text)
                    repeated = canonicalize(output.text)
                    self.assertEqual([], repeated.errors)
                    self.assertEqual(output.text, repeated.text)
                    compiled = compile_source(output.text)
                    self.assertEqual([], compiled.errors)
                    json.dumps(compiled.events)

    def test_mixed_clarifiers_keep_string_number_distinction(self) -> None:
        source = 'x:custom["9007199254740993", 9007199254740993, 1.00]=0'
        result = canonicalize(source, CanonicalizeOptions(max_clarifier_values=3))
        self.assertEqual([], result.errors)
        self.assertIn('custom["9007199254740993", 9007199254740993, 1.0]', result.text)
        compiled = compile_source(source, CompileOptions(max_clarifier_values=3))
        self.assertEqual([], compiled.errors)
        self.assertEqual('custom[9007199254740993, "9007199254740993"]', render_datatype({
            "name": "custom", "clarifiers": [
                {"type": "NumberLiteral", "value": "9007199254740993"}, "9007199254740993",
            ],
        }))
