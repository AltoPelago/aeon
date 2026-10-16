use aeon_core::{CompileToTelexOptions, compile_to_telex};
use aeon_finalize::{
    FinalizeMode, FinalizeOptions, FinalizePortableJsonOptions, finalize_json,
    finalize_portable_json,
};

#[test]
fn source_and_portable_radix_finalization_agree() {
    let fixtures: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../../test-fixtures/radix-bases.json"
    ))
    .expect("fixtures");
    for fixture in fixtures
        .as_array()
        .expect("array")
        .iter()
        .filter(|f| f["testSource"] == true)
    {
        for payload in ["1", "2"] {
            let source = format!(
                "mask:radix[{}]=%{payload}",
                fixture["literal"].as_str().expect("literal")
            );
            let compiled = compile_to_telex(&source, CompileToTelexOptions::default());
            assert!(
                compiled.compile.errors.is_empty(),
                "{source}: {:?}",
                compiled.compile.errors
            );
            assert!(compiled.encode_error.is_none(), "{source}");
            for mode in [FinalizeMode::Strict, FinalizeMode::Loose] {
                let legacy = finalize_json(
                    &compiled.compile.events,
                    FinalizeOptions {
                        mode,
                        ..FinalizeOptions::default()
                    },
                );
                let portable = finalize_portable_json(
                    &compiled.records,
                    FinalizePortableJsonOptions {
                        mode,
                        ..FinalizePortableJsonOptions::default()
                    },
                );
                assert_eq!(legacy.document, portable.document, "{source}");
                let errors = if mode == FinalizeMode::Strict {
                    &legacy.meta.errors
                } else {
                    &legacy.meta.warnings
                };
                let portable_errors = if mode == FinalizeMode::Strict {
                    &portable.meta.errors
                } else {
                    &portable.meta.warnings
                };
                assert_eq!(errors.len(), portable_errors.len(), "{source}");
                assert_eq!(
                    !errors.is_empty(),
                    fixture["base"]
                        .as_u64()
                        .is_none_or(|base| payload.parse::<u64>().expect("digit") >= base),
                    "{source}"
                );
                for diagnostic in errors.iter().chain(portable_errors) {
                    assert_eq!(diagnostic.code, "FINALIZE_INVALID_RADIX_BASE");
                    assert_eq!(diagnostic.path.as_deref(), Some("$.mask"));
                }
            }
        }
    }
}
