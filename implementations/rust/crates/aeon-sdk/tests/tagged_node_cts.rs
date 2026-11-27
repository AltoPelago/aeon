#![cfg(feature = "sansa")]

use std::path::PathBuf;

use altopelago_aeon::sansa_document::{
    AeonNumericMaterialization, AeonSansaNamespace, AeonSansaScope, CompileOptions,
};
use serde_json::{Value, json};

#[test]
#[ignore = "requires the shared tagged-node CTS; use tools/run_cts.py node-model-sansa"]
fn resolves_the_shared_tagged_node_addresses() {
    let root = PathBuf::from(std::env::var_os("AEONITE_CTS_ROOT").expect("CTS root"));
    let suite: Value = serde_json::from_reader(
        std::fs::File::open(root.join("sansa/v1/suites/node-model-revision.json"))
            .expect("tagged-node SANSA suite"),
    )
    .expect("SANSA vectors");
    let namespace = AeonSansaNamespace::compile(
        "<tag(\"Hello\", \"World\")>\nhost@{<glyph@{size = 1}>} = 1\n",
        CompileOptions::default(),
        AeonSansaScope::Payload,
        AeonNumericMaterialization::Lossless,
    )
    .expect("native namespace matching the CTS topology");
    let cases = suite["tests"].as_array().expect("cases");
    assert!(!cases.is_empty());
    for case in cases {
        let id = case["id"].as_str().expect("case ID");
        assert_eq!(
            case["input"]["namespace"], "sansa-node-model-revision",
            "{id}"
        );
        let source = case["input"]["source"].as_str().expect("SANSA address");
        let result = namespace.resolve_address(source, &Default::default());
        let addresses: Vec<_> = result
            .bindings
            .iter()
            .map(|binding| binding.address())
            .collect();
        assert_eq!(
            json!({"ok": result.is_ok(), "addresses": addresses}),
            case["expected"],
            "{id}"
        );
    }
}
