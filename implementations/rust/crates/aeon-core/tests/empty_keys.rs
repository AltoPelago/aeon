use aeon_core::{CompileOptions, CompileResult, compile, format_path};

#[test]
fn empty_keys_shared_vectors() {
    let cases: serde_json::Value =
        serde_json::from_str(include_str!("../../../../../test-fixtures/empty-keys.json"))
            .expect("fixtures");
    let compilers: &[fn(&str, CompileOptions) -> CompileResult] = &[
        compile,
        #[cfg(feature = "sofia")]
        aeon_core::compile_sofia,
    ];
    for case in cases.as_array().expect("array") {
        for compiler in compilers {
            let source = case["source"].as_str().expect("source");
            let result = compiler(source, CompileOptions::default());
            if let Some(code) = case["error"].as_str() {
                assert!(
                    result.errors.iter().any(|error| error.code == code),
                    "{}: {:?}",
                    case["id"],
                    result.errors
                );
            } else {
                assert!(
                    result.errors.is_empty(),
                    "{}: {:?}",
                    case["id"],
                    result.errors
                );
                let paths: Vec<_> = result
                    .events
                    .iter()
                    .map(|event| format_path(&event.path))
                    .collect();
                let expected: Vec<_> = case["paths"]
                    .as_array()
                    .expect("paths")
                    .iter()
                    .map(|path| path.as_str().expect("path"))
                    .collect();
                assert_eq!(paths, expected, "{}", case["id"]);
                let portable = aeon_core::compile_to_telex(source, Default::default());
                assert!(portable.compile.errors.is_empty(), "{}", case["id"]);
                assert!(portable.telex.is_some(), "{}: {:?}", case["id"], portable);
            }
        }
    }
}
