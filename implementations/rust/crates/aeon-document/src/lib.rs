//! Immutable, capability-aware document graph projected from AEON Core.

use std::collections::HashMap;
use std::error::Error;
use std::fmt;
use std::sync::Arc;

use aeon_core::{
    CompileOptions, Diagnostic, PortableAesCompatibilityEvent, PortableAesCompatibilityOptions,
    SansaSelector, adapt_rust_assignment_events_to_portable_aes, compile, parse_sansa_address,
};
use aes_telex::{DatatypeClarifier, GenericArgument};

/// Stable node identity within one immutable document snapshot.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct NodeId(usize);

impl NodeId {
    #[must_use]
    pub const fn index(self) -> usize {
        self.0
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum DocumentScope {
    Payload,
    Header,
    Full,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum DocumentSourcePlane {
    Body,
    Header,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CapabilityState {
    Complete,
    Partial,
    NotSupplied,
    NotCollected,
    NotApplicable,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DocumentCapabilities {
    pub source_bytes: CapabilityState,
    pub authored_lexemes: CapabilityState,
    pub origin: CapabilityState,
    pub span: CapabilityState,
    pub portable_extensions: CapabilityState,
    pub unknown_telex_fields: CapabilityState,
    pub event_order: CapabilityState,
    pub lineage: CapabilityState,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NodeLineage {
    Synthetic,
    PortableEvent {
        ordinal: usize,
        event_address: String,
    },
}

/// One immutable graph entry. Synthetic roots and attribute spaces have no
/// portable event fields and never invent provenance.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DocumentNode {
    id: NodeId,
    full_address: String,
    event_address: Option<String>,
    parent: Option<NodeId>,
    children: Vec<NodeId>,
    attribute_space: Option<NodeId>,
    binding_name: Option<String>,
    position: Option<usize>,
    source_plane: Option<DocumentSourcePlane>,
    representation_kind: String,
    identity: Option<String>,
    datatype: Option<String>,
    generics: Vec<GenericArgument>,
    clarifiers: Vec<DatatypeClarifier>,
    value: Option<String>,
    origin: Option<String>,
    span: Option<String>,
    lineage: NodeLineage,
}

impl DocumentNode {
    #[must_use]
    pub const fn id(&self) -> NodeId {
        self.id
    }

    #[must_use]
    pub fn full_address(&self) -> &str {
        &self.full_address
    }

    #[must_use]
    pub fn event_address(&self) -> Option<&str> {
        self.event_address.as_deref()
    }

    #[must_use]
    pub const fn parent(&self) -> Option<NodeId> {
        self.parent
    }

    #[must_use]
    pub fn children(&self) -> &[NodeId] {
        &self.children
    }

    #[must_use]
    pub const fn attribute_space(&self) -> Option<NodeId> {
        self.attribute_space
    }

    #[must_use]
    pub fn binding_name(&self) -> Option<&str> {
        self.binding_name.as_deref()
    }

    #[must_use]
    pub const fn position(&self) -> Option<usize> {
        self.position
    }

    #[must_use]
    pub const fn source_plane(&self) -> Option<DocumentSourcePlane> {
        self.source_plane
    }

    #[must_use]
    pub fn representation_kind(&self) -> &str {
        &self.representation_kind
    }

    #[must_use]
    pub fn identity(&self) -> Option<&str> {
        self.identity.as_deref()
    }

    #[must_use]
    pub fn datatype(&self) -> Option<&str> {
        self.datatype.as_deref()
    }

    #[must_use]
    pub fn generics(&self) -> &[GenericArgument] {
        &self.generics
    }

    #[must_use]
    pub fn clarifiers(&self) -> &[DatatypeClarifier] {
        &self.clarifiers
    }

    #[must_use]
    pub fn value(&self) -> Option<&str> {
        self.value.as_deref()
    }

    #[must_use]
    pub fn origin(&self) -> Option<&str> {
        self.origin.as_deref()
    }

    #[must_use]
    pub fn span(&self) -> Option<&str> {
        self.span.as_deref()
    }

    #[must_use]
    pub const fn lineage(&self) -> &NodeLineage {
        &self.lineage
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DocumentError {
    Compile(Vec<Diagnostic>),
    PortableProjection { code: &'static str, detail: String },
    InvalidEventAddress { address: String, detail: String },
    UnsupportedEventAddress { address: String },
    MissingParent { address: String, parent: String },
    DuplicateAddress { address: String },
}

impl fmt::Display for DocumentError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Compile(errors) => write!(
                formatter,
                "AEON compilation failed with {} diagnostic(s)",
                errors.len()
            ),
            Self::PortableProjection { code, detail } => {
                write!(formatter, "portable projection failed [{code}]: {detail}")
            }
            Self::InvalidEventAddress { address, detail } => {
                write!(formatter, "invalid event address '{address}': {detail}")
            }
            Self::UnsupportedEventAddress { address } => {
                write!(
                    formatter,
                    "event address '{address}' is not an exact graph address"
                )
            }
            Self::MissingParent { address, parent } => {
                write!(formatter, "event '{address}' is missing parent '{parent}'")
            }
            Self::DuplicateAddress { address } => {
                write!(formatter, "duplicate document address '{address}'")
            }
        }
    }
}

impl Error for DocumentError {}

/// Immutable graph with address, parent, identity, and attribute-space indexes.
#[derive(Debug, Clone)]
pub struct AeonDocument {
    source: Arc<[u8]>,
    nodes: Vec<DocumentNode>,
    full_index: HashMap<String, NodeId>,
    identity_index: HashMap<String, Vec<NodeId>>,
    full_root: NodeId,
    header_root: NodeId,
    payload_root: NodeId,
    capabilities: DocumentCapabilities,
}

/// Cheap borrowed view over one node in a selected document scope.
#[derive(Debug, Clone, Copy)]
pub struct DocumentView<'document> {
    document: &'document AeonDocument,
    scope: DocumentScope,
    id: NodeId,
}

impl<'document> DocumentView<'document> {
    #[must_use]
    pub const fn id(self) -> NodeId {
        self.id
    }

    #[must_use]
    pub fn node(self) -> &'document DocumentNode {
        &self.document.nodes[self.id.0]
    }

    #[must_use]
    pub fn address(self) -> String {
        self.document
            .address(self.scope, self.id)
            .expect("a scoped view always has an address in its own scope")
    }

    #[must_use]
    pub fn parent(self) -> Option<Self> {
        let parent = self.node().parent?;
        self.document.view(self.scope, parent)
    }

    pub fn children(self) -> impl Iterator<Item = Self> + 'document {
        self.node()
            .children
            .iter()
            .filter_map(move |id| self.document.view(self.scope, *id))
    }

    #[must_use]
    pub fn member(self, name: &str) -> Option<Self> {
        self.children()
            .find(|child| child.node().binding_name() == Some(name))
    }

    #[must_use]
    pub fn position(self, index: usize) -> Option<Self> {
        self.children()
            .find(|child| child.node().position() == Some(index))
    }

    #[must_use]
    pub fn attribute_space(self) -> Option<Self> {
        let id = self.node().attribute_space?;
        self.document.view(self.scope, id)
    }
}

impl AeonDocument {
    /// Compile valid AEON and project it through the named portable AES adapter.
    ///
    /// Header events are always retained so payload, header, and full views
    /// remain available from the same snapshot.
    pub fn compile(source: &str, mut options: CompileOptions) -> Result<Self, DocumentError> {
        options.include_header = true;
        options.include_event_annotations = true;
        let result = compile(source, options);
        if !result.errors.is_empty() {
            return Err(DocumentError::Compile(result.errors));
        }
        let projected = adapt_rust_assignment_events_to_portable_aes(
            &result.events,
            &PortableAesCompatibilityOptions {
                include_headers: true,
                header: result.header,
                source_bytes: Some(source.as_bytes().to_vec()),
            },
        )
        .map_err(|error| DocumentError::PortableProjection {
            code: error.code,
            detail: error.detail,
        })?;
        Self::from_portable_events(source.as_bytes(), projected.events)
    }

    pub fn from_portable_events(
        source: &[u8],
        events: Vec<PortableAesCompatibilityEvent>,
    ) -> Result<Self, DocumentError> {
        let mut builder = DocumentBuilder::new(source);
        for (ordinal, event) in events.into_iter().enumerate() {
            builder.push_event(ordinal, event)?;
        }
        Ok(builder.finish())
    }

    #[must_use]
    pub fn source_bytes(&self) -> &[u8] {
        &self.source
    }

    #[must_use]
    pub const fn capabilities(&self) -> &DocumentCapabilities {
        &self.capabilities
    }

    #[must_use]
    pub const fn full_root(&self) -> NodeId {
        self.full_root
    }

    #[must_use]
    pub const fn header_root(&self) -> NodeId {
        self.header_root
    }

    #[must_use]
    pub const fn payload_root(&self) -> NodeId {
        self.payload_root
    }

    #[must_use]
    pub fn full(&self) -> DocumentView<'_> {
        DocumentView {
            document: self,
            scope: DocumentScope::Full,
            id: self.full_root,
        }
    }

    #[must_use]
    pub fn header(&self) -> DocumentView<'_> {
        DocumentView {
            document: self,
            scope: DocumentScope::Header,
            id: self.header_root,
        }
    }

