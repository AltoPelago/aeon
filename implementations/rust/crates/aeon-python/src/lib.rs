use std::borrow::Cow;
use std::time::Instant;

use aeon_aeos::{
    ResultEnvelope, ValidationEnvelope, ValidationOptions, validate, validate_telex_records,
};
use aeon_canonical::{canonicalize, canonicalize_telex};
use aeon_core::{
    BehaviorMode, CompileOptions, CompileResult as CoreCompileResult, DatatypePolicy,
    Diagnostic as CoreDiagnostic, ExportTelexOptions, SourcePlane, Span as CoreSpan, Value,
    aeon_compile_limits, compile_sofia_owned, export_telex_owned, format_path, load_aeonic_limits,
    project_aes_event_records_taken,
};
use aeon_finalize::{
    FinalizeMode, FinalizeOptions, FinalizePortableJsonOptions, FinalizeScope, Materialization,
    finalize_json, finalize_portable_json,
};
use aeon_sdk::{assignment_events_to_aeos, load_schema_str};
use aes_telex::{
    encode_aes_event_records_with_projection_and_limits, parse_telex_with_limits,
    validate_aes_event_records_with_projection_and_limits,
    validate_telex_records_with_projection_and_limits,
};
use pyo3::exceptions::PyRuntimeError;
use pyo3::prelude::*;
use pyo3::types::{PyBytes, PyModule, PyTuple};
use serde::Serialize;
use serde_json::Value as JsonValue;

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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct FinalizationEnvelope {
    errors: Vec<DiagnosticRecord>,
    warnings: Vec<DiagnosticRecord>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LoadEnvelope {
    compile: CompileEnvelope,
    document: Option<JsonValue>,
    finalization: Option<FinalizationEnvelope>,
    validation: Option<ResultEnvelope>,
    schema_error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TelexLoadEnvelope {
    ok: bool,
    document: Option<JsonValue>,
    finalization: Option<FinalizationEnvelope>,
    validation: Option<ResultEnvelope>,
    error_kind: Option<&'static str>,
    error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TelexErrorEnvelope {
    code: &'static str,
    message: String,
    line: Option<usize>,
}

#[pyfunction]
fn compile_json(py: Python<'_>, source: &str) -> PyResult<Py<PyBytes>> {
    let source = source.to_owned();
    let encoded = py
        .detach(move || encode_compile_result(source))
        .map_err(PyRuntimeError::new_err)?;
    Ok(PyBytes::new(py, encoded.as_bytes()).unbind())
}

#[pyfunction]
fn canonicalize_native(py: Python<'_>, source: &str) -> PyResult<(bool, Py<PyBytes>)> {
    let source = source.to_owned();
    let (ok, encoded) = py
        .detach(move || {
            let result = canonicalize(&source);
            if result.errors.is_empty() {
                return Ok((true, result.text.into_bytes()));
            }
            serde_json::to_vec(
                &result
                    .errors
                    .iter()
                    .map(diagnostic_record)
                    .collect::<Vec<_>>(),
            )
            .map(|payload| (false, payload))
            .map_err(|error| format!("failed to serialize canonical diagnostics: {error}"))
        })
        .map_err(PyRuntimeError::new_err)?;
    Ok((ok, PyBytes::new(py, &encoded).unbind()))
}

#[pyfunction]
fn canonicalize_telex_native(py: Python<'_>, source: &str) -> PyResult<(bool, Py<PyBytes>)> {
    let source = source.to_owned();
    let (ok, encoded) = py
        .detach(move || match canonicalize_telex(&source) {
            Ok(text) => Ok((true, text.into_bytes())),
            Err(error) => serde_json::to_vec(&TelexErrorEnvelope {
                code: error.code,
                message: error.to_string(),
                line: error.line,
            })
            .map(|payload| (false, payload))
            .map_err(|json_error| format!("failed to serialize Telex error: {json_error}")),
        })
        .map_err(PyRuntimeError::new_err)?;
    Ok((ok, PyBytes::new(py, &encoded).unbind()))
}

#[pyfunction(signature = (source, mode="strict", scope="payload", schema=None))]
fn load_json(
    py: Python<'_>,
    source: &str,
    mode: &str,
    scope: &str,
    schema: Option<&str>,
) -> PyResult<Py<PyBytes>> {
    let source = source.to_owned();
    let mode = parse_finalize_mode(mode).map_err(PyRuntimeError::new_err)?;
    let scope = parse_finalize_scope(scope).map_err(PyRuntimeError::new_err)?;
    let schema = schema.map(str::to_owned);
    let encoded = py
        .detach(move || encode_load_result(source, mode, scope, schema.as_deref()))
        .map_err(PyRuntimeError::new_err)?;
    Ok(PyBytes::new(py, encoded.as_bytes()).unbind())
}

#[pyfunction(signature = (source, mode="strict", scope="payload", schema=None))]
fn load_telex_json(
    py: Python<'_>,
    source: &str,
    mode: &str,
    scope: &str,
    schema: Option<&str>,
) -> PyResult<Py<PyBytes>> {
    let source = source.to_owned();
    let mode = parse_finalize_mode(mode).map_err(PyRuntimeError::new_err)?;
    let scope = parse_finalize_scope(scope).map_err(PyRuntimeError::new_err)?;
    let schema = schema.map(str::to_owned);
    let encoded = py
        .detach(move || encode_telex_load_result(&source, mode, scope, schema.as_deref()))
        .map_err(PyRuntimeError::new_err)?;
    Ok(PyBytes::new(py, encoded.as_bytes()).unbind())
}

#[allow(clippy::too_many_arguments)]
#[pyfunction(signature = (
    source,
    mode=None,
    datatype_policy=None,
    rich=false,
    limits_source=None,
    max_attribute_depth=None,
    max_separator_depth=None,
    max_generic_depth=None,
    max_events=None
))]
fn compile_cts_json(
    py: Python<'_>,
    source: &str,
    mode: Option<&str>,
    datatype_policy: Option<&str>,
    rich: bool,
    limits_source: Option<&str>,
    max_attribute_depth: Option<usize>,
    max_separator_depth: Option<usize>,
    max_generic_depth: Option<usize>,
    max_events: Option<usize>,
) -> PyResult<Py<PyBytes>> {
    let source = source.to_owned();
    let mode = mode.map(str::to_owned);
    let datatype_policy = datatype_policy.map(str::to_owned);
    let limits_source = limits_source.map(str::to_owned);
    let encoded = py
        .detach(move || {
            let options = cts_compile_options(
                mode.as_deref(),
                datatype_policy.as_deref(),
                rich,
                limits_source.as_deref(),
                max_attribute_depth,
                max_separator_depth,
                max_generic_depth,
                max_events,
            )?;
            let result = compile_sofia_owned(source, options);
            serde_json::to_string(&compile_envelope(&result))
                .map_err(|error| format!("failed to serialize CTS compile result: {error}"))
        })
        .map_err(PyRuntimeError::new_err)?;
    Ok(PyBytes::new(py, encoded.as_bytes()).unbind())
}

