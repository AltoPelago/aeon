use super::*;

#[test]
fn shared_portable_property_vectors() {
    let suite: JsonValue = serde_json::from_str(include_str!(
        "../../../../../test-fixtures/aeos-property-selectors.json"
    ))
    .expect("fixture JSON");
    let regressions: JsonValue = serde_json::from_str(include_str!(
        "../../../../../test-fixtures/aeos-property-regressions.json"
    ))
    .expect("regression JSON");
    let context: JsonValue = serde_json::from_str(include_str!(
        "../../../../../test-fixtures/aeos-property-context-regressions.json"
    ))
    .expect("context regressions");
    let range_attributes: JsonValue = serde_json::from_str(include_str!(
        "../../../../../test-fixtures/aeos-property-range-attribute-regressions.json"
    ))
    .expect("range/attribute regressions");
    for case in suite["tests"]
        .as_array()
        .expect("tests")
        .iter()
        .chain(regressions["tests"].as_array().expect("regressions"))
        .chain(context["tests"].as_array().expect("context cases"))
        .chain(
            range_attributes["tests"]
                .as_array()
                .expect("range/attribute cases"),
        )
    {
        let records: Vec<TelexRecord> = case["records"]
            .as_array()
            .expect("records")
            .iter()
            .map(|record| {
                TelexRecord::new(
                    record
                        .as_object()
                        .expect("record")
                        .iter()
                        .map(|(key, value)| {
                            (
                                key.clone(),
                                value.as_str().expect("field string").to_owned(),
                            )
                        })
                        .collect(),
                )
            })
            .collect();
        let before = records
            .iter()
            .map(|record| record.fields().to_vec())
            .collect::<Vec<_>>();
        let schema: Schema = serde_json::from_value(case["schema"].clone()).expect("schema");
        let options: ValidationOptions = serde_json::from_value(
            case.get("options")
                .cloned()
                .unwrap_or_else(|| serde_json::json!({})),
        )
        .expect("options");
        for _ in 0..2 {
            let results = if case["entrypoint"] == "legacy" {
                vec![validate(&ValidationEnvelope {
                    aes: vec![],
                    schema: Some(schema.clone()),
                    options: options.clone(),
                })]
            } else {
                let wire =
                    aes_telex::encode_telex(&records, case["profile"].as_str()).expect("wire");
                vec![
                    validate_telex_records(&records, Some(schema.clone()), options.clone()),
                    validate_telex(
                        &wire,
                        schema.clone(),
                        options.clone(),
                        &TelexLimits::default(),
                        &[],
                    ),
                ]
            };
            for result in results {
                assert_eq!(
                    result.ok,
                    case["expected"]["ok"].as_bool().expect("ok"),
                    "{} {:?}",
                    case["id"],
                    result.errors
                );
                let mut actual = result
                    .errors
                    .iter()
                    .map(|error| (error.code.clone(), error.path.clone().unwrap_or_default()))
                    .collect::<Vec<_>>();
                let mut expected = case["expected"]["errors"]
                    .as_array()
                    .expect("errors")
                    .iter()
                    .map(|error| {
                        (
                            error["code"].as_str().expect("code").to_owned(),
                            error["path"].as_str().expect("path").to_owned(),
                        )
                    })
                    .collect::<Vec<_>>();
                actual.sort();
                expected.sort();
                assert_eq!(actual, expected, "{}", case["id"]);
                if !result.ok {
                    assert!(result.guarantees.is_empty(), "{}", case["id"]);
                }
                assert_eq!(
                    records
                        .iter()
                        .map(|record| record.fields().to_vec())
                        .collect::<Vec<_>>(),
                    before
                );
            }
        }
    }
}

#[test]
fn nested_partial_attributes_keep_actual_occurrences() {
    let suite: JsonValue = serde_json::from_str(include_str!(
        "../../../../../test-fixtures/aeos-property-nested-attribute-regressions.json"
    ))
    .expect("nested fixture");
    for case in suite["tests"].as_array().expect("tests") {
        let records = case["records"]
            .as_array()
            .expect("records")
            .iter()
            .map(|record| {
                TelexRecord::new(
                    record
                        .as_object()
                        .expect("record")
                        .iter()
                        .map(|(k, v)| (k.clone(), v.as_str().expect("string").to_owned()))
                        .collect(),
                )
            })
            .collect::<Vec<_>>();
        let before = records
            .iter()
            .map(|r| r.fields().to_vec())
            .collect::<Vec<_>>();
        let schema: Schema = serde_json::from_value(case["schema"].clone()).expect("schema");
        let limits = TelexLimits {
            max_attribute_depth: usize::try_from(
                case["limits"]["maxAttributeDepth"].as_u64().expect("depth"),
            )
            .expect("native depth"),
            ..TelexLimits::default()
        };
        for _ in 0..2 {
            let wire =
                aes_telex::encode_telex_with_limits(&records, Some("aes.partial.v1"), &limits)
                    .expect("wire");
            if case["id"] == "root-only-False-False" {
                let default_result = validate_telex(
                    &wire,
                    schema.clone(),
                    ValidationOptions::default(),
                    &TelexLimits::default(),
                    &[],
                );
                assert!(!default_result.ok);
                assert_eq!(default_result.errors[0].code, "AES_LIMIT_EXCEEDED");
                assert!(default_result.guarantees.is_empty());
            }
            for result in [
                validate_telex_records(
                    &records,
                    Some(schema.clone()),
                    ValidationOptions::default(),
                ),
                validate_telex(
                    &wire,
                    schema.clone(),
                    ValidationOptions::default(),
                    &limits,
                    &[],
                ),
            ] {
                assert_eq!(
                    result.ok,
                    case["expected"]["ok"].as_bool().expect("ok"),
                    "{} {:?}",
                    case["id"],
                    result.errors
                );
                let mut errors = result
                    .errors
                    .iter()
                    .map(|e| (e.code.clone(), e.path.clone().unwrap_or_default()))
                    .collect::<Vec<_>>();
                let mut expected = case["expected"]["errors"]
                    .as_array()
                    .expect("errors")
                    .iter()
                    .map(|e| {
                        (
                            e["code"].as_str().expect("code").to_owned(),
                            e["path"].as_str().expect("path").to_owned(),
                        )
                    })
                    .collect::<Vec<_>>();
                errors.sort();
                expected.sort();
                assert_eq!(errors, expected, "{}", case["id"]);
                if !result.ok {
                    assert!(result.guarantees.is_empty());
                }
                assert_eq!(
                    records
                        .iter()
                        .map(|r| r.fields().to_vec())
                        .collect::<Vec<_>>(),
                    before
                );
            }
        }
    }
}
