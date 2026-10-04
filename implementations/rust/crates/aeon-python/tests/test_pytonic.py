from __future__ import annotations

import hashlib
import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

import altopelago.aeon as aeon
from altopelago.aeon import pytonic


class PytonicTests(unittest.TestCase):
    def test_navigates_shared_graph_without_unwrapping_bindings(self) -> None:
        document = pytonic.loads(
            'inventory = { items = [{ sku:string = "A1" }] }\n'
            "status = |approved|\n"
        )

        sku = document["inventory"]["items"][0]["sku"]
        status = document["status"]

        self.assertIsInstance(sku, pytonic.Binding)
        self.assertEqual(sku.address, "$.inventory.items[0].sku")
        self.assertEqual(sku.full_address, "$.body.inventory.items[0].sku")
        self.assertEqual(sku.datatype, "string")
        self.assertEqual(sku.value.kind, "StringLiteral")
        self.assertEqual(sku.value.decoded, "A1")
        self.assertEqual(status.value.kind, "SymbolicLiteral")
        self.assertEqual(status.value.decoded, "approved")

    def test_exposes_attributes_identity_and_capabilities(self) -> None:
        document = pytonic.loads(
            'value\\ROOT\\@{unit:string = "cm"}:number = 3\n'
        )
        value = document["value"]

        self.assertEqual(value.identity, "ROOT")
        self.assertIsNotNone(value.attributes)
        self.assertEqual(value.attributes["unit"].value.decoded, "cm")
        self.assertEqual(document.by_identity("ROOT"), (value,))
        self.assertEqual(document.capabilities.source_bytes, "complete")
        self.assertEqual(document.capabilities.unknown_telex_fields, "not_applicable")

    def test_scopes_and_address_lookup_are_explicit(self) -> None:
        document = pytonic.loads(
            'aeon:header = { mode:string = "strict" }\n'
            '"aeon:mode":string = "payload"\n'
        )

        payload = document.at('$.["aeon:mode"]')
        header = document.at('$.["aeon:mode"]', scope="header")
        self.assertEqual(payload.source_plane, "body")
        self.assertEqual(header.source_plane, "header")
        self.assertNotEqual(payload.full_address, header.full_address)

    def test_views_and_collections_are_immutable(self) -> None:
        document = pytonic.loads("values = [1, 2]\n")
        values = document["values"]

        self.assertIsInstance(values.children, tuple)
        self.assertFalse(hasattr(values, "__dict__"))
        with self.assertRaises(AttributeError):
            values.address = "$.changed"

    def test_invalid_source_raises_public_compile_error(self) -> None:
        with self.assertRaises(aeon.CompileError) as raised:
            pytonic.loads('name = "unterminated')

        self.assertEqual(raised.exception.diagnostics[0].code, "UNTERMINATED_STRING")

    def test_custom_datatype_policy_and_file_loading(self) -> None:
        with self.assertRaises(aeon.CompileError):
            pytonic.loads(
                'value:custom = "yes"\n', datatype_policy="reserved_only"
            )

        with TemporaryDirectory() as directory:
            path = Path(directory, "example.aeon")
            path.write_text('value:custom = "yes"\n', encoding="utf-8")
            document = pytonic.load(path, datatype_policy="allow_custom")

        self.assertEqual(document["value"].datatype, "custom")

    def test_file_loading_preserves_source_bytes_and_provenance(self) -> None:
        source = "first = 1\r\nsecond = 2\r\n"
        expected_origin = f"sha256:{hashlib.sha256(source.encode('utf-8')).hexdigest()}"
        with TemporaryDirectory() as directory:
            path = Path(directory, "crlf.aeon")
            path.write_bytes(source.encode("utf-8"))
            document = pytonic.load(path)

        self.assertEqual(document.source, source)
        self.assertEqual(document["second"].origin, expected_origin)
        self.assertEqual(document["second"].span, "11:21")

    def test_exposes_structured_datatype_components(self) -> None:
        document = pytonic.loads(
            "metric:nan<number> = NaN\nbits:radix[2] = %101.01\n"
        )

        generic = document["metric"].generics[0]
        clarifier = document["bits"].clarifiers[0]
        self.assertEqual((generic.kind, generic.datatype), ("Datatype", "number"))
        self.assertEqual(
            (clarifier.kind, clarifier.value), ("NumberLiteral", "2")
        )

    def test_follows_shared_document_projection_contract(self) -> None:
        fixture_path = (
            Path(__file__).resolve().parents[5]
            / "test-fixtures"
            / "document-projection"
            / "aeon-document-projection.v1.json"
        )
        contract = json.loads(fixture_path.read_text(encoding="utf-8"))

        for fixture in contract["fixtures"]:
            options = fixture.get("compileOptions", {})
            document = pytonic.loads(
                fixture["source"],
                datatype_policy=options.get("datatypePolicy"),
                max_attribute_depth=options.get("maxAttributeDepth"),
            )
            for scope, expected_nodes in fixture["scopes"].items():
                for expected in expected_nodes:
                    with self.subTest(
                        fixture=fixture["id"],
                        scope=scope,
                        address=expected["address"],
                    ):
                        binding = document.at(expected["address"], scope=scope)
                        self.assertEqual(
                            binding.representation_kind,
                            expected["representationKind"],
                        )


if __name__ == "__main__":
    unittest.main()
