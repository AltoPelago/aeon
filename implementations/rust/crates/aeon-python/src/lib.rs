use std::borrow::Cow;
use std::time::Instant;

use aeon_core::{
    CompileOptions, CompileResult as CoreCompileResult, Diagnostic as CoreDiagnostic,
    ExportTelexOptions, SourcePlane, Span as CoreSpan, Value, compile_sofia, export_telex,
    format_path, project_telex_records,
};
use aes_telex::{
    encode_telex_with_projection_and_limits, validate_telex_records_with_projection_and_limits,
};
use pyo3::exceptions::PyRuntimeError;
use pyo3::prelude::*;
use pyo3::types::{PyBytes, PyModule, PyTuple};
use serde::Serialize;

type PackedSpan = (usize, usize, usize, usize, usize, usize);
type PackedEvent = (
    String,
    String,
    &'static str,
    Option<String>,
    &'static str,
    Option<String>,
    PackedSpan,
);
type PackedDiagnostic = (
    String,
    String,
    Option<String>,
    Option<PackedSpan>,
    Option<&'static str>,
);
type PackedCompileResult = (
    Vec<PackedEvent>,
    Vec<PackedDiagnostic>,
    Vec<PackedDiagnostic>,
);

#[pyclass(
    frozen,
    eq,
    hash,
    skip_from_py_object,
    module = "altopelago.aeon",
    name = "Position"
)]
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
struct PyPosition {
    #[pyo3(get)]
    line: usize,
    #[pyo3(get)]
    column: usize,
    #[pyo3(get)]
    offset: usize,
}

#[pymethods]
impl PyPosition {
    #[new]
    const fn new(line: usize, column: usize, offset: usize) -> Self {
        Self {
            line,
            column,
            offset,
        }
    }

    fn __repr__(&self) -> String {
        format!(
            "Position(line={}, column={}, offset={})",
            self.line, self.column, self.offset
        )
    }
}

#[pyclass(
    frozen,
    eq,
    hash,
    skip_from_py_object,
    module = "altopelago.aeon",
    name = "Span"
)]
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
struct PySpan {
    start: PyPosition,
    end: PyPosition,
}

#[pymethods]
impl PySpan {
    #[new]
    fn new(start: PyRef<'_, PyPosition>, end: PyRef<'_, PyPosition>) -> Self {
        Self {
            start: start.clone(),
            end: end.clone(),
        }
    }

    #[getter]
    fn start(&self) -> PyPosition {
        self.start.clone()
    }

    #[getter]
    fn end(&self) -> PyPosition {
        self.end.clone()
    }

    fn __repr__(&self) -> String {
        format!(
            "Span(start={}, end={})",
            self.start.__repr__(),
            self.end.__repr__()
        )
    }
}

#[pyclass(
    frozen,
    eq,
    hash,
    skip_from_py_object,
    module = "altopelago.aeon",
    name = "Diagnostic"
)]
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
struct PyDiagnostic {
    code: String,
    message: String,
    path: Option<String>,
    span: Option<PySpan>,
    phase: Option<Cow<'static, str>>,
}

#[pymethods]
impl PyDiagnostic {
    #[new]
    #[pyo3(signature = (code, message, path=None, span=None, phase=None))]
    fn new(
        code: String,
        message: String,
        path: Option<String>,
        span: Option<PyRef<'_, PySpan>>,
        phase: Option<String>,
    ) -> Self {
        Self {
            code,
            message,
            path,
            span: span.map(|value| value.clone()),
            phase: phase.map(Cow::Owned),
        }
    }

    #[getter]
    fn code(&self) -> &str {
        &self.code
    }

    #[getter]
    fn message(&self) -> &str {
        &self.message
    }

    #[getter]
    fn path(&self) -> Option<&str> {
        self.path.as_deref()
    }

    #[getter]
    fn span(&self) -> Option<PySpan> {
        self.span.clone()
    }

    #[getter]
    fn phase(&self) -> Option<&str> {
        self.phase.as_deref()
    }

    fn __repr__(&self) -> String {
        format!(
            "Diagnostic(code={:?}, message={:?}, path={}, span={}, phase={})",
            self.code,
            self.message,
            option_string_repr(self.path.as_deref()),
            option_debug_repr(self.span.as_ref()),
            option_string_repr(self.phase.as_deref()),
        )
    }
}

