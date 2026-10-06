use std::sync::Arc;
use std::{
    collections::hash_map::DefaultHasher,
    hash::{Hash, Hasher},
};

use aeon_core::{CompileOptions, DatatypePolicy};
use aeon_document::{
    AeonDocument, CapabilityState, DocumentError, DocumentScope, DocumentSourcePlane, NodeId,
    NodeLineage,
};
use aeon_sdk::sansa_document::{
    AeonNumericMaterialization, AeonSansaBinding, AeonSansaNamespace, AeonSansaScope, runtime,
};
use aes_telex::{ClarifierKind, DatatypeClarifier, GenericArgument};
use pyo3::exceptions::{PyIndexError, PyKeyError, PyRuntimeError, PyTypeError, PyValueError};
use pyo3::prelude::*;
use pyo3::types::{PyAny, PyModule, PyTuple};

use super::python_diagnostic;

#[pyclass(frozen, module = "altopelago.aeon.pytonic", name = "Document")]
pub(super) struct PyDocument {
    document: Arc<AeonDocument>,
}

#[pymethods]
impl PyDocument {
    #[getter]
    fn source(&self) -> String {
        String::from_utf8_lossy(self.document.source_bytes()).into_owned()
    }

    #[getter]
    fn payload(&self) -> PyBinding {
        self.binding(DocumentScope::Payload, self.document.payload_root())
    }

    #[getter]
    fn header(&self) -> PyBinding {
        self.binding(DocumentScope::Header, self.document.header_root())
    }

    #[getter]
    fn full(&self) -> PyBinding {
        self.binding(DocumentScope::Full, self.document.full_root())
    }

    #[getter]
    fn capabilities(&self) -> PyCapabilities {
        let capabilities = self.document.capabilities();
        PyCapabilities {
            source_bytes: capability_label(capabilities.source_bytes),
            authored_lexemes: capability_label(capabilities.authored_lexemes),
            origin: capability_label(capabilities.origin),
            span: capability_label(capabilities.span),
            portable_extensions: capability_label(capabilities.portable_extensions),
            unknown_telex_fields: capability_label(capabilities.unknown_telex_fields),
            event_order: capability_label(capabilities.event_order),
            lineage: capability_label(capabilities.lineage),
        }
    }

    #[getter]
    fn sansa_capabilities(&self) -> PySansaCapabilities {
        PySansaCapabilities {
            query: "complete",
            dynamic_address_activation: "constrained",
            local_spaces: "not_exposed",
            transform: "not_exposed",
            instruction: "not_exposed",
            mutate: "not_exposed",
        }
    }

    fn __getitem__(&self, name: &str) -> PyResult<PyBinding> {
        self.payload().member(name)
    }

    #[pyo3(signature = (address, scope="payload"))]
    fn at(&self, address: &str, scope: &str) -> PyResult<PyBinding> {
        let scope = parse_scope(scope)?;
        let id = self
            .document
            .at(scope, address)
            .ok_or_else(|| PyKeyError::new_err(address.to_owned()))?;
        Ok(self.binding(scope, id))
    }

    #[pyo3(signature = (identity, scope="payload"))]
    fn by_identity(&self, py: Python<'_>, identity: &str, scope: &str) -> PyResult<Py<PyTuple>> {
        let scope = parse_scope(scope)?;
        let bindings = self
            .document
            .nodes_with_identity(identity)
            .iter()
            .filter_map(|id| {
                self.document
                    .view(scope, *id)
                    .map(|_| self.binding(scope, *id))
            })
            .map(|binding| Py::new(py, binding))
            .collect::<PyResult<Vec<_>>>()?;
        Ok(PyTuple::new(py, bindings)?.unbind())
    }

