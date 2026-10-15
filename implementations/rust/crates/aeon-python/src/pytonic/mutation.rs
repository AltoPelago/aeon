//! Python conversion and immutable views; SANSA owns planning and validation.
use super::*;
use aeon_sdk::sansa_document::{AeonMutationPlan, AeonMutationPlanResult};
use pyo3::types::{PyBool, PyDict, PyFloat, PyInt, PyList, PyString};
use runtime::mutate::*;

type NativeTarget = MutationTarget<AeonSansaBinding>;

#[pyclass(frozen, module = "altopelago.aeon.pytonic", name = "MutationResult")]
pub(super) struct PyMutationResult {
    plan: Option<PyMutationPlan>,
    errors: Vec<PyMutationDiagnostic>,
}

#[pymethods]
impl PyMutationResult {
    #[getter]
    fn ok(&self) -> bool {
        self.errors.is_empty()
    }
    #[getter]
    fn plan(&self) -> Option<PyMutationPlan> {
        self.plan.clone()
    }
    #[getter]
    fn errors(&self, py: Python<'_>) -> PyResult<Py<PyTuple>> {
        diagnostic_tuple(py, &self.errors)
    }
}

#[pyclass(
    frozen,
    skip_from_py_object,
    module = "altopelago.aeon.pytonic",
    name = "MutationPlan"
)]
#[derive(Clone)]
pub(super) struct PyMutationPlan {
    inner: Arc<AeonMutationPlan>,
    document: Arc<AeonDocument>,
    scope: DocumentScope,
}

#[pymethods]
impl PyMutationPlan {
    #[getter]
    fn plan_version(&self) -> &'static str {
        self.inner.plan().plan_version()
    }
    #[getter]
    fn plan_id(&self) -> Option<&str> {
        self.inner.plan().plan_id()
    }
    #[getter]
    fn operations(&self, py: Python<'_>) -> PyResult<Py<PyTuple>> {
        let values = (0..self.inner.plan().operations().len())
            .map(|index| {
                Py::new(
                    py,
                    PyMutationOperation {
                        plan: self.clone(),
                        index,
                    },
                )
            })
            .collect::<PyResult<Vec<_>>>()?;
        Ok(PyTuple::new(py, values)?.unbind())
    }
    #[getter]
    fn preconditions(&self, py: Python<'_>) -> PyResult<Py<PyTuple>> {
        let values = self
            .inner
            .plan()
            .preconditions()
            .iter()
            .map(|entry| {
                Py::new(
                    py,
                    PyMutationPrecondition {
                        expression: entry.expression.clone(),
                        canonical: entry.canonical.clone(),
                        target: entry.target.as_ref().map(|target| self.target_view(target)),
                        warnings: entry
                            .portability_warnings
                            .iter()
                            .cloned()
                            .map(PySansaDiagnostic::from)
                            .collect(),
                    },
                )
            })
            .collect::<PyResult<Vec<_>>>()?;
        Ok(PyTuple::new(py, values)?.unbind())
    }
    #[getter]
    fn source_provenance(&self, py: Python<'_>) -> PyResult<Py<PyAny>> {
        value_object(py, self.inner.plan().source_provenance())
    }
    #[getter]
    fn diagnostics(&self, py: Python<'_>) -> PyResult<Py<PyTuple>> {
        let diagnostics = self
            .inner
            .plan()
            .diagnostics()
            .iter()
            .cloned()
            .map(PyMutationDiagnostic::from)
            .collect::<Vec<_>>();
        diagnostic_tuple(py, &diagnostics)
    }
    #[getter]
    fn portability_warnings(&self, py: Python<'_>) -> PyResult<Py<PyTuple>> {
        warning_tuple(py, self.inner.plan().portability_warnings())
    }
    #[pyo3(signature = (target="aeon"))]
    fn validate_target(&self, target: &str) -> PyMutationValidation {
        use runtime::mutate_target::ValidateMutationPlanTargetResult;
        let errors = match self.inner.validate_target(target) {
            ValidateMutationPlanTargetResult::Validated { .. } => Vec::new(),
            ValidateMutationPlanTargetResult::Rejected(errors) => {
                errors.into_iter().map(PyMutationDiagnostic::from).collect()
            }
        };
        PyMutationValidation { errors }
    }
}

