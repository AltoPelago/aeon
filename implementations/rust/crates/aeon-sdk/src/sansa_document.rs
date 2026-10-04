//! SANSA namespace projection over the immutable AEON document graph.
//!
//! This module supplies host bindings and exact navigation for a future
//! SANSA runtime. It deliberately does not call the recursively owned Resolve
//! subset in `aeon-core`, and therefore does not claim SANSA.Resolve or Query.

use std::sync::Arc;

use aeon_document::{
    AeonDocument, DocumentNode, DocumentScope, DocumentSourcePlane, NodeId, NodeLineage,
};
use aes_telex::{ClarifierKind, DatatypeClarifier, DatatypeDescriptor, GenericArgument};

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
            address_parsing: AeonSansaCapabilityState::NotExposed,
            resolve: AeonSansaCapabilityState::NotExposed,
            query: AeonSansaCapabilityState::NotExposed,
            local_spaces: AeonSansaCapabilityState::NotExposed,
        }
    }
}

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
            address_parsing: AeonSansaCapabilityState::NotExposed,
            resolve: AeonSansaCapabilityState::NotExposed,
            query: AeonSansaCapabilityState::NotExposed,
            local_spaces: AeonSansaCapabilityState::NotExposed,
        }
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
