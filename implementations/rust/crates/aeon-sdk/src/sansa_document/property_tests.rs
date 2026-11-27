use super::*;
use runtime::property::{PropertyAccess, PropertyAccessContext, PropertyScopeRole};
use runtime::resolve::ResolveOptions;
use serde_json::Value;

fn fixture() -> Value {
    serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../../test-fixtures/property-resolve-sdk-tagged-nodes.json"
    )))
    .expect("SDK property fixture")
}

fn namespace() -> AeonSansaNamespace {
    AeonSansaNamespace::compile(
        fixture()["source"].as_str().expect("source"),
        CompileOptions::default(),
        AeonSansaScope::Payload,
        AeonNumericMaterialization::Lossless,
    )
    .expect("compile SDK fixture")
}

#[test]
fn authoritative_properties_match_shared_text_and_native_ast_fixtures() {
    let ns = namespace();
    for case in fixture()["cases"].as_array().expect("cases") {
        let text = case["address"].as_str().expect("address");
        let mut options = ResolveOptions::default();
        if let Some(context) = case["context"].as_str() {
            options.contextual_root = ns.at_exact(context);
        }
        if let Some(limit) = case["limit"].as_u64() {
            options.max_property_inspections = u32::try_from(limit).expect("limit");
        }
        let parsed = runtime::address::parse_address(text);
        if let Some(code) = case["parseCode"].as_str() {
            assert_eq!(parsed.expect_err("removed selector").code, code, "{text}");
            continue;
        }
        let parsed = parsed.expect("property address");
        for result in [
            ns.resolve_address(text, &options),
            runtime::resolve::resolve_parsed_address(&parsed, &ns, &options),
        ] {
            if let Some(code) = case["code"].as_str() {
                assert!(!result.is_ok(), "{text}");
                assert_eq!(result.errors[0].code, code, "{text}");
                assert!(result.bindings.is_empty());
                if let Some(observed) = case["observed"].as_u64() {
                    assert_eq!(result.errors[0].observed, Some(observed as usize));
                    assert_eq!(
                        result.errors[0].budget.as_deref(),
                        Some("maxPropertyInspections")
                    );
                    assert_eq!(
                        result.errors[0].limit,
                        Some(options.max_property_inspections as usize)
                    );
                }
            } else {
                assert!(result.is_ok(), "{text}: {:?}", result.errors);
                let expected: Vec<_> = case["paths"]
                    .as_array()
                    .expect("paths")
                    .iter()
                    .map(|p| p.as_str().expect("path"))
                    .collect();
                assert_eq!(
                    result
                        .bindings
                        .iter()
                        .map(AeonSansaBinding::address)
                        .collect::<Vec<_>>(),
                    expected,
                    "{text}"
                );
                for binding in result.bindings {
                    assert_eq!(ns.at_exact(&binding.address()), Some(binding));
                }
            }
        }
    }
}

#[test]
fn properties_reject_foreign_document_plane_materialization_and_scope() {
    let ns = namespace();
    let foreign = namespace();
    let options = ResolveOptions {
        contextual_root: foreign.at_exact("$.tag"),
        ..ResolveOptions::default()
    };
    let result = ns.resolve_address("?&tag(\"tag\")", &options);
    assert_eq!(
        result.errors[0].code,
        "SANSA_RESOLVE_PROPERTY_SCOPE_VIOLATION"
    );
    let root = ns.at_exact("$.tag").expect("tag");
    let context = PropertyAccessContext {
        scope_root: &root,
        evaluation_root: &root,
    };
    let outside = ns.at_exact("$.group.inner").expect("other node");
    let child = ns.at_exact("$.tag[0]").expect("direct child");
    assert_eq!(ns.scope(&outside, &context), Ok(PropertyScopeRole::Outside));
    assert_eq!(ns.scope(&root, &context), Ok(PropertyScopeRole::Root));
    assert_eq!(ns.scope(&child, &context), Ok(PropertyScopeRole::Inside));
    let header = AeonSansaNamespace::from_shared(
        Arc::clone(&ns.document),
        AeonSansaScope::Header,
        AeonNumericMaterialization::Lossless,
    );
    assert_eq!(
        ns.scope(&header.root(), &context),
        Ok(PropertyScopeRole::Outside)
    );
    let native = AeonSansaNamespace::from_shared(
        Arc::clone(&ns.document),
        AeonSansaScope::Payload,
        AeonNumericMaterialization::Native,
    );
    assert_eq!(
        ns.scope(&native.root(), &context),
        Ok(PropertyScopeRole::Outside)
    );
}

