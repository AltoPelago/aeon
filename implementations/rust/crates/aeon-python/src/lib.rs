use aeon_core::{
    CompileOptions, CompileResult, CompileToTelexOptions, Diagnostic, SourcePlane, Span, Value,
    compile, compile_to_telex, format_path,
};
use pyo3::exceptions::PyRuntimeError;
use pyo3::prelude::*;
use pyo3::types::{PyBytes, PyModule};
use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CompileEnvelope {
    events: Vec<EventRecord>,
    warnings: Vec<DiagnosticRecord>,
    errors: Vec<DiagnosticRecord>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct EventRecord {
    path: String,
    key: String,
    source_plane: &'static str,
    datatype: Option<String>,
    value_type: &'static str,
    structural_id: Option<String>,
    span: SpanRecord,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DiagnosticRecord {
    code: String,
    path: Option<String>,
    span: Option<SpanRecord>,
    phase: Option<&'static str>,
    message: String,
}

#[derive(Debug, Serialize)]
struct SpanRecord {
    start: PositionRecord,
    end: PositionRecord,
}

#[derive(Debug, Serialize)]
struct PositionRecord {
    line: usize,
    column: usize,
    offset: usize,
}

#[pyfunction]
fn compile_json(py: Python<'_>, source: &str) -> PyResult<Py<PyBytes>> {
    let source = source.to_owned();
    let encoded = py
        .detach(move || encode_compile_result(&source))
        .map_err(PyRuntimeError::new_err)?;
    Ok(PyBytes::new(py, encoded.as_bytes()).unbind())
}

#[pyfunction]
fn compile_telex(py: Python<'_>, source: &str) -> PyResult<(bool, Py<PyBytes>)> {
    let source = source.to_owned();
    let (ok, encoded) = py
        .detach(move || encode_telex_result(&source))
        .map_err(PyRuntimeError::new_err)?;
    Ok((ok, PyBytes::new(py, &encoded).unbind()))
}

#[pymodule]
#[pyo3(name = "_native")]
fn native(module: &Bound<'_, PyModule>) -> PyResult<()> {
    module.add_function(wrap_pyfunction!(compile_json, module)?)?;
    module.add_function(wrap_pyfunction!(compile_telex, module)?)?;
    Ok(())
}

fn encode_compile_result(source: &str) -> Result<String, String> {
    let result = compile(source, CompileOptions::default());
    serde_json::to_string(&compile_envelope(&result))
        .map_err(|error| format!("failed to serialize compile result: {error}"))
}

fn encode_telex_result(source: &str) -> Result<(bool, Vec<u8>), String> {
    let result = compile_to_telex(source, CompileToTelexOptions::default());
    if !result.compile.errors.is_empty() {
        let diagnostics = result
            .compile
            .errors
            .iter()
            .map(diagnostic_record)
            .collect::<Vec<_>>();
        return serde_json::to_vec(&diagnostics)
            .map(|encoded| (false, encoded))
            .map_err(|error| format!("failed to serialize compile diagnostics: {error}"));
    }
    if let Some(error) = result.encode_error {
        return Err(format!("failed to encode Telex: {error}"));
    }
    result
        .telex
        .map(String::into_bytes)
        .map(|encoded| (true, encoded))
        .ok_or_else(|| String::from("Telex compilation produced no encoded output"))
}

fn compile_envelope(result: &CompileResult) -> CompileEnvelope {
    CompileEnvelope {
        events: result.events.iter().map(event_record).collect(),
        warnings: result.warnings.iter().map(diagnostic_record).collect(),
        errors: result.errors.iter().map(diagnostic_record).collect(),
    }
}

fn event_record(event: &aeon_core::AssignmentEvent) -> EventRecord {
    EventRecord {
        path: format_path(&event.path),
        key: event.key.clone(),
        source_plane: match event.source_plane {
            SourcePlane::Header => "header",
            SourcePlane::Body => "body",
        },
        datatype: event.datatype.clone(),
        value_type: value_type_name(&event.value),
        structural_id: event.structural_id.clone(),
        span: span_record(&event.span),
    }
}

fn value_type_name(value: &Value) -> &'static str {
    match value {
        Value::TypedValue { value, .. } => value_type_name(value),
        _ => value.value_kind(),
    }
}

fn diagnostic_record(diagnostic: &Diagnostic) -> DiagnosticRecord {
    DiagnosticRecord {
        code: diagnostic.code.clone(),
        path: diagnostic.path.clone(),
        span: diagnostic.span.as_ref().map(span_record),
        phase: diagnostic_phase_label(diagnostic),
        message: diagnostic.message.clone(),
    }
}

fn span_record(span: &Span) -> SpanRecord {
    SpanRecord {
        start: PositionRecord {
            line: span.start.line,
            column: span.start.column,
            offset: span.start.offset,
        },
        end: PositionRecord {
            line: span.end.line,
            column: span.end.column,
            offset: span.end.offset,
        },
    }
}

fn diagnostic_phase_label(diagnostic: &Diagnostic) -> Option<&'static str> {
    diagnostic
        .phase
        .and_then(phase_label_from_number)
        .or_else(|| match diagnostic.code.as_str() {
            "INPUT_SIZE_EXCEEDED" | "UNSAFE_MAX_NESTING_DEPTH" => Some("Input Validation"),
            "UNEXPECTED_CHARACTER"
            | "UNTERMINATED_BLOCK_COMMENT"
            | "UNTERMINATED_STRING"
            | "UNTERMINATED_TRIMTICK"
            | "INVALID_STRUCTURAL_IDENTITY" => Some("Lexical Analysis"),
            "SYNTAX_ERROR"
            | "INVALID_ESCAPE"
            | "INVALID_DATE"
            | "INVALID_TIME"
            | "INVALID_DATETIME"
            | "INVALID_NUMBER"
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
            | "DATATYPE_LITERAL_MISMATCH"
            | "EVENT_COUNT_EXCEEDED" => Some("Core Validation"),
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
