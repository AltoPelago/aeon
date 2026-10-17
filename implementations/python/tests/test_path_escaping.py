from __future__ import annotations

import json
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from aeon.ast import AttributePathSegment
from aeon.core import (
    CanonicalPath, CanonicalSegment, CompileOptions, compile_source,
    format_path, format_reference_target_path,
)
from aeon.portable import adapt_python_assignment_events_to_portable_aes, export_telex, parse_canonical_path
from aeon.portable_finalize import finalize_portable_json
from aeon.telex import parse_telex, validate_telex


# Actual controls and literal escape spellings must remain distinct keys.
KEYS = tuple(key for code in range(32) for key in (f"z{chr(code)}", f"{chr(code)}z", f"z{chr(code)}key")) + (
    'z"', "z\\", "z\\n", "z\\t", "z\\u0000", 'z\\"',
    'z"].other', "z.@.other", "z[0]", "z😀", "z\u2028", "z\u2029",
)


class PathEscapingTests(unittest.TestCase):
    def compile(self, source, **options):
        result = compile_source(source, CompileOptions(**options))
        self.assertEqual([], result.errors, result.errors)
        return result

    def test_core_payload_and_reference_formatters_round_trip_decoded_segments(self):
        for key in KEYS:
            with self.subTest(key=repr(key)):
                quoted = json.dumps(key, ensure_ascii=False)
                path = CanonicalPath(segments=(CanonicalSegment(type="root"), CanonicalSegment(type="member", key=key)))
                expected = f"$.[{quoted}]"
                self.assertEqual(expected, format_path(path))
                self.assertEqual([key], parse_canonical_path(format_path(path)))
                self.assertEqual(expected, format_reference_target_path([key]))
                self.assertEqual(f"{expected}[2].@.[{quoted}]", format_reference_target_path([key, 2, AttributePathSegment(key=key)]))

    def test_public_compile_and_portable_export_preserve_key_identity(self):
        keys = dict.fromkeys((*KEYS, "z", "other"))
        source = "\n".join(f"{json.dumps(key)}={index}" for index, key in enumerate(keys))
        compiled = self.compile(source)
        self.assertEqual(len(keys), len({event["path"] for event in compiled.events}))
        self.assertEqual(list(keys), [parse_canonical_path(event["path"])[0] for event in compiled.events])
        portable = adapt_python_assignment_events_to_portable_aes(compiled.events)["events"]
        self.assertEqual(list(keys), [parse_canonical_path(event["path"])[0] for event in portable])
        self.assertEqual(dict(zip(keys, range(len(keys)))), finalize_portable_json(portable)["document"])

    def test_clone_pointer_and_attribute_targets_keep_authored_legality(self):
        for key in KEYS:
            quoted = json.dumps(key, ensure_ascii=False)
            path = f"$.[{quoted}]"
            for source, target in (
                (f'{quoted}=1\ncopy=~[{quoted}]\npointer=~>[{quoted}]', path),
                (f'a@{{{quoted}=1}}=0\ncopy=~a.@.[{quoted}]\npointer=~>a.@.[{quoted}]', f'$.a.@.[{quoted}]'),
                (f'a@{{m={{{quoted}=1}}}}=0\ncopy=~a.@.m.[{quoted}]\npointer=~>a.@.m.[{quoted}]', f'$.a.@.m.[{quoted}]'),
                (f'{quoted}@{{{quoted}=1}}=0\ncopy=~[{quoted}].@.[{quoted}]\npointer=~>[{quoted}].@.[{quoted}]', f'{path}.@.[{quoted}]'),
            ):
                with self.subTest(key=repr(key), source=source):
                    compiled = self.compile(source)
                    records = adapt_python_assignment_events_to_portable_aes(compiled.events)["events"]
                    self.assertEqual([target, target], [event["value"] for event in records if event["kind"] in {"CloneReference", "PointerReference"}])
            forward = compile_source(f'copy=~[{quoted}]\n{quoted}=1')
            self.assertEqual(["FORWARD_REFERENCE"], [error.code for error in forward.errors])
            self.assertEqual([], forward.events)
            missing = compile_source(f'{quoted}=~missing')
            self.assertEqual(["MISSING_REFERENCE_TARGET"], [error.code for error in missing.errors])
            untyped = compile_source(f'{quoted}=1', CompileOptions(mode="strict"))
            self.assertEqual(["UNTYPED_VALUE_IN_STRICT_MODE"], [error.code for error in untyped.errors])
            self.assertEqual(path, untyped.errors[0].path)

    def test_recursive_node_projection_and_telex_preserve_escaped_owner(self):
        for key in KEYS:
            with self.subTest(key=repr(key)):
                quoted = json.dumps(key, ensure_ascii=False)
                path = f"$.[{quoted}]"
                source = f'{quoted}=<outer(<inner("leaf")>)>\ncopy=~[{quoted}][0][0]'
                compiled = self.compile(source)
                converted = adapt_python_assignment_events_to_portable_aes(compiled.events, source_bytes=source.encode("utf-8"))
                records = converted["events"]
                self.assertEqual(f"{path}[0][0][0][0]", records[-1]["value"])
                self.assertIn(f"{path}[0][0][0][0]", [event["path"] for event in records])
                encoded = export_telex(compiled.events, source_bytes=source.encode("utf-8"))
                self.assertTrue(validate_telex(encoded)["valid"])
                self.assertEqual(records, parse_telex(encoded).records)
                document = finalize_portable_json(records)["document"]
                self.assertEqual("leaf", document["copy"])
                self.assertEqual("leaf", document[key]["$children"][0]["$children"][0])

    def test_literal_escape_spellings_do_not_alias_decoded_keys_or_headers(self):
        source = '"z\\n"=1\n"z\\\\n"=2\na=~["z\\n"]\nb=~["z\\\\n"]'
        compiled = self.compile(source)
        records = adapt_python_assignment_events_to_portable_aes(compiled.events)["events"]
        self.assertEqual({"z\n": 1, "z\\n": 2, "a": 1, "b": 2}, finalize_portable_json(records)["document"])
        for key in KEYS:
            with self.subTest(key=repr(key)):
                quoted = json.dumps(key, ensure_ascii=False)
                target = json.dumps(f"aeon:{key}", ensure_ascii=False)
                compiled = self.compile(f'aeon:header={{{quoted}=1}}\ncopy=~[{target}]')
                records = adapt_python_assignment_events_to_portable_aes(
                    compiled.events, header=compiled.header, include_headers=True,
                )["events"]
                self.assertEqual(f"$.[{target}]", records[0]["header"])
                self.assertEqual(f"$.[{target}]", records[-1]["value"])

    def test_escaped_paths_are_counted_at_actual_serialized_length(self):
        for key in ("z\n", "z\\", "z\0"):
            with self.subTest(key=repr(key)):
                source = f"{json.dumps(key)}=1"
                expected = f"$.[{json.dumps(key)}]"
                self.compile(source, max_path_characters=len(expected))
                rejected = compile_source(source, CompileOptions(max_path_characters=len(expected) - 1))
                self.assertEqual(["MAX_PATH_CHARACTERS_EXCEEDED"], [error.code for error in rejected.errors])
                self.assertEqual([], rejected.events)

    def test_existing_identifier_unicode_and_ordinary_quoted_paths_stay_stable(self):
        for key, expected in (("name", "$.name"), ("café", "$.café"), ("a.b", '$.["a.b"]')):
            with self.subTest(key=key):
                compiled = self.compile(f"{json.dumps(key)}=1")
                self.assertEqual(expected, compiled.events[0]["path"])
                self.assertEqual(expected, format_reference_target_path([key]))


if __name__ == "__main__":
    unittest.main()
