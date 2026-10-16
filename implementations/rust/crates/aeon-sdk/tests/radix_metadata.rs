use aeon_core::CompileOptions;
use altopelago_aeon::sansa_document::{
    AeonNumericMaterialization, AeonSansaNamespace, AeonSansaScope,
};

#[test]
fn namespace_radix_metadata_respects_reserved_datatype_case() {
    let fixtures: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../../test-fixtures/radix-datatype-names.json"
    ))
    .expect("fixtures");
    for fixture in fixtures.as_array().expect("array") {
        let source = format!(
            "mask:{}=%1",
            fixture["datatype"].as_str().expect("datatype")
        );
        let namespace = AeonSansaNamespace::compile(
            &source,
            CompileOptions::default(),
            AeonSansaScope::Payload,
            AeonNumericMaterialization::Lossless,
        )
        .expect("namespace");
        assert_eq!(
            namespace.at_exact("$.mask").expect("mask").radix_base(),
            fixture["base"].as_u64().map(|base| base as u32),
            "{source}"
        );
    }
}

#[test]
fn namespace_radix_metadata_is_exact() {
    for (literal, base) in [
        ("2.00", Some(2)),
        ("2e0", Some(2)),
        ("20e-1", Some(2)),
        ("2.0000000000000001", None),
    ] {
        let namespace = AeonSansaNamespace::compile(
            &format!("mask:radix[{literal}]=%1"),
            CompileOptions::default(),
            AeonSansaScope::Payload,
            AeonNumericMaterialization::Lossless,
        )
        .expect("namespace");
        assert_eq!(
            namespace.at_exact("$.mask").expect("mask").radix_base(),
            base,
            "{literal}"
        );
    }
}
