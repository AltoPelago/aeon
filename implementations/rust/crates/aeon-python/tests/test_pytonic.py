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
        self.assertEqual(document.sansa_capabilities.query, "complete")
        self.assertEqual(
            document.sansa_capabilities.dynamic_address_activation, "constrained"
        )
        self.assertEqual(document.sansa_capabilities.transform, "not_exposed")
        self.assertEqual(document.sansa_capabilities.mutate, "not_exposed")

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

    def test_query_preserves_binding_views_and_derived_objects(self) -> None:
        document = pytonic.loads(
            """
inventory = {
  items = [
    { sku = "A-100", qty = 2, stage = |approved| },
    { sku = "B-200", qty = 0, stage = |held| }
  ]
}
"""
        )

        result = document.query(
            """
from $.inventory.items.*
where .qty >= 2 and .stage == |approved|
select { sku = .sku stage = .stage }
"""
        )

        self.assertTrue(result.ok)
        self.assertEqual(result.errors, ())
        self.assertEqual(len(result.results), 1)
        record = result.results[0]
        self.assertEqual(record.candidate.address, "$.inventory.items[0]")
        self.assertIsInstance(record.value, pytonic.QueryObject)
        self.assertEqual(record.value["sku"][0].value.decoded, "A-100")
        self.assertEqual(record.value["stage"][0].value.kind, "SymbolicLiteral")
        self.assertEqual(
            tuple(field.name for field in record.value.fields), ("sku", "stage")
        )

    def test_query_exposes_typed_scalars_without_json_materialisation(self) -> None:
        document = pytonic.loads("item = { stage = |approved| }\n")

        for expression, family, canonical, decoded in (
            ("|approved|", "symbol", "approved", "approved"),
            ('"approved"', "string", "approved", "approved"),
            ("true", "boolean", "true", True),
            (
                "123456789012345678901234567890.00100",
                "finite_number",
                "123456789012345678901234567890.00100",
                "123456789012345678901234567890.00100",
            ),
        ):
            with self.subTest(expression=expression):
                result = document.query(f"from $.item\nselect {expression}")
                self.assertTrue(result.ok)
                scalar = result.results[0].value
                self.assertIsInstance(scalar, pytonic.QueryScalar)
                self.assertEqual(scalar.family, family)
                self.assertEqual(scalar.canonical, canonical)
                self.assertEqual(scalar.decoded, decoded)

        symbol = document.query("from $.item\nselect |approved|").results[0].value
        self.assertEqual(symbol.semantic_type, "symbol")

    def test_query_preserves_recursive_structural_container_payloads(self) -> None:
        document = pytonic.loads(
            'item = { name = "A-100", stage = |approved|, values = [1, 2] }\n'
        )

        result = document.query('from $.item\nselect fallback(., "fallback")')

        self.assertTrue(result.ok, result.errors)
        container = result.results[0].value
        self.assertIsInstance(container, pytonic.QueryContainer)
        self.assertEqual(container.kind, "ObjectNode")
        self.assertIsInstance(container.payload, pytonic.QueryObject)
        self.assertEqual(container.payload["name"].decoded, "A-100")
        self.assertEqual(container.payload["stage"].family, "symbol")
        self.assertEqual(
            tuple(value.canonical for value in container.payload["values"]),
            ("1", "2"),
        )

    def test_query_reports_structured_parse_policy_and_budget_failures(self) -> None:
        document = pytonic.loads("items = [1, 2]\n")

        parse_failure = document.query("not a query")
        self.assertFalse(parse_failure.ok)
        self.assertEqual(parse_failure.results, ())
        self.assertEqual(parse_failure.errors[0].phase, "parse")

        policy_failure = document.query(
            "from $.items.*\norder by .\nselect .", policy="validation"
        )
        self.assertFalse(policy_failure.ok)
        self.assertEqual(policy_failure.errors[0].code, "SANSA_QUERY_POLICY_VIOLATION")
        self.assertEqual(policy_failure.errors[0].phase, "policy")

        budget_failure = document.query(
            "from $.items.*\nselect .", max_from_bindings=1
        )
        self.assertFalse(budget_failure.ok)
        diagnostic = budget_failure.errors[0]
        self.assertEqual(diagnostic.code, "SANSA_QUERY_BUDGET_EXCEEDED")
        self.assertEqual(diagnostic.phase, "from")
        self.assertEqual(diagnostic.budget, "maxFromBindings")
        self.assertEqual((diagnostic.limit, diagnostic.observed), (1, 2))

        candidate_failure = document.query(
            'from $.items.*\nwhere . > "not a number"\nselect .'
        )
        self.assertFalse(candidate_failure.ok)
        self.assertEqual(candidate_failure.errors[0].phase, "where")
        self.assertEqual(candidate_failure.errors[0].candidate_address, "$.items[0]")

    def test_query_bindings_retain_the_document_lifetime(self) -> None:
        result = pytonic.loads("items = [1]\n").query(
            "from $.items.*\nselect ."
        )

        self.assertTrue(result.ok)
        self.assertEqual(result.results[0].value[0].address, "$.items[0]")

    def test_query_dynamic_paths_require_an_explicit_constrained_policy(self) -> None:
        document = pytonic.loads(
            "items = [1, 2]\nselector:sansa = $.items.*\n"
        )
        query = "from $.selector\nselect path(.)"

        disabled = document.query(query)
        self.assertFalse(disabled.ok)
        self.assertEqual(
            disabled.errors[0].code,
            "SANSA_QUERY_PATH_ACTIVATION_POLICY_REQUIRED",
        )

        enabled = document.query(
            query,
            activation_roots=("$.items",),
            activation_selectors=("member", "direct_expansion"),
            max_activation_depth=3,
            max_activation_bindings=2,
        )
        self.assertTrue(enabled.ok, enabled.errors)
        self.assertEqual(
            tuple(binding.address for binding in enabled.results[0].value),
            ("$.items[0]", "$.items[1]"),
        )

        with self.assertRaises(ValueError):
            document.query(query, activation_selectors=("direct_expansion",))
        with self.assertRaises(ValueError):
            document.query(
                query,
                activation_roots=("$.items",),
                activation_selectors=("unknown",),
            )

    def test_query_rejects_unknown_python_policy_and_profile(self) -> None:
        document = pytonic.loads("value = 1\n")

        with self.assertRaises(ValueError):
            document.query("from $.value\nselect .", policy="unsafe")
        with self.assertRaises(ValueError):
            document.query("from $.value\nselect .", profile="unknown")


if __name__ == "__main__":
    unittest.main()
