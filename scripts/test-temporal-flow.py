"""Sanity checks for the independent grammar probe, without production imports."""
from pathlib import Path
import runpy
import unittest

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


if __name__ == "__main__":
    unittest.main()
