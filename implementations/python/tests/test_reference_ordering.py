from __future__ import annotations

import hashlib
from dataclasses import asdict
from itertools import permutations
import json
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from aeon.canonical import CanonicalizeOptions, canonicalize
from aeon.core import resolve_paths, resolved_binding_to_event, validate_references
from aeon.lexer import tokenize
from aeon.parser import parse_tokens
from aeon.portable import adapt_python_assignment_events_to_portable_aes

CTS = Path(os.environ.get("AEONITE_CTS_ROOT", ROOT.parents[3] / "aeonite-org/aeonite-cts/cts"))


class ReferenceOrderingTests(unittest.TestCase):
    def canonical(self, source, **options):
        return canonicalize(source, CanonicalizeOptions(ordering="reference-safe-v1", **options))

    def document(self, source, depth=2):
        lexed = tokenize(source)
        self.assertEqual([], lexed.errors)
        parsed = parse_tokens(source, lexed.tokens, max_attribute_depth=depth)
        self.assertEqual([], parsed.errors)
        self.assertIsNotNone(parsed.document)
        return parsed.document

    def graph(self, source, include_headers):
        document = self.document(source)
        resolved, errors = resolve_paths(document)
        self.assertEqual([], errors)
        self.assertEqual([], validate_references(resolved, 2))
        events = [resolved_binding_to_event(binding, include_annotations=True) for binding in resolved]
        records = adapt_python_assignment_events_to_portable_aes(events, include_headers=include_headers)["events"]
        output = []
        for record in records:
            record = {key: value for key, value in record.items() if key not in {"span", "origin"}}
            if record["kind"] == "RadixLiteral":
                record["value"] = record["value"].replace("_", "")
            output.append(json.dumps(record, sort_keys=True))
        return sorted(output)

    def test_selected_experimental_vectors(self):
        manifest_path = CTS / "canonical/v1/canonical-reference-ordering-cts.v1.next.json"
        manifest = json.loads(manifest_path.read_text())
        self.assertEqual("experimental", manifest["meta"]["status"])
        observed = 0
        excluded = 0
        for ref in manifest["suites"]:
            data = (manifest_path.parent / ref["file"]).read_bytes()
            if "content_sha256" in ref:
                self.assertEqual(ref["content_sha256"], hashlib.sha256(data).hexdigest())
            for vector in json.loads(data)["tests"]:
                if vector["id"] in ref.get("exclude_tests", []):
                    excluded += 1
                    continue
                observed += 1
                with self.subTest(vector=vector["id"]):
                    source = vector["input"]["source"]
                    result = self.canonical(source)
                    self.assertEqual(vector["expected"]["ok"], not result.errors, result.errors)
                    for expected in vector["expected"]["errors"]:
                        self.assertIn(expected["code"], [error.code for error in result.errors])
                    expected_text = vector["expected"]["result"].get("canonical_text")
                    if isinstance(expected_text, str):
                        self.assertEqual(expected_text.rstrip(), result.text.rstrip())
                    if result.errors:
                        self.assertEqual("", result.text)
                    else:
                        self.assertEqual(result.text, self.canonical(result.text).text)
                        include_headers = self.document(source).header is not None
                        self.assertEqual(self.graph(source, include_headers), self.graph(result.text, include_headers))
        self.assertEqual(197, observed)
        self.assertEqual(2, excluded)

    def test_legacy_default_and_explicit_opt_in(self):
        source = "z=1\na=~z"
        legacy = canonicalize(source)
        self.assertEqual(legacy, canonicalize(source, CanonicalizeOptions(ordering="lexical-v1")))
        self.assertLess(legacy.text.index("a ="), legacy.text.index("z ="))
        result = self.canonical(source)
        self.assertEqual([], result.errors)
        self.assertLess(result.text.index("z ="), result.text.index("a ="))
        # Existing positional option arguments retain their meanings.
        self.assertEqual(legacy, canonicalize(source, CanonicalizeOptions(1, 1, 1, 32, 64)))

    def test_rendering_boundaries_preserve_graph_and_fixed_point(self):
        fixtures = json.loads((ROOT.parents[1] / "test-fixtures/canonical-rendering-boundaries.json").read_text())
        for fixture in fixtures:
            with self.subTest(fixture=fixture["id"]):
                source = fixture["source"]
                result = self.canonical(source, max_attribute_depth=2)
                self.assertEqual([], result.errors, result.errors)
                self.assertIn(fixture["fragment"], result.text)
                self.assertEqual(result.text, self.canonical(result.text, max_attribute_depth=2).text)
                include_headers = self.document(source).header is not None
                self.assertEqual(self.graph(source, include_headers), self.graph(result.text, include_headers))

    def test_new_rendering_fixes_do_not_change_historical_bytes(self):
        for source, suffix in (
            ('"z\\n"=1', 'z\n = 1'),
            ('a=[@{}=1]', 'a = [@{} = 1]'),
            ('a@{m={}}=0', 'a@{m = { }} = 0'),
        ):
            with self.subTest(source=source):
                legacy = canonicalize(source)
                self.assertEqual([], legacy.errors)
                self.assertTrue(legacy.text.endswith(suffix), legacy.text)
                self.assertEqual(legacy, canonicalize(source, CanonicalizeOptions(ordering="lexical-v1")))

    def test_four_entry_graphs_converge_to_independent_minimum(self):
        keys = ["d", "c", "b", "a"]
        possible = [(key, target) for index, key in enumerate(keys) for target in keys[:index]]
        all_orders = sorted(permutations(keys))
        checked = 0
        for mask in range(1 << len(possible)):
            edges = [edge for index, edge in enumerate(possible) if mask & (1 << index)]
            legal = [order for order in all_orders if all(order.index(target) < order.index(key) for key, target in edges)]
            canonical = None
            for order in legal:
                lines = []
                for key in order:
                    targets = [f"~{target}" for owner, target in edges if owner == key]
                    lines.append(f"{key}=" + ("[" + ",".join(targets) + "]" if targets else "0"))
                result = self.canonical("\n".join(lines))
                self.assertEqual([], result.errors)
                self.assertEqual(legal[0], tuple(binding.key for binding in self.document(result.text).bindings))
                if canonical is not None:
                    self.assertEqual(canonical, result.text)
                canonical = result.text
                checked += 1
            self.assertEqual(canonical, self.canonical(canonical).text)
        self.assertEqual(315, checked)

    def test_limits_and_invalid_options_fail_closed(self):
        for source, limit in (("z=1\na=~z", 0), ("z=1\na=~z\nb=~z", 1), ("outer={z=1,b=~outer.z}", 0)):
            result = self.canonical(source, max_ordering_edges=limit)
            self.assertEqual("", result.text)
            self.assertEqual(["CANONICAL_ORDERING_LIMIT_EXCEEDED"], [error.code for error in result.errors])
        self.assertEqual([], self.canonical("z=1\na={b=~z,c=~>z}", max_ordering_edges=1).errors)
        self.assertEqual([], self.canonical("z=1\na=0", max_ordering_edges=0).errors)
        for limit in (-1, 0.5, float("inf"), float("nan"), 2 ** 53, True, None):
            result = self.canonical("a=1", max_ordering_edges=limit)
            self.assertEqual("", result.text)
            self.assertEqual(["CANONICAL_ORDERING_INVALID_OPTION"], [error.code for error in result.errors])
        self.assertEqual("CANONICAL_ORDERING_INVALID_OPTION", canonicalize("a=1", CanonicalizeOptions(ordering="unknown")).errors[0].code)
        # The edge budget is not interpreted for the historical contract.
        self.assertEqual([], canonicalize("a=1", CanonicalizeOptions(max_ordering_edges=-1)).errors)

    def test_output_revalidation_prevents_partial_success(self):
        with patch("aeon._canonical_ordering._Renderer.render", return_value="a=~z\nz=1\n"):
            result = self.canonical("z=1\na=~z")
        self.assertEqual("", result.text)
        self.assertEqual(["CANONICAL_ORDERING_CONFLICT"], [error.code for error in result.errors])

    def test_core_only_metadata_depth_and_exact_heads(self):
        source = 'aeon:profile="aeon.gp.profile.v1"\nx:radix[2.0000000000000001]=%1'
        self.assertEqual([], self.canonical(source).errors)  # Not profile approval.
        source = "a@{z@{x=1}=1,b=~a.@.z.@.x}=0"
        self.assertTrue(self.canonical(source).errors)
        self.assertEqual([], self.canonical(source, max_attribute_depth=2).errors)
        for source in ('a@{m={b\\B\\=1,a=~a.@.m.b}}=0', '"aeon":custom=0', 'a=[\\VALUE\\@{m=1}={z=1,a=0}]'):
            result = self.canonical(source)
            self.assertEqual([], result.errors, result.errors)
            self.assertEqual(self.graph(source, False), self.graph(result.text, False))

    def test_exact_header_collisions_do_not_invent_local_dependencies(self):
        prefix = 'aeon:header={x@{meta=1}={leaf@{m=2}=3}}\n"aeon:x"=2\n'
        for target, order in (
            ('["aeon:x"].leaf', ["a", "aeon:x"]),
            ('["aeon:x"].leaf.@.m', ["a", "aeon:x"]),
            ('["aeon:x"]', ["aeon:x", "a"]),
        ):
            source = prefix + "a=~" + target
            result = self.canonical(source)
            self.assertEqual([], result.errors)
            self.assertEqual(order, [binding.key for binding in self.document(result.text).bindings])
            self.assertEqual(self.graph(source, True), self.graph(result.text, True))
        shadowed = self.canonical(prefix + 'a=~["aeon:x"].@.meta')
        self.assertEqual("", shadowed.text)
        self.assertEqual(["MISSING_REFERENCE_TARGET"], [error.code for error in shadowed.errors])

    def test_scalar_key_order_and_literal_attribute_markers(self):
        result = self.canonical('"😀"=1\n"\ue000"=2')
        self.assertEqual([], result.errors)
        self.assertEqual(["\ue000", "😀"], [binding.key for binding in self.document(result.text).bindings])
        source = 'holder={"literal.@key"=1}\na=~holder.["literal.@key"]'
        result = self.canonical(source)
        self.assertEqual([], result.errors)
        self.assertEqual(self.graph(source, False), self.graph(result.text, False))

    def test_planning_and_rendering_do_not_mutate_the_authored_ast(self):
        from aeon._canonical_ordering import _orders, _Renderer

        document = self.document('z@{z=1,a=~z.@.z}=2\na={z=~z,a=0}')
        original = asdict(document)
        bindings, errors = resolve_paths(document)
        self.assertEqual([], errors)
        self.assertEqual([], validate_references(bindings, 2))
        orders = _orders(document, 1_000_000, bindings)
        rendered = _Renderer(document, orders).render()
        self.assertEqual(original, asdict(document))
        self.assertEqual(rendered, self.canonical(rendered).text)


if __name__ == "__main__":
    unittest.main()
