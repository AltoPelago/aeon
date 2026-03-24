from __future__ import annotations

from pathlib import Path
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


if __name__ == "__main__":
    unittest.main()
