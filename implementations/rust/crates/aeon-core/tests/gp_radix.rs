use aeon_core::{CompileOptions, CompileResult, compile};

#[test]
fn gp_uses_exact_values_across_binding_generic_and_item_contexts() {
    let compilers: &[fn(&str, CompileOptions) -> CompileResult] = &[
        compile,
        #[cfg(feature = "sofia")]
        aeon_core::compile_sofia,
    ];
    let fixtures: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../../test-fixtures/radix-bases.json"
    ))
    .expect("fixtures");
    let contexts: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../../test-fixtures/gp-radix-contexts.json"
    ))
    .expect("contexts");
    for fixture in fixtures
        .as_array()
        .expect("array")
        .iter()
        .filter(|f| f["testSource"] == true)
    {
        for context in contexts.as_array().expect("array") {
            let source = format!(
                "{}{}{}",
                context["before"].as_str().expect("before"),
                fixture["literal"].as_str().expect("literal"),
                context["after"].as_str().expect("after")
            );
            assert!(
                compile(&source, CompileOptions::default())
                    .errors
                    .is_empty(),
                "{source}"
            );
            for compiler in compilers {
                for header_profile in [false, true] {
                    for validation_only in [false, true] {
                        let mut options = CompileOptions::default();
                        let text = if header_profile {
                            format!("aeon:profile=\"aeon.gp.profile.v1\"\n{source}")
                        } else {
                            options.profile = Some("aeon.gp.profile.v1".to_owned());
                            source.clone()
                        };
                        if validation_only {
                            options.shallow_event_values = true;
                            options.emit_binding_projections = false;
                            options.include_header = false;
                            options.include_event_annotations = false;
                        }
                        let result = compiler(&text, options);
                        let codes: Vec<_> = result.errors.iter().map(|e| e.code.as_str()).collect();
                        assert_eq!(
                            codes,
                            if fixture["base"].is_null() {
                                vec!["PROFILE_DATATYPE_CLARIFIER_INVALID"]
                            } else {
                                vec![]
                            },
                            "{text}, validation_only={validation_only}"
                        );
                    }
                }
            }
        }
    }
}

#[test]
fn gp_keeps_name_and_clarifier_kind_distinctions() {
    let fixtures: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../../test-fixtures/radix-datatype-names.json"
    ))
    .expect("fixtures");
    for fixture in fixtures.as_array().expect("array") {
        let source = format!(
            "mask:{}=%1",
            fixture["datatype"].as_str().expect("datatype")
        );
        let result = compile(
            &source,
            CompileOptions {
                profile: Some("aeon.gp.profile.v1".to_owned()),
                ..CompileOptions::default()
            },
        );
        assert_eq!(
            result
                .errors
                .iter()
                .map(|e| e.code.as_str())
                .collect::<Vec<_>>(),
            if fixture["invalid"] == true {
                vec!["PROFILE_DATATYPE_CLARIFIER_INVALID"]
            } else {
                vec![]
            },
            "{source}"
        );
    }
    for clarifiers in ["\"2\"", "2, 10", "\"2\", 2"] {
        let result = compile(
            &format!("mask:radix[{clarifiers}]=%1"),
            CompileOptions {
                profile: Some("aeon.gp.profile.v1".to_owned()),
                max_clarifier_values: Some(2),
                ..CompileOptions::default()
            },
        );
        assert_eq!(
            result
                .errors
                .iter()
                .map(|e| e.code.as_str())
                .collect::<Vec<_>>(),
            ["PROFILE_DATATYPE_CLARIFIER_INVALID"]
        );
    }
    for literal in ["2_0", "2_0e-1", "6_4.0"] {
        assert!(
            compile(
                &format!("mask:radix[{literal}]=%1"),
                CompileOptions {
                    profile: Some("aeon.gp.profile.v1".to_owned()),
                    ..CompileOptions::default()
                }
            )
            .errors
            .is_empty()
        );
    }
}
