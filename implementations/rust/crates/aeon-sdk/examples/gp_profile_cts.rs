//! Run the opt-in GP profile CTS against the official artifact through the Rust SDK.

use std::fs;
use std::path::Path;

use aeon_core::{BehaviorMode, CompileOptions, DatatypePolicy, Diagnostic};
use altopelago_aeon::profiles::load_profile_contract;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

const GP: &str = "aeon.gp.profile.v1";

fn read_json(path: &Path) -> Value {
    serde_json::from_slice(&fs::read(path).expect("read JSON file")).expect("parse JSON file")
}

fn diagnostics(entries: &[Diagnostic]) -> Value {
    Value::Array(
        entries
            .iter()
            .map(|entry| json!({ "code": entry.code, "path": entry.path }))
            .collect(),
    )
}

fn main() {
    let args = std::env::args_os().skip(1).collect::<Vec<_>>();
    let [contracts_dir, manifest_path] = args.as_slice() else {
        eprintln!("usage: gp_profile_cts <specs contracts/v1 directory> <draft GP manifest>");
        std::process::exit(2);
    };
    let contracts_dir = Path::new(contracts_dir);
    let manifest_path = Path::new(manifest_path);
    let manifest = read_json(manifest_path);
    assert_eq!(manifest["meta"]["lane"], "profile");
    assert_eq!(manifest["meta"]["profile"], GP);
    assert_eq!(manifest["meta"]["sut_protocol"], "cts.protocol.v1");
    assert_eq!(manifest["meta"]["conformance"]["surface"], "experimental");
    assert_eq!(
        manifest["meta"]["conformance"]["experimental_default"],
        "exclude"
    );

    let registry = read_json(&contracts_dir.join("registry.json"));
    let entry = registry["contracts"]
        .as_array()
        .expect("registry contracts")
        .iter()
        .find(|item| item["kind"] == "profile" && item["id"] == GP)
        .expect("official GP profile registry entry");
    assert_eq!(entry["path"], "profiles/aeon.gp.profile.v1.aeon");
    assert_eq!(entry["status"], "active");
    let artifact = fs::read(contracts_dir.join("profiles/aeon.gp.profile.v1.aeon"))
        .expect("read official GP profile");
    let digest: String = Sha256::digest(&artifact)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    assert_eq!(digest, entry["sha256"]);
    let policy =
        load_profile_contract(std::str::from_utf8(&artifact).expect("UTF-8 profile artifact"))
            .expect("load official GP profile");
    assert_eq!(policy.id, GP);
    assert_eq!(policy.version, entry["version"]);

    let dir = manifest_path.parent().expect("manifest directory");
    let mut passed = 0;
    for selection in manifest["suites"].as_array().expect("suite selections") {
        let path = selection["file"].as_str().expect("suite file");
        let suite = read_json(&dir.join(path));
        assert_eq!(suite["id"], selection["id"]);
        for test in suite["tests"].as_array().expect("suite tests") {
            if selection["exclude_tests"]
                .as_array()
                .is_some_and(|ids| ids.contains(&test["id"]))
            {
                continue;
            }
            let id = test["id"].as_str().expect("test id");
            let source = test["input"]["source"].as_str().expect("test source");
            let mode = match test["input"]["mode"].as_str().unwrap_or("transport") {
                "transport" => BehaviorMode::Transport,
                "strict" => BehaviorMode::Strict,
                "custom" => BehaviorMode::Custom,
                other => panic!("{id}: unknown mode {other}"),
            };
            let datatype_policy = if mode == BehaviorMode::Strict {
                DatatypePolicy::ReservedOnly
            } else {
                DatatypePolicy::AllowCustom
            };
            let actual = policy.compile(
                source,
                CompileOptions {
                    mode: Some(mode),
                    datatype_policy: Some(datatype_policy),
                    ..CompileOptions::default()
                },
            );
            let expected = &test["expected"];
            assert_eq!(
                actual.errors.is_empty(),
                expected["ok"].as_bool().expect("ok expectation"),
                "{id}"
            );
            assert_eq!(diagnostics(&actual.errors), expected["errors"], "{id}");
            assert_eq!(diagnostics(&actual.warnings), expected["warnings"], "{id}");
            if let Some(bindings) = expected["result"].get("bindings") {
                let projection = Value::Array(actual.bindings.iter().map(|binding| json!({
                    "path": binding.path, "datatype": binding.datatype, "kind": binding.kind,
                })).collect());
                assert_eq!(&projection, bindings, "{id}");
            }
            passed += 1;
        }
    }
    assert!(passed > 0, "draft GP manifest selected no tests");
    println!(
        "Rust (official {GP} {}) draft GP CTS: {passed} passed",
        policy.version
    );
}