    #[must_use]
    pub fn payload(&self) -> DocumentView<'_> {
        DocumentView {
            document: self,
            scope: DocumentScope::Payload,
            id: self.payload_root,
        }
    }

    #[must_use]
    pub fn node(&self, id: NodeId) -> Option<&DocumentNode> {
        self.nodes.get(id.0)
    }

    #[must_use]
    pub fn view(&self, scope: DocumentScope, id: NodeId) -> Option<DocumentView<'_>> {
        self.address(scope, id).map(|_| DocumentView {
            document: self,
            scope,
            id,
        })
    }

    #[must_use]
    pub fn at(&self, scope: DocumentScope, address: &str) -> Option<NodeId> {
        let full_address = match scope {
            DocumentScope::Full => address.to_owned(),
            DocumentScope::Header => scoped_full_address("header", address)?,
            DocumentScope::Payload => scoped_full_address("body", address)?,
        };
        self.full_index.get(&full_address).copied()
    }

    #[must_use]
    pub fn address(&self, scope: DocumentScope, id: NodeId) -> Option<String> {
        let node = self.node(id)?;
        match scope {
            DocumentScope::Full => Some(node.full_address.clone()),
            DocumentScope::Header => scoped_address(&node.full_address, "header"),
            DocumentScope::Payload => scoped_address(&node.full_address, "body"),
        }
    }

    #[must_use]
    pub fn nodes_with_identity(&self, identity: &str) -> &[NodeId] {
        self.identity_index.get(identity).map_or(&[], Vec::as_slice)
    }
}

