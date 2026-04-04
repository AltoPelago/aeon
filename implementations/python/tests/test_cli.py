from __future__ import annotations

from pathlib import Path
import json
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))


class CliTests(unittest.TestCase):
    def test_inspect_json_returns_deterministic_shape_for_valid_fixture(self) -> None:
        fixture = ROOT / ".." / "typescript" / "packages" / "cli" / "tests" / "fixtures" / "valid.aeon"
        result = subprocess.run(
            [
                str(ROOT / "bin" / "aeon-python"),
                "inspect",
                str(fixture),
                "--json",
            ],
            capture_output=True,
            text=True,
            cwd=str(ROOT),
        )

        self.assertEqual(0, result.returncode)
        self.assertEqual("", result.stderr)
        self.assertIn('"errors": []', result.stdout)
        self.assertIn('"path": "$.a"', result.stdout)
        self.assertIn('"datatype": "int32"', result.stdout)
        self.assertIn('"type": "CloneReference"', result.stdout)
        self.assertIn('"path": [\n          "a"\n        ]', result.stdout)

    def test_inspect_allows_custom_datatypes_by_default_in_custom_mode(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            fixture = Path(tmpdir) / "custom-mode.aeon"
            fixture.write_text('aeon:mode = "custom"\ncolor:stroke = #ff00ff\n', encoding="utf-8")

            result = subprocess.run(
                [
                    str(ROOT / "bin" / "aeon-python"),
                    "inspect",
                    str(fixture),
                    "--json",
                ],
                capture_output=True,
                text=True,
                cwd=str(ROOT),
            )

        self.assertEqual(0, result.returncode)
        self.assertIn('"errors": []', result.stdout)
        self.assertIn('"datatype": "stroke"', result.stdout)

    def test_inspect_max_input_bytes_fails_with_input_size_exceeded(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            fixture = Path(tmpdir) / "oversized.aeon"
            fixture.write_text('value:string = "' + ("x" * 4096) + '"', encoding="utf-8")

            result = subprocess.run(
                [
                    str(ROOT / "bin" / "aeon-python"),
                    "inspect",
                    str(fixture),
                    "--json",
                    "--max-input-bytes",
                    "128",
                ],
                capture_output=True,
                text=True,
                cwd=str(ROOT),
            )

        self.assertEqual(1, result.returncode)
        self.assertIn("INPUT_SIZE_EXCEEDED", result.stdout)
        self.assertIn('"events": []', result.stdout)

    def test_inspect_rejects_invalid_max_input_bytes_value(self) -> None:
        result = subprocess.run(
            [
                str(ROOT / "bin" / "aeon-python"),
                "inspect",
                "missing.aeon",
                "--max-input-bytes",
                "abc",
            ],
            capture_output=True,
            text=True,
            cwd=str(ROOT),
        )

        self.assertEqual(2, result.returncode)
        self.assertIn("Invalid value for --max-input-bytes", result.stderr)

    def test_inspect_rejects_invalid_datatype_policy_value(self) -> None:
        result = subprocess.run(
            [
                str(ROOT / "bin" / "aeon-python"),
                "inspect",
                "missing.aeon",
                "--datatype-policy",
                "invalid",
            ],
            capture_output=True,
            text=True,
            cwd=str(ROOT),
        )

        self.assertEqual(2, result.returncode)
        self.assertIn("Invalid value for --datatype-policy", result.stderr)

    def test_inspect_rejects_missing_datatype_policy_value(self) -> None:
        result = subprocess.run(
            [
                str(ROOT / "bin" / "aeon-python"),
                "inspect",
                "missing.aeon",
                "--datatype-policy",
            ],
            capture_output=True,
            text=True,
            cwd=str(ROOT),
        )

        self.assertEqual(2, result.returncode)
        self.assertIn("Invalid value for --datatype-policy", result.stderr)

    def test_fmt_outputs_expected_canonical_text_for_valid_fixture(self) -> None:
        fixture = ROOT / ".." / "typescript" / "packages" / "cli" / "tests" / "fixtures" / "valid.aeon"
        result = subprocess.run(
            [
                str(ROOT / "bin" / "aeon-python"),
                "fmt",
                str(fixture),
            ],
            capture_output=True,
            text=True,
            cwd=str(ROOT),
        )

        self.assertEqual(0, result.returncode)
        self.assertEqual("", result.stderr)
        expected = "\n".join([
            "aeon:header = {",
            "  encoding = \"utf-8\"",
            "  mode = \"transport\"",
            "  profile = \"core\"",
            "  version = 1.0",
            "}",
            "a:int32 = 1",
            "b = ~a",
            "",
        ])
        self.assertEqual(expected, result.stdout)

    def test_inspect_requires_file_argument(self) -> None:
        result = subprocess.run(
            [
                str(ROOT / "bin" / "aeon-python"),
                "inspect",
                "--json",
            ],
            capture_output=True,
            text=True,
            cwd=str(ROOT),
        )

        self.assertEqual(2, result.returncode)
        self.assertIn("No file specified", result.stderr)

    def test_finalize_json_emits_document_and_finalize_error_meta(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            fixture = Path(tmpdir) / "unsafe-number.aeon"
            fixture.write_text("n = 9007199254740993.0\n", encoding="utf-8")

            result = subprocess.run(
                [
                    str(ROOT / "bin" / "aeon-python"),
                    "finalize",
                    str(fixture),
                    "--json",
                ],
                capture_output=True,
                text=True,
                cwd=str(ROOT),
            )

        self.assertEqual(1, result.returncode)
        payload = json.loads(result.stdout)
        self.assertEqual({"n": "9007199254740993.0"}, payload["document"])
        self.assertEqual("FINALIZE_UNSAFE_NUMBER", payload["meta"]["errors"][0]["code"])

    def test_finalize_defaults_to_envelope_output_without_json_flag(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            fixture = Path(tmpdir) / "simple.aeon"
            fixture.write_text('name = "AEON"\n', encoding="utf-8")

            result = subprocess.run(
                [
                    str(ROOT / "bin" / "aeon-python"),
                    "finalize",
                    str(fixture),
                ],
                capture_output=True,
                text=True,
                cwd=str(ROOT),
            )

        self.assertEqual(0, result.returncode)
        payload = json.loads(result.stdout)
        self.assertEqual({"name": "AEON"}, payload["document"])
        self.assertFalse(payload.get("meta"))

    def test_finalize_json_reports_infinity_as_strict_json_profile_error(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            fixture = Path(tmpdir) / "infinity.aeon"
            fixture.write_text("limit:infinity = Infinity\n", encoding="utf-8")

            result = subprocess.run(
                [
                    str(ROOT / "bin" / "aeon-python"),
                    "finalize",
                    str(fixture),
                    "--json",
                ],
                capture_output=True,
                text=True,
                cwd=str(ROOT),
            )

        self.assertEqual(1, result.returncode)
        payload = json.loads(result.stdout)
        self.assertEqual({"limit": "Infinity"}, payload["document"])
        self.assertEqual("FINALIZE_JSON_PROFILE_INFINITY", payload["meta"]["errors"][0]["code"])

    def test_finalize_json_supports_projected_payload_scope(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            fixture = Path(tmpdir) / "projection.aeon"
            fixture.write_text('"a.b" = 1\nplain = 2\n', encoding="utf-8")

            result = subprocess.run(
                [
                    str(ROOT / "bin" / "aeon-python"),
                    "finalize",
                    str(fixture),
                    "--json",
                    "--projected",
                    "--include-path",
                    '$.["a.b"]',
                ],
                capture_output=True,
                text=True,
                cwd=str(ROOT),
            )

        self.assertEqual(0, result.returncode)
        payload = json.loads(result.stdout)
        self.assertEqual({"a.b": 1}, payload["document"])

    def test_finalize_map_supports_projected_attribute_path_chains(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            fixture = Path(tmpdir) / "map-projection.aeon"
            fixture.write_text(
                'title@{lang = "en", meta = { keep = 2 }} = "Hello"\n'
                'card = { label@{meta = { keep = 3, "x.y" = 4 }} = "Hi" }\n'
                'rich = <pill@{id = "main", meta = { keep = 5 }}("new")>\n',
                encoding="utf-8",
            )

            result = subprocess.run(
                [
                    str(ROOT / "bin" / "aeon-python"),
                    "finalize",
                    str(fixture),
                    "--map",
                    "--projected",
                    "--include-path",
                    "$.card.label@meta.keep",
                    "--include-path",
                    '$.card.label@meta.["x.y"]',
                ],
                capture_output=True,
                text=True,
                cwd=str(ROOT),
            )

        self.assertEqual(0, result.returncode)
        payload = json.loads(result.stdout)
        self.assertEqual(
            ["$.card", "$.card.label"],
            [entry["path"] for entry in payload["document"]["entries"]],
        )


if __name__ == "__main__":
    unittest.main()
