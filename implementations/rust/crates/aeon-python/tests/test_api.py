from __future__ import annotations

import unittest

import altopelago.aeon as aeon


class CompileTests(unittest.TestCase):
    def test_compile_returns_typed_result(self) -> None:
        result = aeon.compile('name:string = "Sofia"\n')

        self.assertTrue(result.ok)
        self.assertIs(result.require_ok(), result)
        self.assertEqual(result.events[0].path, "$.name")
        self.assertEqual(result.events[0].datatype, "string")
        self.assertEqual(result.events[0].value_type, "StringLiteral")

    def test_invalid_source_returns_diagnostics(self) -> None:
        result = aeon.compile('name = "unterminated')

        self.assertFalse(result.ok)
        self.assertEqual(result.errors[0].code, "UNTERMINATED_STRING")
        with self.assertRaises(aeon.CompileError) as raised:
            result.require_ok()
        self.assertEqual(raised.exception.diagnostics, result.errors)

    def test_compile_to_telex_returns_encoded_aes_bytes(self) -> None:
        encoded = aeon.compile_to_telex('name:string = "Sofia"\n')

        self.assertIsInstance(encoded, bytes)
        self.assertIn(b"$.name", encoded)

    def test_compile_to_telex_raises_stable_compile_error(self) -> None:
        with self.assertRaises(aeon.CompileError) as raised:
            aeon.compile_to_telex('name = "unterminated')

        self.assertEqual(raised.exception.diagnostics[0].code, "UNTERMINATED_STRING")


if __name__ == "__main__":
    unittest.main()
