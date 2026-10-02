"""Checks mutation definitions without modifying or importing implementation code."""
from pathlib import Path
import runpy
import unittest

AUDIT = runpy.run_path(str(Path(__file__).with_name("mutate-temporal-flow.py")))


class TemporalMutationTests(unittest.TestCase):
    def test_all_mutations_change_valid_source(self):
        for mutation in AUDIT["mutations"]():
            with self.subTest(mutation=mutation.name):
                source = (AUDIT["ROOT"] / "implementations/python/src/aeon" / mutation.file).read_text()
                changed = AUDIT["apply_mutation"](source, mutation)
                self.assertNotEqual(changed, source)
                compile(changed, mutation.file, "exec")

    def test_stale_anchors_fail_closed(self):
        for mutation in AUDIT["mutations"]():
            with self.subTest(mutation=mutation.name), self.assertRaises(ValueError):
                AUDIT["apply_mutation"]("# no matching source", mutation)

    def test_mutation_names_are_unique(self):
        names = [mutation.name for mutation in AUDIT["mutations"]()]
        self.assertEqual(len(names), len(set(names)))


if __name__ == "__main__":
    unittest.main()
