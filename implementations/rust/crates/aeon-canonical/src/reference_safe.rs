//! Opt-in authored-reference validation and deterministic dependency ordering.
//!
//! The historical parser/writer remains the default. This path parses through
//! Core without invoking datatype, profile, schema, or reference evaluation.

use std::cmp::Reverse;
use std::collections::{BTreeMap, BinaryHeap, HashMap, HashSet};

use aeon_core::{AeonCompileLimits, AttributeValue, Diagnostic, ReferenceSegment, Span};

use super::{AttributeEntry, Binding, CanonicalResult, NodeValue, NullMode, Value};

/// Identifies canonical bytes explicitly during the cross-runtime rollout.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum CanonicalOrdering {
    /// Historical lexical sorting, including its existing parser behavior.
    #[default]
    LexicalV1,
    /// Unicode-scalar smallest-eligible ordering after authored Core validation.
    ReferenceSafeV1,
}

/// Options for the explicit canonical API. Existing `canonicalize` calls retain
/// their historical bytes; neither CLI nor integrity defaults change here.
#[derive(Debug, Clone)]
pub struct CanonicalizeOptions {
    pub ordering: CanonicalOrdering,
    /// Resource limits for the authored native parser (not semantic approval).
    pub limits: AeonCompileLimits,
    /// Maximum distinct projected dependency edges. Default: 1,000,000.
    pub max_ordering_edges: usize,
}

impl Default for CanonicalizeOptions {
    fn default() -> Self {
        Self {
            ordering: CanonicalOrdering::LexicalV1,
            limits: AeonCompileLimits::default(),
            max_ordering_edges: 1_000_000,
        }
    }
}

#[must_use]
pub fn canonicalize_with_options(source: &str, options: &CanonicalizeOptions) -> CanonicalResult {
    if options.ordering == CanonicalOrdering::LexicalV1 {
        return super::canonicalize(source);
    }
    match canonicalize_reference_safe(source, options) {
        Ok(text) => CanonicalResult {
            text,
            errors: Vec::new(),
        },
        Err(errors) => CanonicalResult {
            text: String::new(),
            errors,
        },
    }
}

fn canonicalize_reference_safe(
    source: &str,
    options: &CanonicalizeOptions,
) -> Result<String, Vec<Diagnostic>> {
    let authored = aeon_core::parse_document(source, &options.limits)?;
    let (header, mut body) = convert_document(&authored).map_err(|error| vec![error])?;
    let mut header = header;
    if let Some(header) = header.as_mut() {
        prepare_bindings(header).map_err(|error| vec![error])?;
    }
    prepare_bindings(&mut body).map_err(|error| vec![error])?;
    let mut index = Index::build(header.as_deref().unwrap_or(&[]), &body);
    let errors = index.validate(options.limits.max_attribute_depth);
    if !errors.is_empty() {
        return Err(errors);
    }
    let orders = index
        .plan(options.max_ordering_edges)
        .map_err(|error| vec![error])?;
    if let Some(header) = header.as_mut() {
        apply_bindings(header, &orders).map_err(|error| vec![error])?;
    }
    apply_bindings(&mut body, &orders).map_err(|error| vec![error])?;
    let text = super::render_document(header.unwrap_or_else(super::default_header), body);
    // Rendering is a separate trust boundary: no partial text or lexical
    // fallback if the emitted syntax or reference availability is invalid.
    let output = aeon_core::parse_document(&text, &options.limits)
        .map_err(|_| vec![conflict("Canonical output failed Core parsing")])?;
    let (header, body) = convert_document(&output).map_err(|error| vec![error])?;
    if !Index::build(header.as_deref().unwrap_or(&[]), &body)
        .validate(options.limits.max_attribute_depth)
        .is_empty()
    {
        return Err(vec![conflict(
            "Canonical output failed Core reference validation",
        )]);
    }
    Ok(text)
}

type DocumentParts = (Option<Vec<Binding>>, Vec<Binding>);

fn convert_document(authored: &[aeon_core::Binding]) -> Result<DocumentParts, Diagnostic> {
    let mut header = None;
    let mut body = Vec::new();
    for binding in authored {
        if !binding.is_header {
            body.push(convert_binding(binding));
        } else if binding.key == "aeon:header" {
            // The current header renderer has no envelope-head slot. Fail
            // closed instead of silently discarding authored metadata.
            if binding.structural_id.is_some()
                || binding.datatype.is_some()
                || !binding.attributes.is_empty()
            {
                return Err(
                    conflict("Canonical header envelopes cannot discard an authored head")
                        .with_span(binding.span),
                );
            }
            let aeon_core::Value::ObjectNode { bindings } = &binding.value else {
                return Err(conflict("Canonical header must contain an object"));
            };
            header = Some(bindings.iter().map(convert_binding).collect());
        } else {
            let mut converted = convert_binding(binding);
            converted.key = binding
                .key
                .strip_prefix("aeon:")
                .unwrap_or(&binding.key)
                .to_owned();
            header.get_or_insert_with(Vec::new).push(converted);
        }
    }
    Ok((header, body))
}

fn convert_binding(binding: &aeon_core::Binding) -> Binding {
    Binding {
        rank: Some(0),
        canonical_key: true,
        key: binding.key.clone(),
        structural_id: binding.structural_id.clone(),
        datatype: binding.datatype.clone(),
        attributes: convert_attributes(&binding.attributes, &binding.attribute_order),
        value: convert_value(&binding.value),
    }
}

fn convert_attributes(
    entries: &BTreeMap<String, AttributeValue>,
    order: &[String],
) -> BTreeMap<String, AttributeEntry> {
    let positions: HashMap<_, _> = order
        .iter()
        .enumerate()
        .map(|(index, key)| (key.as_str(), index))
        .collect();
    entries
        .iter()
        .map(|(key, entry)| {
            (
                key.clone(),
                AttributeEntry {
                    rank: Some(positions[key.as_str()]),
                    structural_id: entry.structural_id.clone(),
                    datatype: entry.datatype.clone(),
                    attributes: convert_attributes(&entry.nested_attrs, &entry.nested_attr_order),
                    value: entry
                        .value
                        .as_ref()
                        .map(convert_value)
                        .unwrap_or_else(|| convert_attribute_object(entry)),
                },
            )
        })
        .collect()
}

