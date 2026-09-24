use std::collections::BTreeSet;
use std::hint::black_box;
use std::num::NonZeroUsize;

use aeon_annotations::{AnnotationRecord, AnnotationTarget, extract_annotations, sort_annotations};
use aeon_canonical::canonicalize;
use aeon_core::{
    AssignmentEvent, AttributeValue, BehaviorMode, CompileOptions, DatatypePolicy, Diagnostic,
    EffectiveTelexConfiguration, HeaderFields, NullLiteralMode, ReferenceSegment,
    SofiaStreamCompiler, SofiaStreamProgress, SofiaStreamState, SofiaStreamTerminal, Span, Value,
    compile_sofia, effective_telex_configuration, format_path, load_aeonic_limits,
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
use serde::{Deserialize, Serialize};
use serde_json::{Value as JsonValue, json};
use wasm_bindgen::prelude::*;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProcessOptions {
    #[serde(default = "default_validation_mode")]
    validation_mode: String,
    #[serde(default)]
    datatype_policy: Option<String>,
    #[serde(default = "default_max_input_bytes")]
    max_input_bytes: usize,
    #[serde(default)]
    max_events: Option<usize>,
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
    max_value_nesting_depth: Option<usize>,
    #[serde(default = "default_max_nesting_depth")]
    max_nesting_depth: usize,
    #[serde(default = "default_max_path_depth")]
    max_path_depth: usize,
    #[serde(default = "default_max_string_codepoints")]
    max_string_codepoints: usize,
    #[serde(default = "default_max_key_segment_codepoints")]
    max_key_segment_codepoints: usize,
    #[serde(default = "default_max_collection_items")]
    max_list_items: usize,
    #[serde(default = "default_max_collection_items")]
    max_tuple_items: usize,
    #[serde(default = "default_max_path_characters")]
    max_path_characters: usize,
    #[serde(default = "default_max_numeric_literal_characters")]
    max_numeric_literal_characters: usize,
    #[serde(default = "default_max_structured_comment_characters")]
    max_structured_comment_characters: usize,
    #[serde(default = "default_finalize")]
    finalize: bool,
    #[serde(default)]
    materialization_mode: String,
    #[serde(default = "default_finalize_scope")]
    finalize_scope: String,
    #[serde(default)]
    include_paths: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StreamOptions {
    #[serde(flatten)]
    process: ProcessOptions,
    #[serde(default = "default_stream_batch_events")]
    max_batch_events: usize,
    #[serde(default = "default_stream_pending_batches")]
    max_pending_batches: usize,
}

#[derive(Debug, Serialize)]
struct ProcessResponse {
    canonical: String,
    finalized: JsonValue,
    annotations: Vec<JsonValue>,
    events: Vec<ProcessEvent>,
    warnings: Vec<JsonValue>,
    errors: Vec<JsonValue>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProcessEvent {
    path: String,
    key: String,
    datatype: Option<String>,
    value_type: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    structural_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct StreamProgressResponse {
    state: &'static str,
    accepted: bool,
    pending_batches: usize,
    backpressured: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct StreamBatchResponse {
    sequence: usize,
    first_event_index: usize,
    events: Vec<ProcessEvent>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct StreamTerminalResponse {
    status: &'static str,
    reason: Option<&'static str>,
    event_count: Option<usize>,
    exposed_event_count: usize,
    warnings: Vec<JsonValue>,
    errors: Vec<JsonValue>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct StreamRetentionResponse {
    accepted_input_bytes: usize,
    accounted_shallow_bytes: usize,
    compact_output: bool,
    source_retained: bool,
    source_bytes: usize,
    source_capacity_bytes: usize,
    lexer_active_bytes: usize,
    parser_token_count: usize,
    parser_token_storage_bytes: usize,
    parser_frame_count: usize,
    structural_identity_count: usize,
    structural_identity_storage_bytes: usize,
    completed_binding_count: usize,
    completed_binding_storage_bytes: usize,
    released_completed_binding_count: usize,
    validation_header_field_count: usize,
    validation_header_string_bytes: usize,
    validation_structured_comment_count: usize,
    validation_reference_datatype_claim_count: usize,
    validation_datatype_target_count: usize,
    validation_datatype_target_string_bytes: usize,
    validation_reference_datatype_claim_string_bytes: usize,
    validation_reference_target_count: usize,
    validation_reference_target_string_bytes: usize,
    validation_reference_step_count: usize,
    validation_reference_claim_count: usize,
    validation_reference_step_string_bytes: usize,
    validation_retained_candidate_error_count: usize,
    validation_event_count: usize,
    validation_seen_path_count: usize,
    validation_seen_path_string_bytes: usize,
    prevalidation_error_count: usize,
    ready_batch_count: usize,
    ready_event_count: usize,
    ready_event_slot_bytes: usize,
    staged_batch_count: usize,
    staged_cursor_count: usize,
    staged_event_count: usize,
    staged_event_slot_bytes: usize,
    staged_ast_slot_bytes: usize,
    terminal_source_capacity_bytes: usize,
    terminal_event_count: usize,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct TelexOptions {
    limits_source: Option<String>,
    registered_fields: Vec<String>,
    max_input_bytes: Option<usize>,
    max_line_bytes: Option<usize>,
    max_fields_per_event: Option<usize>,
    max_events: Option<usize>,
    max_decoded_payload_bytes: Option<usize>,
    max_path_depth: Option<usize>,
    max_path_characters: Option<usize>,
    max_attribute_depth: Option<usize>,
    max_value_nesting_depth: Option<usize>,
    max_string_codepoints: Option<usize>,
    max_key_segment_codepoints: Option<usize>,
    max_list_items: Option<usize>,
    max_tuple_items: Option<usize>,
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

const fn default_max_nesting_depth() -> usize {
    256
}

const fn default_max_path_depth() -> usize {
    1024
}

const fn default_max_string_codepoints() -> usize {
    1_048_576
}

const fn default_max_key_segment_codepoints() -> usize {
    1024
}

const fn default_max_collection_items() -> usize {
    65_536
}

const fn default_max_path_characters() -> usize {
    8192
}

const fn default_max_numeric_literal_characters() -> usize {
    1024
}

const fn default_max_structured_comment_characters() -> usize {
    1_048_576
}

const fn default_finalize() -> bool {
    true
}

const fn default_max_input_bytes() -> usize {
    1 << 20
}

const fn default_stream_batch_events() -> usize {
    256
}

const fn default_stream_pending_batches() -> usize {
    2
}

#[wasm_bindgen]
pub fn process_aeon(source: &str, options_json: &str) -> Result<String, JsValue> {
    process_aeon_json(source, options_json).map_err(|error| JsValue::from_str(&error))
}

pub fn process_aeon_json(source: &str, options_json: &str) -> Result<String, String> {
    let options = parse_process_options(options_json)?;
    let result = process(source, &options);
    serde_json::to_string(&result).map_err(|error| format!("failed to serialize response: {error}"))
}

#[wasm_bindgen(js_name = benchmark_process_aeon)]
pub fn benchmark_process_aeon_wasm(source: &str, options_json: &str) -> Result<u32, JsValue> {
    benchmark_process_aeon(source, options_json).map_err(|error| JsValue::from_str(&error))
}

pub fn benchmark_process_aeon(source: &str, options_json: &str) -> Result<u32, String> {
    let options = parse_process_options(options_json)?;
    let result = process(source, &options);
    black_box(&result);
    Ok(6)
}

/// Bounded progressive AEON stream exposed through the generated WASM module.
///
/// Each method returns one JSON envelope so the JavaScript adapter performs one
/// boundary crossing per input chunk, output batch, or lifecycle operation.
#[wasm_bindgen(js_name = AeonStream)]
pub struct AeonStreamWasm {
    compiler: SofiaStreamCompiler,
}

#[wasm_bindgen(js_class = AeonStream)]
impl AeonStreamWasm {
    #[wasm_bindgen(constructor)]
    pub fn new(options_json: &str) -> Result<AeonStreamWasm, JsValue> {
        let options =
            parse_stream_options(options_json).map_err(|error| JsValue::from_str(&error))?;
        if !matches!(
            options.process.validation_mode.as_str(),
            "declared" | "strict" | "custom" | "loose"
        ) {
            return Err(JsValue::from_str(
                "streaming requires declared, strict, custom, or loose validation",
            ));
        }
        let max_batch_events = NonZeroUsize::new(options.max_batch_events)
            .ok_or_else(|| JsValue::from_str("maxBatchEvents must be greater than zero"))?;
        let max_pending_batches = NonZeroUsize::new(options.max_pending_batches)
            .ok_or_else(|| JsValue::from_str("maxPendingBatches must be greater than zero"))?;
        let mut compile = compile_options(&options.process);
        compile.recovery = false;
        Ok(Self {
            compiler: SofiaStreamCompiler::new(compile, max_batch_events, max_pending_batches),
        })
    }

    pub fn state(&self) -> String {
        stream_state_name(self.compiler.state()).to_owned()
    }

    /// Diagnostic live-retention telemetry for benchmarks and profiling.
    ///
    /// The returned JSON deliberately stays on the generated low-level
    /// binding rather than the stable TypeScript facade.
    #[wasm_bindgen(js_name = retentionSnapshot)]
    pub fn retention_snapshot(&self) -> Result<String, JsValue> {
        serde_json::to_string(&stream_retention_response(self.compiler.retention())).map_err(
            |error| {
                JsValue::from_str(&format!(
                    "failed to serialize stream retention snapshot: {error}"
                ))
            },
        )
    }

    pub fn push(&mut self, chunk: &[u8]) -> Result<String, JsValue> {
        let progress = self
            .compiler
            .push(chunk)
            .map_err(|error| JsValue::from_str(&error.to_string()))?;
        stream_progress_json(progress).map_err(|error| JsValue::from_str(&error))
    }

    #[wasm_bindgen(js_name = pushString)]
    pub fn push_string(&mut self, chunk: &str) -> Result<String, JsValue> {
        let progress = self
            .compiler
            .push_str(chunk)
            .map_err(|error| JsValue::from_str(&error.to_string()))?;
        stream_progress_json(progress).map_err(|error| JsValue::from_str(&error))
    }

    pub fn finish(&mut self) -> Result<String, JsValue> {
        let progress = self
            .compiler
            .finish()
            .map_err(|error| JsValue::from_str(&error.to_string()))?;
        stream_progress_json(progress).map_err(|error| JsValue::from_str(&error))
    }

    #[wasm_bindgen(js_name = pullBatch)]
    pub fn pull_batch(&mut self) -> Result<String, JsValue> {
        let batch = self
            .compiler
            .pull_batch()
            .map_err(|error| JsValue::from_str(&error.to_string()))?
            .map(|batch| StreamBatchResponse {
                sequence: batch.sequence(),
                first_event_index: batch.first_event_index(),
                events: batch.into_events().into_iter().map(process_event).collect(),
            });
        serde_json::to_string(&batch).map_err(|error| {
            JsValue::from_str(&format!("failed to serialize stream batch: {error}"))
        })
    }

    pub fn cancel(&mut self) -> Result<String, JsValue> {
        let progress = self
            .compiler
            .cancel()
            .map_err(|error| JsValue::from_str(&error.to_string()))?;
        stream_progress_json(progress).map_err(|error| JsValue::from_str(&error))
    }

    #[wasm_bindgen(js_name = takeTerminal)]
    pub fn take_terminal(&mut self) -> Result<String, JsValue> {
        let terminal = self
            .compiler
            .take_terminal()
            .map_err(|error| JsValue::from_str(&error.to_string()))?;
        let response = match terminal {
            SofiaStreamTerminal::Accepted { event_count } => StreamTerminalResponse {
                status: "accepted",
                reason: None,
                event_count: Some(event_count),
                exposed_event_count: event_count,
                warnings: Vec::new(),
                errors: Vec::new(),
            },
            SofiaStreamTerminal::Invalidated {
                errors,
                warnings,
                exposed_event_count,
            } => StreamTerminalResponse {
                status: "invalidated",
                reason: Some("diagnostics"),
                event_count: None,
                exposed_event_count,
                warnings: diagnostics_json(&warnings),
                errors: diagnostics_json(&errors),
            },
            SofiaStreamTerminal::Cancelled {
                exposed_event_count,
            } => StreamTerminalResponse {
                status: "invalidated",
                reason: Some("cancelled"),
                event_count: None,
                exposed_event_count,
                warnings: Vec::new(),
                errors: Vec::new(),
            },
        };
        serde_json::to_string(&response).map_err(|error| {
            JsValue::from_str(&format!(
                "failed to serialize stream terminal result: {error}"
            ))
        })
    }
}

fn parse_stream_options(options_json: &str) -> Result<StreamOptions, String> {
    let source = if options_json.trim().is_empty() {
        "{}"
    } else {
        options_json
    };
    let options: StreamOptions = serde_json::from_str(source)
        .map_err(|error| format!("invalid stream options JSON: {error}"))?;
    validate_process_options(&options.process)?;
    Ok(options)
}

fn stream_progress_json(progress: SofiaStreamProgress) -> Result<String, String> {
    let response = match progress {
        SofiaStreamProgress::NeedMoreInput { pending_batches } => StreamProgressResponse {
            state: "accepting",
            accepted: true,
            pending_batches,
            backpressured: false,
        },
        SofiaStreamProgress::BatchAvailable {
            pending_batches,
            backpressured,
        } => StreamProgressResponse {
            state: "accepting",
            accepted: true,
            pending_batches,
            backpressured,
        },
        SofiaStreamProgress::Backpressured { pending_batches } => StreamProgressResponse {
            state: "accepting",
            accepted: false,
            pending_batches,
            backpressured: true,
        },
        SofiaStreamProgress::Draining { pending_batches } => StreamProgressResponse {
            state: "draining",
            accepted: true,
            pending_batches,
            backpressured: true,
        },
        SofiaStreamProgress::TerminalReady => StreamProgressResponse {
            state: "terminal-ready",
            accepted: true,
            pending_batches: 0,
            backpressured: false,
        },
    };
    serde_json::to_string(&response)
        .map_err(|error| format!("failed to serialize stream progress: {error}"))
}

fn stream_retention_response(
    retention: aeon_core::ProgressiveRetentionSnapshot,
) -> StreamRetentionResponse {
    StreamRetentionResponse {
        accepted_input_bytes: retention.accepted_input_bytes,
        accounted_shallow_bytes: retention.accounted_shallow_bytes(),
        compact_output: retention.compact_output,
        source_retained: retention.source_retained,
        source_bytes: retention.source_bytes,
        source_capacity_bytes: retention.source_capacity_bytes,
        lexer_active_bytes: retention.lexer_active_bytes,
        parser_token_count: retention.parser_token_count,
        parser_token_storage_bytes: retention.parser_token_storage_bytes,
        parser_frame_count: retention.parser_frame_count,
        structural_identity_count: retention.structural_identity_count,
        structural_identity_storage_bytes: retention.structural_identity_storage_bytes,
        completed_binding_count: retention.completed_binding_count,
        completed_binding_storage_bytes: retention.completed_binding_storage_bytes,
        released_completed_binding_count: retention.released_completed_binding_count,
        validation_header_field_count: retention.validation_header_field_count,
        validation_header_string_bytes: retention.validation_header_string_bytes,
        validation_structured_comment_count: retention.validation_structured_comment_count,
        validation_reference_datatype_claim_count: retention
            .validation_reference_datatype_claim_count,
        validation_datatype_target_count: retention.validation_datatype_target_count,
        validation_datatype_target_string_bytes: retention.validation_datatype_target_string_bytes,
        validation_reference_datatype_claim_string_bytes: retention
            .validation_reference_datatype_claim_string_bytes,
        validation_reference_target_count: retention.validation_reference_target_count,
        validation_reference_target_string_bytes: retention
            .validation_reference_target_string_bytes,
        validation_reference_step_count: retention.validation_reference_step_count,
        validation_reference_claim_count: retention.validation_reference_claim_count,
        validation_reference_step_string_bytes: retention.validation_reference_step_string_bytes,
        validation_retained_candidate_error_count: retention
            .validation_retained_candidate_error_count,
        validation_event_count: retention.validation_event_count,
        validation_seen_path_count: retention.validation_seen_path_count,
        validation_seen_path_string_bytes: retention.validation_seen_path_string_bytes,
        prevalidation_error_count: retention.prevalidation_error_count,
        ready_batch_count: retention.ready_batch_count,
        ready_event_count: retention.ready_event_count,
        ready_event_slot_bytes: retention.ready_event_slot_bytes,
        staged_batch_count: retention.staged_batch_count,
        staged_cursor_count: retention.staged_cursor_count,
        staged_event_count: retention.staged_event_count,
        staged_event_slot_bytes: retention.staged_event_slot_bytes,
        staged_ast_slot_bytes: retention.staged_ast_slot_bytes,
        terminal_source_capacity_bytes: retention.terminal_source_capacity_bytes,
        terminal_event_count: retention.terminal_event_count,
    }
}

const fn stream_state_name(state: SofiaStreamState) -> &'static str {
    match state {
        SofiaStreamState::Accepting => "accepting",
        SofiaStreamState::Draining => "draining",
        SofiaStreamState::TerminalReady => "terminal-ready",
        SofiaStreamState::Complete => "complete",
    }
}

fn parse_process_options(options_json: &str) -> Result<ProcessOptions, String> {
    let options = if options_json.trim().is_empty() {
        ProcessOptions {
            validation_mode: default_validation_mode(),
            datatype_policy: None,
            max_input_bytes: default_max_input_bytes(),
            max_events: None,
            max_separator_depth: default_depth(),
            max_clarifier_values: None,
            max_attribute_depth: default_depth(),
            max_generic_depth: default_depth(),
            max_generic_arguments: default_max_generic_arguments(),
            max_datatype_components: default_max_datatype_components(),
            max_value_nesting_depth: None,
            max_nesting_depth: default_max_nesting_depth(),
            max_path_depth: default_max_path_depth(),
            max_string_codepoints: default_max_string_codepoints(),
            max_key_segment_codepoints: default_max_key_segment_codepoints(),
            max_list_items: default_max_collection_items(),
            max_tuple_items: default_max_collection_items(),
            max_path_characters: default_max_path_characters(),
            max_numeric_literal_characters: default_max_numeric_literal_characters(),
            max_structured_comment_characters: default_max_structured_comment_characters(),
            finalize: true,
            materialization_mode: String::from("all"),
            finalize_scope: default_finalize_scope(),
            include_paths: Vec::new(),
        }
    } else {
        serde_json::from_str(options_json)
            .map_err(|error| format!("invalid options JSON: {error}"))?
    };
    validate_process_options(&options)?;
    Ok(options)
}

fn validate_process_options(options: &ProcessOptions) -> Result<(), String> {
    if !matches!(
        options.validation_mode.as_str(),
        "declared" | "strict" | "custom" | "loose" | "none"
    ) {
        return Err(format!(
            "unsupported validationMode {:?}",
            options.validation_mode
        ));
    }
    if !matches!(
        options.datatype_policy.as_deref(),
        None | Some("reserved_only" | "allow_custom")
    ) {
        return Err(format!(
            "unsupported datatypePolicy {:?}",
            options.datatype_policy.as_deref().unwrap_or_default()
        ));
    }
    Ok(())
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
    let resolved = resolve_telex_options(&options)?;
    let registered = options
        .registered_fields
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>();
    let result = validate_telex_with_limits(source, &registered, &resolved.limits)
        .map_err(|error| telex_syntax_error_json(&error))?;
    let result = with_effective_limits(
        json!({
            "valid": result.valid,
            "profile": result.profile,
            "diagnostics": result
                .diagnostics
                .iter()
                .map(telex_diagnostic_json)
                .collect::<Vec<_>>(),
        }),
        resolved.effective_limits,
    );
    serde_json::to_string(&result)
        .map_err(|error| format!("failed to serialize Telex validation result: {error}"))
}

pub fn canonicalize_telex_text(source: &str, options_json: &str) -> Result<String, String> {
    let options = parse_telex_options(options_json)?;
    let resolved = resolve_telex_options(&options)?;
    canonicalize_telex_with_limits(source, &resolved.limits)
        .map_err(|error| telex_syntax_error_json(&error))
}

pub fn check_telex_completeness_json(source: &str, options_json: &str) -> Result<String, String> {
    let options = parse_telex_options(options_json)?;
    let resolved = resolve_telex_options(&options)?;
    let parsed = parse_telex_with_limits(source, &resolved.limits)
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
    let result = with_effective_limits(
        json!({
            "complete": result.complete,
            "missing": missing,
        }),
        resolved.effective_limits,
    );
    serde_json::to_string(&result)
        .map_err(|error| format!("failed to serialize Telex completeness result: {error}"))
}

pub fn materialize_telex_json(source: &str, options_json: &str) -> Result<String, String> {
    let options = parse_telex_options(options_json)?;
    let resolved = resolve_telex_options(&options)?;
    let parsed = parse_telex_with_limits(source, &resolved.limits)
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
            limits: resolved.limits,
            max_materialized_weight: resolved.max_materialized_weight,
            max_reference_depth: resolved.max_reference_depth,
        },
    );
    let result = with_effective_limits(
        json!({
            "document": result.document,
            "meta": {
                "errors": diagnostics_json(&result.meta.errors),
                "warnings": diagnostics_json(&result.meta.warnings),
            }
        }),
        resolved.effective_limits,
    );
    serde_json::to_string(&result)
        .map_err(|error| format!("failed to serialize Telex materialization result: {error}"))
}

fn parse_telex_options(options_json: &str) -> Result<TelexOptions, String> {
    if options_json.trim().is_empty() {
        return Ok(TelexOptions::default());
    }
    serde_json::from_str(options_json)
        .map_err(|error| format!("invalid Telex options JSON: {error}"))
}

struct ResolvedTelexOptions {
    limits: TelexLimits,
    max_materialized_weight: Option<usize>,
    max_reference_depth: Option<usize>,
    effective_limits: Option<JsonValue>,
}

fn resolve_telex_options(options: &TelexOptions) -> Result<ResolvedTelexOptions, String> {
    let mut effective = if let Some(source) = options.limits_source.as_deref() {
        let selected = load_aeonic_limits(source).map_err(|errors| {
            json!({
                "code": "INVALID_LIMITS_FILE",
                "message": "Unable to select the supplied AEON limits document",
                "diagnostics": errors.iter().map(|error| json!({
                    "code": error.code,
                    "path": error.path,
                    "message": error.message,
                })).collect::<Vec<_>>(),
            })
            .to_string()
        })?;
        Some(effective_telex_configuration(&selected).map_err(|error| {
            json!({
                "code": error.code,
                "message": error.message,
                "path": error.path,
            })
            .to_string()
        })?)
    } else {
        None
    };
    let mut limits = effective
        .as_ref()
        .map_or_else(TelexLimits::default, |selected| selected.telex);
    let selected_telex = limits;
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
    limits.max_attribute_depth = options
        .max_attribute_depth
        .unwrap_or(limits.max_attribute_depth);
    limits.max_value_nesting_depth = options
        .max_value_nesting_depth
        .unwrap_or(limits.max_value_nesting_depth);
    limits.max_string_codepoints = options
        .max_string_codepoints
        .unwrap_or(limits.max_string_codepoints);
    limits.max_key_segment_codepoints = options
        .max_key_segment_codepoints
        .unwrap_or(limits.max_key_segment_codepoints);
    limits.max_list_items = options.max_list_items.unwrap_or(limits.max_list_items);
    limits.max_tuple_items = options.max_tuple_items.unwrap_or(limits.max_tuple_items);
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
    let mut max_materialized_weight = effective
        .as_ref()
        .and_then(|selected| selected.finalization.max_materialized_weight);
    let mut max_reference_depth = effective
        .as_ref()
        .and_then(|selected| selected.finalization.max_reference_depth);
    if let Some(explicit) = options.max_materialized_weight {
        max_materialized_weight = Some(explicit);
    }
    if let Some(explicit) = options.max_reference_depth {
        max_reference_depth = Some(explicit);
    }
    if let Some(selected) = effective.as_mut() {
        selected.overrides_applied = limits != selected_telex
            || max_materialized_weight != selected.finalization.max_materialized_weight
            || max_reference_depth != selected.finalization.max_reference_depth;
        selected.telex = limits;
        selected.finalization.max_materialized_weight = max_materialized_weight;
        selected.finalization.max_reference_depth = max_reference_depth;
    }
    Ok(ResolvedTelexOptions {
        limits,
        max_materialized_weight,
        max_reference_depth,
        effective_limits: effective.as_ref().map(effective_limits_json),
    })
}

fn effective_limits_json(effective: &EffectiveTelexConfiguration) -> JsonValue {
    json!({
        "limitsId": effective.limits_id,
        "limitsVersion": effective.limits_version,
        "profileClaims": effective.profile_claims,
        "telex": {
            "maxInputBytes": effective.telex.max_input_bytes,
            "maxLineBytes": effective.telex.max_line_bytes,
            "maxFieldsPerEvent": effective.telex.max_fields_per_event,
            "maxEvents": effective.telex.max_events,
            "maxDecodedPayloadBytes": effective.telex.max_decoded_payload_bytes,
            "maxPathDepth": effective.telex.max_path_depth,
            "maxPathCharacters": effective.telex.max_path_characters,
            "maxAttributeDepth": effective.telex.max_attribute_depth,
            "maxValueNestingDepth": effective.telex.max_value_nesting_depth,
            "maxStringCodepoints": effective.telex.max_string_codepoints,
            "maxKeySegmentCodepoints": effective.telex.max_key_segment_codepoints,
            "maxListItems": effective.telex.max_list_items,
            "maxTupleItems": effective.telex.max_tuple_items,
            "maxGenericDepth": effective.telex.max_generic_depth,
            "maxGenericArguments": effective.telex.max_generic_arguments,
            "maxClarifierValues": effective.telex.max_clarifier_values,
            "maxDatatypeComponents": effective.telex.max_datatype_components,
        },
        "finalization": {
            "maxMaterializedWeight": effective.finalization.max_materialized_weight,
            "maxReferenceDepth": effective.finalization.max_reference_depth,
        },
        "overridesApplied": effective.overrides_applied,
    })
}

fn with_effective_limits(mut result: JsonValue, effective: Option<JsonValue>) -> JsonValue {
    if let (Some(object), Some(effective)) = (result.as_object_mut(), effective) {
        object.insert("effectiveLimits".to_owned(), effective);
    }
    result
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

fn process(source: &str, options: &ProcessOptions) -> ProcessResponse {
    if source.len() > options.max_input_bytes {
        return ProcessResponse {
            canonical: String::new(),
            finalized: JsonValue::Null,
            annotations: Vec::new(),
            events: Vec::new(),
            warnings: Vec::new(),
            errors: vec![json!({
                "code": "INPUT_SIZE_EXCEEDED",
                "path": "$",
                "span": {
                    "start": { "line": 1, "column": 1, "offset": 0 },
                    "end": { "line": 1, "column": 1, "offset": 0 },
                },
                "phase": "Input Validation",
                "message": format!(
                    "Input size {} bytes exceeds configured limit of {} bytes",
                    source.len(),
                    options.max_input_bytes
                ),
            })],
        };
    }

    if !options.finalize && options.validation_mode != "none" {
        let compile_result = compile_sofia(source, compile_options(options));
        return ProcessResponse {
            canonical: String::new(),
            finalized: JsonValue::Null,
            annotations: annotations_json(source),
            events: process_events(
                &compile_result.events,
                compile_result.header.as_ref(),
                &options.finalize_scope,
            ),
            warnings: diagnostics_json(&compile_result.warnings),
            errors: diagnostics_json(&compile_result.errors),
        };
    }

    let canonical = canonicalize(source);
    let annotations = annotations_json(source);

    if !canonical.errors.is_empty() {
        return ProcessResponse {
            canonical: String::new(),
            finalized: JsonValue::Null,
            annotations,
            events: Vec::new(),
            warnings: Vec::new(),
            errors: diagnostics_json(&canonical.errors),
        };
    }

    if options.validation_mode == "none" {
        return ProcessResponse {
            canonical: canonical.text,
            finalized: JsonValue::Null,
            annotations,
            events: Vec::new(),
            warnings: Vec::new(),
            errors: Vec::new(),
        };
    }

    let compile_result = compile_sofia(source, compile_options(options));

    let events = process_events(
        &compile_result.events,
        compile_result.header.as_ref(),
        &options.finalize_scope,
    );

    if !compile_result.errors.is_empty() {
        return ProcessResponse {
            canonical: canonical.text,
            finalized: JsonValue::Null,
            annotations,
            events,
            warnings: diagnostics_json(&compile_result.warnings),
            errors: diagnostics_json(&compile_result.errors),
        };
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

    ProcessResponse {
        canonical: canonical.text,
        finalized: finalized.document,
        annotations,
        events,
        warnings: diagnostics_json(&warnings),
        errors: diagnostics_json(&finalized.meta.errors),
    }
}

fn compile_options(options: &ProcessOptions) -> CompileOptions {
    CompileOptions {
        recovery: true,
        max_input_bytes: Some(options.max_input_bytes),
        max_events: options.max_events,
        max_separator_depth: options.max_separator_depth,
        max_clarifier_values: options.max_clarifier_values,
        max_attribute_depth: options.max_attribute_depth,
        max_generic_depth: options.max_generic_depth,
        max_generic_arguments: options.max_generic_arguments,
        max_datatype_components: options.max_datatype_components,
        max_value_nesting_depth: options.max_value_nesting_depth,
        max_nesting_depth: options.max_nesting_depth,
        max_path_depth: options.max_path_depth,
        max_string_codepoints: options.max_string_codepoints,
        max_key_segment_codepoints: options.max_key_segment_codepoints,
        max_list_items: options.max_list_items,
        max_tuple_items: options.max_tuple_items,
        max_path_characters: options.max_path_characters,
        max_numeric_literal_characters: options.max_numeric_literal_characters,
        max_structured_comment_characters: options.max_structured_comment_characters,
        datatype_policy: explicit_datatype_policy(options).or({
            match options.validation_mode.as_str() {
                "strict" => Some(DatatypePolicy::ReservedOnly),
                "custom" => Some(DatatypePolicy::AllowCustom),
                _ => None,
            }
        }),
        mode: effective_mode(options),
        ..CompileOptions::default()
    }
}

fn explicit_datatype_policy(options: &ProcessOptions) -> Option<DatatypePolicy> {
    match options.datatype_policy.as_deref() {
        Some("reserved_only") => Some(DatatypePolicy::ReservedOnly),
        Some("allow_custom") => Some(DatatypePolicy::AllowCustom),
        _ => None,
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
                "phase": diagnostic_phase_label(diagnostic),
                "message": diagnostic.message,
            })
        })
        .collect()
}

fn diagnostic_phase_label(diagnostic: &Diagnostic) -> Option<&'static str> {
    diagnostic
        .phase
        .and_then(phase_label_from_number)
        .or_else(|| match diagnostic.code.as_str() {
            "INPUT_SIZE_EXCEEDED" => Some("Input Validation"),
            "UNEXPECTED_CHARACTER"
            | "UNTERMINATED_BLOCK_COMMENT"
            | "UNTERMINATED_STRING"
            | "UNTERMINATED_TRIMTICK"
            | "INVALID_STRUCTURAL_IDENTITY" => Some("Lexical Analysis"),
            "SYNTAX_ERROR"
            | "INVALID_NUMBER"
            | "INVALID_DATE"
            | "INVALID_TIME"
            | "INVALID_DATETIME"
            | "INVALID_SEPARATOR_CHAR"
            | "CLARIFIER_VALUES_EXCEEDED"
            | "GENERIC_ARGUMENTS_EXCEEDED"
            | "DATATYPE_COMPONENTS_EXCEEDED"
            | "SEPARATOR_DEPTH_EXCEEDED"
            | "GENERIC_DEPTH_EXCEEDED" => Some("Parsing"),
            "HEADER_CONFLICT"
            | "DUPLICATE_KEY"
            | "DUPLICATE_CANONICAL_PATH"
            | "DUPLICATE_STRUCTURAL_IDENTITY"
            | "DATATYPE_LITERAL_MISMATCH" => Some("Core Validation"),
            "MISSING_REFERENCE_TARGET"
            | "FORWARD_REFERENCE"
            | "SELF_REFERENCE"
            | "ATTRIBUTE_DEPTH_EXCEEDED" => Some("Reference Validation"),
            "UNTYPED_TOGGLE_LITERAL"
            | "UNTYPED_VALUE_IN_STRICT_MODE"
            | "CUSTOM_TOGGLE_ALIAS_NOT_ALLOWED"
            | "CUSTOM_DATATYPE_NOT_ALLOWED"
            | "INVALID_NODE_HEAD_DATATYPE" => Some("Mode Enforcement"),
            "PROFILE_NOT_FOUND" | "PROFILE_PROCESSORS_SKIPPED" => Some("Profile Compilation"),
            "TYPE_GUARD_FAILED" => Some("Finalization"),
            code if code.starts_with("FINALIZE_") => Some("Finalization"),
            _ => None,
        })
}

const fn phase_label_from_number(phase: u8) -> Option<&'static str> {
    match phase {
        0 => Some("Input Validation"),
        5 => Some("Profile Compilation"),
        6 => Some("Schema Validation"),
        7 => Some("Reference Resolution"),
        8 => Some("Finalization"),
        _ => None,
    }
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
    if !source.as_bytes().contains(&b'/') {
        return Vec::new();
    }
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

fn process_events(
    events: &[AssignmentEvent],
    header: Option<&HeaderFields>,
    scope: &str,
) -> Vec<ProcessEvent> {
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
            output.push(ProcessEvent {
                path: format!("$.[\"aeon:{key}\"]"),
                key: format!("aeon:{key}"),
                datatype: None,
                value_type: value_type_name(value),
                structural_id: None,
            });
        }
    }

    if scope != "header" {
        output.extend(events.iter().cloned().map(process_event));
    }

    output
}

fn process_event(event: AssignmentEvent) -> ProcessEvent {
    ProcessEvent {
        path: format_path(&event.path),
        key: event.key,
        datatype: event.datatype,
        value_type: value_type_name(&event.value),
        structural_id: event.structural_id,
    }
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
        AeonStreamWasm, benchmark_process_aeon, canonicalize_telex_text,
        check_telex_completeness_json, materialize_telex_json, process_aeon_json,
        validate_telex_json,
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
    fn benchmark_process_retains_the_response_without_serializing_it() {
        let fields =
            benchmark_process_aeon("a:string = \"ok\"\n", "{}").expect("benchmark process aeon");

        assert_eq!(fields, 6);
    }

    #[test]
    fn typed_event_response_preserves_public_field_names_and_optional_identity() {
        let output = process_aeon_json("age\\A1\\:int32 = 42\n", "{}").expect("process aeon");
        let parsed: JsonValue = serde_json::from_str(&output).expect("valid json");
        let event = &parsed["events"][0];

        assert_eq!(event["path"], "$.age");
        assert_eq!(event["key"], "age");
        assert_eq!(event["datatype"], "int32");
        assert_eq!(event["valueType"], "NumberLiteral");
        assert_eq!(event["structuralId"], "A1");
    }

    #[test]
    fn progressive_stream_uses_bounded_batches_and_terminal_acceptance() {
        let mut stream = AeonStreamWasm::new(
            r#"{"validationMode":"strict","maxBatchEvents":1,"maxPendingBatches":1}"#,
        )
        .expect("create stream");
        let source = b"alpha:int32 = 1\nbeta:int32 = 2\ngamma:int32 = 3\n";
        let progress: JsonValue =
            serde_json::from_str(&stream.push(source).expect("push complete source"))
                .expect("progress JSON");
        assert_eq!(progress["accepted"], true);
        assert_eq!(progress["backpressured"], true);
        let retained: JsonValue = serde_json::from_str(
            &stream
                .retention_snapshot()
                .expect("read retention snapshot"),
        )
        .expect("retention JSON");
        assert_eq!(retained["acceptedInputBytes"], source.len());
        assert_eq!(retained["compactOutput"], true);
        assert_eq!(retained["sourceRetained"], false);
        assert!(retained["accountedShallowBytes"].as_u64().unwrap_or(0) > 0);

        let mut events = Vec::new();
        loop {
            let batch: JsonValue = serde_json::from_str(&stream.pull_batch().expect("pull batch"))
                .expect("batch JSON");
            if batch.is_null() {
                break;
            }
            assert_eq!(batch["sequence"], events.len());
            assert_eq!(batch["firstEventIndex"], events.len());
            events.push(
                batch["events"][0]["path"]
                    .as_str()
                    .expect("event path")
                    .to_owned(),
            );
        }

        let finish: JsonValue =
            serde_json::from_str(&stream.finish().expect("finish stream")).expect("finish JSON");
        assert_eq!(finish["state"], "draining");
        loop {
            let batch: JsonValue = serde_json::from_str(&stream.pull_batch().expect("drain batch"))
                .expect("batch JSON");
            if batch.is_null() {
                break;
            }
            events.push(
                batch["events"][0]["path"]
                    .as_str()
                    .expect("event path")
                    .to_owned(),
            );
        }
        assert_eq!(stream.state(), "terminal-ready");
        let terminal: JsonValue =
            serde_json::from_str(&stream.take_terminal().expect("take terminal result"))
                .expect("terminal JSON");
        assert_eq!(terminal["status"], "accepted");
        assert_eq!(terminal["eventCount"], 3);
        assert_eq!(events, ["$.alpha", "$.beta", "$.gamma"]);
        assert_eq!(stream.state(), "complete");
        let released: JsonValue = serde_json::from_str(
            &stream
                .retention_snapshot()
                .expect("read released retention snapshot"),
        )
        .expect("released retention JSON");
        assert_eq!(released["accountedShallowBytes"], 0);
        assert_eq!(released["readyEventCount"], 0);
        assert_eq!(released["stagedEventCount"], 0);
    }

    #[test]
    fn progressive_stream_decodes_utf8_across_every_byte_boundary() {
        let source = "message:string = \"Sofía 🌊\"\n";
        for split in 0..=source.len() {
            let mut stream = AeonStreamWasm::new("{}").expect("create stream");
            stream
                .push(&source.as_bytes()[..split])
                .expect("push prefix");
            stream
                .push(&source.as_bytes()[split..])
                .expect("push suffix");
            stream.finish().expect("finish stream");
            let batch: JsonValue =
                serde_json::from_str(&stream.pull_batch().expect("pull final batch"))
                    .expect("batch JSON");
            assert_eq!(batch["events"][0]["path"], "$.message", "split {split}");
            let terminal: JsonValue =
                serde_json::from_str(&stream.take_terminal().expect("take terminal result"))
                    .expect("terminal JSON");
            assert_eq!(terminal["status"], "accepted", "split {split}");
        }
    }

    #[test]
    fn progressive_stream_cancellation_invalidates_exposed_output() {
        let mut stream = AeonStreamWasm::new(r#"{"maxBatchEvents":1,"maxPendingBatches":1}"#)
            .expect("create stream");
        stream.push(b"alpha = 1\nbeta = 2\n").expect("push source");
        let batch: JsonValue =
            serde_json::from_str(&stream.pull_batch().expect("pull batch")).expect("batch JSON");
        assert_eq!(batch["events"][0]["path"], "$.alpha");
        stream.cancel().expect("cancel stream");
        let terminal: JsonValue =
            serde_json::from_str(&stream.take_terminal().expect("take cancellation"))
                .expect("terminal JSON");
        assert_eq!(terminal["status"], "invalidated");
        assert_eq!(terminal["reason"], "cancelled");
        assert_eq!(terminal["exposedEventCount"], 1);
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
        assert_eq!(parsed["errors"][0]["phase"], "Input Validation");
    }

    #[test]
    fn process_options_expose_core_limits_and_independent_datatype_policy() {
        let custom = process_aeon_json(
            "color:stroke = #ff00ff\n",
            r#"{"validationMode":"strict","datatypePolicy":"allow_custom"}"#,
        )
        .expect("process custom datatype under strict behavior");
        let custom: JsonValue = serde_json::from_str(&custom).expect("valid custom JSON");
        assert_eq!(custom["errors"], serde_json::json!([]));

        let limited = process_aeon_json(
            "first:int32 = 1\nsecond:int32 = 2\n",
            r#"{"validationMode":"strict","maxEvents":1}"#,
        )
        .expect("process event-limited source");
        let limited: JsonValue = serde_json::from_str(&limited).expect("valid limit JSON");
        assert_eq!(limited["errors"][0]["code"], "EVENT_COUNT_EXCEEDED");

        let compile_only = process_aeon_json(
            "notJson:nan = NaN\n",
            r#"{"validationMode":"strict","finalize":false}"#,
        )
        .expect("process without finalization");
        let compile_only: JsonValue =
            serde_json::from_str(&compile_only).expect("valid compile-only JSON");
        assert_eq!(compile_only["errors"], serde_json::json!([]));
        assert_eq!(compile_only["finalized"], serde_json::json!(null));

        assert!(
            process_aeon_json("value:int32 = 1\n", r#"{"datatypePolicy":"not-a-policy"}"#,)
                .expect_err("reject unknown datatype policy")
                .contains("unsupported datatypePolicy")
        );
    }

    #[test]
    fn validates_telex_inside_rust() {
        let output = validate_telex_json(
            "telex.aes=1\n\npath=$.answer\nkind=NumberLiteral\nvalue=42\n",
            "",
        )
        .expect("validate Telex");
        let parsed: JsonValue = serde_json::from_str(&output).expect("valid json");

        assert_eq!(parsed["valid"], true);
        assert_eq!(parsed["profile"], "aes.complete.v1");
        assert_eq!(parsed["diagnostics"], serde_json::json!([]));
    }

    #[test]
    fn selects_common_limits_source_at_the_wasm_telex_boundary() {
        let options = serde_json::json!({
            "limitsSource": include_str!(
                "../../../../../test-fixtures/altopelago.aeonic-limits.v1.aeon"
            ),
            "maxStringCodepoints": 2,
        })
        .to_string();
        let output = validate_telex_json(
            "telex.aes=1\n\npath=$.answer\nkind=StringLiteral\nvalue=x\n",
            &options,
        )
        .expect("validate Telex with common limits");
        let parsed: JsonValue = serde_json::from_str(&output).expect("valid json");

        assert_eq!(
            parsed["effectiveLimits"]["limitsId"],
            "altopelago.aeonic-limits.v1"
        );
        assert_eq!(parsed["effectiveLimits"]["telex"]["maxStringCodepoints"], 2);
        assert_eq!(parsed["effectiveLimits"]["overridesApplied"], true);
    }

    #[test]
    fn canonicalizes_telex_inside_rust() {
        let output = canonicalize_telex_text(
            "telex.aes=1\r\n\r\nvalue=\\u{000041}\r\nkind=StringLiteral\r\npath=$.answer\r\n",
            "",
        )
        .expect("canonicalize Telex");

        assert_eq!(
            output,
            "telex.aes=1\n\npath=$.answer\nkind=StringLiteral\nvalue=A\n"
        );
    }

    #[test]
    fn checks_telex_completeness_inside_rust() {
        let output = check_telex_completeness_json(
            "telex.aes=1\nprofile=aes.partial.v1\n\npath=$.a.b\nkind=NumberLiteral\nvalue=1\n",
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
            "telex.aes=1\n\npath=$.answer\nkind=NumberLiteral\nvalue=42\n",
            "",
        )
        .expect("materialize Telex");
        let parsed: JsonValue = serde_json::from_str(&output).expect("valid json");
        assert_eq!(parsed["document"], serde_json::json!({"answer": 42}));
        assert_eq!(parsed["meta"]["errors"], serde_json::json!([]));
    }
}