    #[pyo3(
        signature = (
            query,
            *,
            scope="payload",
            profile="aeon.value.default.v1",
            policy="general",
            max_from_bindings=None,
            max_where_candidates=None,
            max_order_candidates=None,
            max_result_records=None,
            activation_roots=None,
            activation_selectors=None,
            allow_contextual_activation=false,
            max_activation_depth=None,
            max_activation_bindings=None
        )
    )]
    #[allow(clippy::too_many_arguments)]
    fn query(
        &self,
        py: Python<'_>,
        query: &str,
        scope: &str,
        profile: &str,
        policy: &str,
        max_from_bindings: Option<usize>,
        max_where_candidates: Option<usize>,
        max_order_candidates: Option<usize>,
        max_result_records: Option<usize>,
        activation_roots: Option<Vec<String>>,
        activation_selectors: Option<Vec<String>>,
        allow_contextual_activation: bool,
        max_activation_depth: Option<usize>,
        max_activation_bindings: Option<usize>,
    ) -> PyResult<PyQueryResult> {
        use runtime::address::parse_address;
        use runtime::evaluate::{
            AddressActivation, AddressActivationPolicy, EvaluateOptions, QueryBudget, QueryPolicy,
        };
        use runtime::value_semantics::Profile;

        let document_scope = parse_scope(scope)?;
        let sansa_scope = sansa_scope(document_scope);
        let profile =
            Profile::from_id(profile).map_err(|error| PyValueError::new_err(error.message))?;
        let policy = match policy {
            "general" => QueryPolicy::General,
            "validation" => QueryPolicy::Validation,
            _ => {
                return Err(PyValueError::new_err(
                    "policy must be 'general' or 'validation'",
                ));
            }
        };
        let address_activation = match activation_roots {
            Some(roots) => {
                let allowed_roots = roots
                    .into_iter()
                    .map(|root| {
                        parse_address(&root).map_err(|error| {
                            PyValueError::new_err(format!(
                                "invalid activation root {root:?}: {}",
                                error.message
                            ))
                        })
                    })
                    .collect::<PyResult<Vec<_>>>()?;
                let allowed_selectors = activation_selectors
                    .unwrap_or_default()
                    .into_iter()
                    .map(|selector| parse_activation_selector(&selector))
                    .collect::<PyResult<Vec<_>>>()?;
                AddressActivation::Constrained(AddressActivationPolicy {
                    allowed_roots,
                    allowed_selectors,
                    allow_contextual_root: allow_contextual_activation,
                    max_address_depth: max_activation_depth,
                    max_bindings: max_activation_bindings,
                })
            }
            None => {
                if activation_selectors.is_some()
                    || allow_contextual_activation
                    || max_activation_depth.is_some()
                    || max_activation_bindings.is_some()
                {
                    return Err(PyValueError::new_err(
                        "activation_roots is required when configuring address activation",
                    ));
                }
                AddressActivation::Disabled
            }
        };
        let options = EvaluateOptions {
            profile,
            policy,
            budget: QueryBudget {
                max_from_bindings,
                max_where_candidates,
                max_order_candidates,
                max_result_records,
            },
            address_activation,
            ..EvaluateOptions::default()
        };
        let namespace = AeonSansaNamespace::from_shared(
            Arc::clone(&self.document),
            sansa_scope,
            AeonNumericMaterialization::Lossless,
        );
        let query = query.to_owned();
        let output = py.detach(move || namespace.evaluate_query(&query, &options));

        let results = output
            .results
            .into_iter()
            .map(|record| {
                Ok(PyQueryRecord {
                    candidate: python_binding(&self.document, document_scope, &record.candidate)?,
                    value: python_query_value(&self.document, document_scope, record.value)?,
                })
            })
            .collect::<PyResult<Vec<_>>>()?;
        let errors = output
            .errors
            .into_iter()
            .map(PySansaDiagnostic::from)
            .collect();
        Ok(PyQueryResult { results, errors })
    }

    fn __repr__(&self) -> String {
        format!(
            "Document(payload_children={}, header_children={})",
            self.document.payload().children().count(),
            self.document.header().children().count()
        )
    }
}

impl PyDocument {
    fn binding(&self, scope: DocumentScope, id: NodeId) -> PyBinding {
        PyBinding {
            document: Arc::clone(&self.document),
            scope,
            id,
        }
    }
}

#[pyclass(
    frozen,
    skip_from_py_object,
    module = "altopelago.aeon.pytonic",
    name = "Binding"
)]
#[derive(Clone)]
pub(super) struct PyBinding {
    document: Arc<AeonDocument>,
    scope: DocumentScope,
    id: NodeId,
}

#[pymethods]
impl PyBinding {
    #[getter]
    fn address(&self) -> String {
        self.document
            .address(self.scope, self.id)
            .expect("binding scope is valid for its node")
    }

    #[getter]
    fn full_address(&self) -> &str {
        self.node().full_address()
    }

    #[getter]
    fn event_address(&self) -> Option<&str> {
        self.node().event_address()
    }

    #[getter]
    fn name(&self) -> Option<&str> {
        self.node().binding_name()
    }

    #[getter]
    fn position(&self) -> Option<usize> {
        self.node().position()
    }

