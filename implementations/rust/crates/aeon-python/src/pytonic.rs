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

#[pyclass(frozen, module = "altopelago.aeon.pytonic", name = "Binding")]
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
    module.add_class::<PyGenericArgument>()?;
    module.add_class::<PyClarifier>()?;
    module.add_class::<PyCapabilities>()?;
    module.add_function(wrap_pyfunction!(loads, module)?)?;
    Ok(())
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
