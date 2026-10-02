"""Sanity checks for the independent literal-flow oracle and coverage."""
from pathlib import Path
import runpy
import unittest

FLOW = runpy.run_path(str(Path(__file__).with_name("stress-literal-flow.py")))


class LiteralFlowTests(unittest.TestCase):
    def test_number_temporal_dispatch(self):
        for literal, kind in (("2024", "NumberLiteral"), ("2024-", "DateLiteral"), ("11", "NumberLiteral"),
                              ("11:", "TimeLiteral"), ("2024-T11", "DateTimeLiteral"), ("2024-T11&A", "WTCDateTimeLiteral"),
                              ("0e+01", "NumberLiteral"), ("-.1", "NumberLiteral")):
            self.assertEqual(FLOW["numeric_dispatch"](literal)[0], kind)
        for literal in ("0_1", "00", "1e", "1._2", "1 2", "-2024-02", "11:11&local"):
            self.assertIsNone(FLOW["numeric_dispatch"](literal), literal)

    def test_decode_exact_payload_and_scalar_rules(self):
        for literal, payload in (("| a |", " a "), (r"|a\|b|", "a|b"), (r'"\u0041"', "A"),
                                 (r'"\uD83D\uDE00"', "😀"), (r"|\u0000|", "\0"), ("`a\nb`", "a\nb"), ('""', "")):
            self.assertEqual(FLOW["decode"](literal), payload)
        for literal in ("||", "|a\nb|", "|a\rb|", '"a\rb"', r'"\uD800"', r'"\uDC00"',
                        r'"\u{D800}"', r'"\u{110000}"', r'"\u{0000041}"', r'"\uD800\u{DC00}"',
                        r'"\q"', r'"\|"', '"a""b"', '"a'):
            self.assertIsNone(FLOW["decode"](literal), literal)

    def test_numeric_semantics_allow_normalization_not_loss(self):
        key = lambda value: FLOW["numeric_semantics"]({"kind": "NumberLiteral", "value": value})
        self.assertEqual(key("+.50"), key("0.5"))
        self.assertEqual(key("1.0E+03"), key("1e3"))
        self.assertEqual(key("0e+01"), key("0e0"))
        self.assertNotEqual(key("0"), key("-0"))
        self.assertNotEqual(key("1.0"), key("1"))
        self.assertNotEqual(key("123456789012345678901234567890"), key("123456789012345678901234567891"))

    def test_unique_cases_and_family_boundaries(self):
        cases = FLOW["cases"]()
        identities = [(case.group, case.name) for case in cases]
        self.assertEqual(len(identities), len(set(identities)))
        self.assertTrue(all(not case.accepted for case in cases if case.group == "literal-family"))
        self.assertEqual(sum(case.group == "trimtick-gutter-transitions" for case in cases), 49)
        self.assertTrue(any(case.path == "$.v.@.x" and case.expected_value == "a\nb" for case in cases))


if __name__ == "__main__":
    unittest.main()
