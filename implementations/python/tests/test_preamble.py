from __future__ import annotations

from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from aeon import inspect_file_preamble


class FilePreambleTests(unittest.TestCase):
    def test_inspects_shebang_and_format_directive(self) -> None:
        result = inspect_file_preamble("#!/usr/bin/env aeon\n//! format:aeon.test.v1\nvalue = {")
        self.assertEqual("#!/usr/bin/env aeon", result.shebang)
        self.assertIsNotNone(result.host_directive)
        self.assertEqual("//! format:aeon.test.v1", result.host_directive.raw)
        self.assertEqual("format", result.host_directive.kind)
        self.assertEqual("aeon.test.v1", result.format)

    def test_ignores_late_host_directive(self) -> None:
        result = inspect_file_preamble("value = 1\n//! format:aeon.test.v1")
        self.assertIsNone(result.shebang)
        self.assertIsNone(result.host_directive)
        self.assertIsNone(result.format)

    def test_ignores_leading_bom_during_preamble_inspection(self) -> None:
        result = inspect_file_preamble("\ufeff#!/usr/bin/env aeon\n//! format:aeon.test.v1\nvalue = {")
        self.assertEqual("#!/usr/bin/env aeon", result.shebang)
        self.assertIsNotNone(result.host_directive)
        self.assertEqual("aeon.test.v1", result.format)


if __name__ == "__main__":
    unittest.main()