    #[getter]
    fn source_plane(&self) -> Option<&'static str> {
        self.node().source_plane().map(source_plane_label)
    }

    #[getter]
    fn representation_kind(&self) -> &str {
        self.node().representation_kind()
    }

    #[getter]
    fn identity(&self) -> Option<&str> {
        self.node().identity()
    }

    #[getter]
    fn datatype(&self) -> Option<&str> {
        self.node().datatype()
    }

    #[getter]
    fn generics(&self, py: Python<'_>) -> PyResult<Py<PyTuple>> {
        let arguments = self
            .node()
            .generics()
            .iter()
            .cloned()
            .map(PyGenericArgument::from)
            .map(|argument| Py::new(py, argument))
            .collect::<PyResult<Vec<_>>>()?;
        Ok(PyTuple::new(py, arguments)?.unbind())
    }

    #[getter]
    fn clarifiers(&self, py: Python<'_>) -> PyResult<Py<PyTuple>> {
        let clarifiers = self
            .node()
            .clarifiers()
            .iter()
            .cloned()
            .map(PyClarifier::from)
            .map(|clarifier| Py::new(py, clarifier))
            .collect::<PyResult<Vec<_>>>()?;
        Ok(PyTuple::new(py, clarifiers)?.unbind())
    }

    #[getter]
    fn value(&self) -> PyValue {
        PyValue {
            kind: self.node().representation_kind().to_owned(),
            canonical: self.node().value().map(str::to_owned),
        }
    }

    #[getter]
    fn origin(&self) -> Option<&str> {
        self.node().origin()
    }

    #[getter]
    fn span(&self) -> Option<&str> {
        self.node().span()
    }

    #[getter]
    fn parent(&self) -> Option<Self> {
        let parent = self.node().parent()?;
        self.document.view(self.scope, parent)?;
        Some(self.with_id(parent))
    }

    #[getter]
    fn children(&self, py: Python<'_>) -> PyResult<Py<PyTuple>> {
        let children = self
            .node()
            .children()
            .iter()
            .filter(|id| self.document.view(self.scope, **id).is_some())
            .map(|id| self.with_id(*id))
            .map(|binding| Py::new(py, binding))
            .collect::<PyResult<Vec<_>>>()?;
        Ok(PyTuple::new(py, children)?.unbind())
    }

    #[getter]
    fn attributes(&self) -> Option<Self> {
        let id = self.node().attribute_space()?;
        self.document.view(self.scope, id)?;
        Some(self.with_id(id))
    }

    #[getter]
    fn lineage(&self) -> &'static str {
        match self.node().lineage() {
            NodeLineage::Synthetic => "synthetic",
            NodeLineage::PortableEvent { .. } => "portable_event",
        }
    }

    #[getter]
    fn event_ordinal(&self) -> Option<usize> {
        match self.node().lineage() {
            NodeLineage::Synthetic => None,
            NodeLineage::PortableEvent { ordinal, .. } => Some(*ordinal),
        }
    }

    fn member(&self, name: &str) -> PyResult<Self> {
        let view = self
            .document
            .view(self.scope, self.id)
            .expect("binding scope is valid for its node");
        let child = view
            .member(name)
            .ok_or_else(|| PyKeyError::new_err(name.to_owned()))?;
        Ok(self.with_id(child.id()))
    }

    fn at_position(&self, index: usize) -> PyResult<Self> {
        let view = self
            .document
            .view(self.scope, self.id)
            .expect("binding scope is valid for its node");
        let child = view
            .position(index)
            .ok_or_else(|| PyIndexError::new_err(index))?;
        Ok(self.with_id(child.id()))
    }

    fn __getitem__(&self, key: &Bound<'_, PyAny>) -> PyResult<Self> {
        if let Ok(name) = key.extract::<String>() {
            return self.member(&name);
        }
        if let Ok(index) = key.extract::<isize>() {
            if index < 0 {
                return Err(PyIndexError::new_err(index));
            }
            return self.at_position(index as usize);
        }
        Err(PyTypeError::new_err(
            "binding index must be str or non-negative int",
        ))
    }

    fn __len__(&self) -> usize {
        self.node().children().len()
    }

    fn __eq__(&self, other: PyRef<'_, Self>) -> bool {
        Arc::ptr_eq(&self.document, &other.document)
            && self.scope == other.scope
            && self.id == other.id
    }

    fn __hash__(&self) -> isize {
        let mut hasher = DefaultHasher::new();
        (Arc::as_ptr(&self.document) as usize).hash(&mut hasher);
        self.scope.hash(&mut hasher);
        self.id.hash(&mut hasher);
        hasher.finish() as isize
    }

    fn __repr__(&self) -> String {
        format!(
            "Binding(address={:?}, representation_kind={:?}, datatype={})",
            self.address(),
            self.representation_kind(),
            self.datatype()
                .map_or_else(|| String::from("None"), |value| format!("{value:?}"))
        )
    }
}

