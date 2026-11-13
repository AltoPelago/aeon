use super::*;
#[test]
fn shared_identity_selector_vectors() {
    let suite: JsonValue = serde_json::from_str(include_str!(
        "../tests/fixtures/aeos-child-identity-selectors.json"
    ))
    .expect("fixture JSON");
    for case in suite["tests"].as_array().expect("vectors") {
        let mut input = case.clone();
        input["aes"] = input["events"].clone();
        let envelope: ValidationEnvelope = serde_json::from_value(input).expect("typed envelope");
        let expected = &case["expected"];
        for _ in 0..2 {
            let out = validate(&envelope);
            assert_eq!(
                out.ok,
                expected["ok"].as_bool().expect("status"),
                "{}: {out:?}",
                case["id"]
            );
            if !out.ok {
                assert!(out.guarantees.is_empty());
                assert!(
                    out.errors.iter().any(|d| d.code == expected["error"]
                        && expected
                            .get("errorPath")
                            .is_none_or(|p| d.path.as_deref() == p.as_str())),
                    "{}: {out:?}",
                    case["id"]
                );
                if let Some(count) = expected["errorCount"].as_u64() {
                    assert_eq!(out.errors.len(), count as usize, "{}", case["id"]);
                }
            }
        }
    }
}
