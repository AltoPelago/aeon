use std::collections::BTreeSet;

use aeon_annotations::{AnnotationRecord, AnnotationTarget, extract_annotations, sort_annotations};
use aeon_canonical::canonicalize;
use aeon_core::{
    AssignmentEvent, AttributeValue, BehaviorMode, CompileOptions, DatatypePolicy, Diagnostic,
    HeaderFields, NullLiteralMode, ReferenceSegment, Span, Value, compile, format_path,
    normalize_number_literal,
};
use aeon_finalize::{
    FinalizeMode, FinalizeOptions, FinalizePortableJsonOptions, FinalizeScope, Materialization,
    finalize_json, finalize_portable_json,
};
use aes_telex::{
    Diagnostic as TelexDiagnostic, TelexLimits, TelexSyntaxError, canonicalize_telex_with_limits,
    check_prefix_completeness, parse_telex_with_limits, validate_telex_with_limits,
};
use serde::Deserialize;
use serde_json::{Value as JsonValue, json};
use wasm_bindgen::prelude::*;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProcessOptions {
    #[serde(default = "default_validation_mode")]
    validation_mode: String,
    #[serde(default = "default_max_input_bytes")]
    max_input_bytes: usize,
    #[serde(default = "default_depth")]
    max_separator_depth: usize,
    #[serde(default)]
    max_clarifier_values: Option<usize>,
    #[serde(default = "default_depth")]
    max_attribute_depth: usize,
    #[serde(default = "default_depth")]
    max_generic_depth: usize,
    #[serde(default = "default_max_generic_arguments")]
    max_generic_arguments: usize,
    #[serde(default = "default_max_datatype_components")]
    max_datatype_components: usize,
    #[serde(default)]
    materialization_mode: String,
    #[serde(default = "default_finalize_scope")]
    finalize_scope: String,
    #[serde(default)]
    include_paths: Vec<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct TelexOptions {
    registered_fields: Vec<String>,
    max_input_bytes: Option<usize>,
    max_line_bytes: Option<usize>,
    max_fields_per_event: Option<usize>,
    max_events: Option<usize>,
    max_decoded_payload_bytes: Option<usize>,
    max_path_depth: Option<usize>,
    max_path_characters: Option<usize>,
    max_generic_depth: Option<usize>,
    max_generic_arguments: Option<usize>,
    max_clarifier_values: Option<usize>,
    max_datatype_components: Option<usize>,
    finalize_mode: Option<String>,
    finalize_scope: Option<String>,
    max_materialized_weight: Option<usize>,
    max_reference_depth: Option<usize>,
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

const fn default_max_generic_arguments() -> usize {
    32
}

const fn default_max_datatype_components() -> usize {
    64
}

const fn default_max_input_bytes() -> usize {
    1 << 20
}

#[wasm_bindgen]
pub fn process_aeon(source: &str, options_json: &str) -> Result<String, JsValue> {
    process_aeon_json(source, options_json).map_err(|error| JsValue::from_str(&error))
}

pub fn process_aeon_json(source: &str, options_json: &str) -> Result<String, String> {
    let options: ProcessOptions = if options_json.trim().is_empty() {
        ProcessOptions {
            validation_mode: default_validation_mode(),
            max_input_bytes: default_max_input_bytes(),
            max_separator_depth: default_depth(),
            max_clarifier_values: None,
            max_attribute_depth: default_depth(),
            max_generic_depth: default_depth(),
            max_generic_arguments: default_max_generic_arguments(),
            max_datatype_components: default_max_datatype_components(),
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

#[wasm_bindgen(js_name = validate_telex)]
pub fn validate_telex_wasm(source: &str, options_json: &str) -> Result<String, JsValue> {
    validate_telex_json(source, options_json).map_err(|error| JsValue::from_str(&error))
}

#[wasm_bindgen(js_name = canonicalize_telex)]
pub fn canonicalize_telex_wasm(source: &str, options_json: &str) -> Result<String, JsValue> {
    canonicalize_telex_text(source, options_json).map_err(|error| JsValue::from_str(&error))
}

#[wasm_bindgen(js_name = check_telex_completeness)]
pub fn check_telex_completeness_wasm(source: &str, options_json: &str) -> Result<String, JsValue> {
    check_telex_completeness_json(source, options_json).map_err(|error| JsValue::from_str(&error))
}

#[wasm_bindgen(js_name = materialize_telex)]
pub fn materialize_telex_wasm(source: &str, options_json: &str) -> Result<String, JsValue> {
    materialize_telex_json(source, options_json).map_err(|error| JsValue::from_str(&error))
}

pub fn validate_telex_json(source: &str, options_json: &str) -> Result<String, String> {
    let options = parse_telex_options(options_json)?;
    let limits = telex_limits(&options);
    let registered = options
        .registered_fields
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>();
    let result = validate_telex_with_limits(source, &registered, &limits)
        .map_err(|error| telex_syntax_error_json(&error))?;
    serde_json::to_string(&json!({
        "valid": result.valid,
        "profile": result.profile,
        "diagnostics": result
            .diagnostics
            .iter()
            .map(telex_diagnostic_json)
            .collect::<Vec<_>>(),
    }))
    .map_err(|error| format!("failed to serialize Telex validation result: {error}"))
}

pub fn canonicalize_telex_text(source: &str, options_json: &str) -> Result<String, String> {
    let options = parse_telex_options(options_json)?;
    canonicalize_telex_with_limits(source, &telex_limits(&options))
        .map_err(|error| telex_syntax_error_json(&error))
}

pub fn check_telex_completeness_json(source: &str, options_json: &str) -> Result<String, String> {
    let options = parse_telex_options(options_json)?;
    let parsed = parse_telex_with_limits(source, &telex_limits(&options))
        .map_err(|error| telex_syntax_error_json(&error))?;
    let result = check_prefix_completeness(&parsed.records, parsed.projection.as_deref()).map_err(
        |error| {
            json!({
                "code": "TELEX_COMPLETENESS_ERROR",
                "line": null,
                "message": error.detail,
            })
            .to_string()
        },
    )?;
    let missing = result
        .missing
        .iter()
        .map(|entry| {
            let mut value = json!({
                "path": entry.path,
                "requiredBy": entry.required_by,
            });
            if let (Some(field), Some(object)) = (entry.field, value.as_object_mut()) {
                object.insert("field".to_owned(), json!(field));
            }
            value
        })
        .collect::<Vec<_>>();
    serde_json::to_string(&json!({
        "complete": result.complete,
        "missing": missing,
    }))
    .map_err(|error| format!("failed to serialize Telex completeness result: {error}"))
}

pub fn materialize_telex_json(source: &str, options_json: &str) -> Result<String, String> {
    let options = parse_telex_options(options_json)?;
    let limits = telex_limits(&options);
    let parsed = parse_telex_with_limits(source, &limits)
        .map_err(|error| telex_syntax_error_json(&error))?;
    let result = finalize_portable_json(
        &parsed.records,
        FinalizePortableJsonOptions {
            mode: if options.finalize_mode.as_deref() == Some("loose") {
                FinalizeMode::Loose
            } else {
                FinalizeMode::Strict
            },
            scope: match options.finalize_scope.as_deref() {
                Some("header") => FinalizeScope::Header,
                Some("full") => FinalizeScope::Full,
                _ => FinalizeScope::Payload,
            },
            profile: parsed.profile,
            projection: parsed.projection,
            registered_fields: options.registered_fields,
            limits,
            max_materialized_weight: options.max_materialized_weight,
            max_reference_depth: options.max_reference_depth,
        },
    );
    serde_json::to_string(&json!({
        "document": result.document,
        "meta": {
            "errors": diagnostics_json(&result.meta.errors),
            "warnings": diagnostics_json(&result.meta.warnings),
        }
    }))
    .map_err(|error| format!("failed to serialize Telex materialization result: {error}"))
}

fn parse_telex_options(options_json: &str) -> Result<TelexOptions, String> {
    if options_json.trim().is_empty() {
        return Ok(TelexOptions::default());
    }
    serde_json::from_str(options_json)
        .map_err(|error| format!("invalid Telex options JSON: {error}"))
}

fn telex_limits(options: &TelexOptions) -> TelexLimits {
    let mut limits = TelexLimits::default();
    limits.max_input_bytes = options.max_input_bytes.unwrap_or(limits.max_input_bytes);
    limits.max_line_bytes = options.max_line_bytes.unwrap_or(limits.max_line_bytes);
    limits.max_fields_per_event = options
        .max_fields_per_event
        .unwrap_or(limits.max_fields_per_event);
    limits.max_events = options.max_events.unwrap_or(limits.max_events);
    limits.max_decoded_payload_bytes = options
        .max_decoded_payload_bytes
        .unwrap_or(limits.max_decoded_payload_bytes);
    limits.max_path_depth = options.max_path_depth.unwrap_or(limits.max_path_depth);
    limits.max_path_characters = options
        .max_path_characters
        .unwrap_or(limits.max_path_characters);
    limits.max_generic_depth = options
        .max_generic_depth
        .unwrap_or(limits.max_generic_depth);
    limits.max_generic_arguments = options
        .max_generic_arguments
        .unwrap_or(limits.max_generic_arguments);
    limits.max_clarifier_values = options
        .max_clarifier_values
        .unwrap_or(limits.max_clarifier_values);
    limits.max_datatype_components = options
        .max_datatype_components
        .unwrap_or(limits.max_datatype_components);
    limits
}

fn telex_syntax_error_json(error: &TelexSyntaxError) -> String {
    json!({
        "code": error.code,
        "line": error.line,
        "message": error.to_string(),
        "counter": error.counter,
        "observed": error.observed,
        "limit": error.limit,
    })
    .to_string()
}

fn telex_diagnostic_json(diagnostic: &TelexDiagnostic) -> JsonValue {
    json!({
        "code": diagnostic.code,
        "message": diagnostic.message,
        "record": diagnostic.record,
        "path": diagnostic.path,
        "field": diagnostic.field,
        "firstRecord": diagnostic.first_record,
        "requiredPath": diagnostic.required_path,
        "counter": diagnostic.counter,
        "observed": diagnostic.observed,
        "limit": diagnostic.limit,
    })
}

fn process(source: &str, options: &ProcessOptions) -> JsonValue {
    if source.len() > options.max_input_bytes {
        return json!({
            "canonical": "",
            "finalized": null,
            "annotations": [],
            "events": [],
            "warnings": [],
            "errors": [{
                "code": "INPUT_SIZE_EXCEEDED",
                "path": "$",
                "span": {
                    "start": { "line": 1, "column": 1, "offset": 0 },
                    "end": { "line": 1, "column": 1, "offset": 0 },
                },
                "phase": 0,
                "message": format!(
                    "Input size {} bytes exceeds configured limit of {} bytes",
                    source.len(),
                    options.max_input_bytes
                ),
            }],
        });
    }

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

    let compile_result = compile(source, compile_options(options));

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
            "warnings": diagnostics_json(&compile_result.warnings),
            "errors": diagnostics_json(&compile_result.errors),
        });
    }

    let finalized = finalize_json(
        &compile_result.events,
        finalize_options(options, compile_result.header),
    );
    let warnings = compile_result
        .warnings
        .iter()
        .chain(finalized.meta.warnings.iter())
        .cloned()
        .collect::<Vec<_>>();

    json!({
        "canonical": canonical.text,
        "finalized": finalized.document,
        "annotations": annotations,
        "events": events,
        "warnings": diagnostics_json(&warnings),
        "errors": diagnostics_json(&finalized.meta.errors),
    })
}

fn compile_options(options: &ProcessOptions) -> CompileOptions {
    CompileOptions {
        recovery: true,
        max_input_bytes: Some(options.max_input_bytes),
        max_separator_depth: options.max_separator_depth,
        max_clarifier_values: options.max_clarifier_values,
        max_attribute_depth: options.max_attribute_depth,
        max_generic_depth: options.max_generic_depth,
        max_generic_arguments: options.max_generic_arguments,
        max_datatype_components: options.max_datatype_components,
        datatype_policy: match options.validation_mode.as_str() {
            "strict" => Some(DatatypePolicy::ReservedOnly),
            "custom" => Some(DatatypePolicy::AllowCustom),
            _ => None,
        },
        mode: effective_mode(options),
        ..CompileOptions::default()
    }
}

fn effective_mode(options: &ProcessOptions) -> Option<BehaviorMode> {
    match options.validation_mode.as_str() {
        "none" => None,
        "loose" | "transport" => Some(BehaviorMode::Transport),
        "strict" => Some(BehaviorMode::Strict),
        "custom" => Some(BehaviorMode::Custom),
        _ => None,
    }
}

fn finalize_options(options: &ProcessOptions, header: Option<HeaderFields>) -> FinalizeOptions {
    FinalizeOptions {
        mode: if matches!(options.validation_mode.as_str(), "loose" | "transport") {
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
    let mut payload = json!({
        "kind": record.kind,
        "form": record.form,
        "subtype": record.subtype,
        "raw": record.raw,
        "span": span_json(&record.span),
        "target": match &record.target {
            AnnotationTarget::Path { path } => json!({ "kind": "path", "path": path }),
            AnnotationTarget::Unbound { reason } => json!({ "kind": "unbound", "reason": reason }),
        },
    });
    if let Some(placement) = &record.placement {
        let mut placement_json = json!({});
        if let Some(after) = placement.after {
            placement_json["after"] = json!(after.as_str());
        }
        if let Some(before) = placement.before {
            placement_json["before"] = json!(before.as_str());
        }
        payload["placement"] = placement_json;
    }
    payload
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
        let mut seen = BTreeSet::new();
        for key in header.order.iter().chain(header.fields.keys()) {
            if !seen.insert(key.as_str()) {
                continue;
            }
            let Some(value) = header.fields.get(key) else {
                continue;
            };
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
            let mut event_json = json!({
                "path": format_path(&event.path),
                "key": event.key,
                "datatype": event.datatype,
                "valueType": value_type_name(&event.value),
            });
            if let Some(structural_id) = &event.structural_id {
                event_json["structuralId"] = json!(structural_id);
            }
            event_json
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
            structural_id,
            datatype,
            attributes,
            value,
            ..
        } => json!({
            "type": "TypedValue",
            "structuralId": structural_id,
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
        Value::ToggleLiteral { raw } => json!({ "type": "ToggleLiteral", "raw": raw }),
        Value::BooleanLiteral { raw } => json!({ "type": "BooleanLiteral", "raw": raw }),
        Value::HexLiteral { raw } => json!({ "type": "HexLiteral", "raw": raw }),
        Value::SeparatorLiteral { raw } => json!({ "type": "SeparatorLiteral", "raw": raw }),
        Value::EncodingLiteral { raw } => json!({ "type": "EncodingLiteral", "raw": raw }),
        Value::RadixLiteral { raw } => json!({ "type": "RadixLiteral", "raw": raw }),
        Value::SansaAddressLiteral { raw, canonical, .. } => json!({
            "type": "SansaAddressLiteral",
            "value": canonical,
            "raw": raw,
            "canonical": canonical,
            "address": {
                "type": "SansaAddress",
                "canonical": canonical,
            },
        }),
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
    use super::{
        canonicalize_telex_text, check_telex_completeness_json, materialize_telex_json,
        process_aeon_json, validate_telex_json,
    };
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
    fn binds_block_annotation_between_equals_and_value_to_current_field() {
        let output = process_aeon_json(
            "app:object = {\n  name:string = \"alignment playground\"\n  enabled:boolean = /# h #/ true\n  port:number = 8080\n}\n",
            r#"{"validationMode":"strict","maxSeparatorDepth":8,"finalizeScope":"payload"}"#,
        )
        .expect("process aeon");
        let parsed: JsonValue = serde_json::from_str(&output).expect("valid json");

        assert_eq!(parsed["errors"].as_array().expect("errors").len(), 0);
        assert_eq!(parsed["annotations"][0]["target"]["path"], "$.app.enabled");
        assert_eq!(parsed["annotations"][0]["placement"]["after"], "equals");
        assert_eq!(parsed["annotations"][0]["placement"]["before"], "value");
    }

    #[test]
    fn omits_null_placement_sides() {
        let output = process_aeon_json(
            "/# top #/\nname:string = \"alignment playground\"\n",
            r#"{"validationMode":"strict","maxSeparatorDepth":8,"finalizeScope":"payload"}"#,
        )
        .expect("process aeon");
        let parsed: JsonValue = serde_json::from_str(&output).expect("valid json");
        let placement = parsed["annotations"][0]["placement"]
            .as_object()
            .expect("placement object");

        assert!(!placement.contains_key("after"));
        assert_eq!(placement.get("before").expect("before"), "key");
    }

    #[test]
    fn validation_mode_detects_tokenized_structured_header() {
        let output = process_aeon_json(
            "aeon\n:\nheader /# #/=   /# #/{\n  mode:\nstring = \"strict\"\n}\n",
            r#"{"validationMode":"strict","maxSeparatorDepth":8,"finalizeScope":"full"}"#,
        )
        .expect("process aeon");
        let parsed: JsonValue = serde_json::from_str(&output).expect("valid json");

        assert_eq!(parsed["errors"], serde_json::json!([]));
        assert_eq!(parsed["finalized"]["header"]["mode"], "strict");
    }

    #[test]
    fn processes_flexible_structured_header_without_injecting_shorthand_mode() {
        let output = process_aeon_json(
            "aeon\n:\nheader /# #/= /# #/{\n  mode:\nstring = \"strict\"\n  encoding:string = \"utf-8\"\n}\n",
            r#"{"validationMode":"strict","maxSeparatorDepth":8,"finalizeScope":"full"}"#,
        )
        .expect("process aeon");
        let parsed: JsonValue = serde_json::from_str(&output).expect("valid json");

        assert_eq!(parsed["errors"].as_array().expect("errors").len(), 0);
        assert_eq!(parsed["finalized"]["header"]["mode"], "strict");
        assert_eq!(parsed["finalized"]["header"]["encoding"], "utf-8");
        assert_eq!(parsed["events"][0]["path"], "$.[\"aeon:mode\"]");
        assert_eq!(parsed["events"][1]["path"], "$.[\"aeon:encoding\"]");
    }

    #[test]
    fn validation_mode_overrides_declared_mode_without_rewriting_header() {
        let output = process_aeon_json(
            "aeon:mode = \"strict\"\nname = \"AEON\"\n",
            r#"{"validationMode":"loose","maxSeparatorDepth":8,"finalizeScope":"full"}"#,
        )
        .expect("process aeon");
        let parsed: JsonValue = serde_json::from_str(&output).expect("valid json");

        assert_eq!(parsed["errors"], serde_json::json!([]));
        assert_eq!(parsed["finalized"]["header"]["mode"], "strict");
        assert_eq!(parsed["finalized"]["payload"]["name"], "AEON");
    }

    #[test]
    fn fails_closed_when_max_input_bytes_is_exceeded() {
        let output = process_aeon_json(
            "value:string = \"too large\"\n",
            r#"{"validationMode":"strict","maxInputBytes":8}"#,
        )
        .expect("process aeon");
        let parsed: JsonValue = serde_json::from_str(&output).expect("valid json");

        assert_eq!(parsed["canonical"], "");
        assert_eq!(parsed["annotations"], serde_json::json!([]));
        assert_eq!(parsed["errors"][0]["code"], "INPUT_SIZE_EXCEEDED");
        assert_eq!(parsed["errors"][0]["phase"], 0);
    }

    #[test]
    fn validates_telex_inside_rust() {
        let output = validate_telex_json(
            "telex.aes=0\n\npath=$.answer\nkind=NumberLiteral\nvalue=42\n",
            "",
        )
        .expect("validate Telex");
        let parsed: JsonValue = serde_json::from_str(&output).expect("valid json");

        assert_eq!(parsed["valid"], true);
        assert_eq!(parsed["profile"], "aes.complete.v0");
        assert_eq!(parsed["diagnostics"], serde_json::json!([]));
    }

    #[test]
    fn canonicalizes_telex_inside_rust() {
        let output = canonicalize_telex_text(
            "telex.aes=0\r\n\r\nvalue=\\u{000041}\r\nkind=StringLiteral\r\npath=$.answer\r\n",
            "",
        )
        .expect("canonicalize Telex");

        assert_eq!(
            output,
            "telex.aes=0\n\npath=$.answer\nkind=StringLiteral\nvalue=A\n"
        );
    }

    #[test]
    fn checks_telex_completeness_inside_rust() {
        let output = check_telex_completeness_json(
            "telex.aes=0\nprofile=aes.partial.v0\n\npath=$.a.b\nkind=NumberLiteral\nvalue=1\n",
            "",
        )
        .expect("check Telex completeness");
        let parsed: JsonValue = serde_json::from_str(&output).expect("valid json");

        assert_eq!(parsed["complete"], false);
        assert_eq!(parsed["missing"][0]["path"], "$.a");
        assert_eq!(parsed["missing"][0]["requiredBy"], "$.a.b");
    }

    #[test]
    fn materializes_complete_telex_inside_rust() {
        let output = materialize_telex_json(
            "telex.aes=0\n\npath=$.answer\nkind=NumberLiteral\nvalue=42\n",
            "",
        )
        .expect("materialize Telex");
        let parsed: JsonValue = serde_json::from_str(&output).expect("valid json");
        assert_eq!(parsed["document"], serde_json::json!({"answer": 42}));
        assert_eq!(parsed["meta"]["errors"], serde_json::json!([]));
    }
}
