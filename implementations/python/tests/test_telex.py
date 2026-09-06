from __future__ import annotations

import json
from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from aeon.telex import (
    TelexSyntaxError,
    canonicalize_telex,
    parse_telex,
    validate_telex,
    validate_telex_records,
)
from aeon.aeos import portable_records_to_aeos, validate_telex as validate_aeos_telex
from aeon.core import CompileOptions, compile_source
from aeon.portable import export_telex, project_telex_records
from aeon.portable_finalize import PortableFinalizeOptions, finalize_portable_json
from aeon.api import TelexLoadOptions, aeon_to_telex, load_telex_file, load_telex_text, write_telex_file


CTS_ROOT = ROOT.parents[3] / "aeonite-org" / "aeonite-cts" / "cts"


class TelexConformanceTests(unittest.TestCase):
    def test_core_projection_round_trips_through_telex_and_materializes(self) -> None:
        source = 'a\\ROOT\\:list<int> = [2, 3]\ncopy = ~a'
        compiled = compile_source(source, CompileOptions(datatype_policy="allow_custom"))
        self.assertEqual([], compiled.errors)

        encoded = export_telex(compiled.events)
        parsed = parse_telex(encoded)
        self.assertTrue(validate_telex(encoded)["valid"])
        self.assertEqual("list", parsed.records[0]["datatype"])
        self.assertEqual("int", parsed.records[0]["generics"][0]["datatype"])
        self.assertEqual("ROOT", parsed.records[0]["identity"])
        self.assertIn("datatype=list<int>\n", encoded)
        self.assertEqual(
            {"a": [2, 3], "copy": [2, 3]},
            finalize_portable_json(parsed.records)["document"],
        )

    def test_header_projection_is_explicit_and_preserves_order(self) -> None:
        source = 'aeon:mode = "strict"\naeon:encoding = "utf-8"\nvalue:number = 1'
        compiled = compile_source(source)
        self.assertEqual([], compiled.errors)

        without_headers = parse_telex(export_telex(compiled.events, header=compiled.header))
        self.assertIsNone(without_headers.projection)
        self.assertFalse(any("header" in record for record in without_headers.records))

        encoded = export_telex(compiled.events, header=compiled.header, include_headers=True)
        parsed = parse_telex(encoded)
        self.assertEqual("aeon.document.v0", parsed.projection)
        self.assertEqual(
            ['$.["aeon:mode"]', '$.["aeon:encoding"]'],
            [record["header"] for record in parsed.records if "header" in record],
        )
        full = finalize_portable_json(
            parsed.records,
            PortableFinalizeOptions(scope="full", projection=parsed.projection),
        )
        self.assertEqual(
            {"header": {"mode": "strict", "encoding": "utf-8"}, "payload": {"value": 1}},
            full["document"],
        )

    def test_nodes_and_nested_attributes_keep_portable_structure(self) -> None:
        source = 'a = <tag@{x=2}(@{z=3}=0, <kid>)>\nb@{a={x=1, y@{deep=yes}=2}}=0'
        compiled = compile_source(source)
        records = project_telex_records(compiled.events)
        paths = [record["path"] for record in records]
        self.assertIn("$.a[0]", paths)
        self.assertIn("$.a[0][0]", paths)
        self.assertIn("$.a[0][0].@.z", paths)
        self.assertIn("$.b.@.a.y.@.deep", paths)
        document = finalize_portable_json(records)["document"]
        self.assertEqual("tag", document["a"]["$node"])
        self.assertEqual(3, document["@"]["a"]["@items"]["0"]["z"])
        self.assertEqual(2, document["@"]["b"]["a"]["y"])

    def test_aeos_validates_telex_attributes_and_keeps_identity_as_metadata(self) -> None:
        source = 'a\\VALUE\\@{unit\\UNIT\\="ms"}:number = 1'
        compiled = compile_source(source)
        encoded = export_telex(compiled.events)
        schema = {
            "rules": [
                {
                    "path": "$.a",
                    "constraints": {
                        "type": "NumberLiteral",
                        "datatype": "number",
                        "attributes": {"unit": {"required": True, "type": "StringLiteral"}},
                    },
                }
            ]
        }
        result = validate_aeos_telex(encoded, schema)
        self.assertTrue(result["ok"], result["errors"])
        adapted = portable_records_to_aeos(parse_telex(encoded).records)
        self.assertEqual("VALUE", adapted[0]["structuralId"])
        self.assertEqual("UNIT", adapted[0]["annotations"]["unit"]["structuralId"])

    def test_sdk_loads_and_writes_telex_without_aeon_reparse(self) -> None:
        encoded = aeon_to_telex("answer:number = 42")
        loaded = load_telex_text(encoded)
        self.assertTrue(loaded.ok, loaded.errors)
        self.assertEqual(42, loaded.document["answer"])

        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "answer.telex.aes"
            assert loaded.parsed is not None
            write_telex_file(path, loaded.parsed.records)
            reread = load_telex_file(path, TelexLoadOptions())
            self.assertTrue(reread.ok, reread.errors)
            self.assertEqual(loaded.document, reread.document)

    def test_portable_materializer_rejects_sparse_indexes_and_unsafe_numbers(self) -> None:
        sparse = [
            {"path": "$.values", "kind": "ListNode"},
            {"path": "$.values[4]", "kind": "StringLiteral", "value": "far"},
        ]
        sparse_result = finalize_portable_json(sparse)
        self.assertEqual({"values": []}, sparse_result["document"])
        self.assertEqual("FINALIZE_NON_CONTIGUOUS_INDEX", sparse_result["meta"]["errors"][0]["code"])

        unsafe = [{"path": "$.value", "kind": "NumberLiteral", "value": "9007199254740993"}]
        unsafe_result = finalize_portable_json(unsafe)
        self.assertEqual({"value": "9007199254740993"}, unsafe_result["document"])
        self.assertEqual("FINALIZE_UNSAFE_NUMBER", unsafe_result["meta"]["errors"][0]["code"])

    def test_portable_materializer_rejects_multiple_node_heads(self) -> None:
        records = [
            {"path": "$.value", "kind": "NodeLiteral"},
            {"path": "$.value[0]", "kind": "NodeHead", "value": "first"},
            {"path": "$.value[1]", "kind": "NodeHead", "value": "second"},
        ]
        result = finalize_portable_json(records)
        self.assertIsNone(result["document"]["value"])
        self.assertEqual("FINALIZE_UNREPRESENTABLE_NODE_HEADS", result["meta"]["errors"][0]["code"])

    def test_shared_portable_aes_event_snapshot(self) -> None:
        manifest_path = CTS_ROOT / "aes" / "v0" / "aes-events-cts.v0.snapshot-0.1.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        observed = 0
        for suite_ref in manifest["suites"]:
            suite = json.loads((manifest_path.parent / suite_ref["file"]).read_text(encoding="utf-8"))
            for vector in suite["tests"]:
                observed += 1
                with self.subTest(vector=vector["id"]):
                    payload = vector["input"]
                    expected = vector["expected"]
                    result = validate_telex_records(
                        payload["records"],
                        profile=payload.get("profile", "aes.complete.v0"),
                        projection=payload.get("projection"),
                        registered_fields=payload.get("registered_fields", []),
                    )
                    self.assertEqual(expected["valid"], result["valid"])
                    self.assertEqual(expected["profile"], result["profile"])
                    self.assertEqual(
                        expected["diagnostic_codes"],
                        [item["code"] for item in result["diagnostics"]],
                    )
        self.assertEqual(38, observed)

    def test_shared_telex_snapshot(self) -> None:
        manifest_path = CTS_ROOT / "telex" / "v0" / "telex-cts.v0.snapshot-0.1.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        observed = 0
        for suite_ref in manifest["suites"]:
            suite = json.loads((manifest_path.parent / suite_ref["file"]).read_text(encoding="utf-8"))
            for vector in suite["tests"]:
                observed += 1
                with self.subTest(vector=vector["id"]):
                    self.assert_vector(vector)
        self.assertEqual(50, observed)

    def assert_vector(self, vector: dict[str, object]) -> None:
        payload = vector["input"]
        expected = vector["expected"]
        assert isinstance(payload, dict) and isinstance(expected, dict)
        source = payload["telex"]
        limits = payload.get("limits")
        operation = vector["operation"]
        if expected.get("ok") is False:
            with self.assertRaises(TelexSyntaxError) as raised:
                if operation == "canonicalize":
                    canonicalize_telex(source, limits)
                else:
                    parse_telex(source, limits)
            error = expected["error"]
            assert isinstance(error, dict)
            self.assertEqual(error["code"], raised.exception.code)
            self.assertEqual(error.get("line"), raised.exception.line)
            return
        if operation == "parse":
            actual = {"ok": True, **parse_telex(source, limits).to_dict()}
            self.assertEqual(expected, actual)
        elif operation == "canonicalize":
            self.assertEqual(expected, {"ok": True, "telex": canonicalize_telex(source, limits)})
        elif operation == "validate":
            result = validate_telex(source, limits=limits)
            self.assertEqual(expected["valid"], result["valid"])
            self.assertEqual(expected["profile"], result["profile"])
            self.assertEqual(expected["diagnostic_codes"], [item["code"] for item in result["diagnostics"]])
        else:
            self.fail(f"unsupported operation {operation}")


if __name__ == "__main__":
    unittest.main()
