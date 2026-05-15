use aeon_annotations::{AnnotationRecord, AnnotationTarget, extract_annotations, sort_annotations};
use aeon_canonical::canonicalize;
use aeon_core::{
    AssignmentEvent, AttributeValue, CompileOptions, DatatypePolicy, Diagnostic, HeaderFields,
    NullLiteralMode, ReferenceSegment, Span, Value, compile, format_path, normalize_number_literal,
};
use aeon_finalize::{FinalizeMode, FinalizeOptions, FinalizeScope, Materialization, finalize_json};
use serde::Deserialize;
use serde_json::{Value as JsonValue, json};
use wasm_bindgen::prelude::*;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProcessOptions {
    #[serde(default = "default_validation_mode")]
    validation_mode: String,
    #[serde(default = "default_depth")]
    max_separator_depth: usize,
    #[serde(default = "default_depth")]
    max_attribute_depth: usize,
    #[serde(default = "default_depth")]
    max_generic_depth: usize,
    #[serde(default)]
    materialization_mode: String,
    #[serde(default = "default_finalize_scope")]
    finalize_scope: String,
    #[serde(default)]
    include_paths: Vec<String>,
}

fn default_validation_mode() -> String {
    String::from("strict")
}

fn default_finalize_scope() -> String {
    String::from("payload")
}

const fn default_depth() -> usize {
    1
}

#[wasm_bindgen]
pub fn process_aeon(source: &str, options_json: &str) -> Result<String, JsValue> {
    process_aeon_json(source, options_json).map_err(|error| JsValue::from_str(&error))
}

pub fn process_aeon_json(source: &str, options_json: &str) -> Result<String, String> {
    let options: ProcessOptions = if options_json.trim().is_empty() {
        ProcessOptions {
            validation_mode: default_validation_mode(),
            max_separator_depth: default_depth(),
            max_attribute_depth: default_depth(),
            max_generic_depth: default_depth(),
            materialization_mode: String::from("all"),
            finalize_scope: default_finalize_scope(),
            include_paths: Vec::new(),
        }
    } else {
        serde_json::from_str(options_json)
            .map_err(|error| format!("invalid options JSON: {error}"))?
    };

    let result = process(source, &options);
    serde_json::to_string(&result).map_err(|error| format!("failed to serialize response: {error}"))
}

fn process(source: &str, options: &ProcessOptions) -> JsonValue {
    let canonical = canonicalize(source);
    let annotations = annotations_json(source);

    if !canonical.errors.is_empty() {
        return json!({
            "canonical": "",
            "finalized": null,
            "annotations": annotations,
            "events": [],
            "warnings": [],
            "errors": diagnostics_json(&canonical.errors),
        });
    }

    if options.validation_mode == "none" {
        return json!({
            "canonical": canonical.text,
            "finalized": null,
            "annotations": annotations,
            "events": [],
            "warnings": [],
            "errors": [],
        });
    }

    let compile_result = compile(
        &apply_validation_mode(source, &options.validation_mode),
        compile_options(options),
    );

    let events = events_json(
        &compile_result.events,
        compile_result.header.as_ref(),
        &options.finalize_scope,
    );

    if !compile_result.errors.is_empty() {
        return json!({
            "canonical": canonical.text,
            "finalized": null,
            "annotations": annotations,
            "events": events,
            "warnings": [],
            "errors": diagnostics_json(&compile_result.errors),
        });
    }

    let finalized = finalize_json(
        &compile_result.events,
        finalize_options(options, compile_result.header),
    );

    json!({
        "canonical": canonical.text,
        "finalized": finalized.document,
        "annotations": annotations,
        "events": events,
        "warnings": diagnostics_json(&finalized.meta.warnings),
        "errors": diagnostics_json(&finalized.meta.errors),
    })
}

fn compile_options(options: &ProcessOptions) -> CompileOptions {
    CompileOptions {
        recovery: true,
        max_separator_depth: options.max_separator_depth,
        max_attribute_depth: options.max_attribute_depth,
        max_generic_depth: options.max_generic_depth,
        datatype_policy: match options.validation_mode.as_str() {
            "strict" => Some(DatatypePolicy::ReservedOnly),
            "custom" => Some(DatatypePolicy::AllowCustom),
            _ => None,
        },
        ..CompileOptions::default()
    }
}

fn finalize_options(options: &ProcessOptions, header: Option<HeaderFields>) -> FinalizeOptions {
    FinalizeOptions {
        mode: if options.validation_mode == "loose" {
            FinalizeMode::Loose
        } else {
            FinalizeMode::Strict
        },
        materialization: if options.materialization_mode == "projected" {
            Materialization::Projected
        } else {
            Materialization::All
        },
        include_paths: options.include_paths.clone(),
        scope: match options.finalize_scope.as_str() {
            "full" => FinalizeScope::Full,
            "header" => FinalizeScope::Header,
            _ => FinalizeScope::Payload,
        },
        header,
        ..FinalizeOptions::default()
    }
}