impl PyMutationPlan {
    fn target_view(&self, target: &NativeTarget) -> PyMutationTarget {
        PyMutationTarget {
            target: target.clone(),
            document: Arc::clone(&self.document),
            scope: self.scope,
        }
    }
}

#[pyclass(frozen, module = "altopelago.aeon.pytonic", name = "MutationOperation")]
struct PyMutationOperation {
    plan: PyMutationPlan,
    index: usize,
}

impl PyMutationOperation {
    fn operation(&self) -> &MutationOperation<AeonSansaBinding> {
        &self.plan.inner.plan().operations()[self.index]
    }
    fn intent(&self) -> Option<&MutationValueIntent> {
        match self.operation() {
            MutationOperation::Create { value, .. }
            | MutationOperation::Replace { value, .. }
            | MutationOperation::Insert { value, .. } => Some(value),
            _ => None,
        }
    }
    fn placement_data(&self) -> Option<&MutationPlacement<AeonSansaBinding>> {
        match self.operation() {
            MutationOperation::Insert { placement, .. }
            | MutationOperation::Move { placement, .. } => Some(placement),
            _ => None,
        }
    }
}

#[pymethods]
impl PyMutationOperation {
    #[getter]
    fn op(&self) -> &'static str {
        self.operation().kind().as_str()
    }
    #[getter]
    fn target(&self) -> Option<PyMutationTarget> {
        match self.operation() {
            MutationOperation::Replace { target, .. }
            | MutationOperation::Remove { target, .. } => Some(self.plan.target_view(target)),
            _ => None,
        }
    }
    #[getter]
    fn parent(&self) -> Option<PyMutationTarget> {
        match self.operation() {
            MutationOperation::Create { parent, .. } => Some(self.plan.target_view(parent)),
            _ => None,
        }
    }
    #[getter]
    fn source(&self) -> Option<PyMutationTarget> {
        match self.operation() {
            MutationOperation::Move { source, .. } => Some(self.plan.target_view(source)),
            _ => None,
        }
    }
    #[getter]
    fn container(&self) -> Option<PyMutationTarget> {
        match self.operation() {
            MutationOperation::Insert { container, .. }
            | MutationOperation::Move { container, .. } => Some(self.plan.target_view(container)),
            _ => None,
        }
    }
    #[getter]
    fn name(&self) -> Option<&str> {
        match self.operation() {
            MutationOperation::Create { name, .. } => Some(name),
            _ => None,
        }
    }
    #[getter]
    fn has_value(&self) -> bool {
        self.intent().is_some()
    }
    #[getter]
    fn value(&self, py: Python<'_>) -> PyResult<Py<PyAny>> {
        value_object(py, self.intent().map(|intent| &intent.value))
    }
    #[getter]
    fn datatype(&self) -> Option<&str> {
        self.intent().and_then(|intent| intent.datatype.as_deref())
    }
    #[getter]
    fn kind(&self) -> Option<&str> {
        self.intent().and_then(|intent| intent.kind.as_deref())
    }
    #[getter]
    fn placement(&self) -> Option<&'static str> {
        self.placement_data().map(|placement| match placement {
            MutationPlacement::First => "first",
            MutationPlacement::Last => "last",
            MutationPlacement::Before(_) => "before",
            MutationPlacement::After(_) => "after",
        })
    }
    #[getter]
    fn anchor(&self) -> Option<PyMutationTarget> {
        match self.placement_data()? {
            MutationPlacement::Before(target) | MutationPlacement::After(target) => {
                Some(self.plan.target_view(target))
            }
            _ => None,
        }
    }
    #[getter]
    fn provenance(&self, py: Python<'_>) -> PyResult<Py<PyAny>> {
        let provenance = match self.operation() {
            MutationOperation::Create { provenance, .. }
            | MutationOperation::Replace { provenance, .. }
            | MutationOperation::Remove { provenance, .. }
            | MutationOperation::Insert { provenance, .. }
            | MutationOperation::Move { provenance, .. } => provenance.as_ref(),
        };
        value_object(py, provenance)
    }
}

#[pyclass(
    frozen,
    skip_from_py_object,
    module = "altopelago.aeon.pytonic",
    name = "MutationTarget"
)]
#[derive(Clone)]
struct PyMutationTarget {
    target: NativeTarget,
    document: Arc<AeonDocument>,
    scope: DocumentScope,
}