#[pyclass(
    frozen,
    eq,
    hash,
    skip_from_py_object,
    module = "altopelago.aeon",
    name = "Event"
)]
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
struct PyEvent {
    path: String,
    key: String,
    source_plane: Cow<'static, str>,
    datatype: Option<String>,
    value_type: Cow<'static, str>,
    structural_id: Option<String>,
    span: PySpan,
}

#[pymethods]
impl PyEvent {
    #[new]
    fn new(
        path: String,
        key: String,
        source_plane: String,
        datatype: Option<String>,
        value_type: String,
        structural_id: Option<String>,
        span: PyRef<'_, PySpan>,
    ) -> Self {
        Self {
            path,
            key,
            source_plane: Cow::Owned(source_plane),
            datatype,
            value_type: Cow::Owned(value_type),
            structural_id,
            span: span.clone(),
        }
    }

    #[getter]
    fn path(&self) -> &str {
        &self.path
    }

    #[getter]
    fn key(&self) -> &str {
        &self.key
    }

    #[getter]
    fn source_plane(&self) -> &str {
        &self.source_plane
    }

    #[getter]
    fn datatype(&self) -> Option<&str> {
        self.datatype.as_deref()
    }

    #[getter]
    fn value_type(&self) -> &str {
        &self.value_type
    }

    #[getter]
    fn structural_id(&self) -> Option<&str> {
        self.structural_id.as_deref()
    }

    #[getter]
    fn span(&self) -> PySpan {
        self.span.clone()
    }

    fn __repr__(&self) -> String {
        format!(
            "Event(path={:?}, key={:?}, source_plane={:?}, datatype={}, value_type={:?}, structural_id={}, span={:?})",
            self.path,
            self.key,
            self.source_plane,
            option_string_repr(self.datatype.as_deref()),
            self.value_type,
            option_string_repr(self.structural_id.as_deref()),
            self.span,
        )
    }
}

#[pyclass(frozen, module = "altopelago.aeon", name = "CompileResult")]
struct PyCompileResult {
    events: Py<PyTuple>,
    warnings: Py<PyTuple>,
    errors: Py<PyTuple>,
}

#[pymethods]
impl PyCompileResult {
    #[new]
    const fn new(events: Py<PyTuple>, warnings: Py<PyTuple>, errors: Py<PyTuple>) -> Self {
        Self {
            events,
            warnings,
            errors,
        }
    }

    #[getter]
    fn events(&self, py: Python<'_>) -> Py<PyTuple> {
        self.events.clone_ref(py)
    }

    #[getter]
    fn warnings(&self, py: Python<'_>) -> Py<PyTuple> {
        self.warnings.clone_ref(py)
    }

    #[getter]
    fn errors(&self, py: Python<'_>) -> Py<PyTuple> {
        self.errors.clone_ref(py)
    }

    #[getter]
    fn ok(&self, py: Python<'_>) -> bool {
        self.errors.bind(py).is_empty()
    }

    fn require_ok<'py>(slf: PyRef<'py, Self>, py: Python<'py>) -> PyResult<PyRef<'py, Self>> {
        if slf.errors.bind(py).is_empty() {
            return Ok(slf);
        }
        let error_type = py
            .import("altopelago.aeon.errors")?
            .getattr("CompileError")?;
        let error = error_type.call1((slf.errors.bind(py),))?;
        Err(PyErr::from_value(error))
    }

    fn __eq__(&self, other: PyRef<'_, Self>, py: Python<'_>) -> PyResult<bool> {
        Ok(self.events.bind(py).eq(other.events.bind(py))?
            && self.warnings.bind(py).eq(other.warnings.bind(py))?
            && self.errors.bind(py).eq(other.errors.bind(py))?)
    }

    fn __hash__(&self, py: Python<'_>) -> PyResult<isize> {
        (
            self.events.clone_ref(py),
            self.warnings.clone_ref(py),
            self.errors.clone_ref(py),
        )
            .into_pyobject(py)?
            .hash()
    }

    fn __repr__(&self, py: Python<'_>) -> PyResult<String> {
        Ok(format!(
            "CompileResult(events={}, warnings={}, errors={})",
            self.events.bind(py).repr()?.to_string_lossy(),
            self.warnings.bind(py).repr()?.to_string_lossy(),
            self.errors.bind(py).repr()?.to_string_lossy(),
        ))
    }
}

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
fn compile_packed(py: Python<'_>, source: &str) -> PackedCompileResult {
    let source = source.to_owned();
    let result = py.detach(move || compile_sofia(&source, CompileOptions::default()));
    (
        result.events.into_iter().map(packed_event).collect(),
        result.warnings.into_iter().map(packed_diagnostic).collect(),
        result.errors.into_iter().map(packed_diagnostic).collect(),
    )
}

