"""Sanity checks for the independent grammar probe, without production imports."""
from pathlib import Path
from contextlib import redirect_stdout
import io
import runpy
import sys
import unittest
from unittest.mock import patch

FLOW = runpy.run_path(str(Path(__file__).with_name("stress-temporal-flow.py")))


class TemporalFlowTests(unittest.TestCase):
    def test_known_calendar_clock_and_context_examples(self):
        for value in ("0001-", "9999-12-31", "2000-02-29", "2024-T23",
                      "2024-T23:59:60.0000000000-00:00&+/A/A", "2024-T11&local"):
            with self.subTest(value=value):
                self.assertTrue(FLOW["oracle"](value, "year0"))
        for value in ("0000-", "1900-02-29", "2024-04-31", "2024-T24",
                      "2024-T11&Local", "2024-T11&A//A", "2024-T11&Aé",
                      "2024-T11+24:00", "2024-T11+00:60", "2024-T11:11:61"):
            with self.subTest(value=value):
                self.assertFalse(FLOW["oracle"](value, "year0"))
        for value in ("11:", "11:11Z", "11:11:60." + "1" * 200):
            self.assertTrue(FLOW["oracle"](value, "time-hour0"))
        for value in ("11", "11:11&local", "11:11:11.", "11:1١", "11:11.1"):
            self.assertFalse(FLOW["oracle"](value, "time-hour0"))

    def test_complete_transitions_really_accept(self):
        matrix = FLOW["cases"]()
        completions = [case for case in matrix if case.group == "transition-completions"]
        self.assertTrue(completions)
        self.assertTrue(all(case.accepted for case in completions))
        identities = [(case.group, case.name) for case in matrix]
        self.assertEqual(len(identities), len(set(identities)))

    def test_source_boundaries_keep_assignment_separators(self):
        matrix = FLOW["cases"]()
        for case in matrix:
            if case.group == "boundaries" and case.name.endswith(("/SPACE", "/TAB")):
                self.assertIn("\nnext:number", case.source)
                self.assertTrue(case.accepted)
            if case.group == "missing-separator":
                self.assertFalse(case.accepted)

    def test_each_month_end_is_probed_in_common_and_leap_years(self):
        cases = [case for case in FLOW["cases"]() if case.group == "calendar-boundaries"]
        self.assertEqual(len(cases), 72)
        by_literal = {case.literal: case.accepted for case in cases}
        self.assertTrue(by_literal["2023-02-28"])
        self.assertFalse(by_literal["2023-02-29"])
        self.assertTrue(by_literal["2024-02-29"])
        self.assertFalse(by_literal["2024-02-30"])
        for year in (2023, 2024):
            for month in range(1, 13):
                values = [case.accepted for case in cases if case.literal.startswith(f"{year}-{month:02}-")]
                self.assertEqual(values, [True, True, False])

    def test_duplicate_characters_cover_user_examples_and_structural_markers(self):
        cases = {case.literal: case for case in FLOW["cases"]() if case.group == "character-duplication"}
        for literal in ("2002--02", "2002-003-02", "10::10:32", "2021-TT20:",
                        "2002---02", "10:::10:32", "2021-TTT20:", "10:10:32ZZ",
                        "10:10:32++02:30", "10:10:32--00:00", "2024-T10&&local",
                        "23:59:60..0100", "2024-T10&+//Antarctica/Elisabeth"):
            with self.subTest(literal=literal):
                self.assertIn(literal, cases)
                self.assertFalse(cases[literal].accepted)

    def test_legal_fraction_and_context_duplicates_are_preserved(self):
        cases = {case.literal: case for case in FLOW["cases"]() if case.group == "character-duplication"}
        for literal in ("23:59:60.00100", "2024-T10&llocal", "2024-T10&A__A-A+A.A",
                        "2024-T10&A_A--A+A.A", "2024-T10&A_A-A++A.A", "2024-T10&A_A-A+A..A"):
            with self.subTest(literal=literal):
                self.assertIn(literal, cases)
                self.assertTrue(cases[literal].accepted)

    def test_duplication_generator_is_deterministic_and_deduplicates_runs(self):
        first = list(FLOW["duplication_cases"]())
        self.assertEqual(first, list(FLOW["duplication_cases"]()))
        # Duplicating any of the three leading zeroes has the same result.
        zeroes = [(root, value) for name, root, value in first if name.startswith("0001-/") and value == "00001-"]
        self.assertEqual(len(zeroes), 1)
        for name, root, value in first:
            seed, _, copies = name.rsplit("/", 2)
            self.assertEqual(len(value), len(seed) + int(copies[0]) - 1)

    def test_quiet_mode_suppresses_success_but_keeps_failures(self):
        main = FLOW["main"]
        namespace = main.__globals__
        case = FLOW["Case"]("example", "character-duplication", "10::10:32", "v:time = 10::10:32", False)
        for failures in ([], ["deliberate test failure"]):
            output = io.StringIO()
            with patch.dict(namespace, {
                "cases": lambda: [case],
                "COMMANDS": {"python": [__file__]},
                "run_case": lambda *_: {"name": case.name, "group": case.group, "failures": failures},
            }), patch.object(sys, "argv", ["stress-temporal-flow.py", "--quiet"]), redirect_stdout(output):
                status = main()
            self.assertEqual(status, int(bool(failures)))
            if failures:
                self.assertIn("deliberate test failure", output.getvalue())
            else:
                self.assertEqual(output.getvalue(), "")


if __name__ == "__main__":
    unittest.main()