#[test]
fn properties_admit_direct_query_and_preserve_exact_lookup() {
    let ns = namespace();
    let result = ns.evaluate_query(
        "from $.*&key(\"tag\")\nselect .",
        &runtime::evaluate::EvaluateOptions::default(),
    );
    assert!(result.is_ok());
    assert_eq!(result.results.len(), 1);
    assert!(ns.at_exact("$.tag&tag(\"tag\")").is_none());
}

#[test]
fn recursive_predicates_distinguish_tagged_nodes_and_content() {
    let fixture: Value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../../test-fixtures/node-tag-sdk.json"
    )))
    .expect("tagged node fixture");
    let ns = AeonSansaNamespace::compile(
        fixture["source"].as_str().expect("source"),
        CompileOptions::default(),
        AeonSansaScope::Payload,
        AeonNumericMaterialization::Lossless,
    )
    .expect("namespace");
    for case in fixture["cases"].as_array().expect("cases") {
        let text = case["address"].as_str().expect("address");
        let parsed = runtime::address::parse_address(text).expect("parsed");
        for selected in [
            ns.resolve_address(text, &ResolveOptions::default()),
            runtime::resolve::resolve_parsed_address(&parsed, &ns, &ResolveOptions::default()),
        ] {
            assert!(selected.is_ok(), "{text}: {:?}", selected.errors);
            let paths: Vec<_> = selected.bindings.iter().map(|b| b.address()).collect();
            let kinds: Vec<_> = selected
                .bindings
                .iter()
                .map(|b| b.representation_kind())
                .collect();
            assert_eq!(serde_json::to_value(paths).expect("paths"), case["paths"]);
            assert_eq!(serde_json::to_value(kinds).expect("kinds"), case["kinds"]);
            for binding in selected.bindings {
                assert_eq!(Some(binding.clone()), ns.at_exact(&binding.address()));
            }
        }
    }
}

#[test]
fn shared_property_query_document_cases_preserve_original_targets_and_scope() {
    use runtime::evaluate::{EvaluateOptions, EvaluatedValue};
    let fixture: Value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../../test-fixtures/property-query-sdk-tagged-nodes.json"
    )))
    .expect("query fixture");
    let ns = AeonSansaNamespace::compile(
        fixture["source"].as_str().expect("source"),
        CompileOptions::default(),
        AeonSansaScope::Payload,
        AeonNumericMaterialization::Lossless,
    )
    .expect("namespace");
    for case in fixture["cases"].as_array().expect("cases") {
        let source = case["query"].as_str().expect("query");
        let parsed = runtime::query::parse_query(source).expect("query parse");
        let options = EvaluateOptions {
            resolve: ResolveOptions {
                max_property_inspections: case["limit"].as_u64().unwrap_or(10000) as u32,
                ..ResolveOptions::default()
            },
            ..EvaluateOptions::default()
        };
        for result in [
            ns.evaluate_query(source, &options),
            runtime::evaluate::evaluate_parsed_query(&parsed, &ns, &options),
        ] {
            if let Some(code) = case["code"].as_str() {
                assert_eq!(result.errors[0].code, code, "{source}");
                assert_eq!(
                    format!("{:?}", result.errors[0].phase.expect("phase")).to_lowercase(),
                    case["phase"]
                );
                assert!(result.results.is_empty());
                continue;
            }
            assert!(result.is_ok(), "{source}: {:?}", result.errors);
            let records:Vec<Value>=result.results.iter().map(|row| {
                let EvaluatedValue::Bindings(bindings)=&row.value else {panic!("bindings");};
                for b in bindings {assert_eq!(ns.at_exact(&b.address()),Some(b.clone()));}
                assert_eq!(ns.at_exact(&row.candidate.address()),Some(row.candidate.clone()));
                serde_json::json!({"candidate":row.candidate.address(),"valueBindings":bindings.iter().map(|b|b.address()).collect::<Vec<_>>()})
            }).collect();
            assert_eq!(
                serde_json::to_value(records).expect("records"),
                case["records"],
                "{source}"
            );
        }
    }
}
