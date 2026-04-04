import unittest
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from aeon.lexer import tokenize
from aeon.parser import parse_tokens
from aeon.annotations import build_annotation_stream
from aeon.canonical import canonicalize
from aeon.core import CompileOptions, compile_source
from aeon.finalize import FinalizeOptions, finalize_json

class TestAlgorithmicStress(unittest.TestCase):
    def test_algorithmic_dos_recursion_nesting(self):
        depth = 2000
        source = f"k = {'[' * depth}{']' * depth}"
        tokens = tokenize(source).tokens
        result = parse_tokens(source, tokens)
        self.assertEqual(["NESTING_DEPTH_EXCEEDED"], [error.code for error in result.errors])

    def test_compile_fails_closed_on_deep_valid_nesting(self):
        depth = 2000
        source = f"k = {'[' * depth}0{']' * depth}"
        result = compile_source(source)
        self.assertEqual([], result.events)
        self.assertEqual(["NESTING_DEPTH_EXCEEDED"], [error.code for error in result.errors])
        
    def test_algorithmic_dos_large_integer(self):
        digits = 500000
        source = f"huge = {'1' * digits}"
        tokens = tokenize(source).tokens
        result = parse_tokens(source, tokens)
        self.assertEqual(len(result.errors), 0, "Should parse large integer tokens without crashing")

    def test_algorithmic_dos_nested_generic_depth_no_crash(self):
        depth = 2000
        nested_type = ("tuple<" * depth) + "n" + (">" * depth)
        source = f"g:{nested_type} = 1"
        try:
            result = compile_source(source)
            self.assertTrue(any(error.code == "GENERIC_DEPTH_EXCEEDED" for error in result.errors))
        except RecursionError:
            self.fail("RecursionError leaked and crashed the parser on nested generic depth!")

    def test_separator_literal_escape_stress(self):
        repeats = 4000
        payload = '0\\,0\\\\0\\ 0|"0;0"|'
        source = f"line:set[|] = ^{payload * repeats}"
        result = compile_source(source, CompileOptions(max_separator_depth=8))
        self.assertEqual([], [error.code for error in result.errors])
        event = next((entry for entry in result.events if entry["key"] == "line"), None)
        self.assertIsNotNone(event)
        self.assertEqual("SeparatorLiteral", event["value"]["type"])

    def test_reference_path_explosion(self):
        chain = 120
        lines = [
            'aeon:header = {',
            '  encoding:string = "utf-8"',
            '  mode:string = "transport"',
            '}',
            'root:object = {',
            '  "alpha.beta":object = {',
            '    arr:list = [',
            '      {',
            '        meta:object = {',
            '          "x.y":number = 7',
            '        }',
            '      }',
            '    ]',
            '  }',
            '}',
        ]
        ref = '~$.root["alpha.beta"].arr[0].meta["x.y"]'
        for i in range(chain):
            lines.append(f"ref{i}:number = {ref}")
        result = compile_source("\n".join(lines))
        self.assertEqual([], [error.code for error in result.errors])
        ref_events = [entry for entry in result.events if str(entry["key"]).startswith("ref")]
        self.assertEqual(chain, len(ref_events))

    def test_projection_path_stress(self):
        width = 150
        lines = ['root:object = {']
        include_paths = []
        for i in range(width):
            lines.append(f"  item{i}:object = {{")
            lines.append(f'    name:string = "n{i}"')
            lines.append(f"    count:number = {i}")
            lines.append("  }")
            include_paths.append(f"$.root.item{i}.name")
        lines.append("}")
        result = compile_source("\n".join(lines))
        self.assertEqual([], [error.code for error in result.errors])
        finalized = finalize_json(
            result.events,
            FinalizeOptions(
                mode="strict",
                materialization="projected",
                include_paths=include_paths,
            ),
        )
        self.assertNotIn("meta", finalized)
        self.assertEqual("n0", finalized["document"]["root"]["item0"]["name"])
        self.assertNotIn("count", finalized["document"]["root"]["item0"])

    def test_comment_channel_density(self):
        items = 250
        lines = ["list = ["]
        for i in range(items):
            lines.append(f"  /? before-{i} ?/ {i}, //# after-{i}")
        lines.append("]")
        lines.append("/# eof-tail #/")
        source = "\n".join(lines)
        result = compile_source(source)
        self.assertEqual([], [error.code for error in result.errors])
        annotations = build_annotation_stream(source, result.internal_events or [])
        self.assertGreaterEqual(len(annotations), items)

    def test_wide_duplicate_key_collisions(self):
        repeats = 1000
        source = "dupes:object = {\n" + "\n".join("  collision:number = 1" for _ in range(repeats)) + "\n}"
        strict_result = compile_source(source)
        self.assertTrue(any(error.code == "DUPLICATE_CANONICAL_PATH" for error in strict_result.errors))
        recovery_result = compile_source(source, CompileOptions(recovery=True))
        self.assertGreater(len(recovery_result.events), 0)

    def test_canonical_quoted_key_sort_pressure(self):
        keys = [f'"k.{i:03d}" = {i}' for i in range(200)]
        forward = canonicalize("\n".join(keys))
        reverse = canonicalize("\n".join(reversed(keys)))
        self.assertEqual([], forward.errors)
        self.assertEqual([], reverse.errors)
        self.assertEqual(forward.text, reverse.text)

if __name__ == "__main__":
    unittest.main()