struct DocumentBuilder {
    source: Arc<[u8]>,
    nodes: Vec<DocumentNode>,
    full_index: HashMap<String, NodeId>,
    identity_index: HashMap<String, Vec<NodeId>>,
    full_root: NodeId,
    header_root: NodeId,
    payload_root: NodeId,
}

impl DocumentBuilder {
    fn new(source: &[u8]) -> Self {
        let mut builder = Self {
            source: Arc::from(source),
            nodes: Vec::new(),
            full_index: HashMap::new(),
            identity_index: HashMap::new(),
            full_root: NodeId(0),
            header_root: NodeId(0),
            payload_root: NodeId(0),
        };
        builder.full_root = builder.push_synthetic("$", None, None, None, "ObjectNode");
        builder.header_root = builder.push_synthetic(
            "$.header",
            Some(builder.full_root),
            Some("header"),
            Some(DocumentSourcePlane::Header),
            "ObjectNode",
        );
        builder.payload_root = builder.push_synthetic(
            "$.body",
            Some(builder.full_root),
            Some("body"),
            Some(DocumentSourcePlane::Body),
            "ObjectNode",
        );
        builder
    }

    fn push_synthetic(
        &mut self,
        full_address: &str,
        parent: Option<NodeId>,
        binding_name: Option<&str>,
        source_plane: Option<DocumentSourcePlane>,
        representation_kind: &str,
    ) -> NodeId {
        let id = NodeId(self.nodes.len());
        self.nodes.push(DocumentNode {
            id,
            full_address: full_address.to_owned(),
            event_address: None,
            parent,
            children: Vec::new(),
            attribute_space: None,
            binding_name: binding_name.map(str::to_owned),
            position: None,
            source_plane,
            representation_kind: representation_kind.to_owned(),
            identity: None,
            datatype: None,
            generics: Vec::new(),
            clarifiers: Vec::new(),
            value: None,
            origin: None,
            span: None,
            lineage: NodeLineage::Synthetic,
        });
        self.full_index.insert(full_address.to_owned(), id);
        if let Some(parent) = parent {
            self.nodes[parent.0].children.push(id);
        }
        id
    }