#[pymethods]
impl PyMutationTarget {
    #[getter]
    fn requested_address(&self) -> &str {
        &self.target.requested_address
    }
    #[getter]
    fn canonical_address(&self) -> &str {
        &self.target.canonical_address
    }
    #[getter]
    fn representation_kind(&self) -> Option<&str> {
        self.target.representation_kind.as_deref()
    }
    #[getter]
    fn binding(&self) -> PyResult<PyBinding> {
        python_binding(&self.document, self.scope, &self.target.binding)
    }
    #[getter]
    fn portability_warnings(&self, py: Python<'_>) -> PyResult<Py<PyTuple>> {
        warning_tuple(py, &self.target.portability_warnings)
    }
}

#[pyclass(
    frozen,
    module = "altopelago.aeon.pytonic",
    name = "MutationPrecondition"
)]
struct PyMutationPrecondition {
    #[pyo3(get)]
    expression: String,
    #[pyo3(get)]
    canonical: String,
    #[pyo3(get)]
    target: Option<PyMutationTarget>,
    warnings: Vec<PySansaDiagnostic>,
}

#[pymethods]
impl PyMutationPrecondition {
    #[getter]
    fn portability_warnings(&self, py: Python<'_>) -> PyResult<Py<PyTuple>> {
        let warnings = self
            .warnings
            .iter()
            .cloned()
            .map(|warning| Py::new(py, warning))
            .collect::<PyResult<Vec<_>>>()?;
        Ok(PyTuple::new(py, warnings)?.unbind())
    }
}

#[pyclass(
    frozen,
    module = "altopelago.aeon.pytonic",
    name = "MutationValidation"
)]
struct PyMutationValidation {
    errors: Vec<PyMutationDiagnostic>,
}

#[pymethods]
impl PyMutationValidation {
    #[getter]
    fn ok(&self) -> bool {
        self.errors.is_empty()
    }
    #[getter]
    fn errors(&self, py: Python<'_>) -> PyResult<Py<PyTuple>> {
        diagnostic_tuple(py, &self.errors)
    }
}

#[pyclass(
    frozen,
    skip_from_py_object,
    module = "altopelago.aeon.pytonic",
    name = "MutationDiagnostic"
)]
#[derive(Clone)]
struct PyMutationDiagnostic {
    #[pyo3(get)]
    code: String,
    #[pyo3(get)]
    message: String,
    #[pyo3(get)]
    phase: &'static str,
    #[pyo3(get)]
    operation_index: Option<usize>,
    #[pyo3(get)]
    precondition_index: Option<usize>,
    #[pyo3(get)]
    budget: Option<String>,
    #[pyo3(get)]
    limit: Option<usize>,
    #[pyo3(get)]
    observed: Option<usize>,
    #[pyo3(get)]
    request_field: Option<String>,
    #[pyo3(get)]
    operation_field: Option<String>,
    #[pyo3(get)]
    target_format: Option<String>,
    #[pyo3(get)]
    datatype: Option<String>,
    #[pyo3(get)]
    value_path: Option<String>,
}

impl From<MutationDiagnostic> for PyMutationDiagnostic {
    fn from(error: MutationDiagnostic) -> Self {
        Self {
            code: error.code,
            message: error.message,
            phase: match error.phase {
                MutationPhase::Plan => "plan",
                MutationPhase::Target => "target",
                MutationPhase::Policy => "policy",
                MutationPhase::Apply => "apply",
            },
            operation_index: error.operation_index,
            precondition_index: error.precondition_index,
            budget: error.budget,
            limit: error.limit,
            observed: error.observed,
            request_field: error.request_field,
            operation_field: error.operation_field,
            target_format: error.target_format,
            datatype: error.datatype,
            value_path: error.value_path,
        }
    }
}

fn diagnostic_tuple(py: Python<'_>, errors: &[PyMutationDiagnostic]) -> PyResult<Py<PyTuple>> {
    let errors = errors
        .iter()
        .cloned()
        .map(|error| Py::new(py, error))
        .collect::<PyResult<Vec<_>>>()?;
    Ok(PyTuple::new(py, errors)?.unbind())
}

