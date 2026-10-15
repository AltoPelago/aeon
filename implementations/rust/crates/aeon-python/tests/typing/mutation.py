"""Installed-wheel type smoke: python -m mypy --strict tests/typing/mutation.py."""
from typing import assert_type

from altopelago.aeon import pytonic


def inspect_plan(document: pytonic.Document) -> None:
    value = pytonic.scalar("symbol", "held")
    assert_type(value, pytonic.QueryScalar)
    result = document.plan_mutation(
        {"op": "replace", "target": "$.status", "value": value},
        scope="payload", profile="aeon.value.default.v1",
        budget={"max_value_nodes": 2}, max_bindings=10,
        max_position_index=9, plan_id="review",
    )
    assert_type(result, pytonic.MutationResult)
    assert_type(result.errors, tuple[pytonic.MutationDiagnostic, ...])
    plan = result.plan
    if plan is None:
        return
    assert_type(plan, pytonic.MutationPlan)
    assert_type(plan.operations, tuple[pytonic.MutationOperation, ...])
    assert_type(plan.preconditions, tuple[pytonic.MutationPrecondition, ...])
    assert_type(plan.validate_target("json"), pytonic.MutationValidation)
    for operation in plan.operations:
        assert_type(operation.target, pytonic.MutationTarget | None)
        if isinstance(operation.value, pytonic.QueryScalar):
            assert_type(operation.value.family, str)
        if isinstance(operation.provenance, pytonic.QueryObject):
            assert_type(operation.provenance.fields, tuple[pytonic.QueryField, ...])
    assert_type(document.sansa_capabilities.mutate_plan, str)
    assert_type(document.sansa_capabilities.mutate_target_validation, str)
    assert_type(document.sansa_capabilities.mutate_apply, str)
    string_request = {"op": "remove", "target": "$.status"}
    assert_type(document.plan_mutation(string_request), pytonic.MutationResult)
    # Strict mode's unused-ignore check fails if these become writable in the stub.
    plan.plan_id = "changed"  # type: ignore[misc]
    result.ok = False  # type: ignore[misc]
