from __future__ import annotations

from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from aeon.canonical import canonicalize
from aeon.core import compile_source
from aeon.lexer import tokenize


class CanonicalTests(unittest.TestCase):
    def test_canonicalizes_quoted_reference_paths(self) -> None:
        result = canonicalize('a@{"x.y" = 1} = 2\nb = ~["a.b"]@["x.y"].["z w"]')
        self.assertEqual([], result.errors)
        self.assertIn('a@{"x.y" = 1} = 2', result.text)
        self.assertIn('b = ~["a.b"]@["x.y"].["z w"]', result.text)

    def test_canonicalizes_multiline_strings_as_trimticks(self) -> None:
        result = canonicalize('text = "Line\\nBreak"')
        self.assertEqual([], result.errors)
        self.assertIn('text = >`', result.text)
        self.assertIn('  Line', result.text)
        self.assertIn('  Break', result.text)

    def test_canonicalizes_hex_and_tuple_layout_like_typescript(self) -> None:
        source = 'hexes = [#FF00AA, #00FF00]\ntuples = [\n  (\n    1,\n    2\n  )\n]'
        result = canonicalize(source)
        self.assertEqual([], result.errors)
        self.assertIn('hexes = [#ff00aa, #00ff00]', result.text)
        self.assertIn('    1,', result.text)
        self.assertIn('    2', result.text)

    def test_canonicalizes_multiline_nodes_with_compact_simple_children(self) -> None:
        source = 'n = <x(\n  #FF0000,\n  <y@{kind:string = "swatch"}(#00FF00, "ok")>\n)>'
        result = canonicalize(source)
        self.assertEqual([], result.errors)
        self.assertIn('  #ff0000,', result.text)
        self.assertIn('  <y@{kind:string = "swatch"}(#00ff00, "ok")>', result.text)

    def test_canonicalizes_infinity_literals(self) -> None:
        result = canonicalize('top:infinity = Infinity\nbottom:infinity = -Infinity')
        self.assertEqual([], result.errors)
        self.assertIn('top:infinity = Infinity', result.text)
        self.assertIn('bottom:infinity = -Infinity', result.text)

    def test_canonicalizes_multiline_generic_and_separator_boundaries(self) -> None:
        result = canonicalize(
            'aeon:mode = "strict"\n'
            'size\n'
            ':\n'
            'sep\n'
            '[\n'
            'x\n'
            ']\n'
            '= ^300x250\n'
            'items\n'
            ':\n'
            'list\n'
            '<\n'
            'n\n'
            '>\n'
            '=\n'
            '[\n'
            '2\n'
            ',\n'
            '3\n'
            ']\n'
        )
        self.assertEqual([], result.errors)
        self.assertIn('size:sep[x] = ^300x250', result.text)
        self.assertIn('items:list<n> = [2, 3]', result.text)

    def test_scenarios_fixture_parses_in_python(self) -> None:
        fixture = ROOT.parents[1] / "stress-tests" / "full" / "scenarios.aeon"
        source = fixture.read_text(encoding="utf-8")
        result = compile_source(source)
        self.assertEqual(["SYNTAX_ERROR", "SYNTAX_ERROR", "SYNTAX_ERROR"], [error.code for error in result.errors])
        self.assertTrue(all("Invalid encoding literal" in error.message for error in result.errors))

    def test_canonicalize_does_not_emit_shebang_or_host_directive(self) -> None:
        result = canonicalize("#!/usr/bin/env aeon\n//! format:aeon.test.v1\nvalue:number = 1")
        self.assertEqual([], result.errors)
        self.assertNotIn("#!/usr/bin/env aeon", result.text)
        self.assertNotIn("//! format:aeon.test.v1", result.text)
        self.assertIn("value:number = 1", result.text)

    def test_canonicalize_accepts_leading_bom(self) -> None:
        result = canonicalize("\ufeff#!/usr/bin/env aeon\n//! format:aeon.test.v1\nvalue:number = 1")
        self.assertEqual([], result.errors)
        self.assertNotIn("\ufeff", result.text)
        self.assertIn("value:number = 1", result.text)


class LexerAndParserParityTests(unittest.TestCase):
    def test_leading_shebang_is_ignored_as_first_line_comment(self) -> None:
        tokens = tokenize('#!/usr/bin/env aeon\nvalue = 1').tokens
        self.assertEqual(
            ["NEWLINE", "IDENT", "EQUALS", "NUMBER", "EOF"],
            [token.kind for token in tokens],
        )

    def test_root_qualified_paths_are_not_lexed_as_encoding(self) -> None:
        tokens = tokenize('v = ~$.a').tokens
        self.assertEqual(
            ["IDENT", "EQUALS", "TILDE", "DOLLAR", "DOT", "IDENT", "EOF"],
            [token.kind for token in tokens],
        )

    def test_hex_literal_accepts_underscores(self) -> None:
        tokens = tokenize('#00_00_00').tokens
        self.assertEqual("HEX", tokens[0].kind)
        self.assertEqual("#00_00_00", tokens[0].value)

    def test_number_accepts_underscores_in_exponent(self) -> None:
        result = tokenize('1e1_0')
        self.assertEqual([], result.errors)
        self.assertEqual("NUMBER", result.tokens[0].kind)
        self.assertEqual("1e1_0", result.tokens[0].value)

    def test_number_rejects_signed_leading_zero_decimal(self) -> None:
        result = tokenize('+00.5')
        self.assertEqual(["INVALID_NUMBER"], [error.code for error in result.errors])


if __name__ == "__main__":
    unittest.main()
