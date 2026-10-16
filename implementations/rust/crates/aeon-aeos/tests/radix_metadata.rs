use aeon_aeos::{Schema, ValidationOptions, validate_telex_records};
use aeon_core::{CompileToTelexOptions, compile_to_telex};
use serde_json::json;

#[test]
fn radix_constraints_respect_reserved_datatype_case() {
    let fixtures: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../../test-fixtures/radix-datatype-names.json"
    ))
    .expect("fixtures");
    for fixture in fixtures.as_array().expect("array") {
        let source = format!(
            "mask:{}=%1",
            fixture["datatype"].as_str().expect("datatype")
        );
        let compiled = compile_to_telex(&source, CompileToTelexOptions::default());
        assert!(compiled.compile.errors.is_empty(), "{source}");
        assert!(compiled.encode_error.is_none(), "{source}");
        for allow in [false, true] {
            let schema: Schema = serde_json::from_value(json!({"rules":[{"path":"$.mask", "constraints":{"radix":2, "allow_unspecified_radix":allow}}]})).expect("schema");
            let result = validate_telex_records(
                &compiled.records,
                Some(schema),
                ValidationOptions::default(),
            );
            let expected = fixture["invalid"] != true
                && (fixture["base"] == 2 || (fixture["base"].is_null() && allow));
            assert_eq!(
                result.ok, expected,
                "{source}, allow={allow}: {:?}",
                result.errors
            );
        }
    }
}

#[test]
fn attribute_and_any_of_constraints_do_not_bypass_exact_radix_checks() {
    for literal in ["2.00", "2e0", "2.0000000000000001"] {
        let constraints = json!({"type":"RadixLiteral", "radix":2, "allow_unspecified_radix":true});
        for (source, schema) in [
            (
                format!("x@{{mask:radix[{literal}]=%1}}=0"),
                json!({"rules":[{"path":"$.x", "constraints":{"attributes":{"mask":constraints}}}]}),
            ),
            (
                format!("mask:radix[{literal}]=%1"),
                json!({"rules":[{"path":"$.mask", "constraints":{"any_of":[constraints]}}]}),
            ),
        ] {
            let compiled = compile_to_telex(&source, CompileToTelexOptions::default());
            assert!(compiled.compile.errors.is_empty(), "{source}");
            let result = validate_telex_records(
                &compiled.records,
                Some(serde_json::from_value(schema).expect("schema")),
                ValidationOptions::default(),
            );
            assert_eq!(
                result.ok,
                literal != "2.0000000000000001",
                "{source}: {:?}",
                result.errors
            );
        }
    }
}

#[test]
fn aeos_uses_exact_radix_values_and_rejects_invalid_explicit_bases() {
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
        let source = format!(
            "mask:radix[{}]=%1",
            fixture["literal"].as_str().expect("literal")
        );
        let compiled = compile_to_telex(&source, CompileToTelexOptions::default());
        assert!(compiled.compile.errors.is_empty(), "{source}");
        for allow in [false, true] {
            let schema: Schema = serde_json::from_value(json!({"rules":[{"path":"$.mask", "constraints":{"radix":fixture["base"].as_u64().unwrap_or(2), "allow_unspecified_radix":allow}}]})).expect("schema");
            let result = validate_telex_records(
                &compiled.records,
                Some(schema),
                ValidationOptions::default(),
            );
            assert_eq!(
                result.ok,
                !fixture["base"].is_null(),
                "{source}: {:?}",
                result.errors
            );
            for error in result.errors {
                assert_eq!(error.code, "numeric_form_violation");
            }
        }
    }
}