    fn push_event(
        &mut self,
        ordinal: usize,
        event: PortableAesCompatibilityEvent,
    ) -> Result<(), DocumentError> {
        let (plane, event_address) = match (&event.path, &event.header) {
            (Some(path), None) => (DocumentSourcePlane::Body, path.clone()),
            (None, Some(path)) => (DocumentSourcePlane::Header, path.clone()),
            _ => {
                return Err(DocumentError::InvalidEventAddress {
                    address: event.path.or(event.header).unwrap_or_default(),
                    detail: String::from("exactly one of path or header must be supplied"),
                });
            }
        };
        let parsed = parse_sansa_address(&event_address).map_err(|error| {
            DocumentError::InvalidEventAddress {
                address: event_address.clone(),
                detail: error.message,
            }
        })?;
        if !parsed.is_exact || parsed.qualifier_expression.is_some() {
            return Err(DocumentError::UnsupportedEventAddress {
                address: event_address,
            });
        }

        let plane_name = match plane {
            DocumentSourcePlane::Body => "body",
            DocumentSourcePlane::Header => "header",
        };
        let plane_root = match plane {
            DocumentSourcePlane::Body => self.payload_root,
            DocumentSourcePlane::Header => self.header_root,
        };
        let mut parent = plane_root;
        let mut prefix = String::from("$");
        let mut final_name = None;
        let mut final_position = None;

        for (index, selector) in parsed.selectors.iter().enumerate() {
            let last = index + 1 == parsed.selectors.len();
            match selector {
                SansaSelector::Member { name, .. } => {
                    prefix.push_str(&render_member(name));
                    if last {
                        final_name = Some(name.clone());
                    } else if let Some(existing) = self
                        .full_index
                        .get(&full_address(plane_name, &prefix))
                        .copied()
                    {
                        parent = existing;
                    }
                }
                SansaSelector::Position { index } => {
                    prefix.push('[');
                    prefix.push_str(&index.to_string());
                    prefix.push(']');
                    if last {
                        final_position = Some(*index);
                    } else if let Some(existing) = self
                        .full_index
                        .get(&full_address(plane_name, &prefix))
                        .copied()
                    {
                        parent = existing;
                    }
                }
                SansaSelector::AttributeSpace => {
                    prefix.push_str(".@");
                    let address = full_address(plane_name, &prefix);
                    parent = if let Some(existing) = self.full_index.get(&address).copied() {
                        existing
                    } else {
                        let owner = parent;
                        let attribute_space = self.push_synthetic(
                            &address,
                            Some(owner),
                            None,
                            Some(plane),
                            "attributeSpace",
                        );
                        self.nodes[owner.0].attribute_space = Some(attribute_space);
                        attribute_space
                    };
                }
                _ => {
                    return Err(DocumentError::UnsupportedEventAddress {
                        address: event_address,
                    });
                }
            }
        }

        let address = full_address(plane_name, &event_address);
        if self.full_index.contains_key(&address) {
            return Err(DocumentError::DuplicateAddress { address });
        }
        let expected_parent = parent_event_address(&event_address);
        let expected_full_parent = full_address(plane_name, &expected_parent);
        if self.nodes[parent.0].full_address != expected_full_parent {
            return Err(DocumentError::MissingParent {
                address,
                parent: expected_full_parent,
            });
        }

        let id = NodeId(self.nodes.len());
        let identity = event.identity.clone();
        self.nodes.push(DocumentNode {
            id,
            full_address: address.clone(),
            event_address: Some(event_address.clone()),
            parent: Some(parent),
            children: Vec::new(),
            attribute_space: None,
            binding_name: final_name,
            position: final_position,
            source_plane: Some(plane),
            representation_kind: event.kind.to_owned(),
            identity: event.identity,
            datatype: event.datatype,
            generics: event.generics,
            clarifiers: event.clarifiers,
            value: event.value,
            origin: event.origin,
            span: event.span,
            lineage: NodeLineage::PortableEvent {
                ordinal,
                event_address,
            },
        });
        self.nodes[parent.0].children.push(id);
        self.full_index.insert(address, id);
        if let Some(identity) = identity {
            self.identity_index.entry(identity).or_default().push(id);
        }
        Ok(())
    }

