from __future__ import annotations

from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from aeon.core import CompileOptions, compile_source, datatype_has_generic_args


class CoreCompileTests(unittest.TestCase):
    def test_simple_strict_parse(self) -> None:
        result = compile_source("a:number = 1")
        self.assertEqual([], result.errors)
        self.assertEqual("$.a", result.events[0]["path"])
        self.assertEqual("number", result.events[0]["datatype"])

    def test_quoted_key_path(self) -> None:
        result = compile_source('"a.b" = 2')
        self.assertEqual([], result.errors)
        self.assertEqual('$.["a.b"]', result.events[0]["path"])

    def test_literal_words_parse_as_keys_in_key_contexts(self) -> None:
        result = compile_source(
            'yes:string = "top"\n'
            'copy:string = ~yes\n'
            'true@{no:string = "attr"}:string = "named true"\n'
            'node:node = <on(off)>\n'
            'group:object = {\n'
            '  false:boolean = true\n'
            '  off:toggle = yes\n'
            '}'
        )
        self.assertEqual([], result.errors)
        by_path = {event["path"]: event for event in result.events}
        self.assertIn("$.yes", by_path)
        self.assertIn("$.copy", by_path)
        self.assertIn("$.true", by_path)
        self.assertIn("no", by_path["$.true"]["annotations"])
        self.assertEqual("NodeLiteral", by_path["$.node"]["value"]["type"])
        self.assertIn("$.group.false", by_path)
        self.assertIn("$.group.off", by_path)

    def test_sansa_address_literals_accept_rich_forms(self) -> None:
        result = compile_source(
            "absolute:sansa = $.inventory.items[2].sku\n"
            "contextual:sansa = ?.name\n"
            'rich:sansa = $.items.*#text%stringLiteral.("item?*")\n'
            "parent:sansa = $.items[1].^.sku\n"
            "range:sansa = $.items[0..1]\n"
            "openEnd:sansa = $.items[1..]\n"
            "openStart:sansa = $.items[..1]\n"
            'csv:sansa = $.inventory:csv[","]\n'
            "external:sansa = $.value:type<type>[arg]\n"
            "chained:sansa = $.path:tuple<x><y>"
        )
        self.assertEqual([], result.errors)
        for event in result.events:
            self.assertEqual("SansaAddressLiteral", event["value"]["type"])

    def test_sansa_address_literals_terminate_before_comments_and_containers(self) -> None:
        result = compile_source(
            "a:sansa = $.name/* block */\n"
            "b:sansa = $.name// line\n"
            "c:list = [$.name]\n"
            "d:node = <tag($.name)>\n"
            "e:tuple = ($.name)\n"
            'f:sansa = $.items.("item_*")'
        )
        self.assertEqual([], result.errors)
        by_path = {event["path"]: event for event in result.events}
        self.assertEqual("SansaAddressLiteral", by_path["$.a"]["value"]["type"])
        self.assertEqual("SansaAddressLiteral", by_path["$.b"]["value"]["type"])
        self.assertEqual("ListNode", by_path["$.c"]["value"]["type"])
        self.assertEqual("NodeLiteral", by_path["$.d"]["value"]["type"])
        self.assertEqual("TupleLiteral", by_path["$.e"]["value"]["type"])
        self.assertEqual("SansaAddressLiteral", by_path["$.f"]["value"]["type"])

    def test_empty_quoted_key_rejected(self) -> None:
        result = compile_source('"" = ""')
        self.assertEqual(["SYNTAX_ERROR"], [error.code for error in result.errors])

    def test_empty_quoted_path_segment_rejected(self) -> None:
        result = compile_source('a = 1\nv = ~a.[""]')
        self.assertEqual(["SYNTAX_ERROR"], [error.code for error in result.errors])

    def test_root_quoted_member_requires_explicit_dot(self) -> None:
        result = compile_source('"a.b" = 1\nv = ~$["a.b"]')
        self.assertEqual(["SYNTAX_ERROR"], [error.code for error in result.errors])

    def test_root_quoted_member_accepts_explicit_dot_form(self) -> None:
        result = compile_source('"a.b" = 1\nv = ~$.["a.b"]')
        self.assertEqual([], result.errors)

    def test_quoted_member_reference_without_explicit_root_marker_is_legal(self) -> None:
        result = compile_source('"a.b" = 1\nv = ~["a.b"]')
        self.assertEqual([], result.errors)

    def test_escaped_backtick_inside_backtick_string(self) -> None:
        result = compile_source("string006:string = `\\``")
        self.assertEqual([], result.errors)
        self.assertEqual("`", result.events[0]["value"]["value"])

    def test_typed_clone_reference_uses_referenced_value_kind(self) -> None:
        result = compile_source('aeon:mode = "strict"\nref_source_num:number = 99\nclone001:number = ~ref_source_num')
        self.assertEqual([], result.errors)

    def test_typed_pointer_reference_uses_referenced_value_kind(self) -> None:
        result = compile_source('aeon:mode = "strict"\nref_source_num:number = 99\npointer001:number = ~>ref_source_num')
        self.assertEqual([], result.errors)

    def test_structured_header_metadata_is_control_plane_in_strict_mode(self) -> None:
        result = compile_source(
            'aeon:header = {\n'
            '  mode = "strict"\n'
            '  version = "1"\n'
            '  profile = "aeon.gp.profile.v1"\n'
            '  schema = "altopelago.example.schema.v1"\n'
            '}\n'
            'name:string = "AEON"'
        )
        self.assertEqual([], result.errors)

    def test_consumer_selected_transport_mode_overrides_declared_strict_mode(self) -> None:
        result = compile_source('aeon:mode = "strict"\nname = "AEON"', CompileOptions(mode="transport"))
        self.assertEqual([], result.errors)

    def test_list_emits_indexed_paths(self) -> None:
        result = compile_source("a = [1]")
        self.assertEqual([], result.errors)
        self.assertEqual(["$.a", "$.a[0]"], [event["path"] for event in result.events])

    def test_anonymous_typed_list_tuple_and_node_values(self) -> None:
        result = compile_source(
            'values:list = [:int32 = 3, :string = "4"]\n'
            'pair:tuple = (:float64 = 10.5, :float64 = 2.0)\n'
            'page:node = <page(:string = "hello", <tag>, :int32 = 3)>'
        )
        self.assertEqual([], result.errors)
        by_path = {event["path"]: event for event in result.events}
        self.assertEqual("int32", by_path["$.values[0]"]["datatype"])
        self.assertEqual("string", by_path["$.values[1]"]["datatype"])
        self.assertEqual("float64", by_path["$.pair[0]"]["datatype"])
        self.assertEqual("float64", by_path["$.pair[1]"]["datatype"])
        self.assertEqual("NodeLiteral", by_path["$.page"]["value"]["type"])
        self.assertEqual("string", by_path["$.page[0]"]["datatype"])
        self.assertEqual("NodeLiteral", by_path["$.page[1]"]["value"]["type"])
        self.assertEqual("int32", by_path["$.page[2]"]["datatype"])

    def test_node_children_emit_indexed_paths_and_descendants(self) -> None:
        result = compile_source('page:node = <page({a:n = 1, b:n = 2}, "hello")>')
        self.assertEqual([], result.errors)
        by_path = {event["path"]: event for event in result.events}
        self.assertIn("$.page", by_path)
        self.assertIn("$.page[0]", by_path)
        self.assertIn("$.page[0].a", by_path)
        self.assertIn("$.page[0].b", by_path)
        self.assertIn("$.page[1]", by_path)

    def test_references_resolve_through_node_child_indexes(self) -> None:
        result = compile_source('page:node = <page({a:n = 1})>\ncopy:n = ~page[0].a')
        self.assertEqual([], result.errors)
        self.assertIn("$.copy", {event["path"] for event in result.events})

    def test_anonymous_attributed_values_emit_indexed_annotations(self) -> None:
        result = compile_source('page:node = <page(@{unit:string="cm"}:int32 = 3)>\nvalues:list = [@{unit:string="cm"} = 4]')
        self.assertEqual([], result.errors)
        by_path = {event["path"]: event for event in result.events}
        self.assertEqual("int32", by_path["$.page[0]"]["datatype"])
        self.assertEqual("string", by_path["$.page[0]"]["annotations"]["unit"]["datatype"])
        self.assertIsNone(by_path["$.values[0]"]["datatype"])
        self.assertEqual("string", by_path["$.values[0]"]["annotations"]["unit"]["datatype"])

    def test_rejects_reserved_attribute_keys(self) -> None:
        for source in [
            'a@{"@items":n=0}:list = [1]',
            'a:list = [@{"@items":n=0}:n = 4]',
            'a@{"@":n=0} = 1',
            'a@{"__proto__":n=0} = 1',
            'a@{"constructor":n=0} = 1',
            'a@{"prototype":n=0} = 1',
        ]:
            with self.subTest(source=source):
                result = compile_source(source)
                self.assertTrue(result.errors)
                self.assertEqual("SYNTAX_ERROR", result.errors[0].code)
                self.assertIn("Reserved attribute key", result.errors[0].message)

    def test_anonymous_typed_value_rejections(self) -> None:
        for source in [
            ":n = 3",
            "a:n = :n = 3",
            "a:list = [:n = :n = 3]",
            "a:node = <tag(:n = :n = 3)>",
            "a:object = { :n = 3 }",
            "a:list[ :n = :n = 3 ]",
            "a:list[ n = 3 ]",
            "a:list[ : = 3 ]",
            "a:list[ = 3 ]",
            "a:list = [@{unit:n=3}@{a:n=2}:n = 3]",
        ]:
            with self.subTest(source=source):
                result = compile_source(source)
                self.assertIn("SYNTAX_ERROR", [error.code for error in result.errors])

    def test_rejects_repeated_head_attribute_blocks(self) -> None:
        for source in [
            "a@{unit:n=3}@{precision:n=2}:n = 3",
            "n:node = <a@{unit:n=3}@{precision:n=2}:node>",
        ]:
            with self.subTest(source=source):
                result = compile_source(source)
                self.assertIn("SYNTAX_ERROR", [error.code for error in result.errors])

    def test_list_rejects_double_comma_delimiter(self) -> None:
        result = compile_source("a:list = [1,,2]")
        self.assertEqual(["SYNTAX_ERROR"], [error.code for error in result.errors])

    def test_top_level_bindings_require_explicit_delimiter(self) -> None:
        result = compile_source("a = 1 b = 2")
        self.assertEqual(["SYNTAX_ERROR"], [error.code for error in result.errors])
        self.assertEqual("Expected top-level binding delimiter", result.errors[0].message)

    def test_top_level_bindings_reject_block_comment_only_separation(self) -> None:
        result = compile_source("a = 1 /* gap */ b = 2")
        self.assertEqual(["SYNTAX_ERROR"], [error.code for error in result.errors])
        self.assertEqual("Expected top-level binding delimiter", result.errors[0].message)

    def test_custom_datatype_rejected_in_strict_header(self) -> None:
        source = 'aeon:mode = "strict"\ncolor:stroke = #ff00ff'
        result = compile_source(source)
        self.assertEqual(["CUSTOM_DATATYPE_NOT_ALLOWED"], [error.code for error in result.errors])

    def test_custom_datatype_allowed_with_policy(self) -> None:
        source = 'aeon:mode = "strict"\ncolor:stroke = #ff00ff'
        result = compile_source(source, CompileOptions(datatype_policy="allow_custom"))
        self.assertEqual([], result.errors)

    def test_strict_mode_rejects_custom_toggle_alias_even_with_allow_custom(self) -> None:
        source = 'aeon:mode = "strict"\ns:myToggle = on'
        result = compile_source(source, CompileOptions(datatype_policy="allow_custom"))
        self.assertEqual(["CUSTOM_TOGGLE_ALIAS_NOT_ALLOWED"], [error.code for error in result.errors])

    def test_custom_datatype_allowed_in_transport_mode_by_default(self) -> None:
        source = 'aeon:mode = "transport"\ncolor:stroke = #ff00ff'
        result = compile_source(source)
        self.assertEqual([], result.errors)

    def test_custom_mode_requires_typed_values(self) -> None:
        source = 'aeon:mode = "custom"\ncolor = #ff00ff'
        result = compile_source(source)
        self.assertEqual(["UNTYPED_VALUE_IN_STRICT_MODE"], [error.code for error in result.errors])

    def test_custom_mode_allows_custom_datatypes_by_default(self) -> None:
        source = 'aeon:mode = "custom"\ncolor:stroke = #ff00ff'
        result = compile_source(source)
        self.assertEqual([], result.errors)

    def test_custom_mode_allows_custom_toggle_aliases(self) -> None:
        source = 'aeon:mode = "custom"\ns:myToggle = on'
        result = compile_source(source)
        self.assertEqual([], result.errors)

    def test_custom_mode_rejects_removed_toggle_datatype_spelling(self) -> None:
        source = 'aeon:mode = "custom"\ns:switch = on'
        result = compile_source(source)
        self.assertEqual(["CUSTOM_TOGGLE_ALIAS_NOT_ALLOWED"], [error.code for error in result.errors])

    def test_prose_reserved_alias_accepts_trimticks_in_strict_mode(self) -> None:
        source = 'aeon:mode = "strict"\nbody:prose = >`\n  # Heading\n\n  Markdown-ish content.\n`'
        result = compile_source(source)
        self.assertEqual([], result.errors)
        body = next(event for event in result.events if event["path"] == "$.body")
        self.assertEqual("prose", body["datatype"])
        self.assertEqual("StringLiteral", body["value"]["type"])

    def test_custom_mode_enforces_switch_typing(self) -> None:
        source = 'aeon:mode = "custom"\ndebug = yes'
        result = compile_source(source)
        self.assertEqual(["UNTYPED_VALUE_IN_STRICT_MODE"], [error.code for error in result.errors])

    def test_reserved_radix12_alias_allowed_in_strict_mode(self) -> None:
        source = "aeon:mode = \"strict\"\nclock:radix12 = %AB10"
        result = compile_source(source)
        self.assertEqual([], result.errors)
        self.assertEqual("radix12", result.events[0]["datatype"])

    def test_reserved_radix_brackets_allowed_in_strict_mode(self) -> None:
        result = compile_source('aeon:mode = "strict"\nr:radix[2] = %0101')
        self.assertEqual([], result.errors)
        self.assertEqual("radix[2]", result.events[0]["datatype"])

    def test_leading_dot_radix_literals_are_allowed(self) -> None:
        result = compile_source('aeon:mode = "strict"\na:radix = %-.3\nb:radix = %+.1\nc:radix = %.1')
        self.assertEqual([], result.errors)

    def test_reserved_scalar_generics_are_rejected(self) -> None:
        result = compile_source("a:n<string> = 3")
        self.assertEqual(["SYNTAX_ERROR"], [error.code for error in result.errors])

    def test_parameterized_object_and_node_claims_are_preserved(self) -> None:
        result = compile_source(
            'scores:object<number> = { alice:number = 10 }\ndoc:node<html> = <html>\nchild:node<node> = <tag>\nmissing:null<number> = !none\nbad:nan<number> = NaN\nfast:infinity<speedofmass> = Infinity'
        )
        self.assertEqual([], result.errors)
        self.assertEqual("object<number>", result.events[0]["datatype"])
        self.assertEqual("node<html>", result.events[2]["datatype"])
        self.assertEqual("node<node>", result.events[3]["datatype"])
        self.assertEqual("null<number>", result.events[4]["datatype"])
        self.assertEqual("nan<number>", result.events[5]["datatype"])
        self.assertEqual("infinity<speedofmass>", result.events[6]["datatype"])

    def test_binding_node_claim_rejects_reserved_child_value_datatypes(self) -> None:
        result = compile_source("tag:node<string> = <tag>")
        self.assertEqual(["SYNTAX_ERROR"], [error.code for error in result.errors])
        self.assertIn("reserved child value datatypes belong on node heads", result.errors[0].message)

    def test_reserved_scalar_brackets_are_rejected(self) -> None:
        result = compile_source('b:string[333] = "hello world"')
        self.assertEqual(["SYNTAX_ERROR"], [error.code for error in result.errors])

    def test_fixed_radix_alias_brackets_are_rejected(self) -> None:
        result = compile_source("r:radix2[4] = %111")
        self.assertEqual(["SYNTAX_ERROR"], [error.code for error in result.errors])

    def test_reserved_object_aliases_allowed_in_strict_mode(self) -> None:
        for datatype in ("object", "obj", "envelope", "o"):
            with self.subTest(datatype=datatype):
                source = f'aeon:mode = "strict"\nvalue:{datatype} = {{ answer:number = 42 }}'
                result = compile_source(source)
                self.assertEqual([], result.errors)
                self.assertEqual(datatype, result.events[0]["datatype"])
                self.assertEqual("ObjectNode", result.events[0]["value"]["type"])

    def test_reserved_separator_aliases_allowed_in_strict_mode(self) -> None:
        for datatype in ("sep",):
            with self.subTest(datatype=datatype):
                source = f'aeon:mode = "strict"\nvalue:{datatype}[|] = ^a|b'
                result = compile_source(source)
                self.assertEqual([], result.errors)
                self.assertEqual(f"{datatype}[|]", result.events[0]["datatype"])
                self.assertEqual("SeparatorLiteral", result.events[0]["value"]["type"])

    def test_reserved_slash_separator_specs_are_rejected(self) -> None:
        result = compile_source('aeon:mode = "strict"\nvalue:sep[/] = ^000.000')
        self.assertEqual(["INVALID_SEPARATOR_CHAR"], [error.code for error in result.errors])

    def test_reserved_caret_separator_specs_are_allowed(self) -> None:
        result = compile_source('aeon:mode = "strict"\nleft:sep[^] = ^a^b\nright:sep[^] = ^a^b')
        self.assertEqual([], result.errors)
        self.assertEqual("sep[^]", result.events[0]["datatype"])
        self.assertEqual("sep[^]", result.events[1]["datatype"])

    def test_infinity_datatype_is_allowed_in_typed_modes(self) -> None:
        result = compile_source('aeon:mode = "strict"\nlimit:infinity = Infinity')
        self.assertEqual([], result.errors)
        self.assertEqual("InfinityLiteral", result.events[0]["value"]["type"])

    def test_nan_datatype_is_allowed_in_typed_modes(self) -> None:
        result = compile_source('aeon:mode = "strict"\nvalue:nan = NaN')
        self.assertEqual([], result.errors)
        self.assertEqual("NaNLiteral", result.events[0]["value"]["type"])

    def test_null_datatype_is_allowed_in_typed_modes(self) -> None:
        result = compile_source('aeon:mode = "strict"\nvalue:null = !none\nreason:null = !"postponed"')
        self.assertEqual([], result.errors)
        self.assertEqual("NullLiteral", result.events[0]["value"]["type"])
        self.assertEqual("NullLiteral", result.events[1]["value"]["type"])

    def test_not_set_null_sentinel_is_allowed_in_typed_modes(self) -> None:
        result = compile_source('aeon:mode = "strict"\nvalue:null = !notSet')
        self.assertEqual([], result.errors)
        self.assertEqual("NullLiteral", result.events[0]["value"]["type"])
        self.assertEqual("notSet", result.events[0]["value"]["value"])

    def test_number_datatype_rejects_infinity_literal(self) -> None:
        result = compile_source('aeon:mode = "strict"\nlimit:number = Infinity')
        self.assertEqual(["DATATYPE_LITERAL_MISMATCH"], [error.code for error in result.errors])

    def test_number_datatype_rejects_nan_literal(self) -> None:
        result = compile_source('aeon:mode = "strict"\nvalue:number = NaN')
        self.assertEqual(["DATATYPE_LITERAL_MISMATCH"], [error.code for error in result.errors])

    def test_null_datatype_rejects_number_literal(self) -> None:
        result = compile_source('aeon:mode = "strict"\nvalue:null = 0')
        self.assertEqual(["DATATYPE_LITERAL_MISMATCH"], [error.code for error in result.errors])

    def test_removed_reserved_aliases_are_rejected_in_strict_mode(self) -> None:
        cases = (
            ("localdatetime", "2026-03-11T10:30:00Z"),
            ("radix10", "%123"),
            ("radix16", "%BEEF"),
        )
        for datatype, literal in cases:
            with self.subTest(datatype=datatype):
                source = f'aeon:mode = "strict"\nvalue:{datatype} = {literal}'
                result = compile_source(source)
                self.assertEqual(["CUSTOM_DATATYPE_NOT_ALLOWED"], [error.code for error in result.errors])

    def test_invalid_lowercase_t_temporals_are_rejected(self) -> None:
        cases = (
            "dt:datetime = 2007-01-02t10:10:25",
            "z:zrut = 2007-01-02t10:10:25Z&Australia/Melbourne",
        )
        for source in cases:
            with self.subTest(source=source):
                result = compile_source(f'aeon:mode = "strict"\n{source}')
                self.assertEqual(["SYNTAX_ERROR"], [error.code for error in result.errors])

    def test_zrut_accepts_common_named_zone_identifiers_with_dash_and_plus(self) -> None:
        cases = (
            "z:zrut = 2025-01-01T09Z&America/Port-au-Prince",
            "z:zrut = 2025-01-01T09Z&GB-Eire",
            "z:zrut = 2025-01-01T09Z&Etc/GMT-1",
            "z:zrut = 2025-01-01T09Z&Etc/GMT+1",
        )
        for source in cases:
            with self.subTest(source=source):
                result = compile_source(source)
                self.assertEqual([], result.errors)

    def test_zrut_still_rejects_invalid_slash_placement(self) -> None:
        cases = (
            "z:zrut = 2025-01-01T09Z&/",
            "z:zrut = 2025-01-01T09Z&Europe//Brussels",
            "z:zrut = 2025-01-01T09Z&Europe/Belgium/",
        )
        for source in cases:
            with self.subTest(source=source):
                result = compile_source(source)
                self.assertEqual(["INVALID_DATETIME"], [error.code for error in result.errors])

    def test_strict_mode_rejects_non_node_inline_node_head_datatypes(self) -> None:
        result = compile_source('aeon:mode = "strict"\nwidget:node = <tag:contact("x")>')
        self.assertEqual(["INVALID_NODE_HEAD_DATATYPE"], [error.code for error in result.errors])

    def test_strict_mode_allows_node_inline_node_head_datatype(self) -> None:
        result = compile_source('aeon:mode = "strict"\nwidget:node = <tag:node("x")>')
        self.assertEqual([], result.errors)

    def test_strict_mode_accepts_embed_and_inline_as_reserved_encoding_aliases(self) -> None:
        for datatype in ("embed", "inline"):
            with self.subTest(datatype=datatype):
                result = compile_source(f'aeon:mode = "strict"\npayload:{datatype} = &QmFzZTY0IQ==')
                self.assertEqual([], result.errors)

    def test_transport_mode_allows_custom_inline_node_head_datatype(self) -> None:
        result = compile_source('aeon:mode = "transport"\nwidget:node = <tag:pair("x", "y")>')
        self.assertEqual([], result.errors)

    def test_custom_mode_allows_custom_inline_node_head_datatype(self) -> None:
        result = compile_source('aeon:mode = "custom"\nwidget:node = <tag:pair("x", "y")>')
        self.assertEqual([], result.errors)

    def test_parameterized_node_head_claims_are_preserved_without_core_enforcement(self) -> None:
        result = compile_source(
            'aeon:mode = "strict"\ntitle:node = <title:node<string>(<span("hello")>)>'
        )
        self.assertEqual([], result.errors)
        node_value = result.events[0]["value"]
        self.assertEqual("node", node_value["datatype"]["name"])
        self.assertEqual(["string"], node_value["datatype"]["genericArgs"])

    def test_non_node_generic_inline_node_head_datatype_is_rejected(self) -> None:
        result = compile_source('aeon:mode = "transport"\nwidget:node = <tag:pair<int32,string>("x")>')
        self.assertEqual(["SYNTAX_ERROR"], [error.code for error in result.errors])

    def test_custom_mode_rejects_scalar_values_for_generic_custom_datatypes(self) -> None:
        result = compile_source('aeon:mode = "custom"\na:custom<custom> = 0')
        self.assertEqual(["DATATYPE_LITERAL_MISMATCH"], [error.code for error in result.errors])

    def test_custom_mode_allows_list_and_tuple_values_for_generic_custom_datatypes(self) -> None:
        list_result = compile_source('aeon:mode = "custom"\nb:custom<custom> = [2]')
        self.assertEqual([], list_result.errors)

        tuple_result = compile_source('aeon:mode = "custom"\nc:custom<custom> = (2)')
        self.assertEqual([], tuple_result.errors)

    def test_custom_mode_rejects_scalar_values_for_bracketed_custom_datatypes(self) -> None:
        radix_like_result = compile_source('aeon:mode = "custom"\nd:custom[3] = 3')
        self.assertEqual(["DATATYPE_LITERAL_MISMATCH"], [error.code for error in radix_like_result.errors])

        separator_like_result = compile_source('aeon:mode = "custom"\ne:custom[.] = 3')
        self.assertEqual(["DATATYPE_LITERAL_MISMATCH"], [error.code for error in separator_like_result.errors])

    def test_custom_mode_allows_custom_radix_base_between_2_and_64(self) -> None:
        result = compile_source('aeon:mode = "custom"\ns:custom[2] = %111')
        self.assertEqual([], result.errors)

    def test_custom_mode_rejects_custom_radix_base_below_2(self) -> None:
        result = compile_source('aeon:mode = "custom"\ns:custom[1] = %111')
        self.assertEqual(["DATATYPE_LITERAL_MISMATCH"], [error.code for error in result.errors])

    def test_custom_mode_rejects_separator_style_custom_spec_for_radix_literal(self) -> None:
        result = compile_source('aeon:mode = "custom"\ns:custom[.] = %111')
        self.assertEqual(["DATATYPE_LITERAL_MISMATCH"], [error.code for error in result.errors])

    def test_custom_mode_rejects_multi_bracket_custom_spec_for_radix_literal(self) -> None:
        result = compile_source('aeon:mode = "custom"\ns:custom[1][2] = %111')
        self.assertNotEqual([], result.errors)

    def test_custom_mode_allows_valid_custom_separator_bindings(self) -> None:
        separator_result = compile_source('aeon:mode = "custom"\ng:custom[.] = ^1.1.1')
        self.assertEqual([], separator_result.errors)

        ambiguous_result = compile_source('aeon:mode = "custom"\nh:custom[1] = ^1.1.1')
        self.assertEqual([], ambiguous_result.errors)

    def test_custom_mode_reports_incompatible_generic_and_bracket_constraints_clearly(self) -> None:
        result = compile_source('aeon:mode = "custom"\na:custom<custom>[.] = [2]')
        self.assertEqual(["DATATYPE_LITERAL_MISMATCH"], [error.code for error in result.errors])
        self.assertIn("combines incompatible generic and bracket constraints", result.errors[0].message)

    def test_custom_mode_ignores_angle_brackets_inside_separator_specs(self) -> None:
        self.assertTrue(datatype_has_generic_args("custom<custom>"))
        self.assertFalse(datatype_has_generic_args('custom["<"][">"]'))

    def test_separator_literals_terminate_before_comments_resume(self) -> None:
        result = compile_source('g:sep[|] = ^aaa // d')
        self.assertEqual([], result.errors)
        self.assertEqual("SeparatorLiteral", result.events[0]["value"]["type"])
        self.assertEqual("^aaa", result.events[0]["value"]["raw"])

    def test_missing_attribute_reference(self) -> None:
        result = compile_source("a = 1\nv = ~a.@.ns")
        self.assertEqual(["MISSING_REFERENCE_TARGET"], [error.code for error in result.errors])

    def test_nested_attribute_reference_allows_raised_depth(self) -> None:
        result = compile_source("a@{b@{c=3}=2} = 1\nv = ~a.@.b.@.c", CompileOptions(max_attribute_depth=8))
        self.assertEqual([], result.errors)

    def test_nested_attribute_heads_fail_at_default_depth(self) -> None:
        result = compile_source("a@{b@{c=3}=2} = 1")
        self.assertEqual(["ATTRIBUTE_DEPTH_EXCEEDED"], [error.code for error in result.errors])

    def test_forward_reference(self) -> None:
        result = compile_source('v = ~a.@.ns\na@{ns="alto.v1"} = 1')
        self.assertEqual(["FORWARD_REFERENCE"], [error.code for error in result.errors])

    def test_late_structured_header_is_rejected(self) -> None:
        result = compile_source('app:object = {\n  name:string = "playground"\n}\naeon:header = {\n  mode:string = "strict"\n}')
        self.assertEqual(["SYNTAX_ERROR"], [error.code for error in result.errors])

    def test_mixed_structured_and_shorthand_headers_are_rejected(self) -> None:
        result = compile_source('aeon:header = { mode = "strict" }\naeon:mode = "strict"\nvalue:number = 1')
        self.assertEqual(["HEADER_CONFLICT"], [error.code for error in result.errors])
        self.assertEqual(
            "Header conflict: cannot use both structured header (aeon:header) and shorthand header fields",
            result.errors[0].message,
        )

    def test_structured_header_allows_whitespace_and_newlines_around_colon(self) -> None:
        result = compile_source(
            'aeon\n:\nheader /# #/= /# #/{\n'
            '  mode:\nstring = "strict"\n'
            '  encoding:string = "utf-8"\n'
            '}',
            CompileOptions(max_separator_depth=8),
        )
        self.assertEqual([], result.errors)
        self.assertEqual([], result.events)
        self.assertEqual(
            ['$.["aeon:encoding"]', '$.["aeon:mode"]'],
            sorted(event["path"] for event in (result.internal_events or [])),
        )

    def test_shebang_allows_second_line_host_directive(self) -> None:
        result = compile_source('#!/usr/bin/env aeon\n//! format:aeon.test.v1\nvalue:number = 1')
        self.assertEqual([], result.errors)
        self.assertEqual(["$.value"], [event["path"] for event in result.events])

    def test_shebang_is_rejected_when_not_on_first_line(self) -> None:
        result = compile_source('value:number = 1\n#!/usr/bin/env aeon')
        self.assertEqual(["SYNTAX_ERROR"], [error.code for error in result.errors])

    def test_leading_bom_is_accepted(self) -> None:
        result = compile_source("\ufeffvalue:number = 1")
        self.assertEqual([], result.errors)
        self.assertEqual(["$.value"], [event["path"] for event in result.events])

    def test_leading_bom_before_shebang_and_host_directive_is_accepted(self) -> None:
        result = compile_source("\ufeff#!/usr/bin/env aeon\n//! format:aeon.test.v1\nvalue:number = 1")
        self.assertEqual([], result.errors)
        self.assertEqual(["$.value"], [event["path"] for event in result.events])

    def test_non_leading_bom_is_rejected(self) -> None:
        result = compile_source('value = "\ufeffx"\nnext = \ufeff1')
        self.assertEqual(["SYNTAX_ERROR"], [error.code for error in result.errors])

    def test_unterminated_string_uses_dedicated_code_and_aligned_message(self) -> None:
        result = compile_source('a = 1\nb = "unterminated')
        self.assertEqual(["UNTERMINATED_STRING"], [error.code for error in result.errors])
        self.assertEqual('Unterminated string literal (started with ")', result.errors[0].message)

    def test_separator_literal_quoted_segment_rejects_carriage_return(self) -> None:
        result = compile_source('a:sep = ^"a' + '\r' + 'b"')
        self.assertGreaterEqual(len(result.errors), 1)
        self.assertEqual("UNTERMINATED_STRING", result.errors[0].code)

    def test_out_of_range_braced_unicode_escape_fails_closed(self) -> None:
        result = compile_source(r'value = "\u{110000}"')
        self.assertEqual(["INVALID_ESCAPE"], [error.code for error in result.errors])
        self.assertEqual("Invalid unicode escape", result.errors[0].message)

    def test_strict_mode_untyped_toggle_uses_aligned_message(self) -> None:
        result = compile_source('aeon:mode = "strict"\ndebug = yes')
        self.assertEqual(["UNTYPED_TOGGLE_LITERAL"], [error.code for error in result.errors])
        self.assertEqual(
            "Untyped toggle literal in typed mode: '$.debug' requires ':toggle' type annotation",
            result.errors[0].message,
        )

    def test_nested_binding_attribute_reference(self) -> None:
        result = compile_source("a = [{x@{b=0}=1}]\nv = ~a[0].x.@.b")
        self.assertEqual([], result.errors)
        self.assertEqual(["$.a", "$.a[0]", "$.a[0].x", "$.v"], [event["path"] for event in result.events])

    def test_nested_binding_reference_uses_nested_source_path(self) -> None:
        result = compile_source('a:o = {\n  a:string = "hello"\n  b:string = ~a.a\n}')
        self.assertEqual([], result.errors)
        self.assertEqual(["$.a", "$.a.a", "$.a.b"], [event["path"] for event in result.events])

    def test_generic_depth_is_enforced_by_default(self) -> None:
        result = compile_source('t:tuple<tuple<n, n>, tuple<n, n>> = ((1,2),(1,2))')
        self.assertEqual(["GENERIC_DEPTH_EXCEEDED"], [error.code for error in result.errors])

    def test_generic_depth_allows_nested_generics_when_raised(self) -> None:
        result = compile_source(
            't:tuple<tuple<n, n>, tuple<n, n>> = ((1,2),(1,2))',
            CompileOptions(max_generic_depth=8),
        )
        self.assertEqual([], result.errors)
        paths = [event["path"] for event in result.events]
        self.assertIn("$.t", paths)
        self.assertIn("$.t[0]", paths)
        self.assertIn("$.t[1]", paths)

    def test_structural_newlines_inside_generic_and_separator_boundaries_are_accepted(self) -> None:
        result = compile_source(
            'aeon:mode = "strict"\n'
            'size\n'
            ':\n'
            'sep\n'
            '[\n'
            'x\n'
            ']\n'
            '= ^300x250\n'
            'items\n'
            ':\n'
            'list\n'
            '<\n'
            'n\n'
            '>\n'
            '=\n'
            '[\n'
            '2\n'
            ',\n'
            '3\n'
            ']\n'
        )
        self.assertEqual([], result.errors)
        self.assertEqual("sep[x]", result.events[0]["datatype"])
        self.assertEqual("list<n>", result.events[1]["datatype"])

    def test_reference_path_is_preserved_structurally(self) -> None:
        result = compile_source('a@{meta = { "x.y" = 1 }} = 0\nv = ~a.@.meta.["x.y"]')
        self.assertEqual([], result.errors)
        reference_value = result.events[1]["value"]
        self.assertEqual(
            ["a", {"type": "attr", "key": "meta"}, "x.y"],
            reference_value["path"],
        )

    def test_max_input_bytes_fails_closed(self) -> None:
        result = compile_source('value:string = "' + ("x" * 4096) + '"', CompileOptions(max_input_bytes=128))
        self.assertEqual(["INPUT_SIZE_EXCEEDED"], [error.code for error in result.errors])
        self.assertEqual([], result.events)

    def test_max_events_fails_closed(self) -> None:
        result = compile_source("a = 1\nb = 2", CompileOptions(max_events=1))
        self.assertEqual(["EVENT_COUNT_EXCEEDED"], [error.code for error in result.errors])
        self.assertEqual([], result.events)

    def test_exponent_underscore_is_accepted(self) -> None:
        result = compile_source("value:number = 3e3_3")
        self.assertEqual([], [error.code for error in result.errors])

    def test_zero_mantissa_exponents_are_accepted(self) -> None:
        result = compile_source("a:number = 0e0\nb:number = +0e2\nc:number = -0e-2")
        self.assertEqual([], [error.code for error in result.errors])

    def test_invalid_exponent_underscore_boundaries_are_rejected(self) -> None:
        result = compile_source("value:number = 3e_3")
        self.assertEqual(["INVALID_NUMBER"], [error.code for error in result.errors])

    def test_leading_zero_exponent_mantissas_are_rejected(self) -> None:
        result = compile_source("value:number = 00e2")
        self.assertEqual(["INVALID_NUMBER"], [error.code for error in result.errors])

    def test_attribute_datatype_mismatch_is_rejected(self) -> None:
        result = compile_source("b@{n:string=3}:n = 3")
        self.assertEqual(["DATATYPE_LITERAL_MISMATCH"], [error.code for error in result.errors])

    def test_strict_mode_rejects_untyped_attribute_entries(self) -> None:
        result = compile_source('aeon:mode = "strict"\nb@{n=3}:n = 3')
        self.assertIn("UNTYPED_VALUE_IN_STRICT_MODE", [error.code for error in result.errors])
        self.assertIn("$.b.@.n", [error.path for error in result.errors])

    def test_strict_mode_accepts_typed_attribute_entries(self) -> None:
        result = compile_source('aeon:mode = "strict"\nb@{n:number=3}:n = 3')
        self.assertEqual([], result.errors)

    def test_singleton_tuple_literal_is_accepted(self) -> None:
        result = compile_source("aa:tuple<string> = (3)")
        self.assertEqual([], [error.code for error in result.errors])

    def test_singleton_tuple_literal_with_trailing_comma_is_accepted(self) -> None:
        result = compile_source("aa:tuple<string> = (3,)")
        self.assertEqual([], result.errors)

    def test_empty_separator_literal_is_rejected(self) -> None:
        result = compile_source("blue:sep = ^")
        self.assertNotEqual([], result.errors)

    def test_separator_literals_accept_quoted_segments_with_spaces_and_punctuation(self) -> None:
        result = compile_source('value:sep[|] = ^"hello world"|"this, [is] fine"')
        self.assertEqual([], result.errors)
        self.assertEqual('"hello world"|"this, [is] fine"', result.events[0]["value"]["value"])

    def test_separator_literals_reject_raw_spaces(self) -> None:
        result = compile_source("n:node = <b(^aaa bbb)>")
        self.assertEqual(["SYNTAX_ERROR"], [error.code for error in result.errors])

    def test_separator_literals_reject_raw_slashes(self) -> None:
        result = compile_source("blue:sep[|] = ^root/main")
        self.assertEqual(["SYNTAX_ERROR"], [error.code for error in result.errors])

    def test_unparameterized_separator_datatype_accepts_caret_payload(self) -> None:
        result = compile_source("blue:sep = ^200")
        self.assertEqual([], [error.code for error in result.errors])

    def test_unparameterized_kadot_datatype_accepts_caret_payload(self) -> None:
        result = compile_source("semver:kadot = ^3.14.15")
        self.assertEqual([], [error.code for error in result.errors])

    def test_core_does_not_enforce_kadot_shape(self) -> None:
        result = compile_source("dimensions:kadot = ^300x250")
        self.assertEqual([], [error.code for error in result.errors])

    def test_invalid_temporal_literals_use_specific_error_codes(self) -> None:
        result = compile_source("at:time = 24:00\nbad:date = 2025-02-29\ndt:zrut = 2025-01-01T09:30Z&/\n", CompileOptions(recovery=True))
        self.assertEqual(["INVALID_TIME", "INVALID_DATE", "INVALID_DATETIME"], [error.code for error in result.errors[:3]])

    def test_invalid_single_digit_hour_time_candidate_uses_invalid_time(self) -> None:
        result = compile_source('aeon:mode = "transport"\na = 9:00\n')
        self.assertEqual(["INVALID_TIME"], [error.code for error in result.errors])

    def test_invalid_radix_literal_reports_invalid_number(self) -> None:
        result = compile_source("bits = %10A1-._/=")
        self.assertEqual(["INVALID_NUMBER"], [error.code for error in result.errors])

    def test_malformed_transport_hyphen_number_tail_uses_invalid_number(self) -> None:
        result = compile_source('aeon:mode = "transport"\na = 1-1\n')
        self.assertEqual(["INVALID_NUMBER"], [error.code for error in result.errors])

    def test_custom_mode_untyped_toggle_uses_general_typed_mode_error(self) -> None:
        result = compile_source('aeon:mode = "custom"\nflag = yes\n')
        self.assertEqual(["UNTYPED_VALUE_IN_STRICT_MODE"], [error.code for error in result.errors])

    def test_hex_literal_with_trailing_underscore_is_rejected(self) -> None:
        result = compile_source("blue = #FF_FF_FF_")
        self.assertNotEqual([], result.errors)

    def test_untyped_hex_literal_with_double_underscore_is_rejected(self) -> None:
        result = compile_source("blue = #F__f")
        self.assertEqual(["SYNTAX_ERROR"], [error.code for error in result.errors])

    def test_untyped_dotted_encoding_literal_is_rejected(self) -> None:
        result = compile_source("payload = &QmF.zZTY0IQ==")
        self.assertEqual(["SYNTAX_ERROR"], [error.code for error in result.errors])

    def test_standard_base64_encoding_literal_is_rejected(self) -> None:
        result = compile_source("payload:base64 = &abc+/==")
        self.assertEqual(["SYNTAX_ERROR"], [error.code for error in result.errors])

    def test_asterisk_delimited_preprocessor_placeholder_is_rejected(self) -> None:
        result = compile_source("password = *secret-key*")
        self.assertEqual(["SYNTAX_ERROR"], [error.code for error in result.errors])

    def test_structured_header_allows_newline_layout_between_key_tokens(self) -> None:
        result = compile_source('aeon\n:\nheader = {\n  mode:\nstring = "strict"\n}\na:string = "ok"\n')
        self.assertEqual([], result.errors)
        self.assertEqual(["$.a"], [event["path"] for event in result.events])
        self.assertEqual("strict", result.header["fields"]["mode"].value)


if __name__ == "__main__":
    unittest.main()
