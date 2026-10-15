use super::*;
use runtime::mutate::*;
use runtime::mutate_target::ValidateMutationPlanTargetResult;
use runtime::value_semantics::Value;

fn namespace(source: &str) -> AeonSansaNamespace {
    AeonSansaNamespace::compile(
        source,
        CompileOptions::default(),
        AeonSansaScope::Payload,
        AeonNumericMaterialization::Lossless,
    )
    .expect("compile fixture")
}

fn replace(target: &str) -> MutationRequest {
    MutationRequest {
        operations: vec![RequestedMutationOperation::Replace(
            RequestedReplaceOperation {
                target: target.into(),
                value: MutationValueIntent {
                    value: MutationValue::try_scalar(Value::Symbol("approved".into()))
                        .expect("symbol scalar"),
                    datatype: Some("symbol".into()),
                    kind: Some("symbol".into()),
                },
                provenance: None,
            },
        )],
        ..Default::default()
    }
}

#[test]
fn plans_retain_document_bindings_without_mutating_the_snapshot() {
    let source = "value = |held|\n";
    let namespace = namespace(source);
    let expected = namespace.at_exact("$.value").expect("binding");
    let AeonMutationPlanResult::Planned(plan) =
        namespace.plan_mutation(&replace("$.value"), &PlanMutationOptions::default())
    else {
        panic!("plan");
    };
    drop(namespace);
    let MutationOperation::Replace { target, value, .. } = &plan.plan().operations()[0] else {
        panic!("replace");
    };
    assert_eq!(target.binding, expected);
    assert_eq!(
        target.binding.value(),
        Some(AeonSansaValue::Text("held".into()))
    );
    assert_eq!(
        value.value,
        MutationValue::try_scalar(Value::Symbol("approved".into())).expect("symbol")
    );
    assert!(matches!(
        plan.validate_target("aeon"),
        ValidateMutationPlanTargetResult::Validated { .. }
    ));
    assert!(matches!(
        plan.validate_target("json"),
        ValidateMutationPlanTargetResult::Rejected(_)
    ));
    assert_eq!(plan.namespace().document.source_bytes(), source.as_bytes());
}

#[test]
fn shared_query_and_targets_accept_core_calendar_clock_payloads() {
    use runtime::evaluate::{EvaluateOptions, EvaluatedValue};

    for (family, payload) in [
        ("wtc", "2024-T10:&Europe"),
        ("datetime", "2024-02T10Z"),
        ("datetime", "2024-T10:"),
        ("time", "23:55:60.123456789012345678900Z"),
        ("datetime", "2024-02T10:11:60.123456789012345678900"),
        ("wtc", "2024-T10:11:12.000&local"),
        ("wtc", "2024-02T10:+05:30&Europe"),
    ] {
        let source = format!("value = {payload}\n");
        let namespace = namespace(&source);
        let scalar = Value::Temporal {
            payload: payload.into(),
            semantic_type: family.into(),
        };
        assert_eq!(
            namespace
                .at_exact("$.value")
                .expect("binding")
                .runtime_value(),
            Some(scalar.clone()),
            "{payload}"
        );
        let request = MutationRequest {
            operations: vec![RequestedMutationOperation::Replace(
                RequestedReplaceOperation {
                    target: "$.value".into(),
                    value: MutationValueIntent {
                        value: MutationValue::try_scalar(scalar.clone()).expect("scalar"),
                        datatype: None,
                        kind: None,
                    },
                    provenance: None,
                },
            )],
            ..Default::default()
        };
        let AeonMutationPlanResult::Planned(plan) =
            namespace.plan_mutation(&request, &PlanMutationOptions::default())
        else {
            panic!("plan {payload}");
        };
        assert!(matches!(
            plan.validate_target("aeon"),
            ValidateMutationPlanTargetResult::Validated { .. }
        ));
        assert!(matches!(
            plan.validate_target("json"),
            ValidateMutationPlanTargetResult::Rejected(_)
        ));
        let result = namespace.evaluate_query(
            &format!("from $.value\nselect {payload}"),
            &EvaluateOptions::default(),
        );
        assert!(result.is_ok(), "{payload}: {:?}", result.errors);
        assert_eq!(result.results[0].value, EvaluatedValue::Scalar(scalar));
        if matches!(family, "datetime" | "wtc") {
            let relation = namespace.evaluate_query(
                &format!("from $.value\nselect temporalRelation(., {payload})"),
                &EvaluateOptions::default(),
            );
            assert!(relation.is_ok(), "{payload}: {:?}", relation.errors);
            assert_eq!(
                relation.results[0].value,
                EvaluatedValue::Scalar(Value::String("incomparable".into()))
            );
        }
        assert_eq!(namespace.document.source_bytes(), source.as_bytes());
    }
}

#[test]
fn even_empty_plans_retain_the_document() {
    let namespace = namespace("value = 1\n");
    let weak = Arc::downgrade(&namespace.document);
    let AeonMutationPlanResult::Planned(plan) =
        namespace.plan_mutation(&MutationRequest::default(), &PlanMutationOptions::default())
    else {
        panic!("empty plan");
    };
    drop(namespace);
    assert!(weak.upgrade().is_some());
    drop(plan);
    assert!(weak.upgrade().is_none());
}

#[test]
fn contextual_handles_cannot_cross_document_snapshots_or_scopes() {
    let namespace = namespace("value = 1\n");
    let other = self::namespace("value = 1\n");
    let full = AeonSansaNamespace::from_shared(
        Arc::clone(&namespace.document),
        AeonSansaScope::Full,
        AeonNumericMaterialization::Lossless,
    );
    for binding in [
        other.at_exact("$.value").expect("foreign binding"),
        full.root(),
    ] {
        let mut options = PlanMutationOptions::default();
        options.resolve.contextual_root = Some(binding);
        let AeonMutationPlanResult::Rejected(errors) =
            namespace.plan_mutation(&replace("?"), &options)
        else {
            panic!("foreign context must fail");
        };
        assert_eq!(errors[0].code, "SANSA_MUTATE_INVALID_TARGET");
    }
}

#[test]
fn real_document_targets_keep_quoted_members_separate_from_attributes() {
    let namespace = namespace("\"literal.@key\"@{note = \"old\"} = 1\n");
    for (address, json_ok) in [
        ("$.[\"literal.@key\"]", true),
        ("$.[\"literal.@key\"].@.note", false),
    ] {
        let request = MutationRequest {
            operations: vec![RequestedMutationOperation::Remove(
                RequestedRemoveOperation {
                    target: address.into(),
                    provenance: None,
                },
            )],
            ..Default::default()
        };
        let AeonMutationPlanResult::Planned(plan) =
            namespace.plan_mutation(&request, &PlanMutationOptions::default())
        else {
            panic!("plan {address}");
        };
        for target in ["json", "json-compatible"] {
            assert_eq!(
                matches!(
                    plan.validate_target(target),
                    ValidateMutationPlanTargetResult::Validated { .. }
                ),
                json_ok,
                "{address} {target}"
            );
        }
    }
}