    fn finish(self) -> AeonDocument {
        let event_nodes = self
            .nodes
            .iter()
            .filter(|node| matches!(node.lineage, NodeLineage::PortableEvent { .. }))
            .collect::<Vec<_>>();
        let origin = supplied_capability(&event_nodes, |node| node.origin.is_some());
        let span = supplied_capability(&event_nodes, |node| node.span.is_some());
        AeonDocument {
            source: self.source,
            nodes: self.nodes,
            full_index: self.full_index,
            identity_index: self.identity_index,
            full_root: self.full_root,
            header_root: self.header_root,
            payload_root: self.payload_root,
            capabilities: DocumentCapabilities {
                source_bytes: CapabilityState::Complete,
                authored_lexemes: CapabilityState::NotCollected,
                origin,
                span,
                portable_extensions: CapabilityState::NotCollected,
                unknown_telex_fields: CapabilityState::NotApplicable,
                event_order: CapabilityState::Complete,
                lineage: CapabilityState::Complete,
            },
        }
    }
}

fn supplied_capability(
    nodes: &[&DocumentNode],
    supplied: impl Fn(&DocumentNode) -> bool,
) -> CapabilityState {
    let count = nodes.iter().filter(|node| supplied(node)).count();
    match (count, nodes.len()) {
        (0, _) => CapabilityState::NotSupplied,
        (count, total) if count == total => CapabilityState::Complete,
        _ => CapabilityState::Partial,
    }
}

fn scoped_full_address(plane: &str, address: &str) -> Option<String> {
    if address == "$" {
        return Some(format!("$.{plane}"));
    }
    address
        .strip_prefix('$')
        .map(|suffix| format!("$.{plane}{suffix}"))
}

fn scoped_address(full_address: &str, plane: &str) -> Option<String> {
    let root = format!("$.{plane}");
    if full_address == root {
        return Some(String::from("$"));
    }
    full_address
        .strip_prefix(&root)
        .map(|suffix| format!("${suffix}"))
}

fn full_address(plane: &str, event_address: &str) -> String {
    scoped_full_address(plane, event_address)
        .expect("portable event addresses are absolute by construction")
}

fn parent_event_address(address: &str) -> String {
    let parsed = parse_sansa_address(address).expect("validated address remains parseable");
    if parsed.selectors.is_empty() {
        return String::from("$");
    }
    let mut output = String::from("$");
    for selector in &parsed.selectors[..parsed.selectors.len() - 1] {
        match selector {
            SansaSelector::Member { name, .. } => output.push_str(&render_member(name)),
            SansaSelector::Position { index } => {
                output.push('[');
                output.push_str(&index.to_string());
                output.push(']');
            }
            SansaSelector::AttributeSpace => output.push_str(".@"),
            _ => unreachable!("event paths contain only exact selectors"),
        }
    }
    output
}

fn render_member(name: &str) -> String {
    if is_identifier(name) {
        return format!(".{name}");
    }
    let mut quoted = String::from(".[\"");
    for character in name.chars() {
        match character {
            '\\' => quoted.push_str("\\\\"),
            '"' => quoted.push_str("\\\""),
            '\n' => quoted.push_str("\\n"),
            '\r' => quoted.push_str("\\r"),
            '\t' => quoted.push_str("\\t"),
            character => quoted.push(character),
        }
    }
    quoted.push_str("\"]");
    quoted
}

