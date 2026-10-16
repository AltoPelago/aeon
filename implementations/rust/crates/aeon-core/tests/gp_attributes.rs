use aeon_core::{CompileOptions, CompileResult, DatatypePolicy, compile};

#[test]
fn gp_checks_unprojected_occurrences_once_at_their_exact_paths() {
    let fixtures: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../../test-fixtures/gp-attribute-clarifiers.json"
    ))
    .expect("fixtures");
    let tag_heads: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../../test-fixtures/gp-tag-head-clarifiers.json"
    ))
    .expect("tag-head fixtures");
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
                    let result = compiler(&text, options);
                    let actual = serde_json::Value::Array(
                        result
                            .errors
                            .iter()
                            .map(|e| serde_json::json!({"code":e.code,"path":e.path}))
                            .collect(),
                    );
                    assert_eq!(actual, fixture["errors"], "{text}, compact={compact}");
                }
            }
        }
    }
}