#[derive(Clone)]
enum PyQueryValueData {
    Scalar(PyQueryScalar),
    Bindings(Vec<PyBinding>),
    Object(Vec<(String, PyQueryValueData)>),
}

#[pyclass(
    frozen,
    skip_from_py_object,
    module = "altopelago.aeon.pytonic",
    name = "QueryScalar"
)]
#[derive(Clone)]
pub(super) struct PyQueryScalar {
    family: &'static str,
    canonical: Option<String>,
    semantic_type: Option<String>,
}

#[pymethods]
impl PyQueryScalar {
    #[getter]
    fn family(&self) -> &'static str {
        self.family
    }

    #[getter]
    fn canonical(&self) -> Option<&str> {
        self.canonical.as_deref()
    }

    #[getter]
    fn semantic_type(&self) -> Option<&str> {
        self.semantic_type.as_deref()
    }

    #[getter]
    fn decoded<'py>(&self, py: Python<'py>) -> PyResult<Py<PyAny>> {
        match (self.family, self.canonical.as_deref()) {
            ("boolean", Some("true")) => Ok(true.into_pyobject(py)?.to_owned().unbind().into_any()),
            ("boolean", Some("false")) => {
                Ok(false.into_pyobject(py)?.to_owned().unbind().into_any())
            }
            ("explicit_null" | "explicit_absence" | "missing", _) => Ok(py.None()),
            (_, Some(value)) => Ok(value.into_pyobject(py)?.to_owned().unbind().into_any()),
            (_, None) => Ok(py.None()),
        }
    }

    fn __repr__(&self) -> String {
        format!(
            "QueryScalar(family={:?}, canonical={:?}, semantic_type={:?})",
            self.family, self.canonical, self.semantic_type
        )
    }
}

#[pyclass(
    frozen,
    skip_from_py_object,
    module = "altopelago.aeon.pytonic",
    name = "QueryField"
)]
#[derive(Clone)]
pub(super) struct PyQueryField {
    name: String,
    value: PyQueryValueData,
}

#[pymethods]
impl PyQueryField {
    #[getter]
    fn name(&self) -> &str {
        &self.name
    }

    #[getter]
    fn value(&self, py: Python<'_>) -> PyResult<Py<PyAny>> {
        query_value_object(py, &self.value)
    }
}

#[pyclass(
    frozen,
    skip_from_py_object,
    module = "altopelago.aeon.pytonic",
    name = "QueryObject"
)]
#[derive(Clone)]
pub(super) struct PyQueryObject {
    fields: Vec<(String, PyQueryValueData)>,
}

#[pymethods]
impl PyQueryObject {
    #[getter]
    fn fields(&self, py: Python<'_>) -> PyResult<Py<PyTuple>> {
        let fields = self
            .fields
            .iter()
            .cloned()
            .map(|(name, value)| Py::new(py, PyQueryField { name, value }))
            .collect::<PyResult<Vec<_>>>()?;
        Ok(PyTuple::new(py, fields)?.unbind())
    }

    fn __getitem__(&self, py: Python<'_>, name: &str) -> PyResult<Py<PyAny>> {
        let value = self
            .fields
            .iter()
            .find_map(|(field, value)| (field == name).then_some(value))
            .ok_or_else(|| PyKeyError::new_err(name.to_owned()))?;
        query_value_object(py, value)
    }

    fn __len__(&self) -> usize {
        self.fields.len()
    }

    fn __repr__(&self) -> String {
        let names = self
            .fields
            .iter()
            .map(|(name, _)| name.as_str())
            .collect::<Vec<_>>();
        format!("QueryObject(fields={names:?})")
    }
}

#[pyclass(
    frozen,
    skip_from_py_object,
    module = "altopelago.aeon.pytonic",
    name = "QueryRecord"
)]
#[derive(Clone)]
pub(super) struct PyQueryRecord {
    candidate: PyBinding,
    value: PyQueryValueData,
}

#[pymethods]
impl PyQueryRecord {
    #[getter]
    fn candidate(&self) -> PyBinding {
        self.candidate.clone()
    }

    #[getter]
    fn value(&self, py: Python<'_>) -> PyResult<Py<PyAny>> {
        query_value_object(py, &self.value)
    }
}