fn is_identifier(value: &str) -> bool {
    let mut characters = value.chars();
    let Some(first) = characters.next() else {
        return false;
    };
    (first == '_' || first.is_ascii_alphabetic())
        && characters.all(|character| character == '_' || character.is_ascii_alphanumeric())
}

#[cfg(test)]
mod tests {
    use super::*;
    use aeon_core::DatatypePolicy;
    use serde::Deserialize;

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Contract {
        portable_topology_cases: Vec<TopologyCase>,
        fixtures: Vec<ContractFixture>,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct TopologyCase {
        id: String,
        source: String,
        events: Vec<ExpectedEvent>,
    }

    #[derive(Deserialize)]
    struct ExpectedEvent {
        path: String,
        kind: String,
        identity: Option<String>,
        datatype: Option<String>,
        value: Option<String>,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct ContractFixture {
        source: String,
        compile_options: ContractCompileOptions,
        scopes: HashMap<String, Vec<ExpectedNode>>,
    }

    #[derive(Default, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct ContractCompileOptions {
        datatype_policy: Option<String>,
        max_attribute_depth: Option<usize>,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct ExpectedNode {
        address: String,
        representation_kind: String,
    }

    fn fixture_contract() -> Contract {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../../test-fixtures/document-projection/aeon-document-projection.v1.json"
        );
        serde_json::from_str(&std::fs::read_to_string(path).expect("read fixture contract"))
            .expect("parse fixture contract")
    }

    fn body_event(path: &str) -> PortableAesCompatibilityEvent {
        PortableAesCompatibilityEvent {
            path: Some(path.to_owned()),
            header: None,
            kind: "StringLiteral",
            identity: None,
            datatype: None,
            generics: Vec::new(),
            clarifiers: Vec::new(),
            value: Some(String::from("value")),
            origin: None,
            span: None,
        }
    }

    #[test]
    fn builds_fixture_backed_node_head_topology() {
        for case in fixture_contract().portable_topology_cases {
            let document = AeonDocument::compile(
                &case.source,
                CompileOptions {
                    datatype_policy: Some(DatatypePolicy::AllowCustom),
                    max_attribute_depth: 8,
                    ..CompileOptions::default()
                },
            )
            .unwrap_or_else(|error| panic!("compile topology case {}: {error}", case.id));

            for expected in case.events {
                let id = document
                    .at(DocumentScope::Payload, &expected.path)
                    .unwrap_or_else(|| panic!("missing fixture event {}", expected.path));
                let node = document.node(id).expect("fixture node");
                assert_eq!(node.representation_kind(), expected.kind);
                assert_eq!(node.identity(), expected.identity.as_deref());
                assert_eq!(node.datatype(), expected.datatype.as_deref());
                assert_eq!(node.value(), expected.value.as_deref());
            }

            if case.id == "node-head-address-translation" {
                let head = document
                    .at(DocumentScope::Payload, "$.value[0]")
                    .expect("node head");
                let child = document
                    .at(DocumentScope::Payload, "$.value[0][0]")
                    .expect("node child");
                assert_eq!(document.node(child).expect("child").parent(), Some(head));
                let navigated_child = document
                    .payload()
                    .member("value")
                    .expect("value member")
                    .position(0)
                    .expect("node head")
                    .position(0)
                    .expect("node child");
                assert_eq!(navigated_child.id(), child);
            }
        }
    }

    #[test]
    fn builds_every_shared_document_projection_scope() {
        for fixture in fixture_contract().fixtures {
            let mut options = CompileOptions::default();
            options.max_attribute_depth = fixture
                .compile_options
                .max_attribute_depth
                .unwrap_or(options.max_attribute_depth);
            options.datatype_policy = match fixture.compile_options.datatype_policy.as_deref() {
                Some("allow_custom") => Some(DatatypePolicy::AllowCustom),
                Some("reserved_only") => Some(DatatypePolicy::ReservedOnly),
                None => None,
                Some(policy) => panic!("unknown fixture datatype policy {policy}"),
            };
            let document =
                AeonDocument::compile(&fixture.source, options).expect("compile fixture document");
            for (scope_name, expected_nodes) in fixture.scopes {
                let scope = match scope_name.as_str() {
                    "payload" => DocumentScope::Payload,
                    "header" => DocumentScope::Header,
                    "full" => DocumentScope::Full,
                    scope => panic!("unknown fixture scope {scope}"),
                };
                for expected in expected_nodes {
                    let id = document.at(scope, &expected.address).unwrap_or_else(|| {
                        panic!("missing {scope_name} fixture node {}", expected.address)
                    });
                    assert_eq!(
                        document
                            .node(id)
                            .expect("fixture node")
                            .representation_kind(),
                        expected.representation_kind,
                        "representation kind at {scope_name} {}",
                        expected.address
                    );
                }
            }
        }
    }

    #[test]
    fn exposes_payload_header_and_full_scopes_without_address_collisions() {
        let source =
            "aeon:header = { mode:string = \"strict\" }\n\"aeon:mode\":string = \"payload\"";
        let document = AeonDocument::compile(source, CompileOptions::default())
            .expect("compile scoped document");
        let header = document
            .at(DocumentScope::Header, "$.[\"aeon:mode\"]")
            .expect("header binding");
        let payload = document
            .at(DocumentScope::Payload, "$.[\"aeon:mode\"]")
            .expect("payload binding");
        assert_ne!(header, payload);
        assert_eq!(
            document.address(DocumentScope::Full, header).as_deref(),
            Some("$.header.[\"aeon:mode\"]")
        );
        assert_eq!(
            document.address(DocumentScope::Full, payload).as_deref(),
            Some("$.body.[\"aeon:mode\"]")
        );
    }

    #[test]
    fn indexes_synthetic_attribute_spaces_and_identity() {
        let document = AeonDocument::compile(
            "annotated\\ROOT\\@{meta\\META\\ = \"source\"}:number = 1",
            CompileOptions {
                max_attribute_depth: 8,
                ..CompileOptions::default()
            },
        )
        .expect("compile attributed document");
        let binding = document
            .at(DocumentScope::Payload, "$.annotated")
            .expect("binding");
        let attribute_space = document
            .node(binding)
            .expect("binding node")
            .attribute_space()
            .expect("attribute space");
        assert_eq!(
            document
                .address(DocumentScope::Payload, attribute_space)
                .as_deref(),
            Some("$.annotated.@")
        );
        let attribute = document
            .at(DocumentScope::Payload, "$.annotated.@.meta")
            .expect("attribute");
        assert_eq!(
            document.node(attribute).expect("attribute node").parent(),
            Some(attribute_space)
        );
        assert_eq!(document.nodes_with_identity("META"), &[attribute]);
    }

    #[test]
    fn rejects_duplicate_addresses_and_missing_parents() {
        let duplicate =
            AeonDocument::from_portable_events(b"", vec![body_event("$.a"), body_event("$.a")])
                .expect_err("duplicate address must fail");
        assert!(matches!(
            duplicate,
            DocumentError::DuplicateAddress { address } if address == "$.body.a"
        ));

        let missing_parent = AeonDocument::from_portable_events(b"", vec![body_event("$.a.b")])
            .expect_err("missing parent must fail");
        assert!(matches!(
            missing_parent,
            DocumentError::MissingParent { parent, .. } if parent == "$.body.a"
        ));
    }

    #[test]
    fn reports_partial_provenance_without_fabricating_synthetic_metadata() {
        let mut supplied = body_event("$.a");
        supplied.origin = Some(String::from("sha256:example"));
        supplied.span = Some(String::from("0:1"));
        let document = AeonDocument::from_portable_events(b"a", vec![supplied, body_event("$.b")])
            .expect("document");
        assert_eq!(document.capabilities().origin, CapabilityState::Partial);
        assert_eq!(document.capabilities().span, CapabilityState::Partial);
        assert_eq!(document.payload().node().origin(), None);
        assert_eq!(document.payload().node().span(), None);
    }
}
