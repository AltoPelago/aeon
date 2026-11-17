use super::*;
use runtime::property::{PropertyAccess, PropertyAccessContext, PropertyScopeRole};
use runtime::resolve::ResolveOptions;
use serde_json::Value;

fn fixture() -> Value {
    serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../../test-fixtures/property-resolve-sdk.json"
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
        let parsed = runtime::address::parse_address(text).expect("property address");
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
fn properties_reject_foreign_document_plane_materialization_and_direct_head() {
    let ns = namespace();
    let foreign = namespace();
    let options = ResolveOptions {
        contextual_root: foreign.at_exact("$.value"),
        ..ResolveOptions::default()
    };
    let result = ns.resolve_address("?&tag(\"tag\")", &options);
    assert_eq!(
        result.errors[0].code,
        "SANSA_RESOLVE_PROPERTY_SCOPE_VIOLATION"
    );
    let root = ns.root();
    let value = ns.at_exact("$.value").expect("value");
    let context = PropertyAccessContext {
        scope_root: &root,
        evaluation_root: &root,
        direct_head_of: Some(&value),
    };
    for path in ["$.group.nested[0]", "$.value[0][0]"] {
        assert_eq!(
            ns.scope(&ns.at_exact(path).expect("head"), &context),
            Ok(PropertyScopeRole::Outside)
        );
    }
    let head = ns.at_exact("$.value[0]").expect("direct head");
    assert_eq!(ns.scope(&head, &context), Ok(PropertyScopeRole::Inside));
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
fn properties_preserve_closed_query_and_exact_lookup() {
    let ns = namespace();
    let result = ns.evaluate_query(
        "from $.*&key(\"value\")\nselect .",
        &runtime::evaluate::EvaluateOptions::default(),
    );
    assert!(!result.is_ok());
    assert_eq!(result.errors[0].code, "SANSA_RESOLVE_UNSUPPORTED_SELECTOR");
    assert!(ns.at_exact("$.value&tag(\"tag\")").is_none());
}
