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
    for case in suite["tests"]
        .as_array()
        .expect("tests")
        .iter()
        .chain(regressions["tests"].as_array().expect("regressions"))
        .chain(context["tests"].as_array().expect("context cases"))
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