fn warning_tuple(py: Python<'_>, warnings: &[runtime::Diagnostic]) -> PyResult<Py<PyTuple>> {
    let warnings = warnings
        .iter()
        .cloned()
        .map(PySansaDiagnostic::from)
        .map(|warning| Py::new(py, warning))
        .collect::<PyResult<Vec<_>>>()?;
    Ok(PyTuple::new(py, warnings)?.unbind())
}

fn value_data(value: &MutationValue) -> PyQueryValueData {
    match value {
        MutationValue::Null => PyQueryValueData::Null,
        MutationValue::Scalar(value) => python_query_scalar(value.as_value().clone()),
        MutationValue::Sequence(values) => {
            PyQueryValueData::Sequence(values.iter().map(value_data).collect())
        }
        MutationValue::Object(fields) => PyQueryValueData::Object(
            fields
                .iter()
                .map(|(key, value)| (key.clone(), value_data(value)))
                .collect(),
        ),
    }
}

fn value_object(py: Python<'_>, value: Option<&MutationValue>) -> PyResult<Py<PyAny>> {
    value.map_or_else(
        || Ok(py.None()),
        |value| query_value_object(py, &value_data(value)),
    )
}

// This conversion is deliberately bounded before Rust's semantic budget checks.
// It also terminates cyclic Python containers without recursive stack overflow.
#[derive(Default)]
struct Conversion {
    nodes: usize,
}
impl Conversion {
    fn value(&mut self, input: &Bound<'_, PyAny>, depth: usize) -> PyResult<MutationValue> {
        self.nodes += 1;
        if depth > 128 || self.nodes > 100_000 {
            return Err(PyValueError::new_err(
                "mutation input conversion exceeds 128 levels or 100000 value nodes",
            ));
        }
        if input.is_none() {
            return Ok(MutationValue::Null);
        }
        if let Ok(value) = input.extract::<PyRef<'_, PyQueryScalar>>() {
            return wrap_scalar(value.native.clone());
        }
        if let Ok(value) = input.extract::<PyRef<'_, PyValue>>() {
            return wrap_scalar(value.native.clone().ok_or_else(|| {
                PyTypeError::new_err(
                    "container Value descriptors cannot be used as scalar mutation values",
                )
            })?);
        }
        if input.is_instance_of::<PyBool>() {
            return wrap_scalar(runtime::value_semantics::Value::Boolean(input.extract()?));
        }
        if input.is_instance_of::<PyInt>() {
            // Read the built-in numeric payload, not a subclass's __str__.
            let text = input
                .py()
                .get_type::<PyInt>()
                .getattr("__repr__")?
                .call1((input,))?
                .extract::<String>()?;
            return finite_scalar(&text);
        }
        if input.is_instance_of::<PyFloat>() {
            let value = input.extract::<f64>()?;
            return if value.is_nan() {
                wrap_scalar(runtime::value_semantics::Value::Nan)
            } else if value == f64::INFINITY {
                wrap_scalar(runtime::value_semantics::Value::PositiveInfinity)
            } else if value == f64::NEG_INFINITY {
                wrap_scalar(runtime::value_semantics::Value::NegativeInfinity)
            } else {
                let text = input
                    .py()
                    .get_type::<PyFloat>()
                    .getattr("__repr__")?
                    .call1((input,))?
                    .extract::<String>()?;
                finite_scalar(&text)
            };
        }
        if input.is_instance_of::<PyString>() {
            return wrap_scalar(runtime::value_semantics::Value::String(input.extract()?));
        }
        if let Ok(fields) = input.cast::<PyDict>() {
            self.check_width(fields.len())?;
            return fields
                .iter()
                .map(|(name, value)| {
                    Ok((name.extract::<String>()?, self.value(&value, depth + 1)?))
                })
                .collect::<PyResult<Vec<_>>>()
                .map(MutationValue::Object);
        }
        if let Ok(values) = input.cast::<PyList>() {
            self.check_width(values.len())?;
            return values
                .iter()
                .map(|value| self.value(&value, depth + 1))
                .collect::<PyResult<Vec<_>>>()
                .map(MutationValue::Sequence);
        }
        if let Ok(values) = input.cast::<PyTuple>() {
            self.check_width(values.len())?;
            return values
                .iter()
                .map(|value| self.value(&value, depth + 1))
                .collect::<PyResult<Vec<_>>>()
                .map(MutationValue::Sequence);
        }
        Err(PyTypeError::new_err(
            "mutation values must be None, bool, int, float, str, dict, list, tuple, Value or QueryScalar",
        ))
    }

    fn check_width(&self, children: usize) -> PyResult<()> {
        if children > 100_000 - self.nodes {
            return Err(PyValueError::new_err(
                "mutation input conversion exceeds 100000 value nodes",
            ));
        }
        Ok(())
    }
}