#[pyfunction]
fn compile_packed(py: Python<'_>, source: &str) -> PackedCompileResult {
    let source = source.to_owned();
    let result = py.detach(move || compile_sofia_owned(source, CompileOptions::default()));
    (
        result.events.into_iter().map(packed_event).collect(),
        result.warnings.into_iter().map(packed_diagnostic).collect(),
        result.errors.into_iter().map(packed_diagnostic).collect(),
    )
}

#[pyfunction]
fn compile_native(py: Python<'_>, source: &str) -> PyResult<Py<PyCompileResult>> {
    let source = source.to_owned();
    let result = py.detach(move || compile_sofia_owned(source, CompileOptions::default()));
    python_compile_result(py, result)
}

#[pyfunction]
fn compile_telex(py: Python<'_>, source: &str) -> PyResult<(bool, Py<PyBytes>)> {
    let source = source.to_owned();
    let (ok, encoded) = py
        .detach(move || encode_telex_result(source))
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
        let result = compile_sofia_owned(source, telex_compile_options());
        let compile_ns = started.elapsed().as_nanos();
        if !result.errors.is_empty() {
            return Err("cannot profile Telex export for invalid AEON input".to_owned());
        }

        let options = ExportTelexOptions::default();
        let started = Instant::now();
        let mut events = result.events;
        let records = project_aes_event_records_taken(&mut events);
        let project_ns = started.elapsed().as_nanos();

        let started = Instant::now();
        let validation = validate_aes_event_records_with_projection_and_limits(
            &records,
            options.profile.as_deref().unwrap_or("aes.complete.v1"),
            options.projection.as_deref(),
            &options.limits,
        );
        let validation_ns = started.elapsed().as_nanos();
        if !validation.valid {
            return Err(format!(
                "projected Telex records failed AES validation: {:?}",
                validation.diagnostics
            ));
        }

        let started = Instant::now();
        let encoded = encode_aes_event_records_with_projection_and_limits(
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
    module.add_function(wrap_pyfunction!(compile_cts_json, module)?)?;
    module.add_function(wrap_pyfunction!(compile_packed, module)?)?;
    module.add_function(wrap_pyfunction!(compile_native, module)?)?;
    module.add_function(wrap_pyfunction!(compile_telex, module)?)?;
    module.add_function(wrap_pyfunction!(compile_telex_profile, module)?)?;
    module.add_function(wrap_pyfunction!(canonicalize_native, module)?)?;
    module.add_function(wrap_pyfunction!(canonicalize_telex_native, module)?)?;
    module.add_function(wrap_pyfunction!(load_json, module)?)?;
    module.add_function(wrap_pyfunction!(load_telex_json, module)?)?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn cts_compile_options(
    mode: Option<&str>,
    datatype_policy: Option<&str>,
    rich: bool,
    limits_source: Option<&str>,
    max_attribute_depth: Option<usize>,
    max_separator_depth: Option<usize>,
    max_generic_depth: Option<usize>,
    max_events: Option<usize>,
) -> Result<CompileOptions, String> {
    let mut options = CompileOptions::default();
    if let Some(limits_source) = limits_source {
        let limits = load_aeonic_limits(limits_source).map_err(|diagnostics| {
            diagnostics
                .into_iter()
                .map(|diagnostic| {
                    format!(
                        "[{}] {}: {}",
                        diagnostic.code, diagnostic.path, diagnostic.message
                    )
                })
                .collect::<Vec<_>>()
                .join("\n")
        })?;
        let limits = aeon_compile_limits(&limits).map_err(|diagnostic| {
            format!(
                "[{}] {}: {}",
                diagnostic.code, diagnostic.path, diagnostic.message
            )
        })?;
        options.max_input_bytes = limits.max_input_bytes;
        options.max_events = limits.max_events;
        options.max_attribute_depth = limits.max_attribute_depth;
        options.max_clarifier_values = Some(limits.max_clarifier_values);
        options.max_generic_depth = limits.max_generic_depth;
        options.max_generic_arguments = limits.max_generic_arguments;
        options.max_datatype_components = limits.max_datatype_components;
        options.max_value_nesting_depth = Some(limits.max_value_nesting_depth);
        options.max_path_depth = limits.max_path_depth;
        options.max_string_codepoints = limits.max_string_codepoints;
        options.max_key_segment_codepoints = limits.max_key_segment_codepoints;
        options.max_list_items = limits.max_list_items;
        options.max_tuple_items = limits.max_tuple_items;
        options.max_path_characters = limits.max_path_characters;
        options.max_numeric_literal_characters = limits.max_numeric_literal_characters;
        options.max_structured_comment_characters = limits.max_structured_comment_characters;
    }
    options.mode = match mode {
        None => None,
        Some("strict") => Some(BehaviorMode::Strict),
        Some("transport") => Some(BehaviorMode::Transport),
        Some(value) => return Err(format!("unsupported CTS behavior mode: {value}")),
    };
    options.datatype_policy = match (rich, datatype_policy) {
        (true, Some("reserved_only")) => {
            return Err(String::from(
                "rich mode cannot use the reserved_only datatype policy",
            ));
        }
        (true, _) | (false, Some("allow_custom")) => Some(DatatypePolicy::AllowCustom),
        (false, Some("reserved_only")) => Some(DatatypePolicy::ReservedOnly),
        (false, None) => None,
        (false, Some(value)) => return Err(format!("unsupported CTS datatype policy: {value}")),
    };
    if let Some(value) = max_attribute_depth {
        options.max_attribute_depth = value;
    }
    if let Some(value) = max_separator_depth {
        options.max_clarifier_values = Some(value);
    }
    if let Some(value) = max_generic_depth {
        options.max_generic_depth = value;
    }
    if max_events.is_some() {
        options.max_events = max_events;
    }
    Ok(options)
}

fn encode_compile_result(source: String) -> Result<String, String> {
    let result = compile_sofia_owned(source, CompileOptions::default());
    serde_json::to_string(&compile_envelope(&result))
        .map_err(|error| format!("failed to serialize compile result: {error}"))
}

fn encode_load_result(
    source: String,
    mode: FinalizeMode,
    scope: FinalizeScope,
    schema_source: Option<&str>,
) -> Result<String, String> {
    let result = compile_sofia_owned(source, CompileOptions::default());
    let compile = compile_envelope(&result);
    if !result.errors.is_empty() {
        return serialize_load_envelope(LoadEnvelope {
            compile,
            document: None,
            finalization: None,
            validation: None,
            schema_error: None,
        });
    }

    let mut schema_error = None;
    let validation = schema_source.and_then(|source| match load_schema_str(source) {
        Ok(schema) => Some(validate(&ValidationEnvelope {
            aes: assignment_events_to_aeos(&result.events),
            schema: Some(schema),
            options: ValidationOptions::default(),
        })),
        Err(error) => {
            schema_error = Some(error.to_string());
            None
        }
    });
    let finalized = finalize_json(
        &result.events,
        FinalizeOptions {
            mode,
            materialization: Materialization::All,
            include_paths: Vec::new(),
            scope,
            header: result.header.clone(),
            max_materialized_weight: None,
            max_reference_depth: None,
        },
    );
    let finalization = finalization_envelope(&finalized.meta);
    serialize_load_envelope(LoadEnvelope {
        compile,
        document: Some(finalized.document),
        finalization: Some(finalization),
        validation,
        schema_error,
    })
}

fn serialize_load_envelope(envelope: LoadEnvelope) -> Result<String, String> {
    serde_json::to_string(&envelope)
        .map_err(|error| format!("failed to serialize AEON load result: {error}"))
}

fn encode_telex_load_result(
    source: &str,
    mode: FinalizeMode,
    scope: FinalizeScope,
    schema_source: Option<&str>,
) -> Result<String, String> {
    let schema = match schema_source {
        Some(source) => match load_schema_str(source) {
            Ok(schema) => Some(schema),
            Err(error) => {
                return serialize_telex_load_envelope(TelexLoadEnvelope {
                    ok: false,
                    document: None,
                    finalization: None,
                    validation: None,
                    error_kind: Some("schema"),
                    error: Some(error.to_string()),
                });
            }
        },
        None => None,
    };
    let mut finalize = FinalizePortableJsonOptions {
        mode,
        scope,
        ..FinalizePortableJsonOptions::default()
    };
    let parsed = match parse_telex_with_limits(source, &finalize.limits) {
        Ok(parsed) => parsed,
        Err(error) => {
            return serialize_telex_load_envelope(TelexLoadEnvelope {
                ok: false,
                document: None,
                finalization: None,
                validation: None,
                error_kind: Some("telex_syntax"),
                error: Some(error.to_string()),
            });
        }
    };
    let portable = validate_telex_records_with_projection_and_limits(
        &parsed.records,
        &parsed.profile,
        parsed.projection.as_deref(),
        &[],
        &finalize.limits,
    );
    if !portable.valid {
        let message = portable
            .diagnostics
            .iter()
            .map(|diagnostic| format!("{}: {}", diagnostic.code, diagnostic.message))
            .collect::<Vec<_>>()
            .join("\n");
        return serialize_telex_load_envelope(TelexLoadEnvelope {
            ok: false,
            document: None,
            finalization: None,
            validation: None,
            error_kind: Some("telex_validation"),
            error: Some(message),
        });
    }
    let validation = schema.map(|schema| {
        validate_telex_records(&parsed.records, Some(schema), ValidationOptions::default())
    });
    finalize.profile = parsed.profile;
    finalize.projection = parsed.projection;
    let finalized = finalize_portable_json(&parsed.records, finalize);
    let ok = finalized.meta.errors.is_empty()
        && validation
            .as_ref()
            .is_none_or(|result| result.errors.is_empty());
    serialize_telex_load_envelope(TelexLoadEnvelope {
        ok,
        document: Some(finalized.document),
        finalization: Some(finalization_envelope(&finalized.meta)),
        validation,
        error_kind: None,
        error: None,
    })
}

fn serialize_telex_load_envelope(envelope: TelexLoadEnvelope) -> Result<String, String> {
    serde_json::to_string(&envelope)
        .map_err(|error| format!("failed to serialize Telex load result: {error}"))
}

fn finalization_envelope(meta: &aeon_finalize::FinalizeMeta) -> FinalizationEnvelope {
    FinalizationEnvelope {
        errors: meta.errors.iter().map(diagnostic_record).collect(),
        warnings: meta.warnings.iter().map(diagnostic_record).collect(),
    }
}

fn parse_finalize_mode(value: &str) -> Result<FinalizeMode, String> {
    match value {
        "strict" => Ok(FinalizeMode::Strict),
        "loose" => Ok(FinalizeMode::Loose),
        _ => Err(format!(
            "unsupported finalization mode {value:?}; expected 'strict' or 'loose'"
        )),
    }
}

fn parse_finalize_scope(value: &str) -> Result<FinalizeScope, String> {
    match value {
        "payload" => Ok(FinalizeScope::Payload),
        "header" => Ok(FinalizeScope::Header),
        "full" => Ok(FinalizeScope::Full),
        _ => Err(format!(
            "unsupported finalization scope {value:?}; expected 'payload', 'header', or 'full'"
        )),
    }
}

fn encode_telex_result(source: String) -> Result<(bool, Vec<u8>), String> {
    let result = compile_sofia_owned(source, telex_compile_options());
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
    export_telex_owned(result.events, &ExportTelexOptions::default())
        .map(String::into_bytes)
        .map(|encoded| (true, encoded))
        .map_err(|error| format!("failed to encode Telex: {error}"))
}

fn telex_compile_options() -> CompileOptions {
    CompileOptions {
        // Binding projections are a separate compile-result view and are not
        // part of the Telex event stream.
        emit_binding_projections: false,
        ..CompileOptions::default()
    }
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
