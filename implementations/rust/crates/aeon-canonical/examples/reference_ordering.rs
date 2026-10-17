//! Test adapter for default and explicitly selected canonical source APIs.
use std::io::{self, Read};

use aeon_canonical::{CanonicalOrdering, CanonicalizeOptions, canonicalize_with_options};
use serde_json::json;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut input = String::new();
    io::stdin().read_to_string(&mut input)?;
    let request: serde_json::Value = serde_json::from_str(&input)?;
    let source = request["source"].as_str().ok_or("Missing source")?;
    let result = canonicalize_with_options(
        source,
        &CanonicalizeOptions {
            ordering: match request["ordering"].as_str() {
                None => CanonicalOrdering::default(),
                Some("reference-safe-v1") => CanonicalOrdering::ReferenceSafeV1,
                Some("lexical-v1") => CanonicalOrdering::LexicalV1,
                _ => return Err("unknown ordering".into()),
            },
            limits: aeon_core::AeonCompileLimits {
                max_attribute_depth: request["max_attribute_depth"]
                    .as_u64()
                    .map(usize::try_from)
                    .transpose()?
                    .unwrap_or(1),
                ..aeon_core::AeonCompileLimits::default()
            },
            ..CanonicalizeOptions::default()
        },
    );
    // Match the TS public error shape: reference source/target diagnostics
    // have no `path` field; CTS normalizes those to the document root.
    let errors: Vec<_> = result.errors.iter().map(|error| json!({
        "code": error.code, "message": error.message,
        "path": if matches!(error.code.as_str(), "FORWARD_REFERENCE" | "MISSING_REFERENCE_TARGET" | "SELF_REFERENCE" | "ATTRIBUTE_DEPTH_EXCEEDED") { None } else { error.path.as_deref() },
        "phase": error.phase,
        "span": error.span.map(|span| json!({"start": {"offset": span.start.offset}, "end": {"offset": span.end.offset}})),
    })).collect();
    println!("{}", json!({"text": result.text, "errors": errors}));
    Ok(())
}
