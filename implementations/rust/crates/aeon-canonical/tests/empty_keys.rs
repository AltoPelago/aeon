use aeon_canonical::canonicalize;

#[test]
fn empty_keys_canonical_round_trips() {
    let cases: serde_json::Value =
        serde_json::from_str(include_str!("../../../../../test-fixtures/empty-keys.json"))
            .expect("fixtures");
    for case in cases.as_array().expect("array") {
        if case["error"].is_string() {
            continue;
        }
        let first = canonicalize(case["source"].as_str().expect("source"));
        assert!(
            first.errors.is_empty(),
            "{}: {:?}",
            case["id"],
            first.errors
        );
        assert!(first.text.contains("\"\""), "{}", case["id"]);
        let second = canonicalize(&first.text);
        assert!(
            second.errors.is_empty(),
            "{}: {:?}",
            case["id"],
            second.errors
        );
        assert_eq!(first.text, second.text, "{}", case["id"]);
    }
}
