use aeon_core::{CompileOptions, CompileResult, DatatypePolicy, compile};

#[test]
fn gp_checks_datatype_claims_once_at_their_exact_paths() {
    let fixtures: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../../test-fixtures/gp-attribute-clarifiers.json"
    ))
    .expect("fixtures");
    let tag_heads: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../../test-fixtures/gp-tag-head-clarifiers.json"
    ))
    .expect("tag-head fixtures");
    let generics: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../../test-fixtures/gp-datatype-generics.json"
    ))
    .expect("generic fixtures");
    let compilers: &[fn(&str, CompileOptions) -> CompileResult] = &[
        compile,
        #[cfg(feature = "sofia")]
        aeon_core::compile_sofia,
    ];
    for fixture in fixtures
        .as_array()
        .expect("array")
        .iter()
        .chain(tag_heads.as_array().expect("array"))
        .chain(generics.as_array().expect("array"))
    {
        let source = fixture["source"].as_str().expect("source");
        let options = CompileOptions {
            max_attribute_depth: 2,
            max_clarifier_values: Some(2),
            datatype_policy: Some(DatatypePolicy::AllowCustom),
            ..CompileOptions::default()
        };
        assert!(
            compile(source, options.clone()).errors.is_empty(),
            "{source}"
        );
        for compiler in compilers {
            for header in [false, true] {
                for compact in [false, true] {
                    let mut options = options.clone();
                    let text = if header {
                        format!("aeon:profile=\"aeon.gp.profile.v1\"\n{source}")
                    } else {
                        options.profile = Some("aeon.gp.profile.v1".to_owned());
                        source.to_owned()
                    };
                    if compact {
                        options.shallow_event_values = true;
                        options.emit_binding_projections = false;
                        options.include_header = false;
                        options.include_event_annotations = false;
                    }
                    let result = compiler(&text, options.clone());
                    let actual = serde_json::Value::Array(
                        result
                            .errors
                            .iter()
                            .map(|e| serde_json::json!({"code":e.code,"path":e.path}))
                            .collect(),
                    );
                    assert_eq!(actual, fixture["errors"], "{text}, compact={compact}");

                    // An explicitly selected test profile also takes precedence over a GP header.
                    options.profile = Some("set.to.eleven.v1".to_owned());
                    let result = compiler(&text, options);
                    assert!(
                        result.errors.is_empty(),
                        "{text}, compact={compact}: {:?}",
                        result.errors
                    );
                }
            }
        }
    }
}

#[test]
fn test_profile_uses_core_syntax_limits_and_literal_family_validation() {
    let options = CompileOptions {
        profile: Some("set.to.eleven.v1".to_owned()),
        max_generic_arguments: 1,
        ..CompileOptions::default()
    };
    for (source, code) in [
        ("a:symbol<1> = |approved|", "SYNTAX_ERROR"),
        (
            r#"a:string<Locale>["en", "AU"] = "hello""#,
            "CLARIFIER_VALUES_EXCEEDED",
        ),
        (
            r#"a:string<Language, Region> = "hello""#,
            "GENERIC_ARGUMENTS_EXCEEDED",
        ),
        (
            "aeon:mode = \"strict\"\na:node<radix[2]> = 1",
            "DATATYPE_LITERAL_MISMATCH",
        ),
    ] {
        let result = compile(source, options.clone());
        assert_eq!(result.errors.len(), 1, "{source}: {:?}", result.errors);
        assert_eq!(result.errors[0].code, code, "{source}");
        assert!(result.events.is_empty());
    }

    let source = r#"a:string<Locale>["en", 9007199254740993] = "hello""#;
    let result = compile(
        source,
        CompileOptions {
            max_clarifier_values: Some(2),
            ..options
        },
    );
    assert!(result.errors.is_empty(), "{:?}", result.errors);
    assert_eq!(
        result.events[0].datatype.as_deref(),
        Some(r#"string<Locale>["en",9007199254740993]"#)
    );
}