fn apply_validation_mode(source: &str, mode: &str) -> String {
    if mode == "none" {
        return source.to_owned();
    }

    let compile_mode = if mode == "loose" { "transport" } else { mode };
    let lines: Vec<&str> = source.lines().collect();
    let Some(header_start) = lines
        .iter()
        .position(|line| line.trim_start().starts_with("aeon:header") && line.contains('{'))
    else {
        return format!("aeon:mode = \"{compile_mode}\"\n{source}");
    };

    let mut output = Vec::with_capacity(lines.len() + 1);
    let mut in_header = false;
    let mut mode_written = false;

    for (index, line) in lines.iter().enumerate() {
        if index == header_start {
            in_header = true;
        }

        if in_header && line.trim_start().starts_with("mode") && line.contains('=') {
            let indent = line
                .chars()
                .take_while(|ch| ch.is_whitespace())
                .collect::<String>();
            let datatype = line
                .split_once('=')
                .and_then(|(left, _)| left.split_once(':').map(|(_, datatype)| datatype.trim()))
                .map_or(String::new(), |datatype| format!(":{datatype}"));
            output.push(format!("{indent}mode{datatype} = \"{compile_mode}\""));
            mode_written = true;
        } else if in_header && line.trim() == "}" && !mode_written {
            output.push(format!("  mode = \"{compile_mode}\""));
            output.push((*line).to_owned());
            mode_written = true;
            in_header = false;
            continue;
        } else {
            output.push((*line).to_owned());
        }

        if in_header && line.trim() == "}" {
            in_header = false;
        }
    }

    output.join("\n")
}

fn diagnostics_json(diagnostics: &[Diagnostic]) -> Vec<JsonValue> {
    diagnostics
        .iter()
        .map(|diagnostic| {
            json!({
                "code": diagnostic.code,
                "path": diagnostic.path,
                "span": diagnostic.span.as_ref().map(span_json),
                "phase": diagnostic.phase,
                "message": diagnostic.message,
            })
        })
        .collect()
}

fn span_json(span: &Span) -> JsonValue {
    json!({
        "start": {
            "line": span.start.line,
            "column": span.start.column,
            "offset": span.start.offset,
        },
        "end": {
            "line": span.end.line,
            "column": span.end.column,
            "offset": span.end.offset,
        },
    })
}

fn annotations_json(source: &str) -> Vec<JsonValue> {
    sort_annotations(extract_annotations(source))
        .iter()
        .map(annotation_json)
        .collect()
}

fn annotation_json(record: &AnnotationRecord) -> JsonValue {
    json!({
        "kind": record.kind,
        "form": record.form,
        "subtype": record.subtype,
        "raw": record.raw,
        "span": span_json(&record.span),
        "target": match &record.target {
            AnnotationTarget::Path { path } => json!({ "kind": "path", "path": path }),
            AnnotationTarget::Unbound { reason } => json!({ "kind": "unbound", "reason": reason }),
        },
    })
}

fn events_json(
    events: &[AssignmentEvent],
    header: Option<&HeaderFields>,
    scope: &str,
) -> Vec<JsonValue> {
    let mut output = Vec::new();

    if matches!(scope, "header" | "full")
        && let Some(header) = header
    {
        for (key, value) in &header.fields {
            output.push(json!({
                "path": format!("$.[\"aeon:{key}\"]"),
                "key": format!("aeon:{key}"),
                "datatype": null,
                "valueType": value_type_name(value),
            }));
        }
    }

    if scope != "header" {
        output.extend(events.iter().map(|event| {
            json!({
                "path": format_path(&event.path),
                "key": event.key,
                "datatype": event.datatype.as_deref().map(canonical_datatype),
                "valueType": value_type_name(&event.value),
            })
        }));
    }

    output
}

fn value_type_name(value: &Value) -> &'static str {
    match value {
        Value::TypedValue { value, .. } => value_type_name(value),
        _ => value.value_kind(),
    }
}