#[pyclass(
    frozen,
    skip_from_py_object,
    module = "altopelago.aeon.pytonic",
    name = "SansaDiagnostic"
)]
#[derive(Clone)]
pub(super) struct PySansaDiagnostic {
    #[pyo3(get)]
    code: String,
    #[pyo3(get)]
    message: String,
    #[pyo3(get)]
    phase: Option<&'static str>,
    #[pyo3(get)]
    selector_index: Option<usize>,
    #[pyo3(get)]
    candidate_address: Option<String>,
    #[pyo3(get)]
    budget: Option<String>,
    #[pyo3(get)]
    limit: Option<usize>,
    #[pyo3(get)]
    observed: Option<usize>,
}

#[pyclass(
    frozen,
    eq,
    hash,
    skip_from_py_object,
    module = "altopelago.aeon.pytonic",
    name = "SansaCapabilities"
)]
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(super) struct PySansaCapabilities {
    #[pyo3(get)]
    query: &'static str,
    #[pyo3(get)]
    dynamic_address_activation: &'static str,
    #[pyo3(get)]
    local_spaces: &'static str,
    #[pyo3(get)]
    transform: &'static str,
    #[pyo3(get)]
    instruction: &'static str,
    #[pyo3(get)]
    mutate: &'static str,
}

impl From<runtime::Diagnostic> for PySansaDiagnostic {
    fn from(diagnostic: runtime::Diagnostic) -> Self {
        Self {
            code: diagnostic.code,
            message: diagnostic.message,
            phase: diagnostic.phase.map(sansa_phase_label),
            selector_index: diagnostic.selector_index,
            candidate_address: diagnostic.candidate_address,
            budget: diagnostic.budget,
            limit: diagnostic.limit,
            observed: diagnostic.observed,
        }
    }
}

#[pyclass(frozen, module = "altopelago.aeon.pytonic", name = "QueryResult")]
pub(super) struct PyQueryResult {
    results: Vec<PyQueryRecord>,
    errors: Vec<PySansaDiagnostic>,
}

#[pymethods]
impl PyQueryResult {
    #[getter]
    fn ok(&self) -> bool {
        self.errors.is_empty()
    }

    #[getter]
    fn results(&self, py: Python<'_>) -> PyResult<Py<PyTuple>> {
        let results = self
            .results
            .iter()
            .cloned()
            .map(|record| Py::new(py, record))
            .collect::<PyResult<Vec<_>>>()?;
        Ok(PyTuple::new(py, results)?.unbind())
    }

    #[getter]
    fn errors(&self, py: Python<'_>) -> PyResult<Py<PyTuple>> {
        let errors = self
            .errors
            .iter()
            .cloned()
            .map(|diagnostic| Py::new(py, diagnostic))
            .collect::<PyResult<Vec<_>>>()?;
        Ok(PyTuple::new(py, errors)?.unbind())
    }

    fn __repr__(&self) -> String {
        format!(
            "QueryResult(ok={}, results={}, errors={})",
            self.errors.is_empty(),
            self.results.len(),
            self.errors.len()
        )
    }
}

impl PyBinding {
    fn node(&self) -> &aeon_document::DocumentNode {
        self.document.node(self.id).expect("binding node exists")
    }

    fn with_id(&self, id: NodeId) -> Self {
        Self {
            document: Arc::clone(&self.document),
            scope: self.scope,
            id,
        }
    }
}

#[pyclass(
    frozen,
    eq,
    hash,
    skip_from_py_object,
    module = "altopelago.aeon.pytonic",
    name = "Value"
)]
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(super) struct PyValue {
    kind: String,
    canonical: Option<String>,
}

#[pymethods]
impl PyValue {
    #[getter]
    fn kind(&self) -> &str {
        &self.kind
    }

    #[getter]
    fn canonical(&self) -> Option<&str> {
        self.canonical.as_deref()
    }

    #[getter]
    fn decoded<'py>(&self, py: Python<'py>) -> PyResult<Py<PyAny>> {
        match (self.kind.as_str(), self.canonical.as_deref()) {
            ("BooleanLiteral", Some("true")) => {
                Ok(true.into_pyobject(py)?.to_owned().unbind().into_any())
            }
            ("BooleanLiteral", Some("false")) => {
                Ok(false.into_pyobject(py)?.to_owned().unbind().into_any())
            }
            (_, Some(value)) => Ok(value.into_pyobject(py)?.to_owned().unbind().into_any()),
            (_, None) => Ok(py.None()),
        }
    }

    fn __repr__(&self) -> String {
        format!(
            "Value(kind={:?}, canonical={:?})",
            self.kind, self.canonical
        )
    }
}

#[pyclass(
    frozen,
    skip_from_py_object,
    module = "altopelago.aeon.pytonic",
    name = "GenericArgument"
)]
#[derive(Clone)]
pub(super) struct PyGenericArgument {
    argument: GenericArgument,
}