fn convert_attribute_object(entry: &AttributeValue) -> Value {
    Value::Object(
        entry
            .object_member_order
            .iter()
            .map(|key| {
                let member = &entry.object_members[key];
                Binding {
                    rank: Some(0),
                    canonical_key: true,
                    key: key.clone(),
                    structural_id: member.structural_id.clone(),
                    datatype: member.datatype.clone(),
                    attributes: convert_attributes(&member.nested_attrs, &member.nested_attr_order),
                    value: member
                        .value
                        .as_ref()
                        .map(convert_value)
                        .unwrap_or_else(|| convert_attribute_object(member)),
                }
            })
            .collect(),
    )
}

fn convert_value(value: &aeon_core::Value) -> Value {
    use aeon_core::Value as Native;
    match value {
        Native::TypedValue {
            structural_id,
            datatype,
            attributes,
            attribute_order,
            value,
        } => Value::Attributed {
            canonical_head: true,
            structural_id: structural_id.clone(),
            datatype: datatype.clone(),
            attributes: convert_attributes(attributes, attribute_order),
            value: Box::new(convert_value(value)),
        },
        Native::StringLiteral {
            value, trimticks, ..
        } => Value::String {
            value: value.clone(),
            trimticks: trimticks.is_some(),
        },
        Native::SymbolicLiteral { value, .. } => Value::Symbol(value.clone()),
        Native::NumberLiteral { raw } => Value::Number(raw.clone()),
        Native::NullLiteral { mode, value, .. } => Value::Null {
            mode: match mode {
                aeon_core::NullLiteralMode::Reserved => NullMode::Reserved,
                aeon_core::NullLiteralMode::Reason => NullMode::Reason,
            },
            value: value.clone(),
        },
        Native::ObjectNode { bindings } => {
            Value::Object(bindings.iter().map(convert_binding).collect())
        }
        Native::ListNode { items } => Value::List(items.iter().map(convert_value).collect()),
        Native::TupleLiteral { items } => Value::Tuple(items.iter().map(convert_value).collect()),
        Native::NodeLiteral {
            tag,
            structural_id,
            datatype,
            attributes,
            attribute_order,
            children,
            ..
        } => {
            let entries = attributes
                .iter()
                .flat_map(|map| map.iter().map(|(k, v)| (k.clone(), v.clone())))
                .collect();
            Value::Node(NodeValue {
                canonical_key: true,
                tag: tag.clone(),
                structural_id: structural_id.clone(),
                datatype: datatype.clone(),
                attributes: convert_attributes(&entries, attribute_order),
                children: children.iter().map(convert_value).collect(),
            })
        }
        Native::CloneReference { segments, span } | Native::PointerReference { segments, span } => {
            Value::Reference {
                segments: segments.iter().map(Segment::from).collect(),
                pointer: matches!(value, Native::PointerReference { .. }),
                span: *span,
            }
        }
        Native::SeparatorLiteral { raw } => Value::Separator(raw.clone()),
        Native::SansaAddressLiteral { canonical, .. } => Value::Raw(canonical.clone()),
        Native::InfinityLiteral { raw, .. }
        | Native::NaNLiteral { raw, .. }
        | Native::ToggleLiteral { raw }
        | Native::BooleanLiteral { raw }
        | Native::HexLiteral { raw }
        | Native::EncodingLiteral { raw }
        | Native::RadixLiteral { raw }
        | Native::DateLiteral { raw }
        | Native::DateTimeLiteral { raw }
        | Native::TimeLiteral { raw } => Value::Raw(raw.clone()),
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub(super) enum Segment {
    Key(String),
    Index(usize),
    Attr(String),
}

impl From<&ReferenceSegment> for Segment {
    fn from(segment: &ReferenceSegment) -> Self {
        match segment {
            ReferenceSegment::Key(key) => Self::Key(key.clone()),
            ReferenceSegment::Index(index) => Self::Index(*index),
            ReferenceSegment::Attr(key) => Self::Attr(key.clone()),
        }
    }
}

pub(super) fn render_path(path: &[Segment]) -> String {
    let mut result = String::new();
    for (index, segment) in path.iter().enumerate() {
        match segment {
            Segment::Index(index) => result.push_str(&format!("[{index}]")),
            Segment::Key(key) | Segment::Attr(key) => {
                if matches!(segment, Segment::Attr(_)) {
                    result.push_str(".@.");
                } else if index > 0 {
                    result.push('.');
                }
                if super::is_identifier(key) {
                    result.push_str(key);
                } else {
                    result.push_str(&format!("[\"{}\"]", super::escape_string(key)));
                }
            }
        }
    }
    result
}

fn diagnostic_path(path: &[Segment]) -> String {
    let rendered = render_path(path);
    if rendered.starts_with('[') {
        format!("${rendered}")
    } else {
        format!("$.{rendered}")
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum ScopeIdentity {
    Bindings(usize),
    Attributes(usize),
}

type Orders = HashMap<ScopeIdentity, Vec<usize>>;

#[derive(Debug)]
struct Scope {
    identity: ScopeIdentity,
    keys: Vec<String>,
    successors: Vec<HashSet<usize>>,
    indegree: Vec<usize>,
}
#[derive(Debug)]
struct Membership {
    scope: usize,
    entry: usize,
    parent: Option<usize>,
}
#[derive(Debug)]
struct Candidate {
    path: Vec<Segment>,
    plane: bool,
    owner: usize,
    ordinal: usize,
    membership: Option<usize>,
}
#[derive(Debug)]
struct Claim {
    target: Vec<Segment>,
    source: Vec<Segment>,
    ordinal: usize,
    membership: Option<usize>,
    span: Span,
}

#[derive(Clone, Copy)]
struct Context {
    membership: Option<usize>,
    header: bool,
    targetable: bool,
    owner: usize,
    actual: bool,
}

#[derive(Default)]
struct Index {
    scopes: Vec<Scope>,
    memberships: Vec<Membership>,
    candidates: Vec<Candidate>,
    claims: Vec<Claim>,
    payloads: HashMap<Vec<Segment>, (bool, usize)>,
    candidates_seen: HashSet<(bool, Vec<Segment>)>,
    targets: HashMap<Vec<Segment>, usize>,
    ordinal: usize,
    next_owner: usize,
}

// Scope identities are addresses only, never dereferenced. The converted tree
// stays immobile until planning completes; plans are applied bottom-up before
// rendering clones it. Empty scopes need no identity or ordering plan. The
// namespace matters: a struct's first field can share its address, so an
// attribute-map address must never alias a binding-slice identity.
fn attribute_identity<T>(value: &T) -> ScopeIdentity {
    ScopeIdentity::Attributes(std::ptr::from_ref(value) as usize)
}

impl Index {
    fn build(header: &[Binding], body: &[Binding]) -> Self {
        let mut index = Self::default();
        // Slice identity is its first entry; body/object use that same rule.
        let context = Context {
            membership: None,
            header: true,
            targetable: true,
            owner: 0,
            actual: true,
        };
        index.bindings(header, &[], context, &[]);
        index.bindings(
            body,
            &[],
            Context {
                header: false,
                ..context
            },
            &[],
        );
        for (candidate_index, candidate) in index.candidates.iter().enumerate() {
            for length in (1..=candidate.path.len()).rev() {
                if let Some(&(plane, owner)) = index.payloads.get(&candidate.path[..length]) {
                    if plane == candidate.plane && owner == candidate.owner {
                        index
                            .targets
                            .insert(candidate.path.clone(), candidate_index);
                    }
                    break;
                }
            }
        }
        index
    }

    fn scope(&mut self, identity: ScopeIdentity, keys: Vec<String>) -> usize {
        let size = keys.len();
        let index = self.scopes.len();
        self.scopes.push(Scope {
            identity,
            keys,
            successors: vec![HashSet::new(); size],
            indegree: vec![0; size],
        });
        index
    }

    fn member(&mut self, scope: usize, entry: usize, parent: Option<usize>) -> Option<usize> {
        let index = self.memberships.len();
        self.memberships.push(Membership {
            scope,
            entry,
            parent,
        });
        Some(index)
    }

    fn owner(&mut self, path: &[Segment], plane: bool) -> usize {
        let owner = self.next_owner;
        self.next_owner += 1;
        // Exact-path selection: body wins; descendants remain independent.
        self.payloads
            .entry(path.to_vec())
            .and_modify(|selected| {
                if selected.0 && !plane {
                    *selected = (plane, owner);
                }
            })
            .or_insert((plane, owner));
        owner
    }

    fn bindings(
        &mut self,
        entries: &[Binding],
        path: &[Segment],
        context: Context,
        diagnostic_owner: &[Segment],
    ) {
        if entries.is_empty() {
            return;
        }
        let scope = self.scope(
            ScopeIdentity::Bindings(entries.as_ptr() as usize),
            entries.iter().map(|entry| entry.key.clone()).collect(),
        );
        for (position, entry) in entries.iter().enumerate() {
            let member = self.member(scope, position, context.membership);
            let mut child = path.to_vec();
            child.push(Segment::Key(if context.header && path.is_empty() {
                format!("aeon:{}", entry.key)
            } else {
                entry.key.clone()
            }));
            let owner = if context.actual {
                self.owner(&child, context.header)
            } else {
                context.owner
            };
            let context = Context {
                membership: member,
                owner,
                ..context
            };
            let source = if context.targetable {
                child.as_slice()
            } else {
                diagnostic_owner
            };
            self.attributes(&entry.attributes, &child, context, source);
            self.value(&entry.value, &child, context, source);
        }
    }

    fn attributes(
        &mut self,
        attributes: &BTreeMap<String, AttributeEntry>,
        path: &[Segment],
        context: Context,
        diagnostic_owner: &[Segment],
    ) {
        if attributes.is_empty() {
            return;
        }
        let mut entries: Vec<_> = attributes.iter().collect();
        entries.sort_by_key(|(_, entry)| entry.rank);
        let scope = self.scope(
            attribute_identity(attributes),
            entries.iter().map(|(key, _)| (*key).clone()).collect(),
        );
        for (position, (key, entry)) in entries.into_iter().enumerate() {
            let member = self.member(scope, position, context.membership);
            let mut child = path.to_vec();
            child.push(Segment::Attr(key.clone()));
            let source = if context.targetable {
                child.as_slice()
            } else {
                diagnostic_owner
            };
            let context = Context {
                membership: member,
                actual: false,
                ..context
            };
            self.attributes(&entry.attributes, &child, context, source);
            self.value(&entry.value, &child, context, source);
        }
    }

    fn value(
        &mut self,
        value: &Value,
        path: &[Segment],
        context: Context,
        diagnostic_owner: &[Segment],
    ) {
        if let Value::Attributed {
            attributes, value, ..
        } = value
        {
            self.attributes(attributes, path, context, diagnostic_owner);
            self.value(value, path, context, diagnostic_owner);
            return;
        }
        if let Value::Node(node) = value {
            self.attributes(
                &node.attributes,
                path,
                Context {
                    targetable: false,
                    actual: false,
                    ..context
                },
                diagnostic_owner,
            );
        }
        if let Value::Reference { segments, span, .. } = value {
            self.claims.push(Claim {
                target: segments.clone(),
                source: diagnostic_owner.to_vec(),
                ordinal: self.ordinal,
                membership: context.membership,
                span: *span,
            });
            self.ordinal += 1;
        }
        if context.targetable && self.candidates_seen.insert((context.header, path.to_vec())) {
            self.candidates.push(Candidate {
                path: path.to_vec(),
                plane: context.header,
                owner: context.owner,
                ordinal: self.ordinal,
                membership: context.membership,
            });
        }
        self.ordinal += 1;
        match value {
            Value::Object(entries) => self.bindings(entries, path, context, diagnostic_owner),
            Value::List(items)
            | Value::Tuple(items)
            | Value::Node(NodeValue {
                children: items, ..
            }) => {
                for (position, value) in items.iter().enumerate() {
                    let mut child = path.to_vec();
                    child.push(Segment::Index(position));
                    let child_owner = if context.actual {
                        self.owner(&child, context.header)
                    } else {
                        context.owner
                    };
                    let source = if context.targetable {
                        child.as_slice()
                    } else {
                        diagnostic_owner
                    };
                    self.value(
                        value,
                        &child,
                        Context {
                            owner: child_owner,
                            ..context
                        },
                        source,
                    );
                }
            }
            _ => {}
        }
    }

    fn validate(&self, max_attribute_depth: usize) -> Vec<Diagnostic> {
        self.claims
            .iter()
            .filter_map(|claim| {
                let target = self
                    .targets
                    .get(&claim.target)
                    .map(|index| &self.candidates[*index]);
                let code = if claim
                    .target
                    .iter()
                    .filter(|segment| matches!(segment, Segment::Attr(_)))
                    .count()
                    > max_attribute_depth
                {
                    "ATTRIBUTE_DEPTH_EXCEEDED"
                } else if is_self(&claim.source, &claim.target) {
                    "SELF_REFERENCE"
                } else if target.is_none() {
                    "MISSING_REFERENCE_TARGET"
                } else if target.is_some_and(|target| target.ordinal > claim.ordinal) {
                    "FORWARD_REFERENCE"
                } else {
                    return None;
                };
                Some(
                    Diagnostic::new(
                        code,
                        format!("Invalid reference to {}", diagnostic_path(&claim.target)),
                    )
                    .at_path(diagnostic_path(&claim.source))
                    .with_span(claim.span),
                )
            })
            .collect()
    }

    fn plan(&mut self, max_edges: usize) -> Result<Orders, Diagnostic> {
        let mut edges = 0;
        for claim in &self.claims {
            let target = self
                .targets
                .get(&claim.target)
                .ok_or_else(|| conflict("A validated reference has no ordering target"))?;
            let mut source_entries = HashMap::new();
            let mut source = claim.membership;
            while let Some(index) = source {
                let member = &self.memberships[index];
                source_entries.insert(member.scope, member.entry);
                source = member.parent;
            }
            let mut target_member = self.candidates[*target].membership;
            while let Some(index) = target_member {
                let member = &self.memberships[index];
                target_member = member.parent;
                if let Some(&source) = source_entries.get(&member.scope) {
                    if source == member.entry {
                        continue;
                    }
                    let scope = &mut self.scopes[member.scope];
                    if scope.successors[member.entry].contains(&source) {
                        continue;
                    }
                    if edges >= max_edges {
                        return Err(Diagnostic::new(
                            "CANONICAL_ORDERING_LIMIT_EXCEEDED",
                            format!("Canonical ordering exceeds {max_edges} dependency edges"),
                        ));
                    }
                    edges += 1;
                    scope.successors[member.entry].insert(source);
                    scope.indegree[source] += 1;
                }
            }
        }
        self.scopes
            .iter_mut()
            .map(|scope| {
                let mut heap = BinaryHeap::new();
                for (entry, &degree) in scope.indegree.iter().enumerate() {
                    if degree == 0 {
                        heap.push(Reverse((scope.keys[entry].as_str(), entry)));
                    }
                }
                let mut order = Vec::with_capacity(scope.keys.len());
                while let Some(Reverse((_, entry))) = heap.pop() {
                    order.push(entry);
                    for &successor in &scope.successors[entry] {
                        scope.indegree[successor] -= 1;
                        if scope.indegree[successor] == 0 {
                            heap.push(Reverse((scope.keys[successor].as_str(), successor)));
                        }
                    }
                }
                if order.len() != scope.keys.len() {
                    return Err(conflict("Canonical ordering dependencies form a cycle"));
                }
                Ok((scope.identity, order))
            })
            .collect()
    }
}

fn is_self(source: &[Segment], target: &[Segment]) -> bool {
    if source == target {
        return true;
    }
    let first_attribute = source
        .iter()
        .position(|segment| matches!(segment, Segment::Attr(_)));
    for (index, segment) in source.iter().enumerate() {
        if matches!(segment, Segment::Attr(_)) && &source[..index] == target {
            return true;
        }
    }
    let payload = &source[..first_attribute.unwrap_or(source.len())];
    if first_attribute.is_some() && payload == target {
        return true;
    }
    let mut owner = payload.len();
    while owner > 0 && matches!(payload[owner - 1], Segment::Index(_)) {
        owner -= 1;
    }
    owner < payload.len() && &payload[..owner] == target
}

fn conflict(message: &str) -> Diagnostic {
    Diagnostic::new("CANONICAL_ORDERING_CONFLICT", message)
}

// Token boundaries matter: commas and whitespace inside a quoted clarifier
// are payload, not datatype punctuation. Decode strings through the existing
// literal decoder, propagating failures instead of emitting altered data.
fn format_datatype(raw: &str) -> Result<String, Diagnostic> {
    let lexed = aeon_core::tokenize(raw, aeon_core::LexerOptions::default());
    if let Some(error) = lexed.errors.first() {
        return Err(Diagnostic::new(&error.code, &error.message));
    }
    let mut output = String::new();
    let mut bracket_depth = 0usize;
    for token in lexed.tokens {
        match token.kind {
            aeon_core::TokenKind::Eof => {}
            aeon_core::TokenKind::Comma => output.push_str(", "),
            aeon_core::TokenKind::LeftBracket => {
                bracket_depth += 1;
                output.push_str(&token.text);
            }
            aeon_core::TokenKind::RightBracket => {
                bracket_depth = bracket_depth.saturating_sub(1);
                output.push_str(&token.text);
            }
            aeon_core::TokenKind::Number if bracket_depth > 0 => {
                output.push_str(&super::normalize_number(&token.text));
            }
            aeon_core::TokenKind::String => {
                let decoded = super::Parser::new(&token.text).parse_quoted_string()?;
                output.push_str(
                    &serde_json::to_string(&decoded)
                        .map_err(|_| conflict("Cannot render datatype clarifier"))?,
                );
            }
            _ => output.push_str(&token.text),
        }
    }
    Ok(output)
}

fn prepare_datatype(datatype: &mut Option<String>) -> Result<(), Diagnostic> {
    if let Some(raw) = datatype {
        *raw = format_datatype(raw)?;
    }
    Ok(())
}

fn prepare_bindings(entries: &mut [Binding]) -> Result<(), Diagnostic> {
    for entry in entries {
        prepare_datatype(&mut entry.datatype)?;
        prepare_attributes(&mut entry.attributes)?;
        prepare_value(&mut entry.value)?;
    }
    Ok(())
}

fn prepare_attributes(entries: &mut BTreeMap<String, AttributeEntry>) -> Result<(), Diagnostic> {
    for entry in entries.values_mut() {
        prepare_datatype(&mut entry.datatype)?;
        prepare_attributes(&mut entry.attributes)?;
        prepare_value(&mut entry.value)?;
    }
    Ok(())
}

fn prepare_value(value: &mut Value) -> Result<(), Diagnostic> {
    match value {
        Value::Attributed {
            attributes,
            datatype,
            value,
            ..
        } => {
            prepare_datatype(datatype)?;
            prepare_attributes(attributes)?;
            prepare_value(value)?;
        }
        Value::Object(entries) => prepare_bindings(entries)?,
        Value::List(items) | Value::Tuple(items) => {
            for item in items {
                prepare_value(item)?;
            }
        }
        Value::Node(node) => {
            prepare_datatype(&mut node.datatype)?;
            prepare_attributes(&mut node.attributes)?;
            for child in &mut node.children {
                prepare_value(child)?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn order_for(orders: &Orders, identity: ScopeIdentity) -> Result<&[usize], Diagnostic> {
    orders
        .get(&identity)
        .map(Vec::as_slice)
        .ok_or_else(|| conflict("A sortable scope has no canonical ordering plan"))
}

fn apply_bindings(entries: &mut [Binding], orders: &Orders) -> Result<(), Diagnostic> {
    if entries.is_empty() {
        return Ok(());
    }
    let order = order_for(orders, ScopeIdentity::Bindings(entries.as_ptr() as usize))?;
    for entry in entries.iter_mut() {
        apply_attributes(&mut entry.attributes, orders)?;
        apply_value(&mut entry.value, orders)?;
    }
    for (rank, &index) in order.iter().enumerate() {
        entries[index].rank = Some(rank);
    }
    Ok(())
}

fn apply_attributes(
    entries: &mut BTreeMap<String, AttributeEntry>,
    orders: &Orders,
) -> Result<(), Diagnostic> {
    if entries.is_empty() {
        return Ok(());
    }
    let order = order_for(orders, attribute_identity(entries))?;
    let mut keys: Vec<_> = entries
        .iter()
        .map(|(key, entry)| (entry.rank, key.clone()))
        .collect();
    keys.sort();
    for entry in entries.values_mut() {
        apply_attributes(&mut entry.attributes, orders)?;
        apply_value(&mut entry.value, orders)?;
    }
    for (rank, &index) in order.iter().enumerate() {
        entries.get_mut(&keys[index].1).expect("scope entry").rank = Some(rank);
    }
    Ok(())
}

fn apply_value(value: &mut Value, orders: &Orders) -> Result<(), Diagnostic> {
    match value {
        Value::Attributed {
            attributes, value, ..
        } => {
            apply_attributes(attributes, orders)?;
            apply_value(value, orders)?;
        }
        Value::Object(entries) => apply_bindings(entries, orders)?,
        Value::List(items) | Value::Tuple(items) => {
            for item in items {
                apply_value(item, orders)?;
            }
        }
        Value::Node(node) => {
            apply_attributes(&mut node.attributes, orders)?;
            for child in &mut node.children {
                apply_value(child, orders)?;
            }
        }
        _ => {}
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn options() -> CanonicalizeOptions {
        CanonicalizeOptions {
            ordering: CanonicalOrdering::ReferenceSafeV1,
            limits: AeonCompileLimits {
                max_attribute_depth: 2,
                ..AeonCompileLimits::default()
            },
            ..CanonicalizeOptions::default()
        }
    }

    fn canonical(source: &str) -> String {
        let result = canonicalize_with_options(source, &options());
        assert!(result.errors.is_empty(), "{source}: {:?}", result.errors);
        let repeated = canonicalize_with_options(&result.text, &options());
        assert!(repeated.errors.is_empty(), "{:?}", repeated.errors);
        assert_eq!(repeated.text, result.text);
        result.text
    }

    #[test]
    fn explicit_contract_preserves_historical_default() {
        let source = "z=1\na=~z";
        assert_eq!(
            canonicalize_with_options(source, &CanonicalizeOptions::default()),
            super::super::canonicalize(source)
        );
        assert!(canonical(source).ends_with("z = 1\na = ~z\n"));
        assert!(
            super::super::canonicalize(source)
                .text
                .ends_with("a = ~z\nz = 1\n")
        );
    }

    #[test]
    fn rendering_boundaries_preserve_native_graph_and_fixed_points() {
        fn attributes(entries: &mut BTreeMap<String, AttributeEntry>) {
            for entry in entries.values_mut() {
                entry.rank = None;
                attributes(&mut entry.attributes);
                value(&mut entry.value);
            }
        }
        fn bindings(entries: &mut [Binding]) {
            entries.sort_by(|a, b| a.key.cmp(&b.key));
            for entry in entries {
                entry.rank = None;
                attributes(&mut entry.attributes);
                value(&mut entry.value);
            }
        }
        fn value(payload: &mut Value) {
            match payload {
                Value::Attributed {
                    attributes: entries,
                    value: inner,
                    ..
                } => {
                    attributes(entries);
                    value(inner);
                }
                Value::Object(entries) => bindings(entries),
                Value::List(items) | Value::Tuple(items) => {
                    for item in items {
                        value(item);
                    }
                }
                Value::Node(node) => {
                    attributes(&mut node.attributes);
                    for child in &mut node.children {
                        value(child);
                    }
                }
                Value::Reference { span, .. } => {
                    let point = aeon_core::Position {
                        line: 1,
                        column: 1,
                        offset: 0,
                    };
                    *span = Span {
                        start: point,
                        end: point,
                    };
                }
                _ => {}
            }
        }
        fn graph(source: &str) -> DocumentParts {
            let parsed =
                aeon_core::parse_document(source, &options().limits).expect("native parse");
            let (mut header, mut body) = convert_document(&parsed).expect("native document");
            if let Some(header) = header.as_mut() {
                bindings(header);
            }
            bindings(&mut body);
            (header, body)
        }
        let fixtures: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../../test-fixtures/canonical-rendering-boundaries.json"
        ))
        .expect("shared fixtures");
        for fixture in fixtures.as_array().expect("fixture array") {
            let source = fixture["source"].as_str().expect("source");
            let authored = if source.starts_with("aeon:header=") {
                source.to_owned()
            } else {
                format!("aeon:header={{}}\n{source}")
            };
            let output = canonical(&authored);
            assert!(
                output.contains(fixture["fragment"].as_str().expect("fragment")),
                "{}: {output}",
                fixture["id"]
            );
            assert_eq!(graph(&authored), graph(&output), "{}", fixture["id"]);
        }
    }

    #[test]
    fn generic_arguments_are_types_not_numeric_or_string_literals() {
        let fixtures: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../../test-fixtures/datatype-generic-arguments.json"
        ))
        .expect("generic fixtures");
        let node_bindings: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../../test-fixtures/node-binding-generics.json"
        ))
        .expect("node-binding fixtures");
        for fixture in fixtures
            .as_array()
            .expect("fixture array")
            .iter()
            .chain(node_bindings.as_array().expect("fixture array"))
        {
            let source = fixture["source"].as_str().expect("source");
            let valid = fixture["ok"].as_bool().expect("ok");
            assert_eq!(
                aeon_core::parse_document(source, &options().limits).is_ok(),
                valid,
                "{source}"
            );
            for parsed in [
                aeon_core::compile(source, aeon_core::CompileOptions::default()),
                aeon_core::compile_sofia(source, aeon_core::CompileOptions::default()),
            ] {
                assert_eq!(
                    parsed.errors.is_empty(),
                    valid,
                    "{source}: {:?}",
                    parsed.errors
                );
                if !valid {
                    assert!(
                        parsed
                            .errors
                            .iter()
                            .any(|error| error.code == "SYNTAX_ERROR")
                    );
                }
            }
            for result in [
                super::super::canonicalize(source),
                canonicalize_with_options(source, &options()),
            ] {
                assert_eq!(
                    result.errors.is_empty(),
                    valid,
                    "{source}: {:?}",
                    result.errors
                );
                if valid {
                    assert!(
                        result
                            .text
                            .contains(fixture["fragment"].as_str().expect("fragment")),
                        "{}",
                        result.text
                    );
                    assert_eq!(super::super::canonicalize(&result.text).text, result.text);
                    assert_eq!(
                        canonicalize_with_options(&result.text, &options()).text,
                        result.text
                    );
                } else {
                    assert!(
                        result
                            .errors
                            .iter()
                            .any(|error| error.code == "SYNTAX_ERROR")
                    );
                    assert!(result.text.is_empty());
                }
            }
        }
        // Normalization itself must not rewrite invalid numeric generic
        // arguments, even though public canonical entry points reject them.
        assert_eq!(
            super::super::normalize_datatype("custom<1.00>[1.00]"),
            "custom<1.00>[1.0]"
        );
        assert_eq!(
            format_datatype("custom<child<1.00>>[1.00]").expect("format"),
            "custom<child<1.00>>[1.0]"
        );
    }

    #[test]
    fn native_parsers_project_numeric_clarifiers_exactly_like_value_numbers() {
        let fixtures: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../../test-fixtures/numeric-clarifiers.json"
        ))
        .expect("fixtures");
        for fixture in fixtures.as_array().expect("fixture array") {
            let raw = fixture["raw"].as_str().expect("raw");
            let normalized = fixture["normalized"].as_str().expect("normalized");
            let source = format!("x:custom[{raw}]={raw}");
            for result in [
                aeon_core::compile(&source, aeon_core::CompileOptions::default()),
                aeon_core::compile_sofia(&source, aeon_core::CompileOptions::default()),
            ] {
                assert!(result.errors.is_empty(), "{raw}: {:?}", result.errors);
                let events = aeon_core::project_portable_events(&result.events);
                assert_eq!(events[0].value.as_deref(), Some(normalized));
                assert_eq!(events[0].clarifiers.len(), 1);
                assert_eq!(events[0].clarifiers[0].value, normalized);
                assert_eq!(
                    events[0].clarifiers[0].kind,
                    aes_telex::ClarifierKind::NumberLiteral
                );
            }
        }
    }

    #[test]
    fn numeric_clarifiers_use_value_number_rules_in_every_head_context() {
        let fixtures: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../../test-fixtures/numeric-clarifiers.json"
        ))
        .expect("numeric clarifier fixtures");
        for fixture in fixtures.as_array().expect("fixture array") {
            let raw = fixture["raw"].as_str().expect("raw");
            let normalized = fixture["normalized"].as_str().expect("normalized");
            for source in [
                format!("x:custom[{raw}]={raw}"),
                format!("x={{n:custom[{raw}]={raw}}}"),
                format!("x@{{n:custom[{raw}]={raw}}}=0"),
                format!("x=[:custom[{raw}]={raw}]"),
                format!("x=(:custom[{raw}]={raw})"),
                format!("x=<tag(:custom[{raw}]={raw})>"),
                format!("x:list<custom[{raw}]>=[{raw}]"),
                format!("aeon:header={{x:custom[{raw}]={raw}}}"),
            ] {
                let output = canonical(&source);
                assert!(
                    output.contains(&format!("custom[{normalized}]")),
                    "{output}"
                );
                let legacy = super::super::canonicalize(&source);
                assert!(legacy.errors.is_empty(), "{:?}", legacy.errors);
                assert!(
                    legacy.text.contains(&format!("custom[{normalized}]")),
                    "{}",
                    legacy.text
                );
                assert_eq!(super::super::canonicalize(&legacy.text).text, legacy.text);
            }
        }
        let mut limits = options();
        limits.limits.max_clarifier_values = 3;
        let result = canonicalize_with_options(
            r#"x:custom["9007199254740993",9007199254740993,1.00]=0"#,
            &limits,
        );
        assert!(result.errors.is_empty(), "{:?}", result.errors);
        assert!(
            result
                .text
                .contains(r#"custom["9007199254740993", 9007199254740993, 1.0]"#)
        );
    }

    #[test]
    fn head_and_separator_fixes_do_not_change_historical_bytes() {
        for (source, suffix) in [
            (r#""aeon":custom=1"#, "aeon:custom = 1\n"),
            (r#"a@{"aeon":custom=1}=0"#, "a@{aeon:custom = 1} = 0\n"),
            (r#"a=<"aeon":custom>"#, "a = <aeon:custom>\n"),
            (r#"v=^'a.["foo"]'"#, "v = ^'a.foo'\n"),
        ] {
            let legacy = super::super::canonicalize(source);
            assert!(legacy.errors.is_empty(), "{:?}", legacy.errors);
            assert!(legacy.text.ends_with(suffix), "{}", legacy.text);
            assert_eq!(
                canonicalize_with_options(source, &CanonicalizeOptions::default()),
                legacy
            );
        }
    }

    #[test]
    fn scope_identity_is_namespaced_and_missing_plans_fail_closed() {
        assert_ne!(ScopeIdentity::Bindings(7), ScopeIdentity::Attributes(7));
        let authored = aeon_core::parse_document("a@{z=1,b=~a.@.z}={x=1}", &options().limits)
            .expect("authored");
        let (_, mut body) = convert_document(&authored).expect("converted");
        let mut index = Index::build(&[], &body);
        let mut orders = index.plan(100).expect("plan");
        orders.remove(&attribute_identity(&body[0].attributes));
        assert_eq!(
            apply_bindings(&mut body, &orders)
                .expect_err("missing metadata scope")
                .code,
            "CANONICAL_ORDERING_CONFLICT"
        );
    }

    #[test]
    fn cyclic_scope_has_no_successful_order() {
        let mut index = Index::default();
        let scope = index.scope(ScopeIdentity::Bindings(1), vec!["a".into(), "b".into()]);
        index.scopes[scope].successors = vec![HashSet::from([1]), HashSet::from([0])];
        index.scopes[scope].indegree = vec![1, 1];
        assert_eq!(
            index.plan(100).expect_err("cycle").code,
            "CANONICAL_ORDERING_CONFLICT"
        );
    }

    #[test]
    fn metadata_availability_and_external_targets_do_not_create_artificial_cycles() {
        for source in [
            "a@{z=1,b=~a.@.z}=~>a.@.b",
            "a@{z@{x=1}=~a.@.z.@.x,b=~a.@.z}=0",
            "z={leaf=1}\ny={z={leaf=2},b={d={copy=~y.z.leaf},c={copy=~z.leaf}}}\na=~y.b.d.copy",
            "z={leaf=1}\ny={z={leaf=2},b={d={copy=~y},c={copy=~y.b}}}\na=~y.b.d.copy",
            "z=1\na@{z=0,b=~z,a=0}=0",
            "a=[@{z={leaf=1}}=~a[0].@.z.leaf,2]\nb=~a[1]",
            "a=(@{z=1}=~>a[0].@.z,2)\nb=~a[1]",
            "a=<tag(@{z=1}=~a[0].@.z,2)>\nb=~a[1]",
        ] {
            canonical(source);
        }
    }

    #[test]
    fn reference_rejection_is_authored_not_repaired_by_sorting_or_default_header() {
        for (source, code) in [
            ("z=~a\na=7", "FORWARD_REFERENCE"),
            ("a={b=~a.z,z=1}", "FORWARD_REFERENCE"),
            ("a@{b=~a.@.z,z=1}=0", "FORWARD_REFERENCE"),
            ("a=~missing", "MISSING_REFERENCE_TARGET"),
            ("a=~a", "SELF_REFERENCE"),
            ("a@{x=~a}=0", "SELF_REFERENCE"),
            ("a=~[\"aeon:version\"]", "MISSING_REFERENCE_TARGET"),
            ("a=<tag@{z=1}>\nb=~a.@.z", "MISSING_REFERENCE_TARGET"),
            ("a=<tag@{meta={copy=~a}}>", "SELF_REFERENCE"),
            ("a=[~a]", "SELF_REFERENCE"),
            (
                "aeon:version=1\na=~[\"aeon:version\"]\n\"aeon:version\"=2",
                "FORWARD_REFERENCE",
            ),
            (
                "aeon:header={x@{hidden=1}={leaf=2}}\n\"aeon:x\"=0\na=~[\"aeon:x\"].@.hidden",
                "MISSING_REFERENCE_TARGET",
            ),
        ] {
            let result = canonicalize_with_options(source, &options());
            assert_eq!(result.text, "", "{source}");
            assert_eq!(
                result
                    .errors
                    .iter()
                    .map(|error| error.code.as_str())
                    .collect::<Vec<_>>(),
                [code],
                "{source}"
            );
        }
    }

    #[test]
    fn partial_header_collisions_preserve_exact_descendants_not_shadowed_metadata() {
        for source in [
            "aeon:header={x={leaf=1}}\n\"aeon:x\"=2\ncopy=~[\"aeon:x\"].leaf",
            "aeon:header={x={leaf@{meta=1}=2}}\n\"aeon:x\"=0\na=~[\"aeon:x\"].leaf.@.meta",
            "aeon:header={x=[@{meta=1}=2]}\n\"aeon:x\"=0\na=~[\"aeon:x\"][0].@.meta",
            "aeon:header={z={leaf=1},b=~[\"aeon:z\"].leaf}\n\"aeon:z\"=2",
            "aeon:header={x={leaf@{meta=1}=2}}\n\"aeon:x\"={leaf@{meta=3}=4}\na=~[\"aeon:x\"].leaf.@.meta",
        ] {
            canonical(source);
        }
    }

    #[test]
    fn literal_families_identities_and_nonreference_payloads_are_retained() {
        let output = canonical(
            "aeon:header={}\na:custom=|~missing|\nb:prose=>`line\nnext`\nc=2024-02-29T23:59:60.1234567890123\nd=`ordinary`\ne=^~missing\nf=$.missing\nz\\TARGET\\@{meta\\META\\=1}=<tag\\HEAD\\@{x=2}>\ny\\REF\\=~>z.@.meta",
        );
        assert!(output.contains("a:custom = |~missing|"));
        assert!(output.contains("b:prose = >`"));
        assert!(output.contains("d = \"ordinary\""));
        assert!(output.contains("<tag\\HEAD\\@{x = 2}>"));
        // Node heads rendered inside inline metadata also retain identity.
        assert!(canonical("a@{m=<tag\\HEAD\\>}=0").contains("<tag\\HEAD\\>"));
        canonical("aeon:profile=\"aeon.gp.profile.v1\"\na=23:59:60.123456789012345\nb:custom=|x|");
    }

    #[test]
    fn unicode_scalars_and_control_selector_escaping_are_exact() {
        let output = canonical("\"😀\"=0\n\"\u{e000}\"=0\n\"é\"=0\n\"é\"=0\naa=0\na=0\nA=0");
        let parsed =
            aeon_core::parse_document(&output, &options().limits).expect("canonical source");
        assert_eq!(
            parsed
                .iter()
                .filter(|entry| !entry.is_header)
                .map(|entry| entry.key.as_str())
                .collect::<Vec<_>>(),
            ["A", "a", "aa", "é", "é", "\u{e000}", "😀"]
        );
        for character in ["\n", "\r", "\t", "\0", "\u{b}", "\u{1f}", "\"", "\\", "😀"] {
            let key = format!(
                "\"{}\"",
                super::super::escape_string(&format!("z{character}key"))
            );
            for source in [
                format!("{key}=1\na=~[{key}]"),
                format!("holder@{{{key}=1}}=0\na=~>holder.@.[{key}]"),
                format!("holder@{{meta={{{key}=1,a=~holder.@.meta.[{key}]}}}}=0"),
            ] {
                canonical(&source);
            }
        }
    }

    #[test]
    fn edge_budget_deduplicates_and_fails_closed() {
        let mut options = options();
        options.max_ordering_edges = 1;
        assert!(
            canonicalize_with_options("z=1\na={b=~z,c=~>z}", &options)
                .errors
                .is_empty()
        );
        options.max_ordering_edges = 0;
        assert!(
            canonicalize_with_options("z=1\na=0", &options)
                .errors
                .is_empty()
        );
        for source in ["z=1\na=~z", "outer={z=1,b=~outer.z}"] {
            let result = canonicalize_with_options(source, &options);
            assert_eq!(result.text, "");
            assert_eq!(result.errors[0].code, "CANONICAL_ORDERING_LIMIT_EXCEEDED");
        }
    }

    #[test]
    fn parse_limits_and_unrepresentable_header_heads_fail_closed() {
        let mut options = options();
        options.limits.max_input_bytes = Some(2);
        let result = canonicalize_with_options("z=1", &options);
        assert!(result.text.is_empty() && !result.errors.is_empty());
        let result = canonicalize_with_options(
            "a@{z@{x=1}=1}=0",
            &CanonicalizeOptions {
                ordering: CanonicalOrdering::ReferenceSafeV1,
                ..CanonicalizeOptions::default()
            },
        );
        assert!(result.text.is_empty() && !result.errors.is_empty());
        let result = canonicalize_with_options("aeon:header@{meta=1}={}", &self::options());
        assert_eq!(result.text, "");
        assert_eq!(result.errors[0].code, "CANONICAL_ORDERING_CONFLICT");
        for source in [
            "aeon:header={}\na=0\naeon:version=1",
            "a@{m=[{z=1,z=2}]}=0",
            "a=23::59",
        ] {
            let result = canonicalize_with_options(source, &self::options());
            assert!(result.text.is_empty() && !result.errors.is_empty());
        }
    }

    #[test]
    fn every_four_entry_dag_converges_to_independent_lexical_minimum() {
        fn permutations(values: &mut [usize], start: usize, result: &mut Vec<Vec<usize>>) {
            if start == values.len() {
                result.push(values.to_vec());
                return;
            }
            for index in start..values.len() {
                values.swap(start, index);
                permutations(values, start + 1, result);
                values.swap(start, index);
            }
        }
        let mut all = Vec::new();
        permutations(&mut [0, 1, 2, 3], 0, &mut all);
        let pairs = [(0, 1), (0, 2), (0, 3), (1, 2), (1, 3), (2, 3)];
        let keys = ["a", "b", "c", "d"];
        let mut checked = 0;
        for mask in 0..64 {
            let edges: Vec<_> = pairs
                .iter()
                .enumerate()
                .filter(|(index, _)| mask & (1 << index) != 0)
                .map(|(_, edge)| *edge)
                .collect();
            let legal: Vec<_> = all
                .iter()
                .filter(|order| {
                    edges.iter().all(|(a, b)| {
                        order.iter().position(|x| x == a) < order.iter().position(|x| x == b)
                    })
                })
                .collect();
            let minimum = legal.iter().min().expect("acyclic");
            let expected: Vec<_> = minimum.iter().map(|&index| keys[index]).collect();
            for authored in legal {
                let source = authored
                    .iter()
                    .map(|&index| {
                        let refs = edges
                            .iter()
                            .filter(|(_, to)| *to == index)
                            .map(|(from, _)| format!("~{}", keys[*from]))
                            .collect::<Vec<_>>();
                        format!(
                            "{}={}",
                            keys[index],
                            if refs.is_empty() {
                                "0".to_owned()
                            } else {
                                format!("[{}]", refs.join(","))
                            }
                        )
                    })
                    .collect::<Vec<_>>()
                    .join("\n");
                let output = canonical(&source);
                let parsed = aeon_core::parse_document(&output, &options().limits)
                    .expect("canonical syntax");
                assert_eq!(
                    parsed
                        .iter()
                        .filter(|binding| !binding.is_header)
                        .map(|binding| binding.key.as_str())
                        .collect::<Vec<_>>(),
                    expected,
                    "{source}"
                );
                checked += 1;
            }
        }
        assert_eq!(checked, 315);
    }
}
