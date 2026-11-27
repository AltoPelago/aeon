use super::*;
use serde_json::json;

fn rejected_historical_node_records(records: &[TelexRecord]) -> bool {
    if !records.iter().any(|record| {
        record.get("kind") == Some("NodeHead")
            || (record.get("kind") == Some("NodeLiteral") && record.get("tag").is_none())
    }) {
        return false;
    }
    let result = aes_telex::validate_telex_records_with_limits(
        records,
        aes_telex::PARTIAL_AES_PROFILE,
        &[],
        &TelexLimits {
            max_attribute_depth: 4,
            ..TelexLimits::default()
        },
    );
    assert!(!result.valid);
    assert!(
        result
            .diagnostics
            .iter()
            .any(|diagnostic| matches!(diagnostic.code, "AES_UNKNOWN_KIND" | "AES_INVALID_TAG"))
    );
    true
}

fn tagged_item_fixture(records: Vec<TelexRecord>) -> Vec<TelexRecord> {
    records
        .into_iter()
        .filter_map(|record| {
            if record.get("kind") == Some("NodeHead") {
                return None;
            }
            let mut fields = record.fields().to_vec();
            match record.get("path") {
                Some("$.items[0]") => fields.push(("tag".to_owned(), "book".to_owned())),
                Some("$.items[1]") => fields.push(("tag".to_owned(), "chapter".to_owned())),
                Some("$.items[0][0][0]" | "$.items[1][0][0]") => {
                    let path = fields
                        .iter_mut()
                        .find(|(name, _)| name == "path")
                        .expect("path");
                    path.1.truncate(path.1.len() - 3);
                }
                _ => {}
            }
            Some(TelexRecord::new(fields))
        })
        .collect()
}

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
        let mut records: Vec<TelexRecord> = case["records"]
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
        let mut schema_data = case["schema"].clone();
        let mut expected = case["expected"].clone();
        if records.iter().any(|record| {
            record.get("path") == Some("$.items[0][0]") && record.get("kind") == Some("NodeHead")
        }) {
            records = tagged_item_fixture(records);
            let id = case["id"].as_str().expect("case ID");
            let revised_limit = match id {
                "tag-needs-container-and-head" => Some(0),
                "tag-exact-budget"
                | "repeated-predicate-shares-budget"
                | "distinct-rules-budget-3"
                | "identical-rule-cache"
                | "stop-property-work-after-expansion-failure"
                | "closed-world-reuses-resolution" => Some(1),
                "repeated-predicate-exact-budget" | "distinct-rules-budget-4" => Some(2),
                _ => None,
            };
            if let Some(limit) = revised_limit {
                schema_data["resource_policy"]["max_property_inspections"] = json!(limit);
            }
            if let Some(selector) = schema_data["rules"]
                .as_array()
                .expect("rules")
                .iter()
                .filter_map(|rule| rule["selector"].as_str())
                .find(|selector| {
                    sansa_runtime::address::parse_address(selector).is_err_and(|diagnostic| {
                        diagnostic.code == "SANSA_UNKNOWN_PROPERTY_SELECTOR"
                    })
                })
            {
                expected =
                    json!({"ok":false,"errors":[{"code":"invalid_schema_policy","path":selector}]});
            } else if id == "head-tag-is-not-key" {
                schema_data["rules"] = json!([{"selector":"$.items[0]&key(\"book\")","constraints":{"type":"NumberLiteral"}}]);
            }
        } else if rejected_historical_node_records(&records) {
            continue;
        }
        let before = records
            .iter()
            .map(|record| record.fields().to_vec())
            .collect::<Vec<_>>();
        let schema: Schema = serde_json::from_value(schema_data).expect("schema");
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
                    expected["ok"].as_bool().expect("ok"),
                    "{} {:?}",
                    case["id"],
                    result.errors
                );
                let mut actual = result
                    .errors
                    .iter()
                    .map(|error| (error.code.clone(), error.path.clone().unwrap_or_default()))
                    .collect::<Vec<_>>();
                let mut expected = expected["errors"]
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
        if rejected_historical_node_records(&records) {
            continue;
        }
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
