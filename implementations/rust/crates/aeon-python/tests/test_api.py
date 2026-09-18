from __future__ import annotations

import unittest

import altopelago.aeon as aeon
from altopelago.aeon import _native


class CompileTests(unittest.TestCase):
    def test_private_extension_identifies_sofia_engine(self) -> None:
        self.assertEqual(_native.ENGINE, "sofia")

    def test_compile_returns_typed_result(self) -> None:
        result = aeon.compile('name:string = "Sofia"\n')

        self.assertTrue(result.ok)
        self.assertIs(result.require_ok(), result)
        self.assertEqual(result.events[0].path, "$.name")
        self.assertEqual(result.events[0].datatype, "string")
        self.assertEqual(result.events[0].value_type, "StringLiteral")
        self.assertIsInstance(result, aeon.CompileResult)
        self.assertIsInstance(result.events[0], aeon.Event)
        self.assertIsInstance(result.events[0].span, aeon.Span)
        self.assertIsInstance(result.events[0].span.start, aeon.Position)
        self.assertFalse(hasattr(result.events[0], "__dict__"))
        with self.assertRaises(AttributeError):
            result.events[0].path = "$.changed"

    def test_public_value_objects_are_constructible_and_hashable(self) -> None:
        position = aeon.Position(line=1, column=2, offset=3)
        span = aeon.Span(start=position, end=position)
        event = aeon.Event(
            path="$.name",
            key="name",
            source_plane="body",
            datatype="string",
            value_type="StringLiteral",
            structural_id=None,
            span=span,
        )
        result = aeon.CompileResult(events=(event,), warnings=(), errors=())

        self.assertEqual(position, aeon.Position(1, 2, 3))
        self.assertEqual(hash(position), hash(aeon.Position(1, 2, 3)))
        self.assertEqual(result, aeon.CompileResult((event,), (), ()))
        self.assertEqual(result.events[0].span.start.offset, 3)
        self.assertTrue(result.ok)

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
