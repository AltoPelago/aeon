from __future__ import annotations

import unittest

from aeon.api import AeonLoadError, TelexLoadOptions, aeon_to_telex, load_telex_text
from aeon.core import CompileOptions, compile_source
from aeon.limits import (
    aeon_compile_limits,
    effective_telex_configuration,
    finalization_limits,
    load_aeonic_limits,
    telex_limits,
)
from aeon.portable_finalize import PortableFinalizeOptions


SOURCE = '''limits_id = "altopelago.aeonic-limits.v1"
limits_version = "1.0.0"
profile_claims = ["aeon.gp.profile.v1"]
structure = {
  max_attribute_depth = 1
  max_generic_depth = 1
  max_generic_arguments = 32
  max_clarifier_values = 1
  max_datatype_components = 64
  max_value_nesting_depth = 256
  max_path_depth = 1024
  max_string_codepoints = 1048576
  max_key_segment_codepoints = 1024
  max_list_items = 65536
  max_tuple_items = 65536
  max_path_characters = 8192
}
processing = { max_events = 100000, max_reference_depth = 64, max_materialized_weight = 1000000 }
formats = {
  aeon = { max_input_bytes = 16777216, max_numeric_literal_characters = 1024, max_structured_comment_characters = 1048576 }
  telex = { max_input_bytes = 67108864, max_line_bytes = 1048576, max_fields_per_event = 64, max_decoded_payload_bytes = 33554432 }
}
transport = { max_frame_bytes = 16777216, max_buffer_bytes = 33554432, max_header_bytes = 65536 }
'''


class LimitsTests(unittest.TestCase):
    def test_loads_and_normalizes_closed_v1_file(self) -> None:
        loaded = load_aeonic_limits(SOURCE)
        self.assertEqual([], loaded.errors)
        self.assertIsNotNone(loaded.limits)
        effective = aeon_compile_limits(loaded.limits)  # type: ignore[arg-type]
        self.assertEqual(32, effective["max_generic_arguments"])
        self.assertEqual(64, effective["max_datatype_components"])
        self.assertEqual(1024, effective["max_path_depth"])
        self.assertEqual(1_048_576, telex_limits(loaded.limits)["max_string_codepoints"])  # type: ignore[arg-type]
        self.assertEqual(
            {"max_reference_depth": 64, "max_materialized_weight": 1_000_000},
            finalization_limits(loaded.limits),  # type: ignore[arg-type]
        )
        effective_telex = effective_telex_configuration(loaded.limits)  # type: ignore[arg-type]
        self.assertEqual("altopelago.aeonic-limits.v1", effective_telex.limits_id)
        self.assertEqual("1.0.0", effective_telex.limits_version)
        self.assertEqual(["aeon.gp.profile.v1"], effective_telex.profile_claims)
        self.assertEqual(telex_limits(loaded.limits), effective_telex.telex)  # type: ignore[arg-type]
        self.assertEqual(finalization_limits(loaded.limits), effective_telex.finalization)  # type: ignore[arg-type]
        self.assertFalse(effective_telex.overrides_applied)
        self.assertIsNot(loaded.limits.profile_claims, effective_telex.profile_claims)  # type: ignore[union-attr]

    def test_rejects_unknown_fields_and_supports_sentinels(self) -> None:
        unknown = load_aeonic_limits(SOURCE.replace("max_header_bytes = 65536", "max_header_bytes = 65536, surprise = 1"))
        self.assertIsNone(unknown.limits)
        self.assertEqual("INVALID_LIMITS_FILE", unknown.errors[0].code)
        sentinels = load_aeonic_limits(SOURCE.replace("max_events = 100000", 'max_events = !"unBound"').replace("max_input_bytes = 16777216", 'max_input_bytes = !"useImplementation"', 1))
        effective = aeon_compile_limits(sentinels.limits)  # type: ignore[arg-type]
        self.assertIsNone(effective["max_events"])
        self.assertEqual(16_777_216, effective["max_input_bytes"])
        processing_sentinels = load_aeonic_limits(
            SOURCE
            .replace("max_reference_depth = 64", 'max_reference_depth = !"unBound"')
            .replace("max_materialized_weight = 1000000", 'max_materialized_weight = !"useImplementation"')
        )
        self.assertEqual({}, finalization_limits(processing_sentinels.limits))  # type: ignore[arg-type]

    def test_named_resource_limits_are_independent(self) -> None:
        cases = [
            ('a = "xy"', CompileOptions(max_string_codepoints=1), "MAX_STRING_CODEPOINTS_EXCEEDED"),
            ("ab = 1", CompileOptions(max_key_segment_codepoints=1), "MAX_KEY_SEGMENT_CODEPOINTS_EXCEEDED"),
            ("a = [1,2]", CompileOptions(max_list_items=1), "MAX_LIST_ITEMS_EXCEEDED"),
            ("a = (1,2)", CompileOptions(max_tuple_items=1), "MAX_TUPLE_ITEMS_EXCEEDED"),
            ("a = 1234", CompileOptions(max_numeric_literal_characters=3), "MAX_NUMERIC_LITERAL_CHARACTERS_EXCEEDED"),
            ("a = { b = 1 }", CompileOptions(max_path_depth=1), "MAX_PATH_DEPTH_EXCEEDED"),
            ("//@abc\na = 1", CompileOptions(max_structured_comment_characters=2), "MAX_STRUCTURED_COMMENT_CHARACTERS_EXCEEDED"),
            ("//!abc\na = 1", CompileOptions(max_structured_comment_characters=2), "MAX_STRUCTURED_COMMENT_CHARACTERS_EXCEEDED"),
            ("a:tuple<n,n,n> = (1,2,3)", CompileOptions(max_generic_arguments=2), "GENERIC_ARGUMENTS_EXCEEDED"),
            ("a:tuple<n,n> = (1,2)", CompileOptions(max_datatype_components=2), "DATATYPE_COMPONENTS_EXCEEDED"),
        ]
        for source, options, expected in cases:
            with self.subTest(expected=expected):
                result = compile_source(source, options)
                self.assertEqual(expected, result.errors[0].code)

    def test_sdk_selects_the_common_limits_for_telex(self) -> None:
        loaded_limits = load_aeonic_limits(SOURCE)
        self.assertIsNotNone(loaded_limits.limits)
        loaded = load_telex_text(
            "telex.aes=0\n\npath=$.answer\nkind=StringLiteral\nvalue=x\n",
            TelexLoadOptions(
                aeonic_limits=loaded_limits.limits,
                finalize=PortableFinalizeOptions(max_reference_depth=2),
            ),
        )
        self.assertTrue(loaded.ok)
        self.assertEqual("altopelago.aeonic-limits.v1", loaded.effective_limits.limits_id)  # type: ignore[union-attr]
        self.assertEqual(1_048_576, loaded.effective_limits.telex["max_string_codepoints"])  # type: ignore[union-attr]
        self.assertEqual(2, loaded.effective_limits.finalization["max_reference_depth"])  # type: ignore[union-attr]
        self.assertTrue(loaded.effective_limits.overrides_applied)  # type: ignore[union-attr]

    def test_sdk_selects_the_common_limits_for_aeon_to_telex(self) -> None:
        constrained = load_aeonic_limits(
            SOURCE.replace("max_string_codepoints = 1048576", "max_string_codepoints = 1")
        )
        self.assertIsNotNone(constrained.limits)
        with self.assertRaises(AeonLoadError):
            aeon_to_telex('answer = "xx"', aeonic_limits=constrained.limits)


if __name__ == "__main__":
    unittest.main()
