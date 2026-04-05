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

    def test_list_emits_indexed_paths(self) -> None:
        result = compile_source("a = [1]")
        self.assertEqual([], result.errors)
        self.assertEqual(["$.a", "$.a[0]"], [event["path"] for event in result.events])

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

    def test_strict_mode_rejects_custom_switch_alias_even_with_allow_custom(self) -> None:
        source = 'aeon:mode = "strict"\ns:toggle = on'
        result = compile_source(source, CompileOptions(datatype_policy="allow_custom"))
        self.assertEqual(["CUSTOM_SWITCH_ALIAS_NOT_ALLOWED"], [error.code for error in result.errors])

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

    def test_custom_mode_allows_custom_switch_aliases(self) -> None:
        source = 'aeon:mode = "custom"\ns:toggle = on'
        result = compile_source(source)
        self.assertEqual([], result.errors)

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
        for datatype in ("sep", "set"):
            with self.subTest(datatype=datatype):
                source = f'aeon:mode = "strict"\nvalue:{datatype}[|] = ^a|b'
                result = compile_source(source)
                self.assertEqual([], result.errors)
                self.assertEqual(f"{datatype}[|]", result.events[0]["datatype"])
                self.assertEqual("SeparatorLiteral", result.events[0]["value"]["type"])

    def test_reserved_slash_separator_specs_are_rejected(self) -> None:
        result = compile_source('aeon:mode = "strict"\nvalue:set[/] = ^000.000')
        self.assertEqual(["INVALID_SEPARATOR_CHAR"], [error.code for error in result.errors])

    def test_reserved_caret_separator_specs_are_allowed(self) -> None:
        result = compile_source('aeon:mode = "strict"\nleft:set[^] = ^a^b\nright:sep[^] = ^a^b')
        self.assertEqual([], result.errors)
        self.assertEqual("set[^]", result.events[0]["datatype"])
        self.assertEqual("sep[^]", result.events[1]["datatype"])

    def test_infinity_datatype_is_allowed_in_typed_modes(self) -> None:
        result = compile_source('aeon:mode = "strict"\nlimit:infinity = Infinity')
        self.assertEqual([], result.errors)
        self.assertEqual("InfinityLiteral", result.events[0]["value"]["type"])

    def test_number_datatype_rejects_infinity_literal(self) -> None:
        result = compile_source('aeon:mode = "strict"\nlimit:number = Infinity')
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
                result = compile_source(f'aeon:mode = "strict"\npayload:{datatype} = $QmFzZTY0IQ==')
                self.assertEqual([], result.errors)

    def test_transport_mode_allows_custom_inline_node_head_datatype(self) -> None:
        result = compile_source('aeon:mode = "transport"\nwidget:node = <tag:pair("x", "y")>')
        self.assertEqual([], result.errors)

    def test_custom_mode_allows_custom_inline_node_head_datatype(self) -> None:
        result = compile_source('aeon:mode = "custom"\nwidget:node = <tag:pair("x", "y")>')
        self.assertEqual([], result.errors)

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
        result = compile_source("a = 1\nv = ~a@ns")
        self.assertEqual(["MISSING_REFERENCE_TARGET"], [error.code for error in result.errors])

    def test_nested_attribute_reference_allows_raised_depth(self) -> None:
        result = compile_source("a@{b@{c=3}=2} = 1\nv = ~a@b@c", CompileOptions(max_attribute_depth=8))
        self.assertEqual([], result.errors)

    def test_nested_attribute_heads_fail_at_default_depth(self) -> None:
        result = compile_source("a@{b@{c=3}=2} = 1")
        self.assertEqual(["ATTRIBUTE_DEPTH_EXCEEDED"], [error.code for error in result.errors])

    def test_forward_reference(self) -> None:
        result = compile_source('v = ~a@ns\na@{ns="alto.v1"} = 1')
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

    def test_out_of_range_braced_unicode_escape_fails_closed(self) -> None:
        result = compile_source(r'value = "\u{110000}"')
        self.assertEqual(["SYNTAX_ERROR"], [error.code for error in result.errors])
        self.assertEqual("Invalid unicode escape", result.errors[0].message)

    def test_strict_mode_untyped_switch_uses_aligned_message(self) -> None:
        result = compile_source('aeon:mode = "strict"\ndebug = yes')
        self.assertEqual(["UNTYPED_SWITCH_LITERAL"], [error.code for error in result.errors])
        self.assertEqual(
            "Untyped switch literal in typed mode: '$.debug' requires ':switch' type annotation",
            result.errors[0].message,
        )

    def test_nested_binding_attribute_reference(self) -> None:
        result = compile_source("a = [{x@{b=0}=1}]\nv = ~a[0].x@b")
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
        result = compile_source('a@{meta = { "x.y" = 1 }} = 0\nv = ~a@meta.["x.y"]')
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

    def test_unparameterized_set_datatype_accepts_caret_payload(self) -> None:
        result = compile_source("blue:set = ^200")
        self.assertEqual([], [error.code for error in result.errors])

    def test_invalid_temporal_literals_use_specific_error_codes(self) -> None:
        result = compile_source("at:time = 24:00\nbad:date = 2025-02-29\ndt:zrut = 2025-01-01T09:30Z&/\n", CompileOptions(recovery=True))
        self.assertEqual(["INVALID_TIME", "INVALID_DATE", "INVALID_DATETIME"], [error.code for error in result.errors[:3]])

    def test_invalid_radix_literal_reports_invalid_number(self) -> None:
        result = compile_source("bits = %10A1-._/=")
        self.assertEqual(["INVALID_NUMBER"], [error.code for error in result.errors])

    def test_custom_mode_untyped_switch_uses_general_typed_mode_error(self) -> None:
        result = compile_source('aeon:mode = "custom"\nflag = yes\n')
        self.assertEqual(["UNTYPED_VALUE_IN_STRICT_MODE"], [error.code for error in result.errors])

    def test_hex_literal_with_trailing_underscore_is_rejected(self) -> None:
        result = compile_source("blue = #FF_FF_FF_")
        self.assertNotEqual([], result.errors)

    def test_untyped_hex_literal_with_double_underscore_is_rejected(self) -> None:
        result = compile_source("blue = #F__f")
        self.assertEqual(["SYNTAX_ERROR"], [error.code for error in result.errors])

    def test_untyped_dotted_encoding_literal_is_rejected(self) -> None:
        result = compile_source("payload = $QmF.zZTY0IQ==")
        self.assertEqual(["SYNTAX_ERROR"], [error.code for error in result.errors])


if __name__ == "__main__":
    unittest.main()
