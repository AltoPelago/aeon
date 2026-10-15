from __future__ import annotations

import gc
import pickle
import unittest

from altopelago.aeon import pytonic


class MutationPlanningTests(unittest.TestCase):
    def test_plan_retains_snapshot_and_copies_supplied_intent(self) -> None:
        source = 'value = "old"\n'
        document = pytonic.loads(source)
        request = {"op": "replace", "target": "$.value", "value": {"label": "new"}}
        result = document.plan_mutation(request, plan_id="review-1")
        self.assertTrue(result.ok, result.errors)
        self.assertEqual(result.errors, ())
        plan = result.plan
        self.assertEqual(plan.plan_version, "sansa.mutate.plan.v1")
        self.assertEqual(plan.plan_id, "review-1")
        self.assertEqual(plan.preconditions, ())
        self.assertEqual(plan.diagnostics, ())
        self.assertEqual(document.source, source)
        request["value"]["label"] = "changed after planning"
        operation = plan.operations[0]
        target = operation.target
        self.assertEqual(target.binding, document["value"])
        del document, plan, result
        gc.collect()
        self.assertEqual(target.binding.value.decoded, "old")
        self.assertEqual(operation.value["label"].decoded, "new")
        self.assertEqual(target.requested_address, "$.value")
        self.assertEqual(target.canonical_address, "$.value")
        self.assertEqual(target.representation_kind, "StringLiteral")

    def test_all_operations_expose_exact_roles_and_anchors(self) -> None:
        document = pytonic.loads('object = { value = 1 }\nitems = ["a", "b"]\n')
        cases = (
            ({"op": "create", "parent": "$.object", "name": "new", "value": None}, "parent", "$.object"),
            ({"op": "replace", "target": "$.object.value", "value": 2}, "target", "$.object.value"),
            ({"op": "remove", "target": "$.object.value"}, "target", "$.object.value"),
            ({"op": "insert", "container": "$.items", "placement": {"kind": "before", "anchor": "$.items[1]"}, "value": "x"}, "container", "$.items"),
            ({"op": "move", "source": "$.items[0]", "container": "$.items", "placement": {"kind": "after", "anchor": "$.items[1]"}}, "source", "$.items[0]"),
        )
        for request, role, address in cases:
            with self.subTest(op=request["op"]):
                result = document.plan_mutation(request)
                self.assertTrue(result.ok, result.errors)
                operation = result.plan.operations[0]
                self.assertEqual(operation.op, request["op"])
                self.assertEqual(getattr(operation, role).canonical_address, address)
                self.assertEqual(operation.has_value, "value" in request)
                if request["op"] in ("insert", "move"):
                    self.assertEqual(operation.anchor.canonical_address, "$.items[1]")
                    self.assertEqual(operation.placement, request["placement"]["kind"])
                else:
                    self.assertIsNone(operation.placement)
                    self.assertIsNone(operation.anchor)
                for format in ("aeon", "json", "json-compatible"):
                    self.assertTrue(result.plan.validate_target(format).ok)

    def test_typed_descriptors_and_plain_values_keep_their_families(self) -> None:
        document = pytonic.loads('symbol = |held|\nbits:radix[16] = %ff\nnumber = 1\n')
        query_scalar = document.query("from $.number\nselect |approved|").results[0].value
        payload = {
            "symbol": document["symbol"].value,
            "radix": document["bits"].value,
            "query_symbol": query_scalar,
            "new_symbol": pytonic.scalar("symbol", "new"),
            "exact_decimal": pytonic.scalar("finite_number", "12345678901234567890.000100"),
            "large_integer": 123456789012345678901234567890,
            "boolean": True,
            "ordinary_text": "|approved|",
            "none": None,
            "list": [1, "2024-02-29"],
        }
        result = document.plan_mutation({"op": "replace", "target": "$.number", "value": payload})
        self.assertTrue(result.ok, result.errors)
        value = result.plan.operations[0].value
        self.assertEqual(tuple(field.name for field in value.fields), tuple(payload))
        self.assertEqual(value["symbol"].family, "symbol")
        self.assertEqual(value["query_symbol"].family, "symbol")
        self.assertEqual(value["radix"].semantic_type, "radix[16]")
        self.assertEqual(value["new_symbol"].canonical, "new")
        self.assertEqual(value["exact_decimal"].canonical, "12345678901234567890.000100")
        self.assertEqual(value["large_integer"].canonical, "123456789012345678901234567890")
        self.assertEqual(value["boolean"].family, "boolean")
        self.assertEqual(value["ordinary_text"].family, "string")
        self.assertEqual(value["ordinary_text"].canonical, "|approved|")
        self.assertEqual(value["list"][1].family, "string")
        self.assertIsNone(value["none"])
        self.assertTrue(result.plan.validate_target().ok)
        self.assertFalse(result.plan.validate_target("json").ok)

    def test_temporal_reference_and_literal_families_survive_without_hints(self) -> None:
        document = pytonic.loads("value = 1\n")
        for family, canonical, metadata in (
            ("date", "2024-02-29", None),
            ("time", "10:11:12.123456789012345678900Z", None),
            ("datetime", "2024-02-29T10:11:12Z", None),
            ("wtc", "2024-02-29T10:&Europe", None),
            ("radix", "ff", "radix[16]"),
            ("clone_reference", '"literal.key".child', None),
            ("pointer_reference", "$.value", None),
            ("hex", "ff00aa", None),
            ("encoding", "QmFzZTY0IQ==", None),
            ("separator", '"hello world"|fine', None),
            ("explicit_null", "postponed", None),
        ):
            with self.subTest(family=family):
                value = pytonic.scalar(family, canonical, semantic_type=metadata)
                result = document.plan_mutation({"op": "replace", "target": "$.value", "value": value})
                self.assertTrue(result.ok, result.errors)
                self.assertEqual(result.plan.operations[0].value.canonical, canonical)
                self.assertTrue(result.plan.validate_target().ok, result.plan.validate_target().errors)

    def test_planning_and_target_errors_remain_separate(self) -> None:
        document = pytonic.loads("value = 1\n")
        planned = document.plan_mutation({"op": "replace", "target": "$.value", "value": pytonic.scalar("date", "2025-02-29")})
        self.assertTrue(planned.ok)
        validation = planned.plan.validate_target()
        self.assertFalse(validation.ok)
        error = validation.errors[0]
        self.assertEqual(error.phase, "target")
        self.assertEqual(error.code, "SANSA_MUTATE_TARGET_UNSUPPORTED_VALUE")
        self.assertEqual(error.operation_index, 0)
        self.assertEqual(error.value_path, "operations[0].value")
        self.assertEqual(error.target_format, "aeon")
        missed = document.plan_mutation({"op": "remove", "target": "$.missing"})
        self.assertFalse(missed.ok)
        self.assertIsNone(missed.plan)
        self.assertEqual(missed.errors[0].phase, "plan")
        unsupported = planned.plan.validate_target("xml")
        self.assertEqual(unsupported.errors[0].target_format, "xml")

    def test_numeric_subclasses_cannot_rewrite_payloads_through_string_hooks(self) -> None:
        class Integer(int):
            def __str__(self):
                return "999"

            def __repr__(self):
                return "999"

        class Float(float):
            def __str__(self):
                return "999"

            def __repr__(self):
                return "999"

        document = pytonic.loads("value = 1\n")
        for value, canonical in ((Integer(17), "17"), (Float(1.25), "1.25"), (-0.0, "-0.0")):
            planned = document.plan_mutation({"op": "replace", "target": "$.value", "value": value})
            self.assertTrue(planned.ok, planned.errors)
            self.assertEqual(planned.plan.operations[0].value.canonical, canonical)

    def test_preconditions_budgets_and_provenance(self) -> None:
        document = pytonic.loads("value = 1\n")
        request = {
            "operations": [{"op": "replace", "target": "$.value", "value": 2, "provenance": {"line": 7}}],
            "preconditions": [{"expression": ". == 1", "target": "$.value"}],
            "provenance": {"source": "consumer"},
        }
        planned = document.plan_mutation(request)
        self.assertTrue(planned.ok, planned.errors)
        condition = planned.plan.preconditions[0]
        self.assertEqual(condition.target.binding, document["value"])
        self.assertEqual(condition.canonical, ". == 1")
        self.assertEqual(condition.portability_warnings, ())
        self.assertEqual(planned.plan.source_provenance["source"].decoded, "consumer")
        self.assertEqual(planned.plan.operations[0].provenance["line"].canonical, "7")
        request["preconditions"][0]["expression"] = ". == 2"
        failed = document.plan_mutation(request)
        self.assertFalse(failed.ok)
        self.assertEqual(failed.errors[0].precondition_index, 0)
        limited = document.plan_mutation(request, budget={"max_operations": 0})
        self.assertFalse(limited.ok)
        self.assertEqual(limited.errors[0].budget, "maxOperations")
        self.assertEqual((limited.errors[0].limit, limited.errors[0].observed), (0, 1))

    def test_nonfinite_python_numbers_keep_native_families(self) -> None:
        document = pytonic.loads("value = 1\n")
        for value, family in ((float("nan"), "nan"), (float("inf"), "positive_infinity"), (float("-inf"), "negative_infinity")):
            with self.subTest(family=family):
                result = document.plan_mutation({"op": "replace", "target": "$.value", "value": value})
                self.assertTrue(result.ok, result.errors)
                self.assertEqual(result.plan.operations[0].value.family, family)
                self.assertTrue(result.plan.validate_target("aeon").ok)
                self.assertFalse(result.plan.validate_target("json").ok)

    def test_empty_plans_and_value_budget_boundaries(self) -> None:
        document = pytonic.loads("value = 1\n")
        empty = document.plan_mutation({"operations": []})
        self.assertTrue(empty.ok, empty.errors)
        self.assertEqual(empty.plan.operations, ())
        self.assertTrue(empty.plan.validate_target().ok)
        request = {"op": "replace", "target": "$.value", "value": ["abc"]}
        for field, limit, code in (
            ("max_value_nodes", 1, "maxValueNodes"),
            ("max_value_depth", 1, "maxValueDepth"),
            ("max_string_length", 2, "maxStringLength"),
        ):
            with self.subTest(field=field):
                rejected = document.plan_mutation(request, budget={field: limit})
                self.assertFalse(rejected.ok)
                self.assertEqual(rejected.errors[0].budget, code)
        accepted = document.plan_mutation(request, budget={"max_value_nodes": 2, "max_value_depth": 2, "max_string_length": 3})
        self.assertTrue(accepted.ok, accepted.errors)

    def test_json_property_names_attributes_nodes_and_scopes(self) -> None:
        document = pytonic.loads('"literal.@key"@{note = "old"} = 1\nnode:node = <tag("text")>\n')
        for address, json_ok in (('$.["literal.@key"]', True), ('$.["literal.@key"].@.note', False), ("$.node", False)):
            planned = document.plan_mutation({"op": "remove", "target": address})
            self.assertTrue(planned.ok, planned.errors)
            for target in ("json", "json-compatible"):
                self.assertEqual(planned.plan.validate_target(target).ok, json_ok)
            self.assertTrue(planned.plan.validate_target("aeon").ok)
        scoped = pytonic.loads('aeon:header = { mode:string = "strict" }\n"aeon:mode":string = "payload"\n')
        for scope in ("payload", "header"):
            planned = scoped.plan_mutation({"op": "replace", "target": '$.["aeon:mode"]', "value": "updated"}, scope=scope)
            self.assertTrue(planned.ok, planned.errors)
            self.assertEqual(planned.plan.operations[0].target.binding.source_plane, "body" if scope == "payload" else "header")

    def test_wrappers_are_frozen_and_plans_are_not_serializable(self) -> None:
        planned = pytonic.loads("value = 1\n").plan_mutation({"op": "remove", "target": "$.value"})
        plan = planned.plan
        self.assertIsInstance(plan.operations, tuple)
        for value in (planned, plan, plan.operations[0], plan.operations[0].target):
            self.assertFalse(hasattr(value, "__dict__"))
            with self.assertRaises(AttributeError):
                value.extra = "no"
        with self.assertRaises(TypeError):
            pickle.dumps(plan)
        with self.assertRaises(TypeError):
            pytonic.MutationPlan()
        self.assertFalse(hasattr(plan, "apply"))

    def test_shared_query_and_target_accept_core_calendar_clock_payloads(self) -> None:
        for family, canonical in (
            ("wtc", "2024-T10:&Europe"),
            ("datetime", "2024-02T10Z"),
            ("datetime", "2024-T10:"),
            ("time", "23:55:60.123456789012345678900Z"),
            ("datetime", "2024-02T10:11:60.123456789012345678900"),
            ("wtc", "2024-T10:11:12.000&local"),
            ("wtc", "2024-02T10:+05:30&Europe"),
        ):
            with self.subTest(canonical=canonical):
                source = f"value = {canonical}\n"
                document = pytonic.loads(source)
                for value in (document["value"].value, pytonic.scalar(family, canonical)):
                    result = document.plan_mutation({"op": "replace", "target": "$.value", "value": value})
                    self.assertTrue(result.ok, result.errors)
                    self.assertEqual(result.plan.operations[0].value.canonical, canonical)
                    validation = result.plan.validate_target()
                    self.assertTrue(validation.ok, validation.errors)
                    self.assertFalse(result.plan.validate_target("json").ok)
                query = document.query(f"from $.value\nselect {canonical}")
                self.assertTrue(query.ok, query.errors)
                self.assertEqual(query.results[0].value.canonical, canonical)
                if family in ("datetime", "wtc"):
                    relation = document.query(f"from $.value\nselect temporalRelation(., {canonical})")
                    self.assertTrue(relation.ok, relation.errors)
                    self.assertEqual(relation.results[0].value.decoded, "incomparable")
                self.assertEqual(document.source, source)

    def test_shared_temporal_targets_still_reject_malformed_payloads(self) -> None:
        document = pytonic.loads("value = 1\n")
        for family, canonical in (
            ("datetime", "2024--T10:"),
            ("datetime", "2024-02T10::20"),
            ("wtc", "2024-T10:&Europe//comment"),
            ("wtc", "2024-T10:&Local"),
            ("datetime", "2024-02T10Z "),
        ):
            with self.subTest(canonical=canonical):
                result = document.plan_mutation({"op": "replace", "target": "$.value", "value": pytonic.scalar(family, canonical)})
                self.assertTrue(result.ok, result.errors)
                validation = result.plan.validate_target()
                self.assertFalse(validation.ok)
                self.assertEqual(validation.errors[0].phase, "target")
                self.assertEqual(validation.errors[0].code, "SANSA_MUTATE_TARGET_UNSUPPORTED_VALUE")

    def test_python_boundary_rejects_malformed_and_cyclic_values(self) -> None:
        document = pytonic.loads("value = 1\n")
        for request in (
            {"op": "remove", "target": "$.value", "policy": "allow"},
            {"op": "replace", "target": "$.value"},
            {"operations": [], "authority": "allow"},
            {"operations": [], "preconditions": [{"expression": "true", "policy": "allow"}]},
            {"op": "move", "source": "$.value", "container": "$", "placement": {"kind": "first", "anchor": "$.value"}},
        ):
            with self.subTest(request=request), self.assertRaises((ValueError, TypeError)):
                document.plan_mutation(request)
        cyclic = []
        cyclic.append(cyclic)
        with self.assertRaises(ValueError):
            document.plan_mutation({"op": "replace", "target": "$.value", "value": cyclic})
        with self.assertRaises(ValueError):
            document.plan_mutation({"operations": []}, budget={"unknown": 1})
        with self.assertRaises(ValueError):
            pytonic.scalar("number", "1", semantic_type="exec")
        with self.assertRaises(TypeError):
            document.plan_mutation({"op": "replace", "target": "$.value", "value": object()})
        with self.assertRaises(ValueError):
            document.plan_mutation({"op": "replace", "target": "$.value", "value": [None] * 100_001})

    def test_conversion_bounds_cumulative_copied_bytes(self) -> None:
        document = pytonic.loads("value = 1\n")
        large = "x" * (2 * 1024 * 1024)
        # Small Python inputs sharing one payload must not amplify into unbounded Rust copies.
        bound_value = pytonic.loads('value = "' + "x" * (512 * 1024) + '"\n')["value"].value
        for payload in (large, "\U0001f600" * (512 * 1024), pytonic.scalar("symbol", large), pytonic.scalar("radix", "a", semantic_type=large)):
            with self.subTest(kind=type(payload).__name__), self.assertRaisesRegex(ValueError, "cumulative UTF-8 payload bytes"):
                document.plan_mutation({"op": "replace", "target": "$.value", "value": [payload] * 9})
        with self.assertRaisesRegex(ValueError, "cumulative UTF-8 payload bytes"):
            document.plan_mutation({"op": "replace", "target": "$.value", "value": [bound_value] * 33})
        requests = (
            {"op": "replace", "target": "$.value", "value": [{large: None}] * 9},
            {"op": "replace", "target": "$.value", "value": [large] * 4, "provenance": [large] * 4},
            {"operations": [{"op": "replace", "target": "$.value", "value": [large] * 4}], "provenance": [large] * 4},
            {"operations": [{"op": "replace", "target": "$.value", "value": large}] * 8},
            {"operations": [], "preconditions": [{"expression": large}] * 9},
        )
        for request in requests:
            with self.subTest(fields=tuple(request)), self.assertRaisesRegex(ValueError, "cumulative UTF-8 payload bytes"):
                document.plan_mutation(request, budget={"max_string_length": 32 * 1024 * 1024})
        with self.assertRaisesRegex(ValueError, "cumulative UTF-8 payload bytes"):
            document.plan_mutation({"op": "replace", "target": "$.value", "value": [large] * 7}, plan_id=large)


if __name__ == "__main__":
    unittest.main()