#[pymethods]
impl PyGenericArgument {
    #[getter]
    fn kind(&self) -> &'static str {
        match self.argument {
            GenericArgument::Datatype(_) => "Datatype",
            GenericArgument::NumberLiteral(_) => "NumberLiteral",
        }
    }

    #[getter]
    fn datatype(&self) -> Option<&str> {
        match &self.argument {
            GenericArgument::Datatype(descriptor) => Some(&descriptor.datatype),
            GenericArgument::NumberLiteral(_) => None,
        }
    }

    #[getter]
    fn value(&self) -> Option<&str> {
        match &self.argument {
            GenericArgument::Datatype(_) => None,
            GenericArgument::NumberLiteral(value) => Some(value),
        }
    }

    #[getter]
    fn generics(&self, py: Python<'_>) -> PyResult<Py<PyTuple>> {
        let arguments = match &self.argument {
            GenericArgument::Datatype(descriptor) => descriptor
                .generics
                .iter()
                .cloned()
                .map(Self::from)
                .collect(),
            GenericArgument::NumberLiteral(_) => Vec::new(),
        };
        let arguments = arguments
            .into_iter()
            .map(|argument| Py::new(py, argument))
            .collect::<PyResult<Vec<_>>>()?;
        Ok(PyTuple::new(py, arguments)?.unbind())
    }

    #[getter]
    fn clarifiers(&self, py: Python<'_>) -> PyResult<Py<PyTuple>> {
        let clarifiers = match &self.argument {
            GenericArgument::Datatype(descriptor) => descriptor
                .clarifiers
                .iter()
                .cloned()
                .map(PyClarifier::from)
                .collect(),
            GenericArgument::NumberLiteral(_) => Vec::new(),
        };
        let clarifiers = clarifiers
            .into_iter()
            .map(|clarifier| Py::new(py, clarifier))
            .collect::<PyResult<Vec<_>>>()?;
        Ok(PyTuple::new(py, clarifiers)?.unbind())
    }
}

impl From<GenericArgument> for PyGenericArgument {
    fn from(argument: GenericArgument) -> Self {
        Self { argument }
    }
}

#[pyclass(
    frozen,
    eq,
    hash,
    skip_from_py_object,
    module = "altopelago.aeon.pytonic",
    name = "Clarifier"
)]
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(super) struct PyClarifier {
    kind: &'static str,
    value: String,
}

#[pymethods]
impl PyClarifier {
    #[getter]
    fn kind(&self) -> &'static str {
        self.kind
    }

    #[getter]
    fn value(&self) -> &str {
        &self.value
    }
}

impl From<DatatypeClarifier> for PyClarifier {
    fn from(clarifier: DatatypeClarifier) -> Self {
        Self {
            kind: match clarifier.kind {
                ClarifierKind::StringLiteral => "StringLiteral",
                ClarifierKind::NumberLiteral => "NumberLiteral",
            },
            value: clarifier.value,
        }
    }
}

#[pyclass(
    frozen,
    eq,
    hash,
    skip_from_py_object,
    module = "altopelago.aeon.pytonic",
    name = "Capabilities"
)]
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(super) struct PyCapabilities {
    #[pyo3(get)]
    source_bytes: &'static str,
    #[pyo3(get)]
    authored_lexemes: &'static str,
    #[pyo3(get)]
    origin: &'static str,
    #[pyo3(get)]
    span: &'static str,
    #[pyo3(get)]
    portable_extensions: &'static str,
    #[pyo3(get)]
    unknown_telex_fields: &'static str,
    #[pyo3(get)]
    event_order: &'static str,
    #[pyo3(get)]
    lineage: &'static str,
}

#[pyfunction(name = "pytonic_loads", signature = (source, datatype_policy=None, max_attribute_depth=None))]
fn loads(
    py: Python<'_>,
    source: &str,
    datatype_policy: Option<&str>,
    max_attribute_depth: Option<usize>,
) -> PyResult<PyDocument> {
    let source = source.to_owned();
    let datatype_policy = parse_datatype_policy(datatype_policy)?;
    let document = py.detach(move || {
        let mut options = CompileOptions {
            datatype_policy,
            ..CompileOptions::default()
        };
        if let Some(max_attribute_depth) = max_attribute_depth {
            options.max_attribute_depth = max_attribute_depth;
        }
        AeonDocument::compile(&source, options)
    });

    match document {
        Ok(document) => Ok(PyDocument {
            document: Arc::new(document),
        }),
        Err(DocumentError::Compile(diagnostics)) => {
            let diagnostics = diagnostics
                .into_iter()
                .map(|diagnostic| Py::new(py, python_diagnostic(diagnostic)))
                .collect::<PyResult<Vec<_>>>()?;
            let diagnostics = PyTuple::new(py, diagnostics)?;
            let error_type = py
                .import("altopelago.aeon.errors")?
                .getattr("CompileError")?;
            let error = error_type.call1((diagnostics,))?;
            Err(PyErr::from_value(error))
        }
        Err(error) => Err(PyRuntimeError::new_err(error.to_string())),
    }
}