fn wrap_scalar(value: runtime::value_semantics::Value) -> PyResult<MutationValue> {
    MutationValue::try_scalar(value).map_err(|error| PyTypeError::new_err(error.to_string()))
}
fn finite_scalar(text: &str) -> PyResult<MutationValue> {
    use runtime::value_semantics::{FiniteNumber, Value};
    wrap_scalar(Value::FiniteNumber(
        FiniteNumber::parse(text).map_err(|error| PyValueError::new_err(error.message))?,
    ))
}

fn dict<'py>(input: &'py Bound<'py, PyAny>) -> PyResult<&'py Bound<'py, PyDict>> {
    input.cast::<PyDict>().map_err(|_| {
        PyTypeError::new_err(
            "mutation requests, operations, preconditions and budgets must be dictionaries",
        )
    })
}
fn closed(input: &Bound<'_, PyDict>, allowed: &[&str]) -> PyResult<()> {
    for key in input.keys() {
        let name = key.extract::<String>()?;
        if !allowed.contains(&name.as_str()) {
            return Err(PyValueError::new_err(format!(
                "unsupported mutation field {name:?}"
            )));
        }
    }
    Ok(())
}
fn required<'py>(input: &Bound<'py, PyDict>, field: &str) -> PyResult<Bound<'py, PyAny>> {
    input
        .get_item(field)?
        .ok_or_else(|| PyValueError::new_err(format!("missing mutation field {field:?}")))
}
fn text(input: &Bound<'_, PyDict>, field: &str) -> PyResult<String> {
    required(input, field)?.extract()
}
fn optional_text(input: &Bound<'_, PyDict>, field: &str) -> PyResult<Option<String>> {
    input
        .get_item(field)?
        .map(|value| value.extract())
        .transpose()
}
fn optional_value(
    input: &Bound<'_, PyDict>,
    field: &str,
    conversion: &mut Conversion,
) -> PyResult<Option<MutationValue>> {
    input
        .get_item(field)?
        .map(|value| conversion.value(&value, 1))
        .transpose()
}
fn intent(input: &Bound<'_, PyDict>, conversion: &mut Conversion) -> PyResult<MutationValueIntent> {
    Ok(MutationValueIntent {
        value: conversion.value(&required(input, "value")?, 1)?,
        datatype: optional_text(input, "datatype")?,
        kind: optional_text(input, "kind")?,
    })
}
fn placement(input: &Bound<'_, PyDict>) -> PyResult<RequestedMutationPlacement> {
    let value = required(input, "placement")?;
    let (kind, anchor) = if let Ok(kind) = value.extract::<String>() {
        (kind, None)
    } else {
        let value = dict(&value)?;
        closed(value, &["kind", "anchor"])?;
        (text(value, "kind")?, optional_text(value, "anchor")?)
    };
    match (kind.as_str(), anchor) {
        ("first", None) => Ok(RequestedMutationPlacement::First),
        ("last", None) => Ok(RequestedMutationPlacement::Last),
        ("before", Some(anchor)) => Ok(RequestedMutationPlacement::Before(anchor.into())),
        ("after", Some(anchor)) => Ok(RequestedMutationPlacement::After(anchor.into())),
        _ => Err(PyValueError::new_err(
            "placement must be first/last or a before/after dictionary with an anchor",
        )),
    }
}
fn operation(
    input: &Bound<'_, PyAny>,
    conversion: &mut Conversion,
) -> PyResult<RequestedMutationOperation> {
    let input = dict(input)?;
    let op = text(input, "op")?;
    let allowed: &[&str] = match op.as_str() {
        "create" => &[
            "op",
            "parent",
            "name",
            "value",
            "datatype",
            "kind",
            "provenance",
        ],
        "replace" => &["op", "target", "value", "datatype", "kind", "provenance"],
        "remove" => &["op", "target", "provenance"],
        "insert" => &[
            "op",
            "container",
            "placement",
            "value",
            "datatype",
            "kind",
            "provenance",
        ],
        "move" => &["op", "source", "container", "placement", "provenance"],
        _ => {
            return Err(PyValueError::new_err(format!(
                "unsupported mutation operation {op:?}"
            )));
        }
    };
    closed(input, allowed)?;
    let provenance = optional_value(input, "provenance", conversion)?;
    Ok(match op.as_str() {
        "create" => RequestedMutationOperation::Create(RequestedCreateOperation {
            parent: text(input, "parent")?.into(),
            name: text(input, "name")?,
            value: intent(input, conversion)?,
            provenance,
        }),
        "replace" => RequestedMutationOperation::Replace(RequestedReplaceOperation {
            target: text(input, "target")?.into(),
            value: intent(input, conversion)?,
            provenance,
        }),
        "remove" => RequestedMutationOperation::Remove(RequestedRemoveOperation {
            target: text(input, "target")?.into(),
            provenance,
        }),
        "insert" => RequestedMutationOperation::Insert(RequestedInsertOperation {
            container: text(input, "container")?.into(),
            placement: placement(input)?,
            value: intent(input, conversion)?,
            provenance,
        }),
        "move" => RequestedMutationOperation::Move(RequestedMoveOperation {
            source: text(input, "source")?.into(),
            container: text(input, "container")?.into(),
            placement: placement(input)?,
            provenance,
        }),
        _ => unreachable!("operation checked above"),
    })
}
fn sequence<'py>(input: &Bound<'py, PyAny>) -> PyResult<Vec<Bound<'py, PyAny>>> {
    if let Ok(values) = input.cast::<PyList>() {
        if values.len() > 100_000 {
            return Err(PyValueError::new_err("too many Python mutation entries"));
        }
        return Ok(values.iter().collect());
    }
    if let Ok(values) = input.cast::<PyTuple>() {
        if values.len() > 100_000 {
            return Err(PyValueError::new_err("too many Python mutation entries"));
        }
        return Ok(values.iter().collect());
    }
    Err(PyTypeError::new_err(
        "operations and preconditions must be lists or tuples",
    ))
}
fn request(input: &Bound<'_, PyAny>) -> PyResult<MutationRequest> {
    let input_dict = dict(input)?;
    let mut conversion = Conversion::default();
    if input_dict.contains("op")? {
        return Ok(MutationRequest {
            operations: vec![operation(input, &mut conversion)?],
            ..Default::default()
        });
    }
    closed(input_dict, &["operations", "preconditions", "provenance"])?;
    let operations = sequence(&required(input_dict, "operations")?)?;
    if operations.len() > 100_000 {
        return Err(PyValueError::new_err("too many Python mutation operations"));
    }
    let operations = operations
        .iter()
        .map(|input| operation(input, &mut conversion))
        .collect::<PyResult<Vec<_>>>()?;
    let mut preconditions = Vec::new();
    if let Some(values) = input_dict.get_item("preconditions")? {
        let values = sequence(&values)?;
        if values.len() > 100_000 {
            return Err(PyValueError::new_err(
                "too many Python mutation preconditions",
            ));
        }
        for value in values {
            let value = dict(&value)?;
            closed(value, &["expression", "target"])?;
            preconditions.push(RequestedMutationPrecondition {
                expression: text(value, "expression")?,
                target: optional_text(value, "target")?.map(Into::into),
            });
        }
    }
    Ok(MutationRequest {
        operations,
        preconditions,
        provenance: optional_value(input_dict, "provenance", &mut conversion)?,
    })
}