#[pyfunction]
fn compile_native(py: Python<'_>, source: &str) -> PyResult<Py<PyCompileResult>> {
    let source = source.to_owned();
    let result = py.detach(move || compile_sofia(&source, CompileOptions::default()));
    python_compile_result(py, result)
}

#[pyfunction]
fn compile_telex(py: Python<'_>, source: &str) -> PyResult<(bool, Py<PyBytes>)> {
    let source = source.to_owned();
    let (ok, encoded) = py
        .detach(move || encode_telex_result(&source))
        .map_err(PyRuntimeError::new_err)?;
    Ok((ok, PyBytes::new(py, &encoded).unbind()))
}

/// Attribute the valid-input Telex path without including Python call overhead.
///
/// Validation and encoding operate on the same resident records. Encoding uses
/// the public AES entry point and therefore includes its own validation pass;
/// subtracting the independent validation median in the harness gives an
/// approximate wire-emission remainder.
#[pyfunction]
fn compile_telex_profile(
    py: Python<'_>,
    source: &str,
) -> PyResult<(u128, u128, u128, u128, usize, usize)> {
    let source = source.to_owned();
    py.detach(move || {
        let started = Instant::now();
        let result = compile_sofia(&source, CompileOptions::default());
        let compile_ns = started.elapsed().as_nanos();
        if !result.errors.is_empty() {
            return Err("cannot profile Telex export for invalid AEON input".to_owned());
        }

        let options = ExportTelexOptions::default();
        let started = Instant::now();
        let records = project_telex_records(&result.events, &options)
            .map_err(|error| format!("failed to project Telex records: {error}"))?;
        let project_ns = started.elapsed().as_nanos();

        let started = Instant::now();
        let validation = validate_telex_records_with_projection_and_limits(
            &records,
            options.profile.as_deref().unwrap_or("aes.complete.v1"),
            options.projection.as_deref(),
            &[],
            &options.limits,
        );
        let validation_ns = started.elapsed().as_nanos();
        if !validation.valid {
            return Err("projected Telex records failed AES validation".to_owned());
        }

        let started = Instant::now();
        let encoded = encode_telex_with_projection_and_limits(
            &records,
            options.profile.as_deref(),
            options.projection.as_deref(),
            &options.limits,
        )
        .map_err(|error| format!("failed to encode Telex: {error}"))?;
        let encode_ns = started.elapsed().as_nanos();

        Ok((
            compile_ns,
            project_ns,
            validation_ns,
            encode_ns,
            records.len(),
            encoded.len(),
        ))
    })
    .map_err(PyRuntimeError::new_err)
}

#[pymodule]
#[pyo3(name = "_native")]
fn native(module: &Bound<'_, PyModule>) -> PyResult<()> {
    module.add("ENGINE", "sofia")?;
    module.add_class::<PyPosition>()?;
    module.add_class::<PySpan>()?;
    module.add_class::<PyDiagnostic>()?;
    module.add_class::<PyEvent>()?;
    module.add_class::<PyCompileResult>()?;
    module.add_function(wrap_pyfunction!(compile_json, module)?)?;
    module.add_function(wrap_pyfunction!(compile_packed, module)?)?;
    module.add_function(wrap_pyfunction!(compile_native, module)?)?;
    module.add_function(wrap_pyfunction!(compile_telex, module)?)?;
    module.add_function(wrap_pyfunction!(compile_telex_profile, module)?)?;
    Ok(())
}

fn encode_compile_result(source: &str) -> Result<String, String> {
    let result = compile_sofia(source, CompileOptions::default());
    serde_json::to_string(&compile_envelope(&result))
        .map_err(|error| format!("failed to serialize compile result: {error}"))
}

fn encode_telex_result(source: &str) -> Result<(bool, Vec<u8>), String> {
    let result = compile_sofia(source, CompileOptions::default());
    if !result.errors.is_empty() {
        let diagnostics = result
            .errors
            .iter()
            .map(diagnostic_record)
            .collect::<Vec<_>>();
        return serde_json::to_vec(&diagnostics)
            .map(|encoded| (false, encoded))
            .map_err(|error| format!("failed to serialize compile diagnostics: {error}"));
    }
    export_telex(&result.events, &ExportTelexOptions::default())
        .map(String::into_bytes)
        .map(|encoded| (true, encoded))
        .map_err(|error| format!("failed to encode Telex: {error}"))
}