pub(super) fn register(module: &Bound<'_, PyModule>) -> PyResult<()> {
    module.add_class::<PyDocument>()?;
    module.add_class::<PyBinding>()?;
    module.add_class::<PyValue>()?;
    module.add_class::<PyQueryScalar>()?;
    module.add_class::<PyQueryField>()?;
    module.add_class::<PyQueryObject>()?;
    module.add_class::<PyQueryRecord>()?;
    module.add_class::<PySansaDiagnostic>()?;
    module.add_class::<PySansaCapabilities>()?;
    module.add_class::<PyQueryResult>()?;
    module.add_class::<PyGenericArgument>()?;
    module.add_class::<PyClarifier>()?;
    module.add_class::<PyCapabilities>()?;
    module.add_function(wrap_pyfunction!(loads, module)?)?;
    Ok(())
}

fn sansa_scope(scope: DocumentScope) -> AeonSansaScope {
    match scope {
        DocumentScope::Payload => AeonSansaScope::Payload,
        DocumentScope::Header => AeonSansaScope::Header,
        DocumentScope::Full => AeonSansaScope::Full,
    }
}

fn python_binding(
    document: &Arc<AeonDocument>,
    scope: DocumentScope,
    binding: &AeonSansaBinding,
) -> PyResult<PyBinding> {
    let address = binding.address();
    let id = document.at(scope, &address).ok_or_else(|| {
        PyRuntimeError::new_err(format!(
            "SANSA returned a binding outside the selected document scope: {address}"
        ))
    })?;
    Ok(PyBinding {
        document: Arc::clone(document),
        scope,
        id,
    })
}

fn python_query_value(
    document: &Arc<AeonDocument>,
    scope: DocumentScope,
    value: runtime::evaluate::EvaluatedValue<AeonSansaBinding>,
) -> PyResult<PyQueryValueData> {
    use runtime::evaluate::EvaluatedValue;

    Ok(match value {
        EvaluatedValue::Scalar(value) => PyQueryValueData::Scalar(python_query_scalar(value)),
        EvaluatedValue::Bindings(bindings) => PyQueryValueData::Bindings(
            bindings
                .iter()
                .map(|binding| python_binding(document, scope, binding))
                .collect::<PyResult<Vec<_>>>()?,
        ),
        EvaluatedValue::Object(fields) => PyQueryValueData::Object(
            fields
                .into_iter()
                .map(|(name, value)| Ok((name, python_query_value(document, scope, value)?)))
                .collect::<PyResult<Vec<_>>>()?,
        ),
    })
}

fn python_query_scalar(value: runtime::value_semantics::Value) -> PyQueryScalar {
    use runtime::value_semantics::Value;

    let (family, canonical, semantic_type) = match value {
        Value::FiniteNumber(value) => (
            "finite_number",
            Some(value.as_str().to_owned()),
            Some(String::from("number")),
        ),
        Value::PositiveInfinity => (
            "positive_infinity",
            Some(String::from("Infinity")),
            Some(String::from("infinity")),
        ),
        Value::NegativeInfinity => (
            "negative_infinity",
            Some(String::from("-Infinity")),
            Some(String::from("infinity")),
        ),
        Value::Nan => ("nan", Some(String::from("NaN")), Some(String::from("nan"))),
        Value::String(value) => ("string", Some(value), Some(String::from("string"))),
        Value::Boolean(value) => (
            "boolean",
            Some(if value { "true" } else { "false" }.to_owned()),
            Some(String::from("boolean")),
        ),
        Value::Toggle(value) => ("toggle", Some(value), Some(String::from("toggle"))),
        Value::Hex(value) => ("hex", Some(value), Some(String::from("hex"))),
        Value::Radix {
            payload,
            semantic_type,
        } => ("radix", Some(payload), Some(semantic_type)),
        Value::Encoding(value) => ("encoding", Some(value), Some(String::from("encoding"))),
        Value::Separator(value) => ("separator", Some(value), Some(String::from("sep"))),
        Value::Symbol(value) => ("symbol", Some(value), Some(String::from("symbol"))),
        Value::SansaAddress(value) => ("sansa_address", Some(value), Some(String::from("sansa"))),
        Value::ReferenceForm { kind, target } => ("reference", Some(target), Some(kind)),
        Value::Temporal {
            payload,
            semantic_type,
        } => ("temporal", Some(payload), Some(semantic_type)),
        Value::ExplicitNull { reason } => {
            ("explicit_null", Some(reason), Some(String::from("null")))
        }
        Value::ExplicitAbsence { reason } => (
            "explicit_absence",
            Some(reason),
            Some(String::from("absence")),
        ),
        Value::Missing => ("missing", None, None),
        Value::Container { kind, .. } => ("container", None, Some(kind)),
        Value::BindingSet => ("binding_set", None, None),
    };
    PyQueryScalar {
        family,
        canonical,
        semantic_type,
    }
}