#[allow(clippy::too_many_arguments)]
pub(super) fn plan_document(
    document: &PyDocument,
    py: Python<'_>,
    input: &Bound<'_, PyAny>,
    scope: &str,
    profile: &str,
    budget: Option<&Bound<'_, PyAny>>,
    max_bindings: usize,
    max_position_index: usize,
    plan_id: Option<String>,
) -> PyResult<PyMutationResult> {
    let scope = parse_scope(scope)?;
    let request = request(input)?;
    let mut limits = MutationBudget {
        max_operations: Some(10_000),
        max_preconditions: Some(1_000),
        max_value_nodes: Some(100_000),
        max_value_depth: Some(128),
        max_string_length: Some(1_048_576),
    };
    if let Some(budget) = budget {
        let budget = dict(budget)?;
        closed(
            budget,
            &[
                "max_operations",
                "max_preconditions",
                "max_value_nodes",
                "max_value_depth",
                "max_string_length",
            ],
        )?;
        for (name, slot) in [
            ("max_operations", &mut limits.max_operations),
            ("max_preconditions", &mut limits.max_preconditions),
            ("max_value_nodes", &mut limits.max_value_nodes),
            ("max_value_depth", &mut limits.max_value_depth),
            ("max_string_length", &mut limits.max_string_length),
        ] {
            if let Some(value) = budget.get_item(name)? {
                *slot = Some(value.extract()?);
            }
        }
    }
    let options = PlanMutationOptions {
        resolve: runtime::resolve::ResolveOptions {
            max_bindings: Some(max_bindings),
            ..Default::default()
        },
        value_semantics: runtime::value_semantics::Profile::from_id(profile)
            .map_err(|error| PyValueError::new_err(error.message))?,
        budget: limits,
        max_position_index,
        plan_id,
    };
    let namespace = AeonSansaNamespace::from_shared(
        Arc::clone(&document.document),
        sansa_scope(scope),
        AeonNumericMaterialization::Lossless,
    );
    Ok(
        match py.detach(move || namespace.plan_mutation(&request, &options)) {
            AeonMutationPlanResult::Planned(plan) => PyMutationResult {
                plan: Some(PyMutationPlan {
                    inner: Arc::new(plan),
                    document: Arc::clone(&document.document),
                    scope,
                }),
                errors: vec![],
            },
            AeonMutationPlanResult::Rejected(errors) => PyMutationResult {
                plan: None,
                errors: errors.into_iter().map(PyMutationDiagnostic::from).collect(),
            },
        },
    )
}