fn compile_envelope(result: &CoreCompileResult) -> CompileEnvelope {
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

fn packed_event(event: aeon_core::AssignmentEvent) -> PackedEvent {
    let source_plane = match event.source_plane {
        SourcePlane::Header => "header",
        SourcePlane::Body => "body",
    };
    let value_type = value_type_name(&event.value);
    (
        format_path(&event.path),
        event.key,
        source_plane,
        event.datatype,
        value_type,
        event.structural_id,
        packed_span(&event.span),
    )
}

fn value_type_name(value: &Value) -> &'static str {
    match value {
        Value::TypedValue { value, .. } => value_type_name(value),
        _ => value.value_kind(),
    }
}

fn diagnostic_record(diagnostic: &CoreDiagnostic) -> DiagnosticRecord {
    DiagnosticRecord {
        code: diagnostic.code.clone(),
        path: diagnostic.path.clone(),
        span: diagnostic.span.as_ref().map(span_record),
        phase: diagnostic_phase_label(diagnostic),
        message: diagnostic.message.clone(),
    }
}

fn packed_diagnostic(diagnostic: CoreDiagnostic) -> PackedDiagnostic {
    let phase = diagnostic_phase_label(&diagnostic);
    (
        diagnostic.code,
        diagnostic.message,
        diagnostic.path,
        diagnostic.span.as_ref().map(packed_span),
        phase,
    )
}

fn packed_span(span: &CoreSpan) -> PackedSpan {
    (
        span.start.line,
        span.start.column,
        span.start.offset,
        span.end.line,
        span.end.column,
        span.end.offset,
    )
}

fn span_record(span: &CoreSpan) -> SpanRecord {
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

fn diagnostic_phase_label(diagnostic: &CoreDiagnostic) -> Option<&'static str> {
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

fn python_compile_result(
    py: Python<'_>,
    result: CoreCompileResult,
) -> PyResult<Py<PyCompileResult>> {
    let events = result
        .events
        .into_iter()
        .map(|event| Py::new(py, python_event(event)))
        .collect::<PyResult<Vec<_>>>()?;
    let warnings = result
        .warnings
        .into_iter()
        .map(|diagnostic| Py::new(py, python_diagnostic(diagnostic)))
        .collect::<PyResult<Vec<_>>>()?;
    let errors = result
        .errors
        .into_iter()
        .map(|diagnostic| Py::new(py, python_diagnostic(diagnostic)))
        .collect::<PyResult<Vec<_>>>()?;
    Py::new(
        py,
        PyCompileResult {
            events: PyTuple::new(py, events)?.unbind(),
            warnings: PyTuple::new(py, warnings)?.unbind(),
            errors: PyTuple::new(py, errors)?.unbind(),
        },
    )
}

fn python_event(event: aeon_core::AssignmentEvent) -> PyEvent {
    let source_plane = match event.source_plane {
        SourcePlane::Header => "header",
        SourcePlane::Body => "body",
    };
    let value_type = value_type_name(&event.value);
    PyEvent {
        path: format_path(&event.path),
        key: event.key,
        source_plane: Cow::Borrowed(source_plane),
        datatype: event.datatype,
        value_type: Cow::Borrowed(value_type),
        structural_id: event.structural_id,
        span: python_span(&event.span),
    }
}

fn python_diagnostic(diagnostic: CoreDiagnostic) -> PyDiagnostic {
    let phase = diagnostic_phase_label(&diagnostic);
    PyDiagnostic {
        code: diagnostic.code,
        message: diagnostic.message,
        path: diagnostic.path,
        span: diagnostic.span.as_ref().map(python_span),
        phase: phase.map(Cow::Borrowed),
    }
}

fn python_span(span: &CoreSpan) -> PySpan {
    PySpan {
        start: PyPosition {
            line: span.start.line,
            column: span.start.column,
            offset: span.start.offset,
        },
        end: PyPosition {
            line: span.end.line,
            column: span.end.column,
            offset: span.end.offset,
        },
    }
}

fn option_string_repr(value: Option<&str>) -> String {
    value.map_or_else(|| String::from("None"), |value| format!("{value:?}"))
}

fn option_debug_repr(value: Option<&impl std::fmt::Debug>) -> String {
    value.map_or_else(|| String::from("None"), |value| format!("{value:?}"))
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
