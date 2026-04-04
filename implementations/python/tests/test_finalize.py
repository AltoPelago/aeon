from __future__ import annotations

from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from aeon.core import compile_source
from aeon.finalize import FinalizeOptions, finalize_json, finalize_map
from aeon.lexer import tokenize
from aeon.parser import parse_tokens


def compile_events(source: str) -> list[dict[str, object]]:
    result = compile_source(source)
    if result.errors:
        raise AssertionError([error.code for error in result.errors])
    return result.events


def compile_result(source: str):
    result = compile_source(source)
    if result.errors:
        raise AssertionError([error.code for error in result.errors])
    return result


def compile_header(source: str) -> dict[str, object]:
    lex = tokenize(source)
    parsed = parse_tokens(source, lex.tokens)
    if parsed.document is None or parsed.document.header is None:
        raise AssertionError("header not found")
    return {
        "fields": parsed.document.header.fields,
        "span": parsed.document.header.span.to_json(),
    }


class FinalizeJsonTests(unittest.TestCase):
    def test_builds_json_output_from_top_level_bindings(self) -> None:
        events = compile_events(
            '\n'.join([
                'name = "AEON"',
                'count = 3',
                'config = {',
                '  host = "localhost"',
                '  port:int32 = 5432',
                '}',
                'flags = [true, false]',
            ])
        )
        result = finalize_json(events)
        self.assertEqual(
            {
                "name": "AEON",
                "count": 3,
                "config": {"host": "localhost", "port": 5432},
                "flags": [True, False],
            },
            result["document"],
        )

    def test_emits_top_level_attribute_projection_under_at(self) -> None:
        result = finalize_json(compile_result('title@{lang="en"} = "Hello"'))
        self.assertEqual(
            {
                "title": "Hello",
                "@": {
                    "title": {
                        "lang": "en",
                    }
                },
            },
            result["document"],
        )

    def test_localizes_nested_object_attributes_under_at(self) -> None:
        result = finalize_json(compile_result('a@{b=1} = { c@{d=3} = 2 }'))
        self.assertEqual(
            {
                "a": {
                    "c": 2,
                    "@": {
                        "c": {
                            "d": 3,
                        }
                    },
                },
                "@": {
                    "a": {
                        "b": 1,
                    }
                },
            },
            result["document"],
        )

    def test_uses_node_and_children_for_node_projection(self) -> None:
        events = compile_events('view = <div@{id="main"}("hello")>')
        result = finalize_json(events)
        self.assertEqual(
            {
                "view": {
                    "$node": "div",
                    "@": {"id": "main"},
                    "$children": ["hello"],
                }
            },
            result["document"],
        )

    def test_records_reference_diagnostics_and_preserves_tokens(self) -> None:
        events = compile_events("a = 1\nb = ~>a")
        result = finalize_json(events, FinalizeOptions(mode="strict"))
        self.assertEqual("~>a", result["document"]["b"])
        self.assertTrue(result["meta"]["errors"])

    def test_materializes_switch_and_time_literals(self) -> None:
        switch = finalize_json(compile_events("debug = yes"), FinalizeOptions(mode="loose"))
        self.assertEqual(True, switch["document"]["debug"])

        time = finalize_json(compile_events("opens = 09:30:00+02:40"), FinalizeOptions(mode="loose"))
        self.assertEqual("09:30:00+02:40", time["document"]["opens"])

    def test_reports_infinity_as_outside_strict_json_profile(self) -> None:
        result = finalize_json(compile_events("limit:infinity = Infinity"), FinalizeOptions(mode="strict"))
        self.assertEqual("Infinity", result["document"]["limit"])
        self.assertTrue(result["meta"]["errors"])
        self.assertEqual("FINALIZE_JSON_PROFILE_INFINITY", result["meta"]["errors"][0]["code"])

    def test_preserves_hex_case_while_stripping_visual_separators(self) -> None:
        result = finalize_json(compile_events("color:hex = #Ff_00_Aa"), FinalizeOptions(mode="strict"))
        self.assertEqual("Ff00Aa", result["document"]["color"])

    def test_strips_underscore_separators_from_finalized_radix_strings(self) -> None:
        result = finalize_json(compile_events("mask = %101_0101"), FinalizeOptions(mode="strict"))
        self.assertEqual("1010101", result["document"]["mask"])

    def test_reports_radix_digits_that_exceed_declared_base_during_finalization(self) -> None:
        result = finalize_json(compile_events("mask:radix[10] = %1A"), FinalizeOptions(mode="strict"))
        self.assertEqual("1A", result["document"]["mask"])
        self.assertTrue(result["meta"]["errors"])
        self.assertIn("declared radix 10", result["meta"]["errors"][0]["message"])

    def test_keeps_declared_radix_validation_working_for_nested_payload_output(self) -> None:
        result = finalize_json(compile_events("config = { mask:radix[10] = %1A }"), FinalizeOptions(mode="strict", scope="full"))
        self.assertEqual(
            {
                "header": {},
                "payload": {
                    "config": {
                        "mask": "1A",
                    }
                },
            },
            result["document"],
        )
        self.assertTrue(result["meta"]["errors"])
        self.assertIn("declared radix 10", result["meta"]["errors"][0]["message"])

    def test_projects_only_whitelisted_paths(self) -> None:
        events = compile_events('app = { name = "demo", port = 8080 }\nother = "ignore"')
        result = finalize_json(
            events,
            FinalizeOptions(
                mode="strict",
                materialization="projected",
                include_paths=["$.app.name"],
            ),
        )
        self.assertEqual({"app": {"name": "demo"}}, result["document"])

    def test_projects_exact_top_level_attribute_path_without_siblings(self) -> None:
        result = finalize_json(
            compile_result('title@{lang="en", tone="warm"} = "Hello"'),
            FinalizeOptions(
                mode="strict",
                materialization="projected",
                include_paths=["$.title@lang"],
            ),
        )
        self.assertEqual(
            {
                "title": "Hello",
                "@": {
                    "title": {
                        "lang": "en",
                    }
                },
            },
            result["document"],
        )

    def test_projects_attribute_descendant_without_leaking_siblings(self) -> None:
        result = finalize_json(
            compile_result('card = { title@{meta={ keep=2, "x.y"=1 }, tone="warm"} = "Hello" }'),
            FinalizeOptions(
                mode="strict",
                materialization="projected",
                include_paths=['$.card.title@meta.keep'],
            ),
        )
        self.assertEqual(
            {
                "card": {
                    "title": "Hello",
                    "@": {
                        "title": {
                            "meta": {
                                "keep": 2,
                            }
                        }
                    },
                }
            },
            result["document"],
        )

    def test_projects_exact_node_head_attribute_path_without_siblings(self) -> None:
        result = finalize_json(
            compile_events('badge = <pill@{id="main", class="hero"}("new")>'),
            FinalizeOptions(
                mode="strict",
                materialization="projected",
                include_paths=['$.badge@@["id"]'],
            ),
        )
        self.assertEqual(
            {
                "badge": {
                    "$node": "pill",
                    "@": {
                        "id": "main",
                    },
                    "$children": ["new"],
                }
            },
            result["document"],
        )

    def test_supports_header_only_and_full_scopes(self) -> None:
        source = 'aeon:mode = "strict"\naeon:profile = "aeon.gp.profile.v1"\nname:string = "AEON"'
        events = compile_source(source).internal_events
        assert events is not None
        header = compile_header(source)

        header_only = finalize_json(
            events,
            FinalizeOptions(mode="strict", scope="header", header=header),
        )
        self.assertEqual(
            {"mode": "strict", "profile": "aeon.gp.profile.v1"},
            header_only["document"],
        )

        full = finalize_json(
            events,
            FinalizeOptions(mode="strict", scope="full", header=header),
        )
        self.assertEqual(
            {
                "header": {"mode": "strict", "profile": "aeon.gp.profile.v1"},
                "payload": {"name": "AEON"},
            },
            full["document"],
        )

    def test_projected_map_preserves_assignment_chain_for_attribute_paths(self) -> None:
        result = compile_result(
            'title@{lang = "en", meta = { keep = 2 }} = "Hello"\n'
            'card = { label@{meta = { keep = 3, "x.y" = 4 }} = "Hi" }\n'
            'rich = <pill@{id = "main", meta = { keep = 5 }}("new")>\n'
        )

        top_level = finalize_map(
            result,
            FinalizeOptions(
                materialization="projected",
                include_paths=["$.title@lang", "$.title@meta.keep"],
            ),
        )
        self.assertEqual(["$.title"], [entry["path"] for entry in top_level["document"]["entries"]])

        nested = finalize_map(
            result,
            FinalizeOptions(
                materialization="projected",
                include_paths=['$.card.label@meta.keep', '$.card.label@meta.["x.y"]'],
            ),
        )
        self.assertEqual(
            ["$.card", "$.card.label"],
            [entry["path"] for entry in nested["document"]["entries"]],
        )

        node = finalize_map(
            result,
            FinalizeOptions(
                materialization="projected",
                include_paths=["$.rich@@id", "$.rich@@meta.keep"],
            ),
        )
        self.assertEqual(["$.rich"], [entry["path"] for entry in node["document"]["entries"]])

    def test_preserves_legal_quoted_top_level_keys_in_json_finalization(self) -> None:
        result = finalize_json(compile_result('"a.b" = 2\n"two words" = 3'))
        self.assertEqual(
            {
                "a.b": 2,
                "two words": 3,
            },
            result["document"],
        )

    def test_projects_quoted_top_level_keys_by_canonical_include_path(self) -> None:
        result = finalize_json(
            compile_events('"a.b" = 2\nplain = 1'),
            FinalizeOptions(
                mode="strict",
                materialization="projected",
                include_paths=['$.["a.b"]'],
            ),
        )
        self.assertEqual({"a.b": 2}, result["document"])


if __name__ == "__main__":
    unittest.main()
