//! Batch adapter for the Rust half of the 52-Cards paired pilot.

use std::io;

use aeon_canonical::{CanonicalResult, canonicalize};
use aeon_core::{
    CompileOptions, Diagnostic, PortableAesCompatibilityEvent, PortableAesCompatibilityOptions,
    adapt_rust_assignment_events_to_portable_aes, compile,
};
use aes_telex::{ClarifierKind, DatatypeClarifier, GenericArgument};
use serde_json::{Map, Value, json};

fn datatype_fields(
    datatype: &str,
    generics: &[GenericArgument],
    clarifiers: &[DatatypeClarifier],
) -> Map<String, Value> {
    let generics: Vec<_> = generics
        .iter()
        .map(|argument| match argument {
            GenericArgument::Datatype(descriptor) => Value::Object(datatype_fields(
                &descriptor.datatype,
                &descriptor.generics,
                &descriptor.clarifiers,
            )),
            GenericArgument::NumberLiteral(value) => {
                json!({"kind": "NumberLiteral", "value": value})
            }
        })
        .collect();
    let clarifiers: Vec<_> = clarifiers
        .iter()
        .map(|clarifier| {
            let kind = match clarifier.kind {
                ClarifierKind::StringLiteral => "StringLiteral",
                ClarifierKind::NumberLiteral => "NumberLiteral",
            };
            json!({"kind": kind, "value": clarifier.value})
        })
        .collect();
    Map::from_iter([
        ("datatype".into(), json!(datatype)),
        ("generics".into(), json!(generics)),
        ("clarifiers".into(), json!(clarifiers)),
    ])
}

fn portable_record(event: &PortableAesCompatibilityEvent) -> Value {
    let mut record = Map::new();
    record.insert("kind".into(), json!(event.kind));
    for (name, value) in [
        ("path", &event.path),
        ("header", &event.header),
        ("identity", &event.identity),
        ("value", &event.value),
    ] {
        if let Some(value) = value {
            record.insert(name.into(), json!(value));
        }
    }
    if let Some(datatype) = &event.datatype {
        record.extend(datatype_fields(
            datatype,
            &event.generics,
            &event.clarifiers,
        ));
    }
    Value::Object(record)
}

fn diagnostics(errors: &[Diagnostic]) -> Vec<Value> {
    errors
        .iter()
        .map(|error| json!({"code": error.code, "message": error.message, "path": error.path}))
        .collect()
}

fn compile_graph(source: &str) -> Value {
    let result = compile(source, CompileOptions::default());
    if !result.errors.is_empty() {
        return json!({"errors": diagnostics(&result.errors)});
    }
    let options = PortableAesCompatibilityOptions {
        include_headers: true,
        header: result.header,
        source_bytes: None,
    };
    match adapt_rust_assignment_events_to_portable_aes(&result.events, &options) {
        Ok(projected) => {
            let records: Vec<_> = projected.events.iter().map(portable_record).collect();
            json!({"errors": [], "records": records})
        }
        Err(error) => json!({"errors": [{"code": error.code, "message": error.detail}]}),
    }
}

fn format_result(result: &CanonicalResult) -> Value {
    json!({"text": result.text, "errors": diagnostics(&result.errors)})
}

fn inspect(source: &str) -> Value {
    let canonical = canonicalize(source);
    let mut result =
        json!({"authored": compile_graph(source), "canonical": format_result(&canonical)});
    if canonical.errors.is_empty() {
        result["reparsed"] = compile_graph(&canonical.text);
        result["fixed"] = format_result(&canonicalize(&canonical.text));
    }
    result
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let pairs: Vec<[String; 2]> = serde_json::from_reader(io::stdin().lock())?;
    let pairs: Vec<_> = pairs
        .iter()
        .map(|pair| pair.each_ref().map(|source| inspect(source)))
        .collect();
    serde_json::to_writer(
        io::stdout().lock(),
        &json!({"version": env!("CARGO_PKG_VERSION"), "pairs": pairs}),
    )?;
    Ok(())
}
