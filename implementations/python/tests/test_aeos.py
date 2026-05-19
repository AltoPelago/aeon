from __future__ import annotations

import json
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from aeon.aeos import validate, validate_cts_payload, validate_events
from aeon.core import compile_source


class AeosTests(unittest.TestCase):
    def test_empty_envelope(self) -> None:
        result = validate([], {"rules": []})
        self.assertTrue(result["ok"])
        self.assertEqual({}, result["guarantees"])

    def test_duplicate_rule_path(self) -> None:
        result = validate([], {"rules": [{"path": "$.a", "constraints": {}}, {"path": "$.a", "constraints": {}}]})
        self.assertEqual(["duplicate_rule_path"], [error["code"] for error in result["errors"]])

    def test_missing_required(self) -> None:
        result = validate([], {"rules": [{"path": "$.port", "constraints": {"required": True}}]})
        self.assertEqual(["missing_required_field"], [error["code"] for error in result["errors"]])

    def test_type_mismatch(self) -> None:
        aes = [{"path": {"segments": [{"type": "root"}, {"type": "member", "key": "x"}]}, "key": "x", "value": {"type": "NumberLiteral", "raw": "1", "value": "1"}, "span": [0, 1]}]
        result = validate(aes, {"rules": [{"path": "$.x", "constraints": {"type": "StringLiteral"}}]})
        self.assertEqual(["type_mismatch"], [error["code"] for error in result["errors"]])

    def test_accepts_indexed_node_child_paths(self) -> None:
        compiled = compile_source("page:node = <page(:int32 = 3)>")
        self.assertEqual([], compiled.errors)
        result = validate_events(compiled.events, {"rules": [{"path": "$.page", "constraints": {"type": "NodeLiteral"}}, {"path": "$.page[0]", "constraints": {"type": "NumberLiteral"}}]})
        self.assertTrue(result["ok"])
        self.assertEqual([], result["errors"])

    def test_rejects_indexed_node_child_type_mismatch(self) -> None:
        compiled = compile_source("page:node = <page(:int32 = 3)>")
        self.assertEqual([], compiled.errors)
        result = validate_events(compiled.events, {"rules": [{"path": "$.page[0]", "constraints": {"type": "StringLiteral"}}]})
        self.assertEqual(["type_mismatch"], [error["code"] for error in result["errors"]])

    def test_requires_attribute_entries_when_declared_in_schema(self) -> None:
        compiled = compile_source("value:number = 3")
        self.assertEqual([], compiled.errors)
        result = validate_events(compiled.events, {"rules": [{"path": "$.value", "constraints": {"type": "NumberLiteral", "attributes": {"unit": {"required": True, "type": "StringLiteral", "datatype": "string"}}}}]})
        self.assertEqual(["missing_required_field"], [error["code"] for error in result["errors"]])

    def test_checks_attribute_entry_type_and_datatype(self) -> None:
        compiled = compile_source('value@{unit:symbol = "cm"}:number = 3')
        self.assertEqual([], compiled.errors)
        result = validate_events(compiled.events, {"rules": [{"path": "$.value", "constraints": {"attributes": {"unit": {"type": "NumberLiteral", "datatype": "string"}}}}]})
        self.assertTrue(any(error["code"] == "type_mismatch" and error["path"] == "$.value@unit" for error in result["errors"]))

    def test_rejects_unexpected_attribute_entries_when_closed_attributes_is_true(self) -> None:
        aes = [{
            "path": {"segments": [{"type": "root"}, {"type": "member", "key": "value"}]},
            "key": "value",
            "datatype": "number",
            "annotations": {
                "unit": {"value": {"type": "StringLiteral", "raw": '"cm"', "value": "cm"}, "datatype": "string"},
                "extra": {"value": {"type": "StringLiteral", "raw": '"x"', "value": "x"}, "datatype": "string"},
            },
            "value": {"type": "NumberLiteral", "raw": "3", "value": "3"},
            "span": [0, 1],
        }]
        result = validate(aes, {"rules": [{"path": "$.value", "constraints": {"attributes": {"unit": {"type": "StringLiteral"}}, "closed_attributes": True}}]})
        self.assertTrue(any(error["code"] == "unexpected_attribute_entry" and error["path"] == "$.value@extra" for error in result["errors"]))

    def test_recurses_into_nested_attribute_entries(self) -> None:
        aes = [{
            "path": {"segments": [{"type": "root"}, {"type": "member", "key": "value"}]},
            "key": "value",
            "datatype": "number",
            "annotations": {
                "meta": {
                    "value": {"type": "ObjectNode", "bindings": [], "attributes": []},
                    "annotations": {
                        "label": {"value": {"type": "NumberLiteral", "raw": "7", "value": "7"}, "datatype": "n"},
                    },
                },
            },
            "value": {"type": "NumberLiteral", "raw": "3", "value": "3"},
            "span": [0, 1],
        }]
        result = validate(aes, {"rules": [{"path": "$.value", "constraints": {"attributes": {"meta": {"attributes": {"label": {"type": "StringLiteral"}}}}}}]})
        self.assertTrue(any(error["code"] == "type_mismatch" and error["path"] == "$.value@meta@label" for error in result["errors"]))

    def test_applies_datatype_rules_to_attribute_entries_automatically(self) -> None:
        aes = [{
            "path": {"segments": [{"type": "root"}, {"type": "member", "key": "value"}]},
            "key": "value",
            "datatype": "number",
            "annotations": {
                "unit": {"value": {"type": "NumberLiteral", "raw": "-7", "value": "-7"}, "datatype": "uint"},
            },
            "value": {"type": "NumberLiteral", "raw": "3", "value": "3"},
            "span": [0, 1],
        }]
        result = validate(aes, {"rules": [{"path": "$.value", "constraints": {"attributes": {"unit": {}}}}], "datatype_rules": {"uint": {"type": "NumberLiteral", "sign": "unsigned"}}})
        self.assertTrue(any(error["code"] == "numeric_form_violation" and error["path"] == "$.value@unit" for error in result["errors"]))

    def test_literal_widening_and_cardinality_constraints(self) -> None:
        aes = [
            {
                "path": {"segments": [{"type": "root"}, {"type": "member", "key": "app"}]},
                "key": "app",
                "value": {
                    "type": "ObjectNode",
                    "bindings": [
                        {"type": "Binding", "key": "a", "value": {"type": "StringLiteral", "raw": '"a"', "value": "a"}},
                        {"type": "Binding", "key": "b", "value": {"type": "StringLiteral", "raw": '"b"', "value": "b"}},
                    ],
                },
                "span": [0, 13],
            },
            {
                "path": {"segments": [{"type": "root"}, {"type": "member", "key": "name"}]},
                "key": "name",
                "value": {"type": "NullLiteral", "raw": "!notApplicable", "value": "notApplicable"},
                "span": [14, 28],
            },
            {
                "path": {"segments": [{"type": "root"}, {"type": "member", "key": "visible"}]},
                "key": "visible",
                "value": {"type": "ToggleLiteral", "raw": "on", "value": "on"},
                "span": [29, 31],
            },
            {
                "path": {"segments": [{"type": "root"}, {"type": "member", "key": "score"}]},
                "key": "score",
                "value": {"type": "InfinityLiteral", "raw": "Infinity", "value": "Infinity"},
                "span": [32, 40],
            },
        ]
        result = validate(aes, {"rules": [
            {"path": "$.app", "constraints": {"type": "ObjectNode", "max_children": 1}},
            {"path": "$.name", "constraints": {"type": "StringLiteral", "nullable": True, "null_value": "none"}},
            {"path": "$.visible", "constraints": {"type": "ToggleLiteral", "toggle_pair": "yes_no"}},
            {"path": "$.score", "constraints": {"type": "NumberLiteral", "allow_infinity": True}},
        ]})
        self.assertEqual([
            "container_cardinality_mismatch",
            "null_value_mismatch",
            "toggle_pair_mismatch",
        ], [error["code"] for error in result["errors"]])

    def test_reference_policy_forbids_references(self) -> None:
        aes = [{"path": {"segments": [{"type": "root"}, {"type": "member", "key": "x"}]}, "key": "x", "value": {"type": "CloneReference"}, "span": [0, 1]}]
        result = validate(aes, {"rules": [], "reference_policy": "forbid"})
        self.assertEqual(["reference_forbidden"], [error["code"] for error in result["errors"]])

    def test_reference_kind_requires_matching_reference_type(self) -> None:
        aes = [{"path": {"segments": [{"type": "root"}, {"type": "member", "key": "x"}]}, "key": "x", "value": {"type": "PointerReference"}, "span": [0, 1]}]
        result = validate(aes, {"rules": [{"path": "$.x", "constraints": {"reference": "require", "reference_kind": "clone"}}]})
        self.assertEqual(["reference_kind_mismatch"], [error["code"] for error in result["errors"]])

    def test_invalid_reference_constraints_fail_schema_validation(self) -> None:
        result = validate([], {"rules": [{"path": "$.x", "constraints": {"reference_kind": "clone"}}]})
        self.assertEqual(["invalid_reference_constraint"], [error["code"] for error in result["errors"]])

    def test_reference_target_pattern_matches_canonicalized_target(self) -> None:
        aes = [{
            "path": {"segments": [{"type": "root"}, {"type": "member", "key": "postcode"}]},
            "key": "postcode",
            "value": {"type": "CloneReference", "path": ["safe keys", "postcode"]},
            "span": [0, 12],
        }]
        result = validate(aes, {"rules": [{"path": "$.postcode", "constraints": {"reference_target_pattern": '^\\$\\.\\["safe keys"\\]\\.postcode$'}}]})
        self.assertTrue(result["ok"])

    def test_reference_target_pattern_rejects_disallowed_target(self) -> None:
        aes = [{
            "path": {"segments": [{"type": "root"}, {"type": "member", "key": "postcode"}]},
            "key": "postcode",
            "value": {"type": "CloneReference", "path": ["ages", 3]},
            "span": [0, 18],
        }]
        result = validate(aes, {"rules": [{"path": "$.postcode", "constraints": {"reference": "require", "reference_kind": "clone", "reference_target_pattern": '^\\$\\.postcodes\\[\\d+\\]$'}}]})
        self.assertTrue(any(error["code"] == "reference_target_mismatch" for error in result["errors"]))

    def test_resolve_reference_form_checks_terminal_literal(self) -> None:
        aes = [
            {"path": {"segments": [{"type": "root"}, {"type": "member", "key": "source"}]}, "key": "source", "value": {"type": "NumberLiteral", "raw": "2000", "value": "2000"}, "span": [0, 4]},
            {"path": {"segments": [{"type": "root"}, {"type": "member", "key": "postcode"}]}, "key": "postcode", "value": {"type": "CloneReference", "path": ["source"]}, "span": [5, 13]},
        ]
        result = validate(aes, {"rules": [{"path": "$.postcode", "constraints": {"type": "IntegerLiteral", "min_value": "1000", "max_value": "9999", "resolve_reference_form": True}}]})
        self.assertTrue(result["ok"])

    def test_resolve_reference_form_keeps_missing_targets_core_owned(self) -> None:
        aes = [{
            "path": {"segments": [{"type": "root"}, {"type": "member", "key": "postcode"}]},
            "key": "postcode",
            "value": {"type": "CloneReference", "path": ["missing"]},
            "span": [0, 9],
        }]
        result = validate(aes, {"rules": [{"path": "$.postcode", "constraints": {"type": "IntegerLiteral", "min_value": "1000", "max_value": "9999", "resolve_reference_form": True}}]})
        self.assertTrue(result["ok"])

    def test_cts_payload_adapter(self) -> None:
        payload = json.dumps({"aes": [], "schema": {"rules": []}, "options": {}})
        parsed = json.loads(validate_cts_payload(payload))
        self.assertTrue(parsed["ok"])


if __name__ == "__main__":
    unittest.main()
