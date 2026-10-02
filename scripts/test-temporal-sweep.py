"""Oracle, grid, worker protocol, and quiet-run regressions."""
from contextlib import redirect_stdout
import io
import json
from pathlib import Path
import runpy
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).with_name("temporal-sweep.py")
SWEEP = runpy.run_path(str(SCRIPT))


class TemporalSweepTests(unittest.TestCase):
    def test_oracle_core_not_gp_and_calendar_boundaries(self):
        oracle = SWEEP["expected"]
        self.assertTrue(oracle(2000, 2, 29, 23, 59, 60))
        self.assertTrue(oracle(1900, 2, 28, 0, 0, 0))
        for fields in [(1900, 2, 29, 0, 0, 0), (2024, 9, 31, 0, 0, 0),
                       (2024, 0, 0, 0, 0, 0), (2024, 13, 32, 24, 60, 61),
                       (2024, 1, 1, 24, 0, 0), (2024, 1, 1, 0, 60, 0),
                       (2024, 1, 1, 0, 0, 61), (0, 1, 1, 0, 0, 0)]:
            self.assertFalse(oracle(*fields), fields)

    def test_grid_and_fixed_century_counts(self):
        self.assertEqual(SWEEP["GRID_COUNT"], 1108800)
        self.assertEqual(len(SWEEP["century_cases"]()), 24)
        self.assertEqual(SWEEP["grid_case"](0, (2024, 2023)), ("2024-00-00T00:00:00", False))
        self.assertEqual(SWEEP["grid_case"](1108799, (2024, 2023)), ("2023-13-32T24:60:61", False))
        with self.assertRaises(ValueError):
            SWEEP["grid_case"](1108800, (2024, 2023))

    def test_seed_replays_years_and_samples(self):
        years = SWEEP["select_years"](20261002)
        self.assertEqual(years, SWEEP["select_years"](20261002))
        self.assertTrue(SWEEP["calendar"].isleap(years[0]))
        self.assertFalse(SWEEP["calendar"].isleap(years[1]))
        first = list(SWEEP["case_stream"](20261002, years, 10000))
        self.assertEqual(first, list(SWEEP["case_stream"](20261002, years, 10000)))
        self.assertEqual(len(first), 10024)
        self.assertGreater(sum(want for _, want in first), 4000)
        self.assertLess(sum(want for _, want in first), 6000)
        self.assertTrue(any(literal.startswith(str(years[1])) for literal, _ in first[:-24]))

    def test_protocol_cannot_hide_skips_or_missing_mismatches(self):
        batch = [("valid", True), ("invalid", False)]
        validate = SWEEP["validate_response"]
        self.assertEqual(validate({"checked": 2, "accepted": 1, "mismatches": []}, batch), [])
        for response in [
            {"checked": 0, "accepted": 1, "mismatches": []},
            {"checked": 2, "accepted": 0, "mismatches": []},
            {"checked": 2, "accepted": 1},
            {"checked": 2, "accepted": 1, "mismatches": [[2, True, []]]},
            {"checked": 2, "accepted": 1, "mismatches": [[0, True, []]]},
            {"checked": 2, "accepted": 1, "mismatches": [[1, True, []], [1, True, []]]},
        ]:
            with self.subTest(response=response), self.assertRaises(ValueError):
                validate(response, batch)

    def test_worker_controls_and_intentional_mismatch(self):
        worker = SWEEP["Worker"]([sys.executable, str(SCRIPT), "--python-worker"], 10)
        try:
            SWEEP["check_worker"](worker)
            result = worker.request([("2024-01-01T00:00:00", False)])
            self.assertEqual(result["mismatches"], [[0, True, []]])
        finally:
            worker.close()

    def test_success_is_quiet_and_existing_report_is_preserved(self):
        with tempfile.TemporaryDirectory(prefix="aeon-sweep-test-") as temp:
            report = Path(temp) / "report.json"
            command = [sys.executable, str(SCRIPT), "--impl", "python", "--skip-build", "--benchmark", "200",
                       "--seed", "42", "--report", str(report)]
            completed = subprocess.run(command, capture_output=True, text=True, timeout=20)
            self.assertEqual(completed.returncode, 0, completed.stderr)
            self.assertEqual(completed.stdout + completed.stderr, "")
            original = report.read_bytes()
            result = json.loads(original)
            self.assertEqual(result["status"], "passed")
            self.assertEqual(result["backends"]["python"]["checked"], 224)
            self.assertEqual(result["seed"], 42)
            repeated = subprocess.run(command, capture_output=True, text=True, timeout=20)
            self.assertEqual(repeated.returncode, 2)
            self.assertIn("ERROR", repeated.stderr)
            self.assertEqual(report.read_bytes(), original)

    def test_incomplete_stream_cannot_pass(self):
        run = SWEEP["run_backend"]
        namespace = run.__globals__
        original = namespace["case_stream"]
        namespace["case_stream"] = lambda *_: iter([])
        try:
            args = SWEEP["argparse"].Namespace(timeout=10, seed=42, benchmark=1, batch_size=256)
            with self.assertRaisesRegex(RuntimeError, "incomplete sweep"):
                run("python", [sys.executable, str(SCRIPT), "--python-worker"], args, (2024, 2023))
        finally:
            namespace["case_stream"] = original

    def test_mismatch_reaches_default_output(self):
        # Intentionally lie about a real case's expectation after the genuine
        # worker self-test. This verifies the controller's public failure path.
        run = SWEEP["run_backend"]
        namespace = run.__globals__
        original = namespace["case_stream"]
        namespace["case_stream"] = lambda *_: iter([("2024-01-01T00:00:00", False)] + [("2024-01-01T00:00:00", True)] * 24)
        try:
            args = SWEEP["argparse"].Namespace(timeout=10, seed=42, benchmark=1, batch_size=256)
            output = io.StringIO()
            with redirect_stdout(output):
                result = run("python", [sys.executable, str(SCRIPT), "--python-worker"], args, (2024, 2023))
            self.assertEqual(result["mismatches"], 1)
            failure = json.loads(output.getvalue())
            self.assertEqual(failure["literal"], "2024-01-01T00:00:00")
            self.assertFalse(failure["expected"])
            self.assertTrue(failure["actual"])
        finally:
            namespace["case_stream"] = original


if __name__ == "__main__":
    unittest.main()
