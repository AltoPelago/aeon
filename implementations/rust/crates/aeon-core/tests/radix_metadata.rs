use aeon_core::{RadixBaseResolution, radix_base_from_number, resolve_radix_base_from_datatype};

#[test]
fn exact_radix_fixtures() {
    let fixtures: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../../test-fixtures/radix-bases.json"
    ))
    .expect("fixtures");
    for fixture in fixtures.as_array().expect("array") {
        assert_eq!(
            radix_base_from_number(fixture["literal"].as_str().expect("literal")),
            fixture["base"].as_u64().map(|n| n as usize),
            "{fixture}"
        );
    }
    assert_eq!(
        resolve_radix_base_from_datatype(Some("radix")),
        RadixBaseResolution::Unspecified
    );
    assert_eq!(
        resolve_radix_base_from_datatype(Some("radix[2.0000000000000001]")),
        RadixBaseResolution::Invalid
    );
}

#[test]
fn bounds_are_input_sized() {
    assert_eq!(
        radix_base_from_number(&format!("2e{}", "0".repeat(100_000))),
        Some(2)
    );
    assert_eq!(
        radix_base_from_number(&format!("2e{}", "9".repeat(100_000))),
        None
    );
    assert_eq!(
        radix_base_from_number(&format!("2e-{}", "9".repeat(100_000))),
        None
    );
    assert_eq!(
        radix_base_from_number(&format!("2{}e-100000", "0".repeat(100_000))),
        Some(2)
    );
}

#[test]
fn matches_independent_rational_oracle() {
    for coefficient in (0_u64..1000).step_by(7) {
        for exponent in -5_i32..=5 {
            let numerator = coefficient * 10_u64.pow(exponent.max(0) as u32);
            let denominator = 10_u64.pow((-exponent).max(0) as u32);
            let quotient = numerator / denominator;
            let expected = (numerator.is_multiple_of(denominator) && (2..=64).contains(&quotient))
                .then_some(quotient as usize);
            assert_eq!(
                radix_base_from_number(&format!("{coefficient}e{exponent}")),
                expected
            );
        }
    }
}
