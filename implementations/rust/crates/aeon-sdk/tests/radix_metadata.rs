use aeon_core::CompileOptions;
use altopelago_aeon::sansa_document::{
    AeonNumericMaterialization, AeonSansaNamespace, AeonSansaScope,
};

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