fn query_value_object(py: Python<'_>, value: &PyQueryValueData) -> PyResult<Py<PyAny>> {
    match value {
        PyQueryValueData::Scalar(value) => Ok(Py::new(py, value.clone())?.into_any()),
        PyQueryValueData::Bindings(bindings) => {
            let bindings = bindings
                .iter()
                .cloned()
                .map(|binding| Py::new(py, binding))
                .collect::<PyResult<Vec<_>>>()?;
            Ok(PyTuple::new(py, bindings)?.unbind().into_any())
        }
        PyQueryValueData::Object(fields) => Ok(Py::new(
            py,
            PyQueryObject {
                fields: fields.clone(),
            },
        )?
        .into_any()),
    }
}

const fn sansa_phase_label(phase: runtime::DiagnosticPhase) -> &'static str {
    match phase {
        runtime::DiagnosticPhase::Parse => "parse",
        runtime::DiagnosticPhase::Resolve => "resolve",
        runtime::DiagnosticPhase::Policy => "policy",
        runtime::DiagnosticPhase::From => "from",
        runtime::DiagnosticPhase::Where => "where",
        runtime::DiagnosticPhase::Order => "order",
        runtime::DiagnosticPhase::Select => "select",
    }
}

fn parse_activation_selector(value: &str) -> PyResult<runtime::evaluate::ActivationSelector> {
    use runtime::evaluate::ActivationSelector;

    match value {
        "member" => Ok(ActivationSelector::Member),
        "position" => Ok(ActivationSelector::Position),
        "range" => Ok(ActivationSelector::Range),
        "parent" => Ok(ActivationSelector::Parent),
        "attribute" => Ok(ActivationSelector::Attribute),
        "local_space" => Ok(ActivationSelector::LocalSpace),
        "direct_expansion" => Ok(ActivationSelector::DirectExpansion),
        "descendant_expansion" => Ok(ActivationSelector::DescendantExpansion),
        "name_pattern" => Ok(ActivationSelector::NamePattern),
        "semantic_type" => Ok(ActivationSelector::SemanticType),
        "representation_kind" => Ok(ActivationSelector::RepresentationKind),
        _ => Err(PyValueError::new_err(format!(
            "unsupported activation selector {value:?}"
        ))),
    }
}

fn parse_scope(value: &str) -> PyResult<DocumentScope> {
    match value {
        "payload" => Ok(DocumentScope::Payload),
        "header" => Ok(DocumentScope::Header),
        "full" => Ok(DocumentScope::Full),
        _ => Err(PyValueError::new_err(
            "scope must be 'payload', 'header', or 'full'",
        )),
    }
}

fn parse_datatype_policy(value: Option<&str>) -> PyResult<Option<DatatypePolicy>> {
    match value {
        None => Ok(None),
        Some("reserved_only") => Ok(Some(DatatypePolicy::ReservedOnly)),
        Some("allow_custom") => Ok(Some(DatatypePolicy::AllowCustom)),
        Some(_) => Err(PyValueError::new_err(
            "datatype_policy must be 'reserved_only' or 'allow_custom'",
        )),
    }
}

const fn source_plane_label(value: DocumentSourcePlane) -> &'static str {
    match value {
        DocumentSourcePlane::Body => "body",
        DocumentSourcePlane::Header => "header",
    }
}

const fn capability_label(value: CapabilityState) -> &'static str {
    match value {
        CapabilityState::Complete => "complete",
        CapabilityState::Partial => "partial",
        CapabilityState::NotSupplied => "not_supplied",
        CapabilityState::NotCollected => "not_collected",
        CapabilityState::NotApplicable => "not_applicable",
    }
}
