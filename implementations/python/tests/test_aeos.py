from __future__ import annotations

import json
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from aeon.aeos import validate, validate_cts_payload


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

    def test_cts_payload_adapter(self) -> None:
        payload = json.dumps({"aes": [], "schema": {"rules": []}, "options": {}})
        parsed = json.loads(validate_cts_payload(payload))
        self.assertTrue(parsed["ok"])


if __name__ == "__main__":
    unittest.main()
