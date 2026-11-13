from pathlib import Path
import json
import subprocess
import sys
import tempfile
import unittest


RUNNER = Path(__file__).resolve().parents[1] / "tools" / "run_sansa_address_cts.py"


class SansaAddressCtsRunnerTests(unittest.TestCase):
    def run_case(self, source: str, terms: list[str]) -> subprocess.CompletedProcess[str]:
        with tempfile.TemporaryDirectory(prefix="aeon-sansa-cts-runner-") as directory:
            root = Path(directory)
            (root / "manifest.json").write_text(
                json.dumps({"suites": [{"file": "suite.json"}]}), encoding="utf-8"
            )
            (root / "suite.json").write_text(
                json.dumps({"tests": [{
                    "id": "qualifier-expectation",
                    "input": {"source": source},
                    "expected": {"ok": True, "qualifier_terms": terms},
                }]}),
                encoding="utf-8",
            )
            return subprocess.run(
                [sys.executable, str(RUNNER), "--cts", str(root / "manifest.json")],
                capture_output=True, text=True, timeout=10, check=False,
            )

    def test_matching_schema_qualifier_terms_pass(self) -> None:
        result = self.run_case("$.result:number|nan", ["number", "nan"])
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("Summary: pass=1 fail=0", result.stdout)

    def test_wrong_or_reordered_qualifier_terms_fail(self) -> None:
        for terms in [["wrong"], ["nan", "number"]]:
            with self.subTest(terms=terms):
                result = self.run_case("$.result:number|nan", terms)
                self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
                self.assertIn("qualifier terms mismatch", result.stdout)
                self.assertIn("Summary: pass=0 fail=1", result.stdout)

    def test_absent_qualifier_is_checked_against_empty_expected_terms(self) -> None:
        result = self.run_case("$.result", [])
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        mismatch = self.run_case("$.result", ["number"])
        self.assertEqual(mismatch.returncode, 1, mismatch.stdout + mismatch.stderr)
        self.assertIn("qualifier terms mismatch", mismatch.stdout)


if __name__ == "__main__":
    unittest.main()