#[allow(dead_code)]
fn value_json(value: &Value) -> JsonValue {
    match value {
        Value::TypedValue {
            datatype,
            attributes,
            value,
            ..
        } => json!({
            "type": "TypedValue",
            "datatype": datatype,
            "attributes": attributes_json(attributes),
            "value": value_json(value),
        }),
        Value::NumberLiteral { raw } => {
            json!({ "type": "NumberLiteral", "raw": raw, "value": normalize_number_literal(raw) })
        }
        Value::InfinityLiteral { raw, .. } => json!({ "type": "InfinityLiteral", "raw": raw }),
        Value::NaNLiteral { raw, .. } => json!({ "type": "NaNLiteral", "raw": raw }),
        Value::NullLiteral { mode, value, raw } => json!({
            "type": "NullLiteral",
            "mode": match mode {
                NullLiteralMode::Reserved => "reserved",
                NullLiteralMode::Reason => "reason",
            },
            "value": value,
            "raw": raw,
        }),
        Value::StringLiteral { value, raw, .. } => {
            json!({ "type": "StringLiteral", "value": value, "raw": raw })
        }
        Value::SwitchLiteral { raw } => json!({ "type": "SwitchLiteral", "raw": raw }),
        Value::BooleanLiteral { raw } => json!({ "type": "BooleanLiteral", "raw": raw }),
        Value::HexLiteral { raw } => json!({ "type": "HexLiteral", "raw": raw }),
        Value::SeparatorLiteral { raw } => json!({ "type": "SeparatorLiteral", "raw": raw }),
        Value::EncodingLiteral { raw } => json!({ "type": "EncodingLiteral", "raw": raw }),
        Value::RadixLiteral { raw } => json!({ "type": "RadixLiteral", "raw": raw }),
        Value::DateLiteral { raw } => json!({ "type": "DateLiteral", "raw": raw }),
        Value::DateTimeLiteral { raw } => json!({ "type": "DateTimeLiteral", "raw": raw }),
        Value::TimeLiteral { raw } => json!({ "type": "TimeLiteral", "raw": raw }),
        Value::NodeLiteral {
            raw,
            tag,
            datatype,
            children,
            ..
        } => json!({
            "type": "NodeLiteral",
            "raw": raw,
            "tag": tag,
            "datatype": datatype,
            "children": children.iter().map(value_json).collect::<Vec<_>>(),
        }),
        Value::ListNode { items } => {
            json!({ "type": "ListNode", "items": items.iter().map(value_json).collect::<Vec<_>>() })
        }
        Value::TupleLiteral { items } => {
            json!({ "type": "TupleLiteral", "items": items.iter().map(value_json).collect::<Vec<_>>() })
        }
        Value::ObjectNode { bindings } => json!({
            "type": "ObjectNode",
            "bindings": bindings.iter().map(binding_json).collect::<Vec<_>>(),
        }),
        Value::CloneReference { segments, .. } => {
            json!({ "type": "CloneReference", "segments": reference_segments_json(segments) })
        }
        Value::PointerReference { segments, .. } => {
            json!({ "type": "PointerReference", "segments": reference_segments_json(segments) })
        }
    }
}

fn canonical_datatype(name: &str) -> String {
    if datatype_base(name) == "switch" {
        name.replacen("switch", "toggle", 1)
    } else {
        name.to_owned()
    }
}

fn datatype_base(datatype: &str) -> &str {
    datatype
        .find(['<', '['])
        .map(|idx| &datatype[..idx])
        .unwrap_or(datatype)
}

#[allow(dead_code)]
fn binding_json(binding: &aeon_core::Binding) -> JsonValue {
    json!({
        "key": binding.key,
        "datatype": binding.datatype,
        "attributes": attributes_json(&binding.attributes),
        "value": value_json(&binding.value),
        "span": span_json(&binding.span),
    })
}

#[allow(dead_code)]
fn attributes_json(attributes: &std::collections::BTreeMap<String, AttributeValue>) -> JsonValue {
    JsonValue::Object(
        attributes
            .iter()
            .map(|(key, value)| (key.clone(), attribute_json(value)))
            .collect(),
    )
}

#[allow(dead_code)]
fn attribute_json(attribute: &AttributeValue) -> JsonValue {
    json!({
        "datatype": attribute.datatype,
        "value": attribute.value.as_ref().map(value_json),
        "nestedAttrs": attributes_json(&attribute.nested_attrs),
        "objectMembers": attributes_json(&attribute.object_members),
    })
}

#[allow(dead_code)]
fn reference_segments_json(segments: &[ReferenceSegment]) -> Vec<JsonValue> {
    segments
        .iter()
        .map(|segment| match segment {
            ReferenceSegment::Key(key) => json!({ "type": "key", "key": key }),
            ReferenceSegment::Index(index) => json!({ "type": "index", "index": index }),
            ReferenceSegment::Attr(key) => json!({ "type": "attr", "key": key }),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::process_aeon_json;
    use serde_json::Value as JsonValue;

    #[test]
    fn processes_basic_document() {
        let output = process_aeon_json(
            "a:string = \"ok\"\n",
            r#"{"validationMode":"strict","maxSeparatorDepth":8,"finalizeScope":"payload"}"#,
        )
        .expect("process aeon");
        let parsed: JsonValue = serde_json::from_str(&output).expect("valid json");

        assert_eq!(parsed["errors"].as_array().expect("errors").len(), 0);
        assert_eq!(parsed["finalized"]["a"], "ok");
        assert_eq!(parsed["events"][0]["path"], "$.a");
    }

    #[test]
    fn events_canonicalize_legacy_switch_datatype_to_toggle() {
        let output = process_aeon_json(
            "state:switch = on\n",
            r#"{"validationMode":"strict","maxSeparatorDepth":8,"finalizeScope":"payload"}"#,
        )
        .expect("process aeon");
        let parsed: JsonValue = serde_json::from_str(&output).expect("valid json");

        assert_eq!(parsed["errors"].as_array().expect("errors").len(), 0);
        assert_eq!(parsed["events"][0]["datatype"], "toggle");
        assert_eq!(parsed["events"][0]["valueType"], "SwitchLiteral");
    }
}
