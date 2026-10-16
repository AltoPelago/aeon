from __future__ import annotations

import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

import altopelago.aeon as aeon
from altopelago.aeon import _native, pytonic


class CompileTests(unittest.TestCase):
    def test_gp_uses_exact_numeric_radix_bases(self) -> None:
        root = Path(__file__).resolve().parents[5] / "test-fixtures"
        fixtures = json.loads((root / "radix-bases.json").read_text())
        contexts = json.loads((root / "gp-radix-contexts.json").read_text())
        for fixture in (f for f in fixtures if f["testSource"]):
            for context in contexts:
                source = context["before"] + fixture["literal"] + context["after"]
                with self.subTest(source=source):
                    self.assertTrue(aeon.compile(source).ok)
                    result = aeon.compile('aeon:profile="aeon.gp.profile.v1"\n' + source)
                    self.assertEqual(fixture["base"] is not None, result.ok, result.errors)
                    self.assertEqual([] if result.ok else ["PROFILE_DATATYPE_CLARIFIER_INVALID"], [e.code for e in result.errors])

    def test_reserved_radix_names_are_case_sensitive(self) -> None:
        fixtures = json.loads((Path(__file__).resolve().parents[5] / "test-fixtures/radix-datatype-names.json").read_text())
        for fixture in fixtures:
            for payload, digit in (("1", 1), ("A", 10)):
                source = f"mask:{fixture['datatype']}=%{payload}"
                with self.subTest(source=source):
                    self.assertTrue(aeon.compile(source).ok)
                    legacy = aeon.load_text(source, mode="strict")
                    portable = aeon.load_telex_text(aeon.compile_to_telex(source), mode="strict")
                    self.assertEqual(legacy.document, portable.document)
                    base = fixture["base"]
                    expected = fixture["invalid"] or (base is not None and digit >= base)
                    for result in (legacy, portable):
                        self.assertEqual(expected, any(d.code == "FINALIZE_INVALID_RADIX_BASE" for d in result.finalization_errors))

    def test_exact_radix_source_and_telex_finalization(self) -> None:
        for literal, invalid in (("2.00", False), ("2e0", False), ("20e-1", False), ("2.0000000000000001", True)):
            for payload in ("1", "2"):
                source = f"mask:radix[{literal}]=%{payload}"
                self.assertTrue(aeon.compile(source).ok)
                legacy = aeon.load_text(source, mode="strict")
                portable = aeon.load_telex_text(aeon.compile_to_telex(source), mode="strict")
                self.assertEqual(legacy.document, portable.document)
                for result in (legacy, portable):
                    self.assertEqual(invalid or payload == "2", any(d.code == "FINALIZE_INVALID_RADIX_BASE" for d in result.finalization_errors))

    def test_generic_arguments_are_type_descriptors_not_numeric_literals(self) -> None:
        fixtures = json.loads((Path(__file__).resolve().parents[5] / "test-fixtures/datatype-generic-arguments.json").read_text())
        for fixture in fixtures:
            source = fixture["source"]
            with self.subTest(source=source):
                compiled = aeon.compile(source)
                self.assertEqual(compiled.ok, fixture["ok"], compiled.errors)
                if fixture["ok"]:
                    canonical = aeon.canonicalize(source)
                    self.assertIn(fixture["fragment"], canonical)
                    self.assertEqual(canonical, aeon.canonicalize(canonical))
                else:
                    self.assertIn("SYNTAX_ERROR", [error.code for error in compiled.errors])
                    with self.assertRaises(aeon.CompileError):
                        aeon.canonicalize(source)

    def test_exact_numeric_clarifiers_through_canonical_and_telex_apis(self) -> None:
        fixtures = json.loads((Path(__file__).resolve().parents[5] / "test-fixtures/numeric-clarifiers.json").read_text())
        for fixture in fixtures:
            raw, normalized = fixture["raw"], fixture["normalized"]
            with self.subTest(raw=raw):
                source = f"x:custom[{raw}]={raw}"
                compiled = aeon.compile(source)
                self.assertTrue(compiled.ok, compiled.errors)
                self.assertEqual(compiled.events[0].datatype, f"custom[{normalized}]")
                canonical = aeon.canonicalize(source)
                self.assertIn(f"custom[{normalized}]", canonical)
                self.assertEqual(aeon.canonicalize(canonical), canonical)
                document = pytonic.loads(source)
                self.assertEqual(document["x"].clarifiers[0].kind, "NumberLiteral")
                self.assertEqual(document["x"].clarifiers[0].value, normalized)
                encoded = aeon.compile_to_telex(source)
                loaded = aeon.load_telex_text(encoded, mode="loose")
                loaded.require_ok()

    def test_private_extension_identifies_sofia_engine(self) -> None:
        self.assertEqual(_native.ENGINE, "sofia")

    def test_private_cts_hook_accepts_conformance_options(self) -> None:
        payload = json.loads(
            _native.compile_cts_json(
                'value:custom = "Sofia"\n',
                mode="strict",
                rich=True,
                max_events=1,
            )
        )

        self.assertEqual(payload["errors"], [])
        self.assertEqual(len(payload["events"]), 1)
        self.assertEqual(payload["events"][0]["datatype"], "custom")

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

    def test_canonicalize_uses_native_canonical_writer(self) -> None:
        rendered = aeon.canonicalize("b=2\na=1\n")

        self.assertIn("a = 1\nb = 2", rendered)
        self.assertEqual(aeon.canonicalize(rendered), rendered)

    def test_canonicalize_raises_compile_error(self) -> None:
        with self.assertRaises(aeon.CompileError):
            aeon.canonicalize('name = "unterminated')

    def test_load_text_materializes_and_retains_reports(self) -> None:
        loaded = aeon.load_text('name = "Sofia"\ncount = 2\n')

        self.assertTrue(loaded.ok)
        self.assertIs(loaded.require_ok(), loaded)
        self.assertEqual(loaded.document, {"count": 2, "name": "Sofia"})
        self.assertEqual(loaded.get("$.name"), "Sofia")
        self.assertEqual(loaded.require("$.count"), 2)
        self.assertIsInstance(loaded.compile, aeon.CompileResult)

    def test_loaded_document_supports_indexed_and_quoted_member_paths(self) -> None:
        loaded = aeon.load_text(
            'items = [1, [2, 3]]\n"a.b" = "dot"\n"quote\\\"slash\\\\" = "escaped"\n'
        ).require_ok()

        self.assertEqual(loaded.get("$.items[0]"), 1)
        self.assertEqual(loaded.get("$.items[1][1]"), 3)
        self.assertEqual(loaded.require('$.["a.b"]'), "dot")
        self.assertEqual(loaded.require('$.["quote\\\"slash\\\\"]'), "escaped")
        for malformed in ("$.items[]", "$.items[-1]", "$.items[0", "$.items[0]tail"):
            with self.subTest(path=malformed), self.assertRaises(ValueError):
                loaded.get(malformed)

    def test_missing_document_uses_lookup_default_at_root(self) -> None:
        loaded = aeon.load_text('name = "unterminated')
        sentinel = object()

        self.assertIs(loaded.get("$", sentinel), sentinel)
        with self.assertRaises(aeon.AeonLoadError):
            loaded.require("$")

    def test_load_text_preserves_lossy_materialization_diagnostics(self) -> None:
        strict = aeon.load_text("status = |approved|\n")
        loose = aeon.load_text("status = |approved|\n", mode="loose")

        self.assertFalse(strict.ok)
        self.assertEqual(
            strict.finalization_errors[0].code, "FINALIZE_JSON_PROFILE_SYMBOL"
        )
        with self.assertRaises(aeon.AeonLoadError):
            strict.require_ok()
        self.assertTrue(loose.ok)
        self.assertEqual(loose.document, {"status": "approved"})
        self.assertEqual(
            loose.finalization_warnings[0].code, "FINALIZE_JSON_PROFILE_SYMBOL"
        )

    def test_load_text_runs_aeos_validation(self) -> None:
        schema = json.dumps(
            {
                "schema_id": "com.example.native-python-test",
                "schema_version": "1",
                "rules": [
                    {
                        "path": "$.count",
                        "constraints": {"type": "StringLiteral"},
                    }
                ]
            }
        )
        loaded = aeon.load_text("count = 2\n", schema=schema)

        self.assertFalse(loaded.ok)
        self.assertTrue(loaded.validation_errors)
        with self.assertRaises(aeon.AeonLoadError):
            loaded.require_ok()

    def test_source_and_telex_validation_preserve_attributes(self) -> None:
        source = 'value@{unit:string = "cm"}:number = 3\n'
        schema = json.dumps(
            {
                "schema_id": "com.example.native-python-attributes",
                "schema_version": "1",
                "rules": [
                    {
                        "path": "$.value",
                        "constraints": {
                            "type": "NumberLiteral",
                            "attributes": {
                                "unit": {
                                    "required": True,
                                    "type": "StringLiteral",
                                    "datatype": "string",
                                }
                            },
                        },
                    }
                ],
            }
        )

        source_loaded = aeon.load_text(source, schema=schema)
        telex_loaded = aeon.load_telex_text(
            aeon.compile_to_telex(source), schema=schema
        )

        self.assertTrue(source_loaded.ok)
        self.assertTrue(telex_loaded.ok)
        self.assertEqual(source_loaded.validation_errors, telex_loaded.validation_errors)

    def test_load_text_surfaces_invalid_schema(self) -> None:
        loaded = aeon.load_text("count = 2\n", schema="{}")

        self.assertFalse(loaded.ok)
        self.assertIn("schema_id", loaded.schema_error or "")

    def test_load_file_reads_utf8_source(self) -> None:
        with TemporaryDirectory() as directory:
            path = Path(directory, "example.aeon")
            path.write_text('name = "Sofia"\n', encoding="utf-8")

            self.assertEqual(aeon.load_file(path).document, {"name": "Sofia"})

    def test_telex_can_be_canonicalized_and_loaded(self) -> None:
        encoded = aeon.compile_to_telex('name = "Sofia"\n')
        canonical = aeon.canonicalize_telex(encoded)
        loaded = aeon.load_telex_text(canonical)

        self.assertTrue(loaded.ok)
        self.assertEqual(loaded.document, {"name": "Sofia"})
        self.assertEqual(aeon.canonicalize_telex(canonical), canonical)

    def test_invalid_telex_is_a_result_until_required(self) -> None:
        loaded = aeon.load_telex_text("not telex")

        self.assertFalse(loaded.ok)
        self.assertEqual(loaded.error_kind, "telex_syntax")
        with self.assertRaises(aeon.TelexError):
            loaded.require_ok()

    def test_telex_loading_retains_lossy_materialization_reports(self) -> None:
        encoded = aeon.compile_to_telex("status = |approved|\n")
        strict = aeon.load_telex_text(encoded)
        loose = aeon.load_telex_text(encoded, mode="loose")

        self.assertFalse(strict.ok)
        self.assertEqual(
            strict.finalization_errors[0].code, "FINALIZE_JSON_PROFILE_SYMBOL"
        )
        self.assertTrue(loose.ok)
        self.assertEqual(loose.document, {"status": "approved"})
        self.assertEqual(
            loose.finalization_warnings[0].code, "FINALIZE_JSON_PROFILE_SYMBOL"
        )


if __name__ == "__main__":
    unittest.main()