/// Explicit typed payload construction, never interpretation of ordinary strings.
#[pyfunction(signature = (family, canonical, *, semantic_type=None))]
fn scalar(family: &str, canonical: &str, semantic_type: Option<&str>) -> PyResult<PyQueryScalar> {
    use runtime::value_semantics::{FiniteNumber, Value};
    let value = match family {
        "string" => Value::String(canonical.into()),
        "finite_number" => Value::FiniteNumber(
            FiniteNumber::parse(canonical).map_err(|error| PyValueError::new_err(error.message))?,
        ),
        "boolean" => Value::Boolean(match canonical {
            "true" => true,
            "false" => false,
            _ => {
                return Err(PyValueError::new_err(
                    "boolean payload must be true or false",
                ));
            }
        }),
        "toggle" => Value::Toggle(canonical.into()),
        "hex" => Value::Hex(canonical.into()),
        "symbol" => Value::Symbol(canonical.into()),
        "encoding" => Value::Encoding(canonical.into()),
        "separator" => Value::Separator(canonical.into()),
        "sansa_address" => Value::SansaAddress(canonical.into()),
        "radix" => Value::Radix {
            payload: canonical.into(),
            semantic_type: semantic_type.unwrap_or("radix").into(),
        },
        "date" | "time" | "datetime" | "wtc" => Value::Temporal {
            payload: canonical.into(),
            semantic_type: family.into(),
        },
        "clone_reference" | "pointer_reference" => Value::ReferenceForm {
            kind: if family == "clone_reference" {
                "cloneReference"
            } else {
                "pointerReference"
            }
            .into(),
            target: canonical.into(),
        },
        "explicit_null" => Value::ExplicitNull {
            reason: canonical.into(),
        },
        _ => return Err(PyValueError::new_err("unsupported scalar family")),
    };
    if semantic_type.is_some() && family != "radix" {
        return Err(PyValueError::new_err(
            "semantic_type is supported only for radix metadata",
        ));
    }
    let PyQueryValueData::Scalar(value) = python_query_scalar(value) else {
        unreachable!("factory creates scalar families only")
    };
    Ok(value)
}

pub(super) fn register(module: &Bound<'_, PyModule>) -> PyResult<()> {
    module.add_class::<PyMutationResult>()?;
    module.add_class::<PyMutationPlan>()?;
    module.add_class::<PyMutationOperation>()?;
    module.add_class::<PyMutationTarget>()?;
    module.add_class::<PyMutationPrecondition>()?;
    module.add_class::<PyMutationDiagnostic>()?;
    module.add_class::<PyMutationValidation>()?;
    module.add_function(wrap_pyfunction!(scalar, module)?)?;
    Ok(())
}
