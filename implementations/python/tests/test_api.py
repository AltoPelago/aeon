from __future__ import annotations

from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from aeon import AeonLoadError, LoadOptions, load_file, load_schema_file, load_text


class ApiConvenienceTests(unittest.TestCase):
    def test_load_text_returns_document_and_path_access(self) -> None:
        loaded = load_text('greeting:string = "Hello"\nflags = [true, false]')
        loaded.require_ok()

        self.assertTrue(loaded.ok)
        self.assertEqual("Hello", loaded.get("$.greeting"))
        self.assertEqual(False, loaded.get("$.flags[1]"))
        self.assertEqual("Hello", loaded.require("$.greeting"))

    def test_load_text_surfaces_compile_errors(self) -> None:
        loaded = load_text("broken = [1,,2]")
        self.assertFalse(loaded.ok)
        self.assertIsNone(loaded.document)
        with self.assertRaises(AeonLoadError):
            loaded.require_ok()

    def test_load_text_supports_schema_validation(self) -> None:
        loaded = load_text(
            'port:number = 8080',
            LoadOptions(
                schema={
                    "rules": [
                        {"path": "$.port", "constraints": {"required": True, "type": "IntegerLiteral"}},
                    ]
                }
            ),
        )
        loaded.require_ok()
        self.assertTrue(loaded.ok)
        self.assertEqual(8080, loaded.require("$.port"))

    def test_load_text_surfaces_schema_validation_errors(self) -> None:
        loaded = load_text(
            'port:string = "oops"',
            LoadOptions(
                schema={
                    "rules": [
                        {"path": "$.port", "constraints": {"required": True, "type": "IntegerLiteral"}},
                    ]
                }
            ),
        )
        self.assertFalse(loaded.ok)
        self.assertEqual(["type_mismatch"], [error["code"] for error in loaded.validation_errors])
        with self.assertRaises(AeonLoadError):
            loaded.require_ok()

    def test_load_file_reads_from_disk(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "hello.aeon"
            path.write_text('greeting:string = "Hello from file"', encoding="utf-8")
            loaded = load_file(path)
            loaded.require_ok()
            self.assertEqual("Hello from file", loaded.require("$.greeting"))

    def test_load_schema_file_projects_aeos_document(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            schema_path = Path(temp_dir) / "person.aeos"
            schema_path.write_text(
                "\n".join(
                    [
                        "aeos:schema = {",
                        '  id = "com.example.person"',
                        '  version = "1"',
                        '  world = "closed"',
                        "  rules = {",
                        '    "$.ages[*]" = {',
                        '      type = "IntegerLiteral"',
                        '      reference_target_path = "$.people[*].age"',
                        "    }",
                        "  }",
                        "}",
                    ]
                )
                + "\n",
                encoding="utf-8",
            )
            schema = load_schema_file(schema_path)
            self.assertEqual("closed", schema["world"])
            self.assertEqual("$.ages[*]", schema["rules"][0]["path"])
            self.assertEqual(
                r"^\$\.people\[\d+\]\.age$",
                schema["rules"][0]["constraints"]["reference_target_pattern"],
            )

    def test_load_text_supports_schema_file_option(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            schema_path = Path(temp_dir) / "port.aeos"
            schema_path.write_text(
                "\n".join(
                    [
                        "aeos:schema = {",
                        '  id = "com.example.port"',
                        '  version = "1"',
                        "  rules = {",
                        '    "$.port" = { required = true, type = "IntegerLiteral" }',
                        "  }",
                        "}",
                    ]
                )
                + "\n",
                encoding="utf-8",
            )
            loaded = load_text('port:number = 8080', LoadOptions(schema_file=schema_path))
            loaded.require_ok()
            self.assertTrue(loaded.ok)


if __name__ == "__main__":
    unittest.main()
