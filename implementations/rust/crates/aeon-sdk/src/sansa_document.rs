//! SANSA namespace projection over the immutable AEON document graph.
//!
//! This module always supplies host bindings and exact graph navigation. With
//! the optional `sansa` feature it also adapts those handles to the independent
//! `altopelago-sansa-runtime` crate for Address, Resolve, and Query.

use std::sync::Arc;

pub use aeon_core::CompileOptions;
pub use aeon_document::{AeonDocument, DocumentError};
use aeon_document::{DocumentNode, DocumentScope, DocumentSourcePlane, NodeId, NodeLineage};
#[cfg(feature = "sansa")]
use aes_telex::format_datatype_descriptor;
use aes_telex::{ClarifierKind, DatatypeClarifier, DatatypeDescriptor, GenericArgument};

#[cfg(feature = "sansa")]
pub use sansa_runtime as runtime;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum AeonSansaScope {
    Payload,
    Header,
    Full,
}

impl From<AeonSansaScope> for DocumentScope {
    fn from(value: AeonSansaScope) -> Self {
        match value {
            AeonSansaScope::Payload => Self::Payload,
            AeonSansaScope::Header => Self::Header,
            AeonSansaScope::Full => Self::Full,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub enum AeonNumericMaterialization {
    #[default]
    Lossless,
    Native,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum AeonSansaCapabilityState {
    Complete,
    NotExposed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct AeonSansaCapabilities {
    pub namespace_projection: AeonSansaCapabilityState,
    pub exact_address_lookup: AeonSansaCapabilityState,
    pub address_parsing: AeonSansaCapabilityState,
    pub resolve: AeonSansaCapabilityState,
    pub query: AeonSansaCapabilityState,
    pub local_spaces: AeonSansaCapabilityState,
}

impl Default for AeonSansaCapabilities {
    fn default() -> Self {
        Self {
            namespace_projection: AeonSansaCapabilityState::Complete,
            exact_address_lookup: AeonSansaCapabilityState::Complete,
            address_parsing: SANSA_RUNTIME_CAPABILITY,
            resolve: SANSA_RUNTIME_CAPABILITY,
            query: SANSA_RUNTIME_CAPABILITY,
            local_spaces: AeonSansaCapabilityState::NotExposed,
        }
    }
}

#[cfg(feature = "sansa")]
const SANSA_RUNTIME_CAPABILITY: AeonSansaCapabilityState = AeonSansaCapabilityState::Complete;
#[cfg(not(feature = "sansa"))]
const SANSA_RUNTIME_CAPABILITY: AeonSansaCapabilityState = AeonSansaCapabilityState::NotExposed;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum AeonSansaNonFinite {
    NaN,
    PositiveInfinity,
    NegativeInfinity,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum AeonSansaReferenceKind {
    Clone,
    Pointer,
}

#[derive(Debug, Clone, PartialEq)]
pub enum AeonSansaValue {
    Text(String),
    NumberLexeme(String),
    NativeNumber(f64),
    Boolean(bool),
    Null,
    NonFinite(AeonSansaNonFinite),
    Address {
        address: String,
        canonical: String,
    },
    Reference {
        kind: AeonSansaReferenceKind,
        path: String,
        canonical: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AeonSansaDatatypeDescriptor {
    pub datatype: String,
    pub generics: Vec<AeonSansaGenericArgument>,
    pub clarifiers: Vec<AeonSansaClarifier>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AeonSansaGenericArgument {
    Datatype(AeonSansaDatatypeDescriptor),
    NumberLiteral(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum AeonSansaClarifierKind {
    StringLiteral,
    NumberLiteral,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct AeonSansaClarifier {
    pub kind: AeonSansaClarifierKind,
    pub value: String,
}

#[derive(Debug, Clone)]
pub struct AeonSansaNamespace {
    document: Arc<AeonDocument>,
    scope: DocumentScope,
    numeric_materialization: AeonNumericMaterialization,
}

impl AeonSansaNamespace {
    /// Compile AEON source directly into a SANSA-capable document namespace.
    pub fn compile(
        source: &str,
        options: CompileOptions,
        scope: AeonSansaScope,
        numeric_materialization: AeonNumericMaterialization,
    ) -> Result<Self, DocumentError> {
        AeonDocument::compile(source, options)
            .map(|document| Self::new(document, scope, numeric_materialization))
    }

    #[must_use]
    pub fn new(
        document: AeonDocument,
        scope: AeonSansaScope,
        numeric_materialization: AeonNumericMaterialization,
    ) -> Self {
        Self::from_shared(Arc::new(document), scope, numeric_materialization)
    }

    #[must_use]
    pub fn from_shared(
        document: Arc<AeonDocument>,
        scope: AeonSansaScope,
        numeric_materialization: AeonNumericMaterialization,
    ) -> Self {
        Self {
            document,
            scope: scope.into(),
            numeric_materialization,
        }
    }

    #[must_use]
    pub const fn capabilities(&self) -> AeonSansaCapabilities {
        AeonSansaCapabilities {
            namespace_projection: AeonSansaCapabilityState::Complete,
            exact_address_lookup: AeonSansaCapabilityState::Complete,
            address_parsing: SANSA_RUNTIME_CAPABILITY,
            resolve: SANSA_RUNTIME_CAPABILITY,
            query: SANSA_RUNTIME_CAPABILITY,
            local_spaces: AeonSansaCapabilityState::NotExposed,
        }
    }

    /// Resolve a SANSA address against this document namespace.
    #[cfg(feature = "sansa")]
    #[must_use]
    pub fn resolve_address(
        &self,
        address: &str,
        options: &runtime::resolve::ResolveOptions<AeonSansaBinding>,
    ) -> runtime::resolve::ResolveOutput<AeonSansaBinding> {
        runtime::resolve::resolve_address(address, self, options)
    }

    /// Parse and evaluate a stable SANSA Query against this document namespace.
    #[cfg(feature = "sansa")]
    #[must_use]
    pub fn evaluate_query(
        &self,
        query: &str,
        options: &runtime::evaluate::EvaluateOptions<AeonSansaBinding>,
    ) -> runtime::evaluate::QueryOutput<AeonSansaBinding> {
        runtime::evaluate::evaluate_query(query, self, options)
    }

    #[must_use]
    pub fn root(&self) -> AeonSansaBinding {
        let id = match self.scope {
            DocumentScope::Payload => self.document.payload_root(),
            DocumentScope::Header => self.document.header_root(),
            DocumentScope::Full => self.document.full_root(),
        };
        self.binding(id)
    }

    /// Look up one exact document address.
    ///
    /// This is graph indexing, not SANSA.Resolve. Expanded selectors and
    /// contextual roots are intentionally not accepted by this method.
    #[must_use]
    pub fn at_exact(&self, address: &str) -> Option<AeonSansaBinding> {
        self.document
            .at(self.scope, address)
            .map(|id| self.binding(id))
    }

    #[must_use]
    pub fn bindings_with_identity(&self, identity: &str) -> Vec<AeonSansaBinding> {
        self.document
            .nodes_with_identity(identity)
            .iter()
            .filter(|id| self.document.view(self.scope, **id).is_some())
            .map(|id| self.binding(*id))
            .collect()
    }

    fn binding(&self, id: NodeId) -> AeonSansaBinding {
        AeonSansaBinding {
            document: Arc::clone(&self.document),
            scope: self.scope,
            id,
            numeric_materialization: self.numeric_materialization,
        }
    }
}

#[cfg(feature = "sansa")]
impl runtime::resolve::Namespace for AeonSansaNamespace {
    type Binding = AeonSansaBinding;

    fn root(&self) -> Option<Self::Binding> {
        Some(AeonSansaNamespace::root(self))
    }

    fn children(&self, binding: &Self::Binding) -> Vec<Self::Binding> {
        binding.children()
    }

    fn parent(&self, binding: &Self::Binding) -> runtime::resolve::Navigation<Self::Binding> {
        binding.parent().map_or(
            runtime::resolve::Navigation::Missing,
            runtime::resolve::Navigation::Binding,
        )
    }

    fn attribute_space(
        &self,
        binding: &Self::Binding,
    ) -> runtime::resolve::Navigation<Self::Binding> {
        binding.attribute_space().map_or(
            runtime::resolve::Navigation::Missing,
            runtime::resolve::Navigation::Binding,
        )
    }

    fn name(&self, binding: &Self::Binding) -> Option<String> {
        binding.name().map(str::to_owned)
    }

    fn position(&self, binding: &Self::Binding) -> Option<usize> {
        binding.index()
    }

    fn semantic_type(&self, binding: &Self::Binding) -> Option<String> {
        binding.runtime_semantic_type()
    }

    fn representation_kind(&self, binding: &Self::Binding) -> Option<String> {
        Some(binding.representation_kind().to_owned())
    }

    fn value(&self, binding: &Self::Binding) -> Option<runtime::value_semantics::Value> {
        binding.runtime_value()
    }

    fn binding_address(&self, binding: &Self::Binding) -> Option<String> {
        Some(binding.address())
    }
}

#[derive(Debug, Clone)]
pub struct AeonSansaBinding {
    document: Arc<AeonDocument>,
    scope: DocumentScope,
    id: NodeId,
    numeric_materialization: AeonNumericMaterialization,
}

impl PartialEq for AeonSansaBinding {
    fn eq(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.document, &other.document)
            && self.scope == other.scope
            && self.id == other.id
            && self.numeric_materialization == other.numeric_materialization
    }
}

impl Eq for AeonSansaBinding {}

impl AeonSansaBinding {
    #[must_use]
    pub fn address(&self) -> String {
        self.document
            .address(self.scope, self.id)
            .expect("a SANSA binding is always visible in its selected scope")
    }

    #[must_use]
    pub fn parent(&self) -> Option<Self> {
        let id = self.node().parent()?;
        self.document.view(self.scope, id)?;
        Some(self.with_id(id))
    }

    #[must_use]
    pub fn children(&self) -> Vec<Self> {
        self.node()
            .children()
            .iter()
            .filter(|id| self.document.view(self.scope, **id).is_some())
            .map(|id| self.with_id(*id))
            .collect()
    }

    #[must_use]
    pub fn member(&self, name: &str) -> Option<Self> {
        self.view().member(name).map(|view| self.with_id(view.id()))
    }

    #[must_use]
    pub fn position(&self, index: usize) -> Option<Self> {
        self.view()
            .position(index)
            .map(|view| self.with_id(view.id()))
    }

    #[must_use]
    pub fn attribute_space(&self) -> Option<Self> {
        self.view()
            .attribute_space()
            .map(|view| self.with_id(view.id()))
    }

    #[must_use]
    pub fn name(&self) -> Option<&str> {
        (!self.is_selected_root())
            .then(|| self.node().binding_name())
            .flatten()
    }

    #[must_use]
    pub fn index(&self) -> Option<usize> {
        self.node().position()
    }

    #[must_use]
    pub fn identity(&self) -> Option<&str> {
        self.node().identity()
    }

    #[must_use]
    pub fn semantic_type(&self) -> Option<&str> {
        self.node()
            .datatype()
            .or_else(|| semantic_type(self.node().representation_kind()))
    }

    #[cfg(feature = "sansa")]
    fn runtime_semantic_type(&self) -> Option<String> {
        let node = self.node();
        if let Some(datatype) = node.datatype() {
            return Some(format_datatype_descriptor(&DatatypeDescriptor {
                datatype: datatype.to_owned(),
                generics: node.generics().to_vec(),
                clarifiers: node.clarifiers().to_vec(),
            }));
        }
        semantic_type(node.representation_kind()).map(str::to_owned)
    }

    #[must_use]
    pub fn datatype(&self) -> Option<&str> {
        self.node().datatype()
    }

    #[must_use]
    pub fn generics(&self) -> Vec<AeonSansaGenericArgument> {
        self.node()
            .generics()
            .iter()
            .map(generic_argument)
            .collect()
    }

    #[must_use]
    pub fn clarifiers(&self) -> Vec<AeonSansaClarifier> {
        self.node().clarifiers().iter().map(clarifier).collect()
    }

    #[must_use]
    pub fn representation_kind(&self) -> &str {
        self.node().representation_kind()
    }

    #[must_use]
    pub fn scalar_kind(&self) -> Option<&'static str> {
        scalar_kind(self.node().representation_kind())
    }

    #[must_use]
    pub fn null_reason(&self) -> Option<&str> {
        (self.node().representation_kind() == "NullLiteral")
            .then(|| self.node().value())
            .flatten()
    }

    #[must_use]
    pub fn numeric_lexeme(&self) -> Option<&str> {
        (self.node().representation_kind() == "NumberLiteral")
            .then(|| self.node().value())
            .flatten()
    }

    #[must_use]
    pub fn radix_base(&self) -> Option<u32> {
        if self.node().representation_kind() != "RadixLiteral" {
            return None;
        }
        radix_base_from_datatype(self.node().datatype()).or_else(|| {
            let clarifiers = self.node().clarifiers();
            if self.node().datatype() != Some("radix") || clarifiers.len() != 1 {
                return None;
            }
            match &clarifiers[0] {
                DatatypeClarifier {
                    kind: ClarifierKind::NumberLiteral,
                    value,
                } => value
                    .parse::<u32>()
                    .ok()
                    .filter(|base| (2..=64).contains(base)),
                _ => None,
            }
        })
    }

    #[must_use]
    pub fn radix_scale(&self) -> Option<usize> {
        if self.node().representation_kind() != "RadixLiteral" {
            return None;
        }
        radix_scale(self.node().value()?, self.radix_base())
    }

    #[must_use]
    pub fn value(&self) -> Option<AeonSansaValue> {
        let node = self.node();
        let value = node.value();
        match node.representation_kind() {
            "StringLiteral" | "DateLiteral" | "DateTimeLiteral" | "TimeLiteral"
            | "WTCDateTimeLiteral" | "HexLiteral" | "RadixLiteral" | "EncodingLiteral"
            | "SeparatorLiteral" | "SymbolicLiteral" | "ToggleLiteral" | "NodeHead" => {
                value.map(|value| AeonSansaValue::Text(value.to_owned()))
            }
            "NumberLiteral" => match self.numeric_materialization {
                AeonNumericMaterialization::Lossless => {
                    value.map(|value| AeonSansaValue::NumberLexeme(value.to_owned()))
                }
                AeonNumericMaterialization::Native => value
                    .and_then(|value| value.parse::<f64>().ok())
                    .map(AeonSansaValue::NativeNumber),
            },
            "InfinityLiteral" => Some(AeonSansaValue::NonFinite(if value == Some("-Infinity") {
                AeonSansaNonFinite::NegativeInfinity
            } else {
                AeonSansaNonFinite::PositiveInfinity
            })),
            "NaNLiteral" => Some(AeonSansaValue::NonFinite(AeonSansaNonFinite::NaN)),
            "BooleanLiteral" => value.map(|value| AeonSansaValue::Boolean(value == "true")),
            "NullLiteral" => Some(AeonSansaValue::Null),
            "SansaAddressLiteral" => value.map(|value| AeonSansaValue::Address {
                address: value.to_owned(),
                canonical: value.to_owned(),
            }),
            "CloneReference" | "PointerReference" => value.map(|value| {
                let path = if self.scope == DocumentScope::Full {
                    address_in_plane(node.source_plane(), value)
                } else {
                    value.to_owned()
                };
                let kind = if node.representation_kind() == "PointerReference" {
                    AeonSansaReferenceKind::Pointer
                } else {
                    AeonSansaReferenceKind::Clone
                };
                let sigil = if kind == AeonSansaReferenceKind::Pointer {
                    "~>"
                } else {
                    "~"
                };
                AeonSansaValue::Reference {
                    kind,
                    canonical: format!("{sigil}{path}"),
                    path,
                }
            }),
            _ => None,
        }
    }

    #[cfg(feature = "sansa")]
    fn runtime_value(&self) -> Option<runtime::value_semantics::Value> {
        use runtime::value_semantics::{FiniteNumber, Value};

        let node = self.node();
        if node.representation_kind() == "NodeLiteral" {
            return Some(Value::Container {
                kind: String::from("NodeLiteral"),
                payload: self.runtime_node_payload(),
            });
        }
        if is_container_kind(node.representation_kind()) {
            return Some(Value::Container {
                kind: node.representation_kind().to_owned(),
                payload: self.runtime_container_payload(),
            });
        }

        let payload = node.value();
        Some(match node.representation_kind() {
            "StringLiteral" | "NodeHead" => Value::String(payload?.to_owned()),
            "NumberLiteral" => Value::FiniteNumber(FiniteNumber::parse(payload?).ok()?),
            "InfinityLiteral" if payload == Some("-Infinity") => Value::NegativeInfinity,
            "InfinityLiteral" => Value::PositiveInfinity,
            "NaNLiteral" => Value::Nan,
            "BooleanLiteral" => Value::Boolean(payload? == "true"),
            "ToggleLiteral" => Value::Toggle(payload?.to_owned()),
            "HexLiteral" => Value::Hex(payload?.to_owned()),
            "RadixLiteral" => Value::Radix {
                payload: payload?.to_owned(),
                semantic_type: self
                    .runtime_semantic_type()
                    .unwrap_or_else(|| String::from("radix")),
            },
            "EncodingLiteral" => Value::Encoding(payload?.to_owned()),
            "SeparatorLiteral" => Value::Separator(payload?.to_owned()),
            "SymbolicLiteral" => Value::Symbol(payload?.to_owned()),
            "SansaAddressLiteral" => Value::SansaAddress(payload?.to_owned()),
            "DateLiteral" => Value::Temporal {
                payload: payload?.to_owned(),
                semantic_type: self
                    .runtime_semantic_type()
                    .unwrap_or_else(|| String::from("date")),
            },
            "TimeLiteral" => Value::Temporal {
                payload: payload?.to_owned(),
                semantic_type: self
                    .runtime_semantic_type()
                    .unwrap_or_else(|| String::from("time")),
            },
            "DateTimeLiteral" => Value::Temporal {
                payload: payload?.to_owned(),
                semantic_type: self
                    .runtime_semantic_type()
                    .unwrap_or_else(|| String::from("datetime")),
            },
            "WTCDateTimeLiteral" => Value::Temporal {
                payload: payload?.to_owned(),
                semantic_type: self
                    .runtime_semantic_type()
                    .unwrap_or_else(|| String::from("wtc")),
            },
            "NullLiteral" => Value::ExplicitNull {
                reason: payload.unwrap_or_default().to_owned(),
            },
            "CloneReference" | "PointerReference" => {
                let target = if self.scope == DocumentScope::Full {
                    address_in_plane(node.source_plane(), payload?)
                } else {
                    payload?.to_owned()
                };
                Value::ReferenceForm {
                    kind: node.representation_kind().to_owned(),
                    target,
                }
            }
            _ => Value::String(payload?.to_owned()),
        })
    }

    #[cfg(feature = "sansa")]
    fn runtime_node_payload(&self) -> runtime::value_semantics::ContainerValue {
        use std::collections::BTreeMap;

        use runtime::value_semantics::{ContainerValue, Value};

        let head = self
            .children()
            .into_iter()
            .find(|child| child.representation_kind() == "NodeHead");
        let mut node = BTreeMap::new();
        let children = if let Some(head) = head {
            if let Some(tag) = head.node_tag() {
                node.insert(
                    String::from("tag"),
                    ContainerValue::Scalar(Box::new(Value::String(tag.to_owned()))),
                );
            }
            if let Some(attributes) = head.attribute_space() {
                node.insert(
                    String::from("attributes"),
                    attributes.runtime_container_payload(),
                );
            }
            head.children()
        } else {
            Vec::new()
        };
        node.insert(
            String::from("children"),
            ContainerValue::Sequence(
                children
                    .iter()
                    .map(AeonSansaBinding::runtime_container_entry)
                    .collect(),
            ),
        );
        ContainerValue::Object(node)
    }

    #[cfg(feature = "sansa")]
    fn runtime_container_payload(&self) -> runtime::value_semantics::ContainerValue {
        use std::collections::BTreeMap;

        use runtime::value_semantics::ContainerValue;

        let children = self.children();
        let sequence = is_sequence_kind(self.representation_kind())
            || (!children.is_empty() && children.iter().all(|child| child.index().is_some()));
        if sequence {
            return ContainerValue::Sequence(
                children
                    .iter()
                    .map(AeonSansaBinding::runtime_container_entry)
                    .collect(),
            );
        }

        let mut entries = BTreeMap::new();
        for child in children {
            if let Some(name) = child.name() {
                entries.insert(name.to_owned(), child.runtime_container_entry());
            }
        }
        ContainerValue::Object(entries)
    }

    #[cfg(feature = "sansa")]
    fn runtime_container_entry(&self) -> runtime::value_semantics::ContainerValue {
        use runtime::value_semantics::ContainerValue;

        if self.node().representation_kind() == "NodeLiteral" {
            self.runtime_node_payload()
        } else if is_container_kind(self.node().representation_kind()) {
            self.runtime_container_payload()
        } else {
            self.runtime_value()
                .map(|value| ContainerValue::Scalar(Box::new(value)))
                .unwrap_or(ContainerValue::Null)
        }
    }

    #[must_use]
    pub fn node_tag(&self) -> Option<&str> {
        match self.node().representation_kind() {
            "NodeHead" => self.node().value(),
            "NodeLiteral" => self
                .node()
                .children()
                .iter()
                .filter_map(|id| self.document.node(*id))
                .find(|child| child.representation_kind() == "NodeHead")
                .and_then(DocumentNode::value),
            _ => None,
        }
    }

    #[must_use]
    pub fn source_plane(&self) -> Option<&'static str> {
        if self.is_selected_root() || self.node().representation_kind() == "attributeSpace" {
            return None;
        }
        self.node().source_plane().map(|plane| match plane {
            DocumentSourcePlane::Header => "header",
            DocumentSourcePlane::Body => "body",
        })
    }

    #[must_use]
    pub fn origin(&self) -> Option<&str> {
        self.node().origin()
    }

    #[must_use]
    pub fn span(&self) -> Option<&str> {
        self.node().span()
    }

    #[must_use]
    pub fn lineage(&self) -> &'static str {
        match self.node().lineage() {
            NodeLineage::Synthetic => "synthetic",
            NodeLineage::PortableEvent { .. } => "portable_event",
        }
    }

    fn node(&self) -> &DocumentNode {
        self.document
            .node(self.id)
            .expect("a SANSA binding always references a document node")
    }

    fn view(&self) -> aeon_document::DocumentView<'_> {
        self.document
            .view(self.scope, self.id)
            .expect("a SANSA binding is always visible in its selected scope")
    }

    fn with_id(&self, id: NodeId) -> Self {
        Self {
            document: Arc::clone(&self.document),
            scope: self.scope,
            id,
            numeric_materialization: self.numeric_materialization,
        }
    }

    fn is_selected_root(&self) -> bool {
        self.id
            == match self.scope {
                DocumentScope::Payload => self.document.payload_root(),
                DocumentScope::Header => self.document.header_root(),
                DocumentScope::Full => self.document.full_root(),
            }
    }
}

fn generic_argument(argument: &GenericArgument) -> AeonSansaGenericArgument {
    match argument {
        GenericArgument::Datatype(descriptor) => {
            AeonSansaGenericArgument::Datatype(datatype_descriptor(descriptor))
        }
        GenericArgument::NumberLiteral(value) => {
            AeonSansaGenericArgument::NumberLiteral(value.clone())
        }
    }
}

fn datatype_descriptor(descriptor: &DatatypeDescriptor) -> AeonSansaDatatypeDescriptor {
    AeonSansaDatatypeDescriptor {
        datatype: descriptor.datatype.clone(),
        generics: descriptor.generics.iter().map(generic_argument).collect(),
        clarifiers: descriptor.clarifiers.iter().map(clarifier).collect(),
    }
}

fn clarifier(value: &DatatypeClarifier) -> AeonSansaClarifier {
    AeonSansaClarifier {
        kind: match value.kind {
            ClarifierKind::StringLiteral => AeonSansaClarifierKind::StringLiteral,
            ClarifierKind::NumberLiteral => AeonSansaClarifierKind::NumberLiteral,
        },
        value: value.value.clone(),
    }
}

fn semantic_type(kind: &str) -> Option<&'static str> {
    match kind {
        "StringLiteral" => Some("string"),
        "NumberLiteral" => Some("number"),
        "InfinityLiteral" => Some("infinity"),
        "NaNLiteral" => Some("nan"),
        "NullLiteral" => Some("null"),
        "BooleanLiteral" => Some("boolean"),
        "ToggleLiteral" => Some("toggle"),
        "HexLiteral" => Some("hex"),
        "RadixLiteral" => Some("radix"),
        "EncodingLiteral" => Some("encoding"),
        "SeparatorLiteral" => Some("sep"),
        "SymbolicLiteral" => Some("symbol"),
        "SansaAddressLiteral" => Some("sansa"),
        "DateLiteral" => Some("date"),
        "TimeLiteral" => Some("time"),
        "DateTimeLiteral" => Some("datetime"),
        "WTCDateTimeLiteral" => Some("wtc"),
        _ => None,
    }
}

fn scalar_kind(kind: &str) -> Option<&'static str> {
    match kind {
        "NumberLiteral" => Some("number"),
        "NullLiteral" => Some("null"),
        "InfinityLiteral" => Some("infinity"),
        "NaNLiteral" => Some("nan"),
        "ToggleLiteral" => Some("toggle"),
        "HexLiteral" => Some("hex"),
        "RadixLiteral" => Some("radix"),
        "EncodingLiteral" => Some("encoding"),
        "SeparatorLiteral" => Some("separator"),
        "SymbolicLiteral" => Some("symbol"),
        "SansaAddressLiteral" => Some("sansaAddress"),
        "DateLiteral" => Some("date"),
        "TimeLiteral" => Some("time"),
        "DateTimeLiteral" => Some("datetime"),
        "WTCDateTimeLiteral" => Some("wtc"),
        "CloneReference" | "PointerReference" => Some("referenceForm"),
        _ => None,
    }
}

#[cfg(feature = "sansa")]
fn is_container_kind(kind: &str) -> bool {
    matches!(
        kind,
        "ObjectNode" | "ListNode" | "TupleLiteral" | "attributeSpace"
    )
}

#[cfg(feature = "sansa")]
fn is_sequence_kind(kind: &str) -> bool {
    matches!(kind, "ListNode" | "TupleLiteral")
}

fn address_in_plane(plane: Option<DocumentSourcePlane>, address: &str) -> String {
    let plane = match plane {
        Some(DocumentSourcePlane::Header) => "header",
        Some(DocumentSourcePlane::Body) | None => "body",
    };
    if address == "$" {
        format!("$.{plane}")
    } else {
        format!("$.{plane}{}", &address[1..])
    }
}

fn radix_base_from_datatype(datatype: Option<&str>) -> Option<u32> {
    let datatype = datatype?.trim().to_ascii_lowercase();
    if datatype == "decimal" {
        return Some(10);
    }
    match datatype.as_str() {
        "radix2" => Some(2),
        "radix6" => Some(6),
        "radix8" => Some(8),
        "radix12" => Some(12),
        _ => None,
    }
}

fn radix_scale(value: &str, base: Option<u32>) -> Option<usize> {
    let mut saw_digit = false;
    let mut saw_point = false;
    let mut scale = 0;
    let mut characters = value.chars().peekable();
    if matches!(characters.peek(), Some('+' | '-')) {
        characters.next();
    }
    for character in characters {
        if character == '.' {
            if saw_point {
                return None;
            }
            saw_point = true;
            continue;
        }
        if character == '_' {
            continue;
        }
        let digit = radix_digit_value(character)?;
        if base.is_some_and(|base| digit >= base) {
            return None;
        }
        saw_digit = true;
        if saw_point {
            scale += 1;
        }
    }
    (saw_digit && (!saw_point || scale > 0)).then_some(scale)
}

fn radix_digit_value(character: char) -> Option<u32> {
    match character {
        '0'..='9' => Some(character as u32 - '0' as u32),
        'A'..='Z' => Some(character as u32 - 'A' as u32 + 10),
        'a'..='z' => Some(character as u32 - 'a' as u32 + 36),
        '&' => Some(62),
        '!' => Some(63),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use aeon_core::{CompileOptions, DatatypePolicy};
    use serde_json::{Map, Value, json};

    use super::*;

    #[test]
    fn matches_shared_typescript_namespace_projection_except_partial_sequence_spans() {
        let contract: Value = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../../test-fixtures/document-projection/aeon-document-projection.v1.json"
        )))
        .expect("parse document projection contract");

        for fixture in contract["fixtures"].as_array().expect("fixtures") {
            let options = &fixture["compileOptions"];
            let mut compile_options = CompileOptions::default();
            if let Some(depth) = options["maxAttributeDepth"].as_u64() {
                compile_options.max_attribute_depth = depth as usize;
            }
            compile_options.datatype_policy = match options["datatypePolicy"].as_str() {
                Some("allow_custom") => Some(DatatypePolicy::AllowCustom),
                Some("reserved_only") => Some(DatatypePolicy::ReservedOnly),
                None => None,
                Some(value) => panic!("unknown datatype policy {value}"),
            };
            let document = AeonDocument::compile(
                fixture["source"].as_str().expect("fixture source"),
                compile_options,
            )
            .expect("compile fixture document");

            for (scope_name, expected) in fixture["scopes"].as_object().expect("scopes") {
                let scope = match scope_name.as_str() {
                    "payload" => AeonSansaScope::Payload,
                    "header" => AeonSansaScope::Header,
                    "full" => AeonSansaScope::Full,
                    value => panic!("unknown scope {value}"),
                };
                let namespace = AeonSansaNamespace::new(
                    document.clone(),
                    scope,
                    AeonNumericMaterialization::Lossless,
                );
                let mut actual = snapshot_namespace(&namespace);
                let mut expected = expected.clone();
                omit_partial_sequence_spans(&mut actual);
                omit_partial_sequence_spans(&mut expected);
                assert_eq!(
                    actual,
                    expected,
                    "{} ({scope_name})",
                    fixture["id"].as_str().expect("fixture id")
                );
            }
        }
    }

    #[test]
    fn exposes_only_exact_rust_source_spans() {
        let document = AeonDocument::compile(
            "named = 1\nsequence = [2]\nnode:node = <tag(\"value\")>",
            CompileOptions::default(),
        )
        .expect("compile document");
        let namespace = AeonSansaNamespace::new(
            document,
            AeonSansaScope::Payload,
            AeonNumericMaterialization::Lossless,
        );

        assert_eq!(
            namespace
                .at_exact("$.named")
                .and_then(|binding| binding.span().map(str::to_owned))
                .as_deref(),
            Some("0:9")
        );
        assert_eq!(
            namespace
                .at_exact("$.sequence[0]")
                .and_then(|binding| binding.span().map(str::to_owned)),
            None
        );
        assert!(
            namespace
                .at_exact("$.node[0]")
                .and_then(|binding| binding.span().map(str::to_owned))
                .is_some()
        );
        assert_eq!(
            namespace
                .at_exact("$.node[0][0]")
                .and_then(|binding| binding.span().map(str::to_owned)),
            None
        );
    }

    #[test]
    fn handle_navigation_supports_parent_then_sibling_without_recursive_copies() {
        let document = AeonDocument::compile(
            "inventory = { items = [{ sku = \"A1\", qty = 2 }] }",
            CompileOptions::default(),
        )
        .expect("compile document");
        let namespace = AeonSansaNamespace::new(
            document,
            AeonSansaScope::Payload,
            AeonNumericMaterialization::Lossless,
        );
        let sku = namespace
            .root()
            .member("inventory")
            .and_then(|binding| binding.member("items"))
            .and_then(|binding| binding.position(0))
            .and_then(|binding| binding.member("sku"))
            .expect("sku binding");
        let item = sku.parent().expect("item parent");
        let quantity = item.member("qty").expect("quantity sibling");

        assert_eq!(item.address(), "$.inventory.items[0]");
        assert_eq!(quantity.address(), "$.inventory.items[0].qty");
        assert_eq!(quantity.numeric_lexeme(), Some("2"));
    }

    #[cfg(not(feature = "sansa"))]
    #[test]
    fn advertises_projection_without_claiming_resolve_or_query() {
        let document = AeonDocument::compile("value = 1", CompileOptions::default())
            .expect("compile document");
        let namespace = AeonSansaNamespace::new(
            document,
            AeonSansaScope::Payload,
            AeonNumericMaterialization::Lossless,
        );

        assert_eq!(
            namespace.capabilities(),
            AeonSansaCapabilities {
                namespace_projection: AeonSansaCapabilityState::Complete,
                exact_address_lookup: AeonSansaCapabilityState::Complete,
                address_parsing: AeonSansaCapabilityState::NotExposed,
                resolve: AeonSansaCapabilityState::NotExposed,
                query: AeonSansaCapabilityState::NotExposed,
                local_spaces: AeonSansaCapabilityState::NotExposed,
            }
        );
        assert!(namespace.at_exact("$.value").is_some());
        assert!(namespace.at_exact("$.*").is_none());
    }

    #[cfg(feature = "sansa")]
    #[test]
    fn maps_every_scalar_literal_family_to_exact_runtime_values() {
        use runtime::value_semantics::{FiniteNumber, Value};

        let namespace = AeonSansaNamespace::compile(
            r#"
text = "hello"
number = 1.20
positive = Infinity
negative = -Infinity
not_number = NaN
boolean = true
toggle:toggle = on
hex:hex = #ff_ff
radix:radix[16] = %ff
encoded:encoding = &QmFzZTY0IQ==
separator:sep["."] = ^1.2
symbol:symbol = |approved|
address:sansa = $.text
date:date = 2024-02-29
time:time = 10:11:12.123Z
datetime:datetime = 2024-02-29T10:11:12Z
wtc:wtc = 2024-02-29T10:11:12Z&Europe/Brussels
nothing:null = !"postponed"
copy = ~text
pointer = ~>text
"#,
            CompileOptions::default(),
            AeonSansaScope::Payload,
            AeonNumericMaterialization::Lossless,
        )
        .expect("compile literal namespace");

        let expected = [
            ("$.text", Value::String(String::from("hello"))),
            (
                "$.number",
                Value::FiniteNumber(FiniteNumber::parse("1.2").expect("finite number")),
            ),
            ("$.positive", Value::PositiveInfinity),
            ("$.negative", Value::NegativeInfinity),
            ("$.not_number", Value::Nan),
            ("$.boolean", Value::Boolean(true)),
            ("$.toggle", Value::Toggle(String::from("on"))),
            ("$.hex", Value::Hex(String::from("ffff"))),
            (
                "$.radix",
                Value::Radix {
                    payload: String::from("ff"),
                    semantic_type: String::from("radix[16]"),
                },
            ),
            ("$.encoded", Value::Encoding(String::from("QmFzZTY0IQ=="))),
            ("$.separator", Value::Separator(String::from("1.2"))),
            ("$.symbol", Value::Symbol(String::from("approved"))),
            ("$.address", Value::SansaAddress(String::from("$.text"))),
            (
                "$.date",
                Value::Temporal {
                    payload: String::from("2024-02-29"),
                    semantic_type: String::from("date"),
                },
            ),
            (
                "$.time",
                Value::Temporal {
                    payload: String::from("10:11:12.123Z"),
                    semantic_type: String::from("time"),
                },
            ),
            (
                "$.datetime",
                Value::Temporal {
                    payload: String::from("2024-02-29T10:11:12Z"),
                    semantic_type: String::from("datetime"),
                },
            ),
            (
                "$.wtc",
                Value::Temporal {
                    payload: String::from("2024-02-29T10:11:12Z&Europe/Brussels"),
                    semantic_type: String::from("wtc"),
                },
            ),
            (
                "$.nothing",
                Value::ExplicitNull {
                    reason: String::from("postponed"),
                },
            ),
            (
                "$.copy",
                Value::ReferenceForm {
                    kind: String::from("CloneReference"),
                    target: String::from("$.text"),
                },
            ),
            (
                "$.pointer",
                Value::ReferenceForm {
                    kind: String::from("PointerReference"),
                    target: String::from("$.text"),
                },
            ),
        ];

        for (address, value) in expected {
            let binding = namespace.at_exact(address).expect("binding should exist");
            assert_eq!(binding.runtime_value(), Some(value), "{address}");
        }

        for (address, semantic_type) in [("$.radix", "radix[16]"), ("$.separator", "sep[\".\"]")] {
            let binding = namespace.at_exact(address).expect("binding should exist");
            assert_eq!(
                runtime::resolve::Namespace::semantic_type(&namespace, &binding).as_deref(),
                Some(semantic_type),
                "{address}"
            );
        }
    }

    #[cfg(feature = "sansa")]
    #[test]
    fn node_equality_includes_tags_attributes_and_ordered_content() {
        use runtime::evaluate::EvaluateOptions;

        let namespace = AeonSansaNamespace::compile(
            r#"
left:node = <alpha@{tone = "warm"}("x", "y")>
same:node = <alpha@{tone = "warm"}("x", "y")>
different_tag:node = <beta@{tone = "warm"}("x", "y")>
different_attribute:node = <alpha@{tone = "cool"}("x", "y")>
different_child_order:node = <alpha@{tone = "warm"}("y", "x")>
"#,
            CompileOptions::default(),
            AeonSansaScope::Payload,
            AeonNumericMaterialization::Lossless,
        )
        .expect("compile node namespace");

        for (target, expected_matches) in [
            ("same", 1),
            ("different_tag", 0),
            ("different_attribute", 0),
            ("different_child_order", 0),
        ] {
            let query = format!("from $.left\nwhere . == $.{target}\nselect .");
            let output = namespace.evaluate_query(&query, &EvaluateOptions::default());
            assert!(output.is_ok(), "{target}: {:?}", output.errors);
            assert_eq!(output.results.len(), expected_matches, "{target}");
        }

        let head = namespace
            .at_exact("$.left[0]")
            .expect("node head binding should exist");
        assert_eq!(
            head.runtime_value(),
            Some(runtime::value_semantics::Value::String(String::from(
                "alpha"
            )))
        );
    }

    #[cfg(feature = "sansa")]
    #[test]
    fn resolves_and_queries_the_document_through_the_shared_runtime() {
        use runtime::evaluate::{EvaluateOptions, EvaluatedValue};
        use runtime::resolve::ResolveOptions;

        let document = AeonDocument::compile(
            r#"
inventory = {
  items = [
    { sku = "A-100", qty = 2, stage = |approved| },
    { sku = "B-200", qty = 0, stage = |held| }
  ]
}
left = { code = "same", stage = |approved|, counts = [1, 2] }
right = { code = "same", stage = |approved|, counts = [1, 2] }
"#,
            CompileOptions::default(),
        )
        .expect("compile document");
        let namespace = AeonSansaNamespace::new(
            document,
            AeonSansaScope::Payload,
            AeonNumericMaterialization::Lossless,
        );

        assert_eq!(
            namespace.capabilities(),
            AeonSansaCapabilities {
                namespace_projection: AeonSansaCapabilityState::Complete,
                exact_address_lookup: AeonSansaCapabilityState::Complete,
                address_parsing: AeonSansaCapabilityState::Complete,
                resolve: AeonSansaCapabilityState::Complete,
                query: AeonSansaCapabilityState::Complete,
                local_spaces: AeonSansaCapabilityState::NotExposed,
            }
        );

        let resolved =
            namespace.resolve_address("$.inventory.items.*.sku", &ResolveOptions::default());
        assert!(resolved.is_ok(), "{:?}", resolved.errors);
        assert_eq!(
            resolved
                .bindings
                .iter()
                .map(AeonSansaBinding::address)
                .collect::<Vec<_>>(),
            ["$.inventory.items[0].sku", "$.inventory.items[1].sku"]
        );

        let queried = namespace.evaluate_query(
            "from $.inventory.items.*\n\
             where .qty >= 2 and .stage == |approved|\n\
             select { sku = .sku qty = .qty }",
            &EvaluateOptions::default(),
        );
        assert!(queried.is_ok(), "{:?}", queried.errors);
        assert_eq!(queried.results.len(), 1);
        assert_eq!(
            queried.results[0].candidate.address(),
            "$.inventory.items[0]"
        );
        let EvaluatedValue::Object(fields) = &queried.results[0].value else {
            panic!("query projection should produce an object")
        };
        let EvaluatedValue::Bindings(sku) = &fields[0].1 else {
            panic!("sku projection should preserve its binding")
        };
        assert_eq!(sku[0].address(), "$.inventory.items[0].sku");

        let structural = namespace.evaluate_query(
            "from $.left\nwhere . == $.right\nselect .",
            &EvaluateOptions::default(),
        );
        assert!(structural.is_ok(), "{:?}", structural.errors);
        assert_eq!(structural.results.len(), 1);
    }

    fn snapshot_namespace(namespace: &AeonSansaNamespace) -> Value {
        let mut output = Vec::new();
        visit(&namespace.root(), None, &mut output);
        Value::Array(output)
    }

    fn visit(binding: &AeonSansaBinding, parent: Option<&str>, output: &mut Vec<Value>) {
        let address = binding.address();
        let mut value = Map::new();
        value.insert(String::from("address"), json!(address));
        if let Some(parent) = parent {
            value.insert(String::from("parent"), json!(parent));
        }
        insert(&mut value, "name", binding.name().map(str::to_owned));
        insert(&mut value, "index", binding.index());
        insert(
            &mut value,
            "identity",
            binding.identity().map(str::to_owned),
        );
        insert(
            &mut value,
            "semanticType",
            binding.semantic_type().map(str::to_owned),
        );
        insert(
            &mut value,
            "datatype",
            binding.datatype().map(str::to_owned),
        );
        let generics = binding.generics();
        if !generics.is_empty() {
            value.insert(
                String::from("generics"),
                Value::Array(generics.iter().map(generic_json).collect()),
            );
        } else if binding.datatype().is_some() {
            value.insert(String::from("generics"), json!([]));
        }
        let clarifiers = binding.clarifiers();
        if !clarifiers.is_empty() {
            value.insert(
                String::from("clarifiers"),
                Value::Array(clarifiers.iter().map(clarifier_json).collect()),
            );
        } else if binding.datatype().is_some() {
            value.insert(String::from("clarifiers"), json!([]));
        }
        value.insert(
            String::from("representationKind"),
            json!(binding.representation_kind()),
        );
        insert(&mut value, "scalarKind", binding.scalar_kind());
        insert(&mut value, "nullReason", binding.null_reason());
        insert(&mut value, "numericLexeme", binding.numeric_lexeme());
        insert(&mut value, "radixBase", binding.radix_base());
        insert(&mut value, "radixScale", binding.radix_scale());
        if let Some(binding_value) = binding.value() {
            value.insert(String::from("value"), sansa_value_json(&binding_value));
        }
        insert(&mut value, "nodeTag", binding.node_tag());
        insert(&mut value, "sourcePlane", binding.source_plane());
        insert(&mut value, "origin", binding.origin());
        insert(&mut value, "span", binding.span());
        let children = binding.children();
        value.insert(
            String::from("children"),
            Value::Array(
                children
                    .iter()
                    .map(|child| json!(child.address()))
                    .collect(),
            ),
        );
        let attribute_space = binding.attribute_space();
        if let Some(attribute_space) = &attribute_space {
            value.insert(
                String::from("attributeSpace"),
                json!(attribute_space.address()),
            );
        }
        output.push(Value::Object(value));

        for child in children {
            visit(&child, Some(&address), output);
        }
        if let Some(attribute_space) = attribute_space {
            visit(&attribute_space, Some(&address), output);
        }
    }

    fn insert<T: serde::Serialize>(target: &mut Map<String, Value>, name: &str, value: Option<T>) {
        if let Some(value) = value {
            target.insert(
                name.to_owned(),
                serde_json::to_value(value).expect("serialize snapshot value"),
            );
        }
    }

    fn omit_partial_sequence_spans(snapshot: &mut Value) {
        let Some(bindings) = snapshot.as_array_mut() else {
            return;
        };
        for binding in bindings {
            let Some(binding) = binding.as_object_mut() else {
                continue;
            };
            if binding.contains_key("index")
                && binding.get("representationKind").and_then(Value::as_str) != Some("NodeHead")
            {
                binding.remove("span");
            }
        }
    }

    fn generic_json(argument: &AeonSansaGenericArgument) -> Value {
        match argument {
            AeonSansaGenericArgument::Datatype(descriptor) => json!({
                "datatype": descriptor.datatype,
                "generics": descriptor.generics.iter().map(generic_json).collect::<Vec<_>>(),
                "clarifiers": descriptor.clarifiers.iter().map(clarifier_json).collect::<Vec<_>>(),
            }),
            AeonSansaGenericArgument::NumberLiteral(value) => {
                json!({"kind": "NumberLiteral", "value": value})
            }
        }
    }

    fn clarifier_json(clarifier: &AeonSansaClarifier) -> Value {
        json!({
            "kind": match clarifier.kind {
                AeonSansaClarifierKind::StringLiteral => "StringLiteral",
                AeonSansaClarifierKind::NumberLiteral => "NumberLiteral",
            },
            "value": clarifier.value,
        })
    }

    fn sansa_value_json(value: &AeonSansaValue) -> Value {
        match value {
            AeonSansaValue::Text(value) | AeonSansaValue::NumberLexeme(value) => json!(value),
            AeonSansaValue::NativeNumber(value) => json!(value),
            AeonSansaValue::Boolean(value) => json!(value),
            AeonSansaValue::Null => Value::Null,
            AeonSansaValue::NonFinite(value) => json!({
                "$nonFinite": match value {
                    AeonSansaNonFinite::NaN => "nan",
                    AeonSansaNonFinite::PositiveInfinity => "positive-infinity",
                    AeonSansaNonFinite::NegativeInfinity => "negative-infinity",
                }
            }),
            AeonSansaValue::Address { address, canonical } => json!({
                "type": "SansaAddressLiteral",
                "address": address,
                "canonical": canonical,
            }),
            AeonSansaValue::Reference {
                kind,
                path,
                canonical,
            } => json!({
                "type": match kind {
                    AeonSansaReferenceKind::Clone => "CloneReference",
                    AeonSansaReferenceKind::Pointer => "PointerReference",
                },
                "path": path,
                "canonical": canonical,
            }),
        }
    }
}
