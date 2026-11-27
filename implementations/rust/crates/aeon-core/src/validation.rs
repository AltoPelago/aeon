#![allow(clippy::too_many_arguments)]

use std::collections::btree_map::Entry;
use std::collections::{BTreeMap, HashMap, HashSet};

use crate::flatten::{FlattenedDocument, ValidationEvent, ValidationReferenceStep};
use crate::pathing::{
    format_reference_base, format_reference_target, render_child_index_path,
    render_child_member_path,
};
use crate::temporal::invalid_temporal_literal;
use crate::{
    AssignmentEvent, AttributeValue, BehaviorMode, Binding, CanonicalPath, DatatypePolicy,
    DatatypeProfile, Diagnostic, PathSegment, ReferenceSegment, SourcePlane, Span, Value,
    format_path,
};

#[derive(Debug, Clone, Default)]
pub(crate) struct ValidationIndexes {
    pub(crate) event_lookup: BTreeMap<String, usize>,
}

pub(crate) fn build_validation_indexes(flattened: &FlattenedDocument) -> ValidationIndexes {
    let mut event_lookup = BTreeMap::new();
    for (index, event) in flattened.events.iter().enumerate() {
        index_datatype_event(
            &mut event_lookup,
            flattened.event_path(index),
            index,
            event.source_plane,
            |previous| flattened.events[previous].source_plane,
        );
    }
    ValidationIndexes { event_lookup }
}

pub(crate) fn build_validation_event_lookup(
    events: &[ValidationEvent<'_>],
    errors: &mut Vec<Diagnostic>,
) -> BTreeMap<String, usize> {
    let mut event_lookup = BTreeMap::new();
    let mut planes_at_colliding_paths = HashSet::new();
    for (index, event) in events.iter().enumerate() {
        let path = event.path.as_str();
        if let Some(previous_plane) = index_datatype_event(
            &mut event_lookup,
            path,
            index,
            event.source_plane,
            |previous| events[previous].source_plane,
        ) {
            // Track both planes only when a path repeats, including when
            // their events are interleaved.
            planes_at_colliding_paths.insert((previous_plane, path));
            if !planes_at_colliding_paths.insert((event.source_plane, path)) {
                errors.push(
                    Diagnostic::new(
                        "DUPLICATE_KEY",
                        format!("Duplicate key: '{}'", key_from_path(path)),
                    )
                    .at_path(path)
                    .with_span(event.span),
                );
            }
        }
    }
    event_lookup
}

fn index_datatype_event(
    lookup: &mut BTreeMap<String, usize>,
    path: &str,
    index: usize,
    plane: SourcePlane,
    plane_at: impl FnOnce(usize) -> SourcePlane,
) -> Option<SourcePlane> {
    match lookup.entry(path.to_owned()) {
        Entry::Vacant(entry) => {
            entry.insert(index);
            None
        }
        Entry::Occupied(mut entry) => {
            let previous = plane_at(*entry.get());
            if previous == SourcePlane::Header || plane == SourcePlane::Body {
                entry.insert(index);
            }
            Some(previous)
        }
    }
}

pub(crate) fn top_level_canonical_paths_have_duplicates(bindings: &[Binding]) -> bool {
    let mut seen = HashSet::with_capacity(bindings.len());
    bindings
        .iter()
        .any(|binding| !seen.insert((binding.is_header, binding.key.as_str())))
}

pub(crate) fn validate_duplicate_canonical_paths(
    flattened: &mut FlattenedDocument,
    recovery: bool,
    errors: &mut Vec<Diagnostic>,
) {
    let duplicate_indexes = {
        let mut seen = HashSet::with_capacity(flattened.events.len());
        let mut duplicate_indexes = Vec::new();
        for (index, event) in flattened.events.iter().enumerate() {
            if !seen.insert((event.source_plane, flattened.event_path(index))) {
                duplicate_indexes.push(index);
            }
        }
        duplicate_indexes
    };
    if duplicate_indexes.is_empty() {
        return;
    }
    for index in &duplicate_indexes {
        let path = flattened.event_path(*index);
        errors.push(
            Diagnostic::new(
                "DUPLICATE_KEY",
                format!("Duplicate key: '{}'", key_from_path(path)),
            )
            .at_path(path)
            .with_span(flattened.events[*index].span),
        );
    }
    if recovery {
        let mut retained = HashSet::new();
        let mut retained_events = Vec::with_capacity(flattened.events.len());
        if flattened.paths_are_in_bindings() {
            let mut retained_bindings = Vec::with_capacity(flattened.bindings.len());
            for (event, binding) in flattened.events.drain(..).zip(flattened.bindings.drain(..)) {
                if retained.insert((event.source_plane, binding.path.clone())) {
                    retained_events.push(event);
                    retained_bindings.push(binding);
                }
            }
            flattened.bindings = retained_bindings;
        } else {
            let mut retained_paths = Vec::with_capacity(flattened.rendered_event_paths.len());
            for (event, path) in flattened
                .events
                .drain(..)
                .zip(flattened.rendered_event_paths.drain(..))
            {
                if retained.insert((event.source_plane, path.clone())) {
                    retained_events.push(event);
                    retained_paths.push(path);
                }
            }
            flattened.rendered_event_paths = retained_paths;
        }
        flattened.events = retained_events;
    } else {
        flattened.events.clear();
        flattened.rendered_event_paths.clear();
        flattened.bindings.clear();
    }
}

pub(crate) fn validate_duplicate_object_member_keys(
    bindings: &[Binding],
    errors: &mut Vec<Diagnostic>,
) -> bool {
    let root = CanonicalPath::root();
    let mut found_duplicate = false;
    for binding in bindings {
        if binding.is_header
            && binding.key == "aeon:header"
            && let Value::ObjectNode { bindings: fields } = &binding.value
        {
            // The progressive compiler sees authored header envelopes; the
            // whole-document compiler sees lowered fields. Use the same
            // canonical field paths without cloning or lowering either AST.
            found_duplicate |= validate_duplicate_object_member_keys_in_attributes(
                &binding.attributes,
                "$",
                Some("$"),
                errors,
            );
            for field in fields {
                let path = format_path(&root.member(format!("aeon:{}", field.key)));
                found_duplicate |=
                    validate_duplicate_object_member_keys_in_binding(field, &path, None, errors);
            }
            continue;
        }
        if binding.attributes.is_empty() && !value_may_contain_object_bindings(&binding.value) {
            continue;
        }
        let path = format_path(&root.member(binding.key.clone()));
        found_duplicate |=
            validate_duplicate_object_member_keys_in_binding(binding, &path, None, errors);
    }
    found_duplicate
}

fn validate_duplicate_object_member_keys_in_binding(
    binding: &Binding,
    path: &str,
    diagnostic_owner: Option<&str>,
    errors: &mut Vec<Diagnostic>,
) -> bool {
    let mut found = validate_duplicate_object_member_keys_in_attributes(
        &binding.attributes,
        path,
        diagnostic_owner,
        errors,
    );
    if value_may_contain_object_bindings(&binding.value) {
        found |= validate_duplicate_object_member_keys_in_value(
            &binding.value,
            path,
            diagnostic_owner,
            errors,
        );
    }
    found
}

fn validate_duplicate_object_member_keys_in_attributes(
    attributes: &BTreeMap<String, AttributeValue>,
    path: &str,
    diagnostic_owner: Option<&str>,
    errors: &mut Vec<Diagnostic>,
) -> bool {
    if attributes.is_empty() {
        return false;
    }
    let parent = format!("{path}.@");
    let mut found = false;
    for (key, entry) in attributes {
        let path = render_child_member_path(&parent, key);
        found |= validate_duplicate_object_member_keys_in_attribute(
            entry,
            &path,
            diagnostic_owner,
            errors,
        );
    }
    found
}

fn validate_duplicate_object_member_keys_in_attribute(
    entry: &AttributeValue,
    path: &str,
    diagnostic_owner: Option<&str>,
    errors: &mut Vec<Diagnostic>,
) -> bool {
    let mut found = validate_duplicate_object_member_keys_in_attributes(
        &entry.nested_attrs,
        path,
        diagnostic_owner,
        errors,
    );
    if let Some(value) = &entry.value
        && value_may_contain_object_bindings(value)
    {
        found |=
            validate_duplicate_object_member_keys_in_value(value, path, diagnostic_owner, errors);
    }
    // Attribute-object keys have already been checked by the parser before
    // entering this map. Their values and attached metadata still need a walk.
    for (key, member) in &entry.object_members {
        let path = render_child_member_path(path, key);
        found |= validate_duplicate_object_member_keys_in_attribute(
            member,
            &path,
            diagnostic_owner,
            errors,
        );
    }
    found
}

fn validate_duplicate_object_member_keys_in_value(
    value: &Value,
    path: &str,
    diagnostic_owner: Option<&str>,
    errors: &mut Vec<Diagnostic>,
) -> bool {
    let mut found_duplicate = false;
    match value {
        Value::TypedValue {
            value, attributes, ..
        } => {
            found_duplicate |= validate_duplicate_object_member_keys_in_attributes(
                attributes,
                path,
                diagnostic_owner,
                errors,
            );
            found_duplicate |= validate_duplicate_object_member_keys_in_value(
                value,
                path,
                diagnostic_owner,
                errors,
            );
        }
        Value::ObjectNode { bindings } => {
            let mut seen = HashSet::new();
            for binding in bindings {
                let member_path = render_child_member_path(path, &binding.key);
                if !seen.insert(binding.key.as_str()) {
                    found_duplicate = true;
                    errors.push(
                        Diagnostic::new(
                            "DUPLICATE_KEY",
                            format!("Duplicate key: '{}'", binding.key),
                        )
                        .at_path(diagnostic_owner.unwrap_or(&member_path))
                        .with_span(binding.span),
                    );
                }
                found_duplicate |= validate_duplicate_object_member_keys_in_binding(
                    binding,
                    &member_path,
                    diagnostic_owner,
                    errors,
                );
            }
        }
        Value::ListNode { items } | Value::TupleLiteral { items } => {
            for (index, item) in items.iter().enumerate() {
                if value_may_contain_object_bindings(item) {
                    found_duplicate |= validate_duplicate_object_member_keys_in_value(
                        item,
                        &render_child_index_path(path, index),
                        diagnostic_owner,
                        errors,
                    );
                }
            }
        }
        Value::NodeLiteral {
            attributes,
            children,
            ..
        } => {
            for attributes in attributes {
                found_duplicate |= validate_duplicate_object_member_keys_in_attributes(
                    attributes,
                    path,
                    diagnostic_owner,
                    errors,
                );
            }
            for (index, child) in children.iter().enumerate() {
                if value_may_contain_object_bindings(child) {
                    found_duplicate |= validate_duplicate_object_member_keys_in_value(
                        child,
                        &render_child_index_path(path, index),
                        diagnostic_owner,
                        errors,
                    );
                }
            }
        }
        _ => {}
    }
    found_duplicate
}

fn value_may_contain_object_bindings(value: &Value) -> bool {
    match value {
        Value::TypedValue {
            value, attributes, ..
        } => !attributes.is_empty() || value_may_contain_object_bindings(value),
        Value::ObjectNode { .. }
        | Value::ListNode { .. }
        | Value::TupleLiteral { .. }
        | Value::NodeLiteral { .. } => true,
        _ => false,
    }
}

fn key_from_path(path: &str) -> String {
    if let Some(start) = path.rfind(".[") {
        let segment = &path[start + 2..];
        if segment.starts_with('"') && segment.ends_with(']') {
            return unescape_quoted_path_segment(&segment[..segment.len() - 1]);
        }
    }
    path.rsplit('.').next().unwrap_or(path).to_string()
}

fn unescape_quoted_path_segment(segment: &str) -> String {
    let inner = segment
        .strip_prefix('"')
        .and_then(|value| value.strip_suffix('"'))
        .unwrap_or(segment);
    let mut result = String::new();
    let mut chars = inner.chars();
    while let Some(ch) = chars.next() {
        if ch == '\\' {
            if let Some(next) = chars.next() {
                result.push(next);
            }
        } else {
            result.push(ch);
        }
    }
    result
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum CompactReferenceStep {
    Claim {
        current_path: String,
        owner_path: String,
        target: String,
        base: String,
        attribute_depth: usize,
        span: Span,
    },
    VisibleTarget(String),
}

impl CompactReferenceStep {
    pub(crate) fn is_claim(&self) -> bool {
        matches!(self, Self::Claim { .. })
    }

    pub(crate) fn retained_string_bytes(&self) -> usize {
        match self {
            Self::Claim {
                current_path,
                owner_path,
                target,
                base,
                ..
            } => {
                current_path.capacity()
                    + owner_path.capacity()
                    + target.capacity()
                    + base.capacity()
            }
            Self::VisibleTarget(path) => path.capacity(),
        }
    }
}

pub(crate) fn compact_reference_steps(
    steps: &[ValidationReferenceStep<'_>],
) -> Vec<CompactReferenceStep> {
    let mut compact = Vec::new();
    for step in steps {
        match step {
            ValidationReferenceStep::ValidateValue {
                path,
                owner_path,
                value,
            } => collect_compact_value_references(value, path, owner_path, &mut compact),
            ValidationReferenceStep::VisibleTarget(path) => {
                compact.push(CompactReferenceStep::VisibleTarget(path.clone()));
            }
            ValidationReferenceStep::DatatypeTarget { .. } => {}
        }
    }
    compact
}

pub(crate) fn validate_compact_reference_steps(
    steps: &[CompactReferenceStep],
    all_targets: &HashSet<String>,
    max_attribute_depth: usize,
    errors: &mut Vec<Diagnostic>,
) {
    let mut seen_base = HashSet::new();
    for step in steps {
        match step {
            CompactReferenceStep::Claim {
                current_path,
                owner_path,
                target,
                base,
                attribute_depth,
                span,
            } => validate_reference_claim(
                current_path,
                owner_path,
                target,
                base,
                *attribute_depth,
                *span,
                all_targets,
                &seen_base,
                max_attribute_depth,
                errors,
            ),
            CompactReferenceStep::VisibleTarget(path) => {
                let _ = seen_base.insert(path.clone());
            }
        }
    }
}

fn collect_compact_value_references(
    value: &Value,
    current_path: &str,
    owner_path: &str,
    compact: &mut Vec<CompactReferenceStep>,
) {
    match value {
        Value::CloneReference { segments, span } | Value::PointerReference { segments, span } => {
            compact.push(CompactReferenceStep::Claim {
                current_path: current_path.to_owned(),
                owner_path: owner_path.to_owned(),
                target: format_reference_target(segments),
                base: format_reference_base(segments),
                attribute_depth: segments
                    .iter()
                    .filter(|segment| matches!(segment, ReferenceSegment::Attr(_)))
                    .count(),
                span: *span,
            });
        }
        Value::ObjectNode { .. } | Value::ListNode { .. } | Value::TupleLiteral { .. } => {}

        _ => {}
    }
}

pub(crate) fn append_compact_value_references(
    value: &Value,
    current_path: &str,
    owner_path: &str,
    shallow_value: bool,
    compact: &mut Vec<CompactReferenceStep>,
) {
    if shallow_value
        && matches!(
            value,
            Value::ObjectNode { .. } | Value::ListNode { .. } | Value::TupleLiteral { .. }
        )
    {
        return;
    }
    collect_compact_value_references(value, current_path, owner_path, compact);
}

#[allow(clippy::too_many_arguments)]
fn validate_reference_claim(
    current_path: &str,
    owner_path: &str,
    target: &str,
    base: &str,
    attribute_depth: usize,
    reference_span: Span,
    all_targets: &HashSet<String>,
    seen_base: &HashSet<String>,
    max_attribute_depth: usize,
    errors: &mut Vec<Diagnostic>,
) {
    if attribute_depth > max_attribute_depth {
        errors.push(
            Diagnostic::new(
                "ATTRIBUTE_DEPTH_EXCEEDED",
                format!("Reference at {current_path} exceeds max attribute depth"),
            )
            .at_path("$")
            .with_span(reference_span),
        );
        return;
    }
    if target == current_path
        || target == owner_path
        || is_attribute_to_own_payload_reference(current_path, target)
    {
        errors.push(
            Diagnostic::new(
                "SELF_REFERENCE",
                format!("Self reference: '{current_path}' references itself"),
            )
            .at_path("$")
            .with_span(reference_span),
        );
        return;
    }
    if !all_targets.contains(target) {
        errors.push(
            Diagnostic::new(
                "MISSING_REFERENCE_TARGET",
                format!("Missing reference target: '{target}'"),
            )
            .at_path("$")
            .with_span(reference_span),
        );
        return;
    }
    // Metadata becomes available before its attached payload, including on
    // anonymous sequence items. Test the exact target rather than requiring
    // the payload's base to have been published. Use parsed attribute depth:
    // a quoted property name containing ".@" is not an attribute selector.
    let is_visible = if attribute_depth > 0 {
        seen_base.contains(target)
    } else {
        seen_base.contains(base)
    };
    if !is_visible {
        errors.push(
            Diagnostic::new(
                "FORWARD_REFERENCE",
                format!("Forward reference: '{current_path}' references '{target}' defined later"),
            )
            .at_path("$")
            .with_span(reference_span),
        );
    }
}

fn is_attribute_to_own_payload_reference(current_path: &str, target: &str) -> bool {
    // Rendered quoted member names may contain ".@"; only namespace selectors
    // outside quotes identify an attribute's owning payload.
    let mut quoted = false;
    let mut escaped = false;
    for (index, character) in current_path.char_indices() {
        if escaped {
            escaped = false;
        } else if quoted && character == '\\' {
            escaped = true;
        } else if character == '"' {
            quoted = !quoted;
        } else if !quoted
            && character == '.'
            && current_path[index..].starts_with(".@")
            && target == &current_path[..index]
        {
            return true;
        }
    }
    false
}

pub(crate) fn validate_datatypes<P: AsRef<str>>(
    events: &[AssignmentEvent],
    rendered_event_paths: &[P],
    event_lookup: &BTreeMap<String, usize>,
    bindings: &[Binding],
    effective_mode: Option<BehaviorMode>,
    datatype_policy: Option<DatatypePolicy>,
    max_separator_depth: usize,
    max_generic_depth: usize,
    recovery: bool,
    datatype_profile: Option<DatatypeProfile<'_>>,
    errors: &mut Vec<Diagnostic>,
) {
    let mode = effective_mode.unwrap_or_else(|| extract_behavior_mode(bindings));
    let datatype_policy = effective_datatype_policy(mode, datatype_policy);
    let mut references = DatatypeReferenceCache::default();
    let mut authored_targets = AuthoredDatatypeTargets::new(bindings, recovery);
    for (event, path) in events.iter().zip(rendered_event_paths.iter()) {
        let path = path.as_ref();
        if let Some(datatype) = &event.datatype {
            if let Some(error) =
                invalid_inline_node_datatype(&event.value, datatype, path, event.span, mode)
            {
                errors.push(error);
                continue;
            }
            if let Some(error) =
                validate_datatype_shape(datatype, event, max_separator_depth, max_generic_depth)
            {
                let path_override = match error.code.as_str() {
                    "INVALID_NUMBER"
                    | "INVALID_SEPARATOR_CHAR"
                    | "CLARIFIER_VALUES_EXCEEDED"
                    | "GENERIC_DEPTH_EXCEEDED" => "$",
                    _ => path,
                };
                errors.push(error.with_span(event.span).at_path(path_override));
                continue;
            }
            let resolved_value = references.resolve(&event.value, |segments| {
                resolve_datatype_reference_target(segments, &mut authored_targets, |path| {
                    let event = &events[*event_lookup.get(path)?];
                    (event.source_plane == SourcePlane::Body).then_some(&event.value)
                })
            });
            if let Some(error) = datatype_value_error(
                datatype,
                &resolved_value,
                path,
                event.span,
                mode,
                datatype_policy,
            ) {
                errors.push(error);
            } else if let Some(profile) = datatype_profile
                && let Some(error) =
                    profile.custom_value_error(datatype, resolved_value.value_kind(), path)
            {
                errors.push(error.with_span(event.span));
            }
        }
    }
    validate_resolved_attribute_datatypes(
        &mut authored_targets,
        mode,
        datatype_policy,
        max_separator_depth,
        max_generic_depth,
        datatype_profile,
        errors,
    );
}

pub(crate) fn validate_direct_event_datatype(
    event: &AssignmentEvent,
    path: &str,
    mode: BehaviorMode,
    datatype_policy: Option<DatatypePolicy>,
    max_separator_depth: usize,
    max_generic_depth: usize,
) -> Option<Diagnostic> {
    let datatype = event.datatype.as_deref()?;
    if let Some(error) =
        invalid_inline_node_datatype(&event.value, datatype, path, event.span, mode)
    {
        return Some(error);
    }
    if matches!(
        event.value,
        Value::CloneReference { .. } | Value::PointerReference { .. }
    ) {
        return None;
    }
    if let Some(error) =
        validate_datatype_shape(datatype, event, max_separator_depth, max_generic_depth)
    {
        let path_override = match error.code.as_str() {
            "INVALID_NUMBER"
            | "INVALID_SEPARATOR_CHAR"
            | "CLARIFIER_VALUES_EXCEEDED"
            | "GENERIC_DEPTH_EXCEEDED" => "$",
            _ => path,
        };
        return Some(error.with_span(event.span).at_path(path_override));
    }
    datatype_value_error(
        datatype,
        &CompactDatatypeValue::from_value(&event.value),
        path,
        event.span,
        mode,
        effective_datatype_policy(mode, datatype_policy),
    )
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum CompactDatatypeValue {
    Number,
    Infinity,
    NaN,
    Null,
    String,
    TrimtickString,
    Toggle,
    Boolean,
    Hex(bool),
    Separator,
    Symbolic,
    Encoding {
        literal_valid: bool,
        base64_valid: bool,
    },
    Radix(bool),
    Date,
    DateTime,
    WtcDateTime,
    Time,
    Sansa,
    Node,
    List,
    Tuple,
    Object,
    CloneReference(String),
    PointerReference(String),
}

impl CompactDatatypeValue {
    pub(crate) fn from_value(value: &Value) -> Self {
        match value {
            Value::TypedValue { value, .. } => Self::from_value(value),
            Value::NumberLiteral { .. } => Self::Number,
            Value::InfinityLiteral { .. } => Self::Infinity,
            Value::NaNLiteral { .. } => Self::NaN,
            Value::NullLiteral { .. } => Self::Null,
            Value::StringLiteral { trimticks, .. } => {
                if trimticks.is_some() {
                    Self::TrimtickString
                } else {
                    Self::String
                }
            }
            Value::ToggleLiteral { .. } => Self::Toggle,
            Value::BooleanLiteral { .. } => Self::Boolean,
            Value::HexLiteral { raw } => Self::Hex(has_valid_literal_underscores(raw)),
            Value::SeparatorLiteral { .. } => Self::Separator,
            Value::SymbolicLiteral { .. } => Self::Symbolic,
            Value::EncodingLiteral { raw } => {
                #[cfg(test)]
                tests::ENCODING_CLASSIFICATIONS.with(|count| count.set(count.get() + 1));
                Self::Encoding {
                    literal_valid: has_valid_encoding_literal(raw),
                    base64_valid: has_valid_base64url_literal(raw),
                }
            }
            Value::RadixLiteral { raw } => Self::Radix(has_valid_radix_literal(raw)),
            Value::DateLiteral { .. } => Self::Date,
            Value::DateTimeLiteral { raw } => {
                if raw.contains('&') {
                    Self::WtcDateTime
                } else {
                    Self::DateTime
                }
            }
            Value::TimeLiteral { .. } => Self::Time,
            Value::SansaAddressLiteral { .. } => Self::Sansa,
            Value::NodeLiteral { .. } => Self::Node,
            Value::ListNode { .. } => Self::List,
            Value::TupleLiteral { .. } => Self::Tuple,
            Value::ObjectNode { .. } => Self::Object,
            Value::CloneReference { segments, .. } => {
                Self::CloneReference(format_reference_target(segments))
            }
            Value::PointerReference { segments, .. } => {
                Self::PointerReference(format_reference_target(segments))
            }
        }
    }

    pub(crate) fn reference_target(&self) -> Option<&str> {
        match self {
            Self::CloneReference(target) | Self::PointerReference(target) => Some(target),
            _ => None,
        }
    }

    pub(crate) fn value_kind(&self) -> &'static str {
        match self {
            Self::Number => "NumberLiteral",
            Self::Infinity => "InfinityLiteral",
            Self::NaN => "NaNLiteral",
            Self::Null => "NullLiteral",
            Self::String => "StringLiteral",
            Self::TrimtickString => "TrimtickStringLiteral",
            Self::Toggle => "ToggleLiteral",
            Self::Boolean => "BooleanLiteral",
            Self::Hex(_) => "HexLiteral",
            Self::Separator => "SeparatorLiteral",
            Self::Symbolic => "SymbolicLiteral",
            Self::Encoding { .. } => "EncodingLiteral",
            Self::Radix(_) => "RadixLiteral",
            Self::Date => "DateLiteral",
            Self::DateTime => "DateTimeLiteral",
            Self::WtcDateTime => "WTCDateTimeLiteral",
            Self::Time => "TimeLiteral",
            Self::Sansa => "SansaAddressLiteral",
            Self::Node => "NodeLiteral",
            Self::List => "ListNode",
            Self::Tuple => "TupleLiteral",
            Self::Object => "ObjectNode",
            Self::CloneReference(_) => "CloneReference",
            Self::PointerReference(_) => "PointerReference",
        }
    }

    pub(crate) fn retained_string_bytes(&self) -> usize {
        match self {
            Self::CloneReference(target) | Self::PointerReference(target) => target.capacity(),
            _ => 0,
        }
    }
}

pub(crate) fn validate_compact_reference_datatype(
    datatype: &str,
    resolved_value: &CompactDatatypeValue,
    path: &str,
    span: Span,
    mode: BehaviorMode,
    datatype_policy: Option<DatatypePolicy>,
    max_separator_depth: usize,
    max_generic_depth: usize,
) -> Option<Diagnostic> {
    if let Some(error) =
        validate_datatype_shape_without_literal(datatype, max_separator_depth, max_generic_depth)
    {
        let path_override = match error.code.as_str() {
            "INVALID_SEPARATOR_CHAR" | "CLARIFIER_VALUES_EXCEEDED" | "GENERIC_DEPTH_EXCEEDED" => {
                "$"
            }
            _ => path,
        };
        return Some(error.with_span(span).at_path(path_override));
    }
    datatype_value_error(
        datatype,
        resolved_value,
        path,
        span,
        mode,
        effective_datatype_policy(mode, datatype_policy),
    )
}

pub(crate) fn collect_attribute_datatype_checks(
    bindings: &[Binding],
    mode: BehaviorMode,
    datatype_policy: Option<DatatypePolicy>,
    max_separator_depth: usize,
    max_generic_depth: usize,
    checks: &mut Vec<AttributeDatatypeCheck>,
) {
    validate_attribute_datatypes_in_scope(
        bindings,
        "$",
        AttributeValueScope::Projected,
        mode,
        effective_datatype_policy(mode, datatype_policy),
        max_separator_depth,
        max_generic_depth,
        checks,
    );
}

pub(crate) fn validate_datatypes_light(
    events: &[ValidationEvent<'_>],
    event_lookup: &BTreeMap<String, usize>,
    bindings: &[Binding],
    effective_mode: Option<BehaviorMode>,
    datatype_policy: Option<DatatypePolicy>,
    max_separator_depth: usize,
    max_generic_depth: usize,
    datatype_profile: Option<DatatypeProfile<'_>>,
    errors: &mut Vec<Diagnostic>,
) {
    let mode = effective_mode.unwrap_or_else(|| extract_behavior_mode(bindings));
    let datatype_policy = effective_datatype_policy(mode, datatype_policy);
    let mut references = DatatypeReferenceCache::default();
    let mut authored_targets = AuthoredDatatypeTargets::new(bindings, false);
    for event in events {
        if let Some(datatype) = &event.datatype {
            if let Some(error) =
                invalid_inline_node_datatype(event.value, datatype, &event.path, event.span, mode)
            {
                errors.push(error);
                continue;
            }
            if let Some(error) = validate_datatype_shape_light(
                datatype,
                event.value,
                max_separator_depth,
                max_generic_depth,
            ) {
                let path_override = match error.code.as_str() {
                    "INVALID_NUMBER"
                    | "INVALID_SEPARATOR_CHAR"
                    | "CLARIFIER_VALUES_EXCEEDED"
                    | "GENERIC_DEPTH_EXCEEDED" => "$",
                    _ => event.path.as_str(),
                };
                errors.push(error.with_span(event.span).at_path(path_override));
                continue;
            }
            if !is_reserved_datatype(datatype) && datatype_policy == DatatypePolicy::ReservedOnly {
                errors.push(
                    Diagnostic::new(
                        "CUSTOM_DATATYPE_NOT_ALLOWED",
                        format!(
                            "Custom datatype not allowed in typed mode at '{}': ':{datatype}' requires --datatype-policy allow_custom",
                            event.path
                        ),
                    )
                    .at_path(event.path.clone())
                    .with_span(event.span),
                );
                continue;
            }
            let resolved_value = references.resolve(event.value, |segments| {
                resolve_datatype_reference_target(segments, &mut authored_targets, |path| {
                    let event = &events[*event_lookup.get(path)?];
                    (event.source_plane == SourcePlane::Body).then_some(event.value)
                })
            });
            if datatype_base(datatype) == "switch"
                && matches!(resolved_value, CompactDatatypeValue::Toggle)
            {
                errors.push(
                    Diagnostic::new(
                        "CUSTOM_TOGGLE_ALIAS_NOT_ALLOWED",
                        format!(
                            "Custom toggle alias not allowed at '{}': use ':toggle' instead of ':{datatype}'",
                            event.path
                        ),
                    )
                    .at_path(event.path.clone())
                    .with_span(event.span),
                );
                continue;
            }
            if !is_reserved_datatype(datatype)
                && mode == BehaviorMode::Strict
                && matches!(resolved_value, CompactDatatypeValue::Toggle)
            {
                errors.push(
                    Diagnostic::new(
                        "CUSTOM_TOGGLE_ALIAS_NOT_ALLOWED",
                        format!(
                            "Custom toggle alias not allowed at '{}': use ':toggle' instead of ':{datatype}'",
                            event.path
                        ),
                    )
                    .at_path(event.path.clone())
                    .with_span(event.span),
                );
                continue;
            }
            if !datatype_matches_compact_value(datatype, &resolved_value) {
                let message =
                    datatype_mismatch_message(&event.path, datatype, resolved_value.value_kind());
                errors.push(
                    Diagnostic::new("DATATYPE_LITERAL_MISMATCH", message)
                        .at_path(event.path.clone())
                        .with_span(event.span),
                );
            } else if let Some(profile) = datatype_profile
                && let Some(error) =
                    profile.custom_value_error(datatype, resolved_value.value_kind(), &event.path)
            {
                errors.push(error.with_span(event.span));
            }
        }
    }
    validate_resolved_attribute_datatypes(
        &mut authored_targets,
        mode,
        datatype_policy,
        max_separator_depth,
        max_generic_depth,
        datatype_profile,
        errors,
    );
}

pub(crate) fn validate_typed_mode_rules(
    bindings: &[Binding],
    effective_mode: Option<BehaviorMode>,
    errors: &mut Vec<Diagnostic>,
) {
    let mode = effective_mode.unwrap_or_else(|| extract_behavior_mode(bindings));
    if !matches!(mode, BehaviorMode::Strict | BehaviorMode::Custom) {
        return;
    }
    validate_typed_mode_rules_in_scope(bindings, &CanonicalPath::root(), mode, errors);
}

pub(crate) fn extract_behavior_mode(bindings: &[Binding]) -> BehaviorMode {
    for binding in bindings {
        if !binding.is_header || binding.key != "aeon:mode" {
            continue;
        }
        if let Value::StringLiteral { value, .. } = &binding.value {
            return match value.as_str() {
                "strict" => BehaviorMode::Strict,
                "custom" => BehaviorMode::Custom,
                _ => BehaviorMode::Transport,
            };
        }
    }
    BehaviorMode::Transport
}

pub(crate) fn effective_datatype_policy(
    mode: BehaviorMode,
    explicit: Option<DatatypePolicy>,
) -> DatatypePolicy {
    match explicit {
        Some(policy) => policy,
        None => match mode {
            BehaviorMode::Transport | BehaviorMode::Custom => DatatypePolicy::AllowCustom,
            BehaviorMode::Strict => DatatypePolicy::ReservedOnly,
        },
    }
}

#[derive(Default)]
struct DatatypeReferenceCache<'a> {
    terminals: HashMap<*const Value, &'a Value>,
    literal_facts: HashMap<*const Value, CompactDatatypeValue>,
}

impl<'a> DatatypeReferenceCache<'a> {
    fn resolve(
        &mut self,
        value: &'a Value,
        lookup: impl FnMut(&[ReferenceSegment]) -> Option<&'a Value>,
    ) -> CompactDatatypeValue {
        let resolved = resolve_reference_chain(value, &mut self.terminals, lookup).unwrap_or(value);
        if !std::ptr::eq(value, resolved)
            && matches!(
                resolved,
                Value::EncodingLiteral { .. }
                    | Value::HexLiteral { .. }
                    | Value::RadixLiteral { .. }
                    | Value::DateTimeLiteral { .. }
            )
        {
            // The same literal can terminate several chains. Its validity
            // depends on the authored bytes, so classify it by identity once.
            return self
                .literal_facts
                .entry(std::ptr::from_ref(resolved))
                .or_insert_with(|| CompactDatatypeValue::from_value(resolved))
                .clone();
        }
        CompactDatatypeValue::from_value(resolved)
    }
}

fn resolve_reference_chain<'a>(
    mut value: &'a Value,
    terminal_values: &mut HashMap<*const Value, &'a Value>,
    mut lookup: impl FnMut(&[ReferenceSegment]) -> Option<&'a Value>,
) -> Option<&'a Value> {
    let mut seen = HashSet::new();
    loop {
        match value {
            Value::TypedValue { value: inner, .. } => value = inner,
            Value::CloneReference { segments, .. } | Value::PointerReference { segments, .. } => {
                let reference = std::ptr::from_ref(value);
                if let Some(&terminal) = terminal_values.get(&reference) {
                    value = terminal;
                    break;
                }
                if !seen.insert(reference) {
                    return Some(value);
                }
                value = lookup(segments)?;
            }
            _ => break,
        }
    }
    terminal_values.extend(seen.into_iter().map(|reference| (reference, value)));
    Some(value)
}

/// Borrowed one-hop binding data for the internal Core/Finalize boundary.
/// Metadata objects have no Value slot, so retain the actual attribute binding.
/// This view is not an occurrence identity or a serialized reference program.
#[doc(hidden)]
#[derive(Clone, Copy)]
pub enum AssignmentReferenceTarget<'a> {
    Value(&'a Value),
    Attribute(&'a AttributeValue),
}

impl<'a> AssignmentReferenceTarget<'a> {
    fn datatype_value(self) -> &'a Value {
        match self {
            Self::Value(value) => value,
            Self::Attribute(attribute) => attribute.datatype_value(),
        }
    }
}

/// Internal one-hop binding lookup; does not validate or follow references.
/// The caller supplies an index restricted to its admitted plane and retains
/// freshness, cycle and materialization-limit responsibilities.
#[doc(hidden)]
pub fn resolve_assignment_reference_target<'a>(
    segments: &[ReferenceSegment],
    events: &'a [AssignmentEvent],
    event_lookup: &BTreeMap<String, usize>,
) -> Option<AssignmentReferenceTarget<'a>> {
    for split in (1..=segments.len()).rev() {
        let prefix = &segments[..split];
        if prefix
            .iter()
            .any(|segment| matches!(segment, ReferenceSegment::Attr(_)))
        {
            continue;
        }
        let prefix_path = format_reference_target(prefix);
        let event = event_lookup
            .get(&prefix_path)
            .and_then(|index| events.get(*index))?;
        let remainder = &segments[split..];
        if remainder.is_empty() {
            return Some(AssignmentReferenceTarget::Value(&event.value));
        }
        if let Some(value) = resolve_reference_remainder_target(
            &event.value,
            Some(&event.annotations),
            remainder,
            &mut find_object_member,
        ) {
            return Some(value);
        }
    }
    None
}

fn resolve_datatype_reference_target<'a>(
    segments: &[ReferenceSegment],
    authored_targets: &mut AuthoredDatatypeTargets<'a>,
    body_event_value: impl FnOnce(&str) -> Option<&'a Value>,
) -> Option<&'a Value> {
    if !segments
        .iter()
        .any(|segment| matches!(segment, ReferenceSegment::Attr(_)))
        && let Some(value) = body_event_value(&format_reference_target(segments))
    {
        return Some(value);
    }
    // Compact validation events omit some container slots. Consult the
    // authored owner before falling back to a header or declaring it absent.
    authored_targets.lookup(segments)
}

fn find_object_member<'a>(bindings: &'a [Binding], key: &str) -> Option<&'a Binding> {
    bindings.iter().find(|binding| binding.key == key)
}

fn resolve_reference_remainder_target<'a>(
    value: &'a Value,
    annotations: Option<&'a BTreeMap<String, AttributeValue>>,
    remainder: &[ReferenceSegment],
    member: &mut impl FnMut(&'a [Binding], &str) -> Option<&'a Binding>,
) -> Option<AssignmentReferenceTarget<'a>> {
    if remainder.is_empty() {
        return Some(AssignmentReferenceTarget::Value(value));
    }
    if let Value::TypedValue {
        attributes,
        value: payload,
        ..
    } = value
    {
        let annotations = annotations
            .filter(|entries| !entries.is_empty())
            .or(Some(attributes));
        return resolve_reference_remainder_target(payload, annotations, remainder, member);
    }
    match &remainder[0] {
        ReferenceSegment::Attr(key) => {
            let attr = annotations
                .and_then(|entries| entries.get(key))
                .or_else(|| {
                    let Value::NodeLiteral { attributes, .. } = value else {
                        return None;
                    };
                    attributes.iter().find_map(|entries| entries.get(key))
                })?;
            resolve_reference_remainder_from_attr_target(attr, &remainder[1..], member)
        }
        ReferenceSegment::Key(key) => {
            let Value::ObjectNode { bindings } = value else {
                return None;
            };
            let binding = member(bindings, key)?;
            resolve_reference_remainder_target(
                &binding.value,
                Some(&binding.attributes),
                &remainder[1..],
                member,
            )
        }
        ReferenceSegment::Index(index) => match value {
            Value::ListNode { items } | Value::TupleLiteral { items } => {
                resolve_reference_remainder_target(
                    items.get(*index)?,
                    None,
                    &remainder[1..],
                    member,
                )
            }
            Value::NodeLiteral { children, .. } => resolve_reference_remainder_target(
                children.get(*index)?,
                None,
                &remainder[1..],
                member,
            ),
            _ => None,
        },
    }
}

fn resolve_reference_remainder_from_attr_target<'a>(
    attr: &'a AttributeValue,
    remainder: &[ReferenceSegment],
    member: &mut impl FnMut(&'a [Binding], &str) -> Option<&'a Binding>,
) -> Option<AssignmentReferenceTarget<'a>> {
    if remainder.is_empty() {
        return Some(AssignmentReferenceTarget::Attribute(attr));
    }
    match &remainder[0] {
        ReferenceSegment::Attr(key) => {
            if let Some(entry) = attr.nested_attrs.get(key) {
                resolve_reference_remainder_from_attr_target(entry, &remainder[1..], member)
            } else {
                resolve_reference_remainder_target(attr.value.as_ref()?, None, remainder, member)
            }
        }
        ReferenceSegment::Key(key) => {
            if let Some(entry) = attr.object_members.get(key) {
                resolve_reference_remainder_from_attr_target(entry, &remainder[1..], member)
            } else {
                resolve_reference_remainder_target(attr.value.as_ref()?, None, remainder, member)
            }
        }
        ReferenceSegment::Index(_) => {
            resolve_reference_remainder_target(attr.value.as_ref()?, None, remainder, member)
        }
    }
}

fn validate_typed_mode_rules_in_scope(
    bindings: &[Binding],
    parent: &CanonicalPath,
    mode: BehaviorMode,
    errors: &mut Vec<Diagnostic>,
) {
    for binding in bindings {
        let path = parent.member(binding.key.clone());
        if matches!(parent.segments.as_slice(), [crate::PathSegment::Root]) && binding.is_header {
            continue;
        }
        let strict_toggle =
            mode == BehaviorMode::Strict && matches!(binding.value, Value::ToggleLiteral { .. });
        let implicitly_typed = matches!(binding.value, Value::NodeLiteral { .. }) || strict_toggle;
        if !binding.is_header && binding.datatype.is_none() && !implicitly_typed {
            errors.push(
                Diagnostic::new(
                    "UNTYPED_VALUE_IN_STRICT_MODE",
                    format!(
                        "Untyped value in typed mode: '{}' requires explicit type annotation",
                        format_path(&path)
                    ),
                )
                .at_path(format_path(&path))
                .with_span(binding.span),
            );
        }
        validate_switch_literal_in_value(
            &binding.value,
            &path,
            binding.span,
            binding.datatype.as_deref(),
            mode,
            errors,
        );
        if let Value::ObjectNode { bindings: nested } = &binding.value {
            validate_typed_mode_rules_in_scope(nested, &path, mode, errors);
        }
    }
}

fn invalid_inline_node_datatype(
    value: &Value,
    datatype: &str,
    path: &str,
    span: Span,
    mode: BehaviorMode,
) -> Option<Diagnostic> {
    (matches!(mode, BehaviorMode::Strict) && matches!(value, Value::NodeLiteral { .. })
        && datatype_base(datatype) != "node")
        .then(|| Diagnostic::new(
            "INVALID_NODE_DATATYPE",
            format!("Invalid node datatype in strict mode at '{path}': expected ':node', got ':{datatype}'"),
        ).at_path(path).with_span(span))
}

fn validate_switch_literal_in_value(
    value: &Value,
    path: &CanonicalPath,
    owner_span: Span,
    datatype: Option<&str>,
    mode: BehaviorMode,
    errors: &mut Vec<Diagnostic>,
) {
    match value {
        Value::ToggleLiteral { .. } => {
            if matches!(mode, BehaviorMode::Strict) && datatype.is_none() {
                errors.push(
                    Diagnostic::new(
                        "UNTYPED_TOGGLE_LITERAL",
                        format!(
                            "Untyped toggle literal in typed mode: '{}' requires ':toggle' type annotation",
                            format_path(path)
                        ),
                    )
                    .at_path(format_path(path))
                    .with_span(owner_span),
                );
            }
        }
        Value::ObjectNode { .. } => {}
        Value::ListNode { items } | Value::TupleLiteral { items } => {
            let nested_datatype = if datatype.is_some() {
                Some("toggle")
            } else {
                None
            };
            for (index, item) in items.iter().enumerate() {
                validate_switch_literal_in_value(
                    item,
                    &path.index(index),
                    owner_span,
                    nested_datatype,
                    mode,
                    errors,
                );
            }
        }
        _ => {}
    }
}

fn validate_datatype_shape(
    datatype: &str,
    event: &AssignmentEvent,
    max_separator_depth: usize,
    max_generic_depth: usize,
) -> Option<Diagnostic> {
    if let Some(error) =
        validate_datatype_shape_without_literal(datatype, max_separator_depth, max_generic_depth)
    {
        return Some(error);
    }
    if let Value::NumberLiteral { raw } = &event.value
        && !is_valid_number_literal(raw)
    {
        if let Some((code, message)) = invalid_temporal_literal(raw) {
            return Some(Diagnostic::new(code, message));
        }
        return Some(Diagnostic::new(
            "INVALID_NUMBER",
            format!("Number literal `{raw}` is not valid"),
        ));
    }
    None
}

fn validate_datatype_shape_without_literal(
    datatype: &str,
    max_separator_depth: usize,
    max_generic_depth: usize,
) -> Option<Diagnostic> {
    if datatype.contains("[,]") {
        return Some(Diagnostic::new(
            "INVALID_SEPARATOR_CHAR",
            format!("Datatype `{datatype}` uses a reserved separator character"),
        ));
    }
    if separator_spec_depth(datatype) > max_separator_depth {
        return Some(Diagnostic::new(
            "CLARIFIER_VALUES_EXCEEDED",
            format!("Datatype `{datatype}` exceeds max_clarifier_values {max_separator_depth}"),
        ));
    }
    let observed_generic_depth = generic_depth(datatype);
    if observed_generic_depth > max_generic_depth {
        return Some(Diagnostic::new(
            "GENERIC_DEPTH_EXCEEDED",
            format!(
                "Generic depth {observed_generic_depth} exceeds max_generic_depth {max_generic_depth}"
            ),
        ));
    }
    None
}

fn validate_datatype_shape_light(
    datatype: &str,
    value: &Value,
    max_separator_depth: usize,
    max_generic_depth: usize,
) -> Option<Diagnostic> {
    if datatype.contains("[,]") {
        return Some(Diagnostic::new(
            "INVALID_SEPARATOR_CHAR",
            format!("Datatype `{datatype}` uses a reserved separator character"),
        ));
    }
    if separator_spec_depth(datatype) > max_separator_depth {
        return Some(Diagnostic::new(
            "CLARIFIER_VALUES_EXCEEDED",
            format!("Datatype `{datatype}` exceeds max_clarifier_values {max_separator_depth}"),
        ));
    }
    let observed_generic_depth = generic_depth(datatype);
    if observed_generic_depth > max_generic_depth {
        return Some(Diagnostic::new(
            "GENERIC_DEPTH_EXCEEDED",
            format!(
                "Generic depth {observed_generic_depth} exceeds max_generic_depth {max_generic_depth}"
            ),
        ));
    }
    if let Value::NumberLiteral { raw } = value
        && !is_valid_number_literal(raw)
    {
        if let Some((code, message)) = invalid_temporal_literal(raw) {
            return Some(Diagnostic::new(code, message));
        }
        return Some(Diagnostic::new(
            "INVALID_NUMBER",
            format!("Number literal `{raw}` is not valid"),
        ));
    }
    None
}

fn separator_spec_depth(datatype: &str) -> usize {
    datatype_bracket_specs(datatype).len()
}

pub(crate) fn datatype_base(datatype: &str) -> &str {
    let generic_idx = datatype.find('<');
    let separator_idx = datatype.find('[');
    let end_idx = match (generic_idx, separator_idx) {
        (Some(a), Some(b)) => a.min(b),
        (Some(a), None) => a,
        (None, Some(b)) => b,
        (None, None) => datatype.len(),
    };
    &datatype[..end_idx]
}

pub(crate) fn is_reserved_datatype(datatype: &str) -> bool {
    is_reserved_datatype_name(datatype_base(datatype))
}

/// Whether a name denotes a datatype reserved by Core.
#[must_use]
pub fn is_reserved_datatype_name(name: &str) -> bool {
    matches!(
        name,
        "number"
            | "n"
            | "int"
            | "int8"
            | "int16"
            | "int32"
            | "int64"
            | "uint"
            | "uint8"
            | "uint16"
            | "uint32"
            | "uint64"
            | "float"
            | "float32"
            | "float64"
            | "infinity"
            | "nan"
            | "string"
            | "trimtick"
            | "prose"
            | "boolean"
            | "bool"
            | "toggle"
            | "hex"
            | "radix"
            | "decimal"
            | "radix2"
            | "radix6"
            | "radix8"
            | "radix12"
            | "radix16"
            | "encoding"
            | "base64"
            | "embed"
            | "inline"
            | "date"
            | "time"
            | "datetime"
            | "wtc"
            | "sep"
            | "kadot"
            | "symbol"
            | "tuple"
            | "triple"
            | "list"
            | "object"
            | "obj"
            | "envelope"
            | "o"
            | "node"
            | "sansa"
            | "null"
    )
}

fn expected_kinds_for_reserved_datatype(datatype: &str) -> Option<Vec<&'static str>> {
    match datatype_base(datatype) {
        "number" | "n" | "int" | "int8" | "int16" | "int32" | "int64" | "uint" | "uint8"
        | "uint16" | "uint32" | "uint64" | "float" | "float32" | "float64" => {
            Some(vec!["NumberLiteral"])
        }
        "infinity" => Some(vec!["InfinityLiteral"]),
        "nan" => Some(vec!["NaNLiteral"]),
        "null" => Some(vec!["NullLiteral"]),
        "string" => Some(vec!["StringLiteral"]),
        "trimtick" | "prose" => Some(vec!["TrimtickStringLiteral"]),
        "boolean" | "bool" => Some(vec!["BooleanLiteral"]),
        "toggle" => Some(vec!["ToggleLiteral"]),
        "hex" => Some(vec!["HexLiteral"]),
        "radix" | "decimal" | "radix2" | "radix6" | "radix8" | "radix12" | "radix16" => {
            Some(vec!["RadixLiteral"])
        }
        "encoding" | "base64" | "embed" | "inline" => Some(vec!["EncodingLiteral"]),
        "date" => Some(vec!["DateLiteral"]),
        "time" => Some(vec!["TimeLiteral"]),
        "datetime" => Some(vec!["DateTimeLiteral"]),
        "wtc" => Some(vec!["WTCDateTimeLiteral"]),
        "sep" | "kadot" => Some(vec!["SeparatorLiteral"]),
        "symbol" => Some(vec!["SymbolicLiteral"]),
        "tuple" | "triple" => Some(vec!["TupleLiteral"]),
        "list" => Some(vec!["ListNode"]),
        "object" | "obj" | "envelope" | "o" => Some(vec!["ObjectNode"]),
        "node" => Some(vec!["NodeLiteral"]),
        "sansa" => Some(vec!["SansaAddressLiteral"]),
        _ => None,
    }
}

fn datatype_mismatch_message(path: &str, datatype: &str, actual_kind: &str) -> String {
    if let Some(expected) = expected_kinds_for_reserved_datatype(datatype) {
        return format!(
            "Datatype/literal mismatch at '{}': datatype ':{datatype}' expects {}, got {actual_kind}",
            path,
            expected.join(" or ")
        );
    }
    format!(
        "Datatype/literal mismatch at '{}': datatype ':{datatype}' is not supported for literal matching, got {actual_kind}",
        path
    )
}

fn datatype_value_error(
    datatype: &str,
    value: &CompactDatatypeValue,
    path: &str,
    span: Span,
    mode: BehaviorMode,
    datatype_policy: DatatypePolicy,
) -> Option<Diagnostic> {
    if !is_reserved_datatype(datatype) && datatype_policy == DatatypePolicy::ReservedOnly {
        return Some(
            Diagnostic::new(
                "CUSTOM_DATATYPE_NOT_ALLOWED",
                format!(
                    "Custom datatype not allowed in typed mode at '{path}': ':{datatype}' requires --datatype-policy allow_custom"
                ),
            )
            .at_path(path.to_owned())
            .with_span(span),
        );
    }
    if datatype_base(datatype) == "switch" && matches!(value, CompactDatatypeValue::Toggle) {
        return Some(
            Diagnostic::new(
                "CUSTOM_TOGGLE_ALIAS_NOT_ALLOWED",
                format!(
                    "Custom toggle alias not allowed at '{path}': use ':toggle' instead of ':{datatype}'"
                ),
            )
            .at_path(path.to_owned())
            .with_span(span),
        );
    }
    if !is_reserved_datatype(datatype)
        && mode == BehaviorMode::Strict
        && matches!(value, CompactDatatypeValue::Toggle)
    {
        return Some(
            Diagnostic::new(
                "CUSTOM_TOGGLE_ALIAS_NOT_ALLOWED",
                format!(
                    "Custom toggle alias not allowed at '{path}': use ':toggle' instead of ':{datatype}'"
                ),
            )
            .at_path(path.to_owned())
            .with_span(span),
        );
    }
    if !datatype_matches_compact_value(datatype, value) {
        return Some(
            Diagnostic::new(
                "DATATYPE_LITERAL_MISMATCH",
                datatype_mismatch_message(path, datatype, value.value_kind()),
            )
            .at_path(path.to_owned())
            .with_span(span),
        );
    }
    None
}

fn datatype_matches_value(datatype: &str, value: &Value) -> bool {
    datatype_matches_compact_value(datatype, &CompactDatatypeValue::from_value(value))
}

fn datatype_matches_compact_value(datatype: &str, value: &CompactDatatypeValue) -> bool {
    match datatype_base(datatype) {
        "number" | "n" | "int" | "int8" | "int16" | "int32" | "int64" | "uint" | "uint8"
        | "uint16" | "uint32" | "uint64" | "float" | "float32" | "float64" => {
            matches!(value, CompactDatatypeValue::Number)
        }
        "infinity" => matches!(value, CompactDatatypeValue::Infinity),
        "nan" => matches!(value, CompactDatatypeValue::NaN),
        "string" => matches!(value, CompactDatatypeValue::String),
        "trimtick" | "prose" => matches!(value, CompactDatatypeValue::TrimtickString),
        "boolean" | "bool" => matches!(value, CompactDatatypeValue::Boolean),
        "toggle" => matches!(value, CompactDatatypeValue::Toggle),
        "hex" => matches!(value, CompactDatatypeValue::Hex(true)),
        "radix" | "decimal" | "radix2" | "radix6" | "radix8" | "radix12" | "radix16" => {
            matches!(value, CompactDatatypeValue::Radix(true))
        }
        "base64" => matches!(
            value,
            CompactDatatypeValue::Encoding {
                base64_valid: true,
                ..
            }
        ),
        "encoding" | "inline" | "embed" => matches!(
            value,
            CompactDatatypeValue::Encoding {
                literal_valid: true,
                ..
            }
        ),
        "date" => matches!(value, CompactDatatypeValue::Date),
        "time" => matches!(value, CompactDatatypeValue::Time),
        "datetime" => matches!(value, CompactDatatypeValue::DateTime),
        "wtc" => matches!(value, CompactDatatypeValue::WtcDateTime),
        "sep" | "kadot" => matches!(value, CompactDatatypeValue::Separator),
        "symbol" => matches!(value, CompactDatatypeValue::Symbolic),
        "tuple" | "triple" => matches!(value, CompactDatatypeValue::Tuple),
        "list" => matches!(value, CompactDatatypeValue::List),
        "object" | "obj" | "envelope" | "o" => matches!(value, CompactDatatypeValue::Object),
        "node" => matches!(value, CompactDatatypeValue::Node),
        "sansa" => matches!(value, CompactDatatypeValue::Sansa),
        "null" => matches!(value, CompactDatatypeValue::Null),
        _ => true,
    }
}

fn datatype_bracket_specs(datatype: &str) -> Vec<&str> {
    let mut specs = Vec::new();
    let mut angle_depth = 0usize;
    let mut bracket_depth = 0usize;
    let mut bracket_start = None;

    for (index, ch) in datatype.char_indices() {
        match ch {
            '[' if angle_depth == 0 => {
                bracket_depth += 1;
                if bracket_depth == 1 {
                    bracket_start = Some(index + ch.len_utf8());
                }
            }
            ']' if angle_depth == 0 && bracket_depth > 0 => {
                bracket_depth -= 1;
                if bracket_depth == 0
                    && let Some(start) = bracket_start.take()
                {
                    specs.push(&datatype[start..index]);
                }
            }
            '<' if bracket_depth == 0 => angle_depth += 1,
            '>' if bracket_depth == 0 => angle_depth = angle_depth.saturating_sub(1),
            _ if bracket_depth > 0 => {}
            _ => {}
        }
    }
    specs
}

#[cfg(test)]
#[allow(clippy::items_after_test_module)]
mod tests {
    use super::*;

    thread_local! {
        pub(super) static ENCODING_CLASSIFICATIONS: std::cell::Cell<usize> =
            const { std::cell::Cell::new(0) };
        pub(super) static AUTHORED_SEQUENCE_READS: std::cell::Cell<usize> =
            const { std::cell::Cell::new(0) };
    }

    #[test]
    fn reference_chain_reuses_terminal_values_across_claims() {
        let count = 64;
        let mut values = vec![Value::NumberLiteral { raw: "7".into() }];
        values.extend((0..count).map(|index| Value::PointerReference {
            segments: vec![ReferenceSegment::Index(index)],
            span: Span::zero(),
        }));
        let mut terminal_values = HashMap::new();
        let lookups = std::cell::Cell::new(0);
        for claim in values.iter().rev().take(count) {
            let terminal = resolve_reference_chain(claim, &mut terminal_values, |segments| {
                lookups.set(lookups.get() + 1);
                let [ReferenceSegment::Index(index)] = segments else {
                    return None;
                };
                values.get(*index)
            });
            assert_eq!(terminal, values.first());
        }
        assert_eq!(lookups.get(), count);
    }

    #[test]
    fn typed_attributes_classify_each_shared_encoding_once() {
        use std::fmt::Write as _;

        let payload = "A".repeat(8192);
        let mut source = format!("valid = &{payload}TQ\ninvalid = &{payload}TR\nvia = ~>valid\n");
        for index in 0..64 {
            writeln!(
                source,
                "item{index}@{{encoded:encoding = ~>valid, base:base64 = ~via}} = 1"
            )
            .expect("append claims");
        }
        source.push_str("last@{bad:base64 = ~>invalid} = 1");

        for validation_only in [false, true] {
            ENCODING_CLASSIFICATIONS.with(|count| count.set(0));
            let result = crate::compile(
                &source,
                crate::CompileOptions {
                    shallow_event_values: validation_only,
                    emit_binding_projections: !validation_only,
                    include_header: !validation_only,
                    include_event_annotations: !validation_only,
                    ..crate::CompileOptions::default()
                },
            );
            let [error] = result.errors.as_slice() else {
                panic!("validation_only={validation_only}: {:?}", result.errors);
            };
            assert_eq!(error.code, "DATATYPE_LITERAL_MISMATCH");
            assert_eq!(error.path.as_deref(), Some("$.last.@.bad"));
            assert!(error.message.ends_with("got EncodingLiteral"), "{error:?}");
            assert_eq!(
                ENCODING_CLASSIFICATIONS.with(std::cell::Cell::get),
                2,
                "validation_only={validation_only}"
            );
        }
    }

    #[test]
    fn authored_datatype_targets_reuse_one_index_for_distinct_object_members() {
        let binding = |key: String, value: Value| crate::Binding {
            key,
            is_header: false,
            structural_id: None,
            datatype: None,
            attributes: BTreeMap::new(),
            attribute_order: Vec::new(),
            value,
            span: Span::zero(),
        };
        for width in [64, 128] {
            let members = (0..width)
                .map(|index| {
                    binding(
                        format!("member{index}"),
                        Value::NumberLiteral {
                            raw: index.to_string(),
                        },
                    )
                })
                .collect();
            let roots = [binding(
                "source".into(),
                Value::ObjectNode { bindings: members },
            )];
            let mut targets = AuthoredDatatypeTargets::new(&roots, false);
            assert!(targets.object_members.is_empty());
            for index in (0..width).rev() {
                let target = [
                    ReferenceSegment::Key("source".into()),
                    ReferenceSegment::Key(format!("member{index}")),
                ];
                let expected = Value::NumberLiteral {
                    raw: index.to_string(),
                };
                assert_eq!(targets.lookup(&target), Some(&expected));
                let source = &targets.paths.roots.as_ref().expect("root index is built")["source"];
                let children = source.children.as_ref().expect("children are cached");
                let members = children.members.as_ref().expect("member index is built");
                assert_eq!(members.len(), width);
                assert!(members.values().all(|path| path.children.is_none()));
                assert!(targets.object_members.is_empty());
            }
        }
    }

    #[test]
    fn single_indexed_datatype_lookup_only_caches_the_requested_slot() {
        for width in [64, 2048] {
            let source = format!("source = [{}@{{meta = 7}} = 2]", "1, ".repeat(width - 1));
            let bindings = crate::parse_document(&source, &crate::AeonCompileLimits::default())
                .expect("valid attributed sequence");
            let mut targets = AuthoredDatatypeTargets::new(&bindings, false);
            let segments = [
                ReferenceSegment::Key("source".into()),
                ReferenceSegment::Index(width - 1),
                ReferenceSegment::Attr("meta".into()),
            ];
            for _ in 0..2 {
                assert_eq!(
                    targets.lookup(&segments),
                    Some(&Value::NumberLiteral { raw: "7".into() })
                );
            }
            let source = &targets.paths.roots.as_ref().expect("root index is built")["source"];
            let children = source.children.as_ref().expect("requested child is cached");
            assert_eq!(children.items.len(), 1);
            assert!(children.items.contains_key(&(width - 1)));
            assert!(children.members.is_none());
            assert!(children.sequences.is_none());
        }
    }

    #[test]
    fn header_visibility_reuses_dense_coverage_across_duplicate_body_sequences() {
        let mut bindings = crate::parse_document(
            r#"aeon:x = [0]
"aeon:x" = [1, 2, 3, 4]"#,
            &crate::AeonCompileLimits::default(),
        )
        .expect("header and body may overlap");
        let mut shorter = bindings[1].clone();
        shorter.value = Value::TupleLiteral {
            items: vec![Value::NumberLiteral { raw: "1".into() }],
        };
        bindings.extend(std::iter::repeat_n(shorter, 128));

        let root = CanonicalPath::root().member("aeon:x");
        let mut paths = AuthoredPayloadPaths::for_header_collisions(&bindings);
        for index in 0..2048 {
            let slot = root.index(index);
            assert_eq!(paths.body_shadows_header(&slot), index < 4, "{index}");
            if index >= 4 {
                assert!(!paths.body_shadows_header(&slot.member("child")), "{index}");
            }
        }
        let owner = &paths.roots.as_ref().expect("root index is built")["aeon:x"];
        let children = owner.children.as_ref().expect("coverage is cached");
        assert_eq!(children.body_sequence_len, Some(4));
        assert!(children.items.is_empty());
    }

    #[test]
    fn header_visibility_does_not_rescan_short_occurrences_for_covered_descendants() {
        let width = 128;
        let source = format!(
            "aeon:x = [0]\n\"aeon:x\" = [{}{{leaf = 1}}]\n",
            "{leaf = 1}, ".repeat(width - 1)
        );
        let mut bindings = crate::parse_document(&source, &crate::AeonCompileLimits::default())
            .expect("header and body may overlap");
        let mut shorter = bindings[1].clone();
        shorter.value = Value::TupleLiteral {
            items: vec![Value::NumberLiteral { raw: "1".into() }],
        };
        bindings.extend(std::iter::repeat_n(shorter, width));
        let mut scalar = bindings[1].clone();
        scalar.value = Value::NumberLiteral { raw: "2".into() };
        bindings.extend(std::iter::repeat_n(scalar, width));

        let root = CanonicalPath::root().member("aeon:x");
        let mut paths = AuthoredPayloadPaths::for_header_collisions(&bindings);
        AUTHORED_SEQUENCE_READS.with(|count| count.set(0));
        for index in (0..width).rev() {
            let slot = root.index(index);
            assert!(paths.body_shadows_header(&slot.member("leaf")), "{index}");
        }
        assert_eq!(
            AUTHORED_SEQUENCE_READS.with(std::cell::Cell::get),
            2 * (bindings.len() - 1)
        );
    }

    #[test]
    fn sparse_sequence_traversal_yields_covering_occurrences_in_authored_order() {
        let widths = [2, 3, 0, 2, 5, 1, 4, 3, 0, 4, 5];
        let values: Vec<_> = widths
            .iter()
            .enumerate()
            .map(|(ordinal, &width)| Value::ListNode {
                items: vec![
                    Value::NumberLiteral {
                        raw: ordinal.to_string()
                    };
                    width
                ],
            })
            .collect();
        let sequences = AuthoredSequenceIndex::new(values.iter().map(|value| AuthoredPayload {
            value,
            annotations: None,
            is_header: false,
        }));
        for slot in 0..=5 {
            let actual: Vec<_> = sequences.items_at(slot).map(|item| item.value).collect();
            let expected: Vec<_> = values
                .iter()
                .filter_map(|value| {
                    let Value::ListNode { items } = value else {
                        unreachable!("test constructs only lists");
                    };
                    items.get(slot)
                })
                .collect();
            assert_eq!(actual, expected, "slot {slot}");
        }
    }

    #[test]
    fn indexed_collisions_keep_authored_order_and_unique_descendants() {
        let limits = crate::AeonCompileLimits::default();
        let mut bindings =
            crate::parse_document("source = [@{meta = 1} = 0]", &limits).expect("short source");
        bindings.extend(
            crate::parse_document("source = [@{meta = 2} = 0, @{meta = 3} = 0]", &limits)
                .expect("long source"),
        );

        for (recovery, shared) in [(true, "1"), (false, "2")] {
            let mut targets = AuthoredDatatypeTargets::new(&bindings, recovery);
            for (index, expected) in [(1, "3"), (0, shared)] {
                let target = [
                    ReferenceSegment::Key("source".into()),
                    ReferenceSegment::Index(index),
                    ReferenceSegment::Attr("meta".into()),
                ];
                assert_eq!(
                    targets.lookup(&target),
                    Some(&Value::NumberLiteral {
                        raw: expected.into()
                    })
                );
            }
        }
    }

    #[test]
    fn bracket_spec_helpers_ignore_brackets_inside_generics() {
        assert_eq!(datatype_bracket_specs("outer<inner[.]>[x]"), vec!["x"]);
        assert_eq!(datatype_bracket_specs("outer<inner[.]>[22]"), vec!["22"]);
        assert_eq!(datatype_bracket_specs("sep[<]"), vec!["<"]);
        assert_eq!(datatype_bracket_specs("sep[>]"), vec![">"]);
        assert_eq!(separator_spec_depth("outer<inner[.]>[x]"), 1);
        assert_eq!(separator_spec_depth("outer<inner[.]>[22]"), 1);
    }
}

fn has_valid_literal_underscores(raw: &str) -> bool {
    let body = &raw[1..];
    if body.is_empty() || body.starts_with('_') || body.ends_with('_') {
        return false;
    }
    let mut prev_underscore = false;
    for ch in body.chars() {
        if ch == '_' {
            if prev_underscore {
                return false;
            }
            prev_underscore = true;
        } else {
            prev_underscore = false;
        }
    }
    true
}

fn is_radix_digit(ch: char) -> bool {
    ch.is_ascii_alphanumeric() || matches!(ch, '&' | '!')
}

fn has_valid_radix_literal(raw: &str) -> bool {
    let body = &raw[1..];
    if body.is_empty() {
        return false;
    }
    let chars: Vec<char> = body.chars().collect();
    let mut index = if matches!(chars.first(), Some('+' | '-')) {
        1
    } else {
        0
    };
    if index >= chars.len() {
        return false;
    }
    let mut saw_digit = false;
    let mut saw_decimal = false;
    let mut prev_was_digit = false;
    let mut saw_digit_before_decimal = false;
    while index < chars.len() {
        let ch = chars[index];
        if is_radix_digit(ch) {
            saw_digit = true;
            prev_was_digit = true;
            if !saw_decimal {
                saw_digit_before_decimal = true;
            }
        } else if ch == '_' {
            if !prev_was_digit || index + 1 >= chars.len() || !is_radix_digit(chars[index + 1]) {
                return false;
            }
            prev_was_digit = false;
        } else if ch == '.' {
            if saw_decimal || index + 1 >= chars.len() || !is_radix_digit(chars[index + 1]) {
                return false;
            }
            if !prev_was_digit && saw_digit_before_decimal {
                return false;
            }
            saw_decimal = true;
            prev_was_digit = false;
        } else {
            return false;
        }
        index += 1;
    }
    saw_digit && prev_was_digit
}

fn has_valid_encoding_literal(raw: &str) -> bool {
    if !raw.starts_with('&') {
        return false;
    }
    let body = &raw[1..];
    if body.is_empty() {
        return false;
    }
    if !body
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '=' | '-' | '_'))
    {
        return false;
    }
    match body.find('=') {
        None => true,
        Some(index) => body.len() - index <= 2 && body[index..].chars().all(|ch| ch == '='),
    }
}

fn has_valid_base64url_literal(raw: &str) -> bool {
    let Some(body) = raw.strip_prefix('&') else {
        return false;
    };
    let unpadded = body.trim_end_matches('=');
    let padding = body.len() - unpadded.len();
    if padding > 2
        || unpadded.is_empty()
        || !unpadded
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return false;
    }
    let remainder = unpadded.len() % 4;
    if remainder == 1
        || (padding != 0 && (unpadded.len() + padding) % 4 != 0)
        || (padding == 1 && remainder != 3)
        || (padding == 2 && remainder != 2)
    {
        return false;
    }
    let Some(last) = unpadded.bytes().last().and_then(base64url_sextet) else {
        return false;
    };
    match remainder {
        2 => last & 0x0f == 0,
        3 => last & 0x03 == 0,
        _ => true,
    }
}

fn base64url_sextet(byte: u8) -> Option<u8> {
    match byte {
        b'A'..=b'Z' => Some(byte - b'A'),
        b'a'..=b'z' => Some(byte - b'a' + 26),
        b'0'..=b'9' => Some(byte - b'0' + 52),
        b'-' => Some(62),
        b'_' => Some(63),
        _ => None,
    }
}

#[derive(Debug)]
pub(crate) enum AttributeDatatypeCheck {
    Error(Diagnostic),
    Reference {
        path: String,
        datatype: String,
        value: Value,
        profile_custom: bool,
    },
}

impl AttributeDatatypeCheck {
    pub(crate) fn profile_custom_value(
        profile: DatatypeProfile<'_>,
        datatype: &str,
        value: &Value,
        path: &str,
    ) -> Option<Self> {
        if !profile.checks_custom_kind(datatype) {
            return None;
        }
        let mut value = value;
        while let Value::TypedValue { value: inner, .. } = value {
            value = inner;
        }
        if matches!(
            value,
            Value::CloneReference { .. } | Value::PointerReference { .. }
        ) {
            return Some(Self::Reference {
                path: path.to_owned(),
                datatype: datatype.to_owned(),
                value: value.clone(),
                profile_custom: true,
            });
        }
        profile
            .custom_value_error(datatype, value.value_kind(), path)
            .map(Self::Error)
    }

    pub(crate) fn diagnostic<'a>(
        &'a self,
        profile: Option<DatatypeProfile<'_>>,
        resolve: impl FnOnce(&'a Value) -> CompactDatatypeValue,
    ) -> Option<Diagnostic> {
        match self {
            Self::Error(error) => Some(error.clone()),
            Self::Reference {
                path,
                datatype,
                value,
                profile_custom,
            } => {
                if *profile_custom {
                    return profile.and_then(|profile| {
                        profile.custom_value_error(datatype, resolve(value).value_kind(), path)
                    });
                }
                let resolved = resolve(value);
                (!datatype_matches_compact_value(datatype, &resolved)).then(|| {
                    Diagnostic::new(
                        "DATATYPE_LITERAL_MISMATCH",
                        datatype_mismatch_message(path, datatype, resolved.value_kind()),
                    )
                    .at_path(path)
                })
            }
        }
    }
}

#[derive(Clone, Copy)]
struct AuthoredPayload<'a> {
    value: &'a Value,
    annotations: Option<&'a BTreeMap<String, AttributeValue>>,
    is_header: bool,
}

impl<'a> AuthoredPayload<'a> {
    fn binding(binding: &'a Binding, parent_is_header: bool) -> Self {
        Self {
            value: &binding.value,
            annotations: Some(&binding.attributes),
            is_header: parent_is_header || binding.is_header,
        }
    }

    fn payload(self) -> &'a Value {
        let mut value = self.value;
        while let Value::TypedValue { value: inner, .. } = value {
            value = inner;
        }
        value
    }

    fn sequence(self) -> Option<&'a [Value]> {
        #[cfg(test)]
        tests::AUTHORED_SEQUENCE_READS.with(|count| count.set(count.get() + 1));
        match self.payload() {
            Value::ListNode { items } | Value::TupleLiteral { items } => Some(items),
            Value::NodeLiteral { children, .. } => Some(children),
            _ => None,
        }
    }

    fn item(self, index: usize) -> Option<Self> {
        Some(Self {
            value: self.sequence()?.get(index)?,
            annotations: None,
            is_header: self.is_header,
        })
    }
}

// Colliding payloads contribute descendants independently. Select the visible
// occurrence only at the exact owner path, before looking at its attributes.
struct AuthoredPayloadPath<'a> {
    first: AuthoredPayload<'a>,
    later: Vec<AuthoredPayload<'a>>,
    selected: usize,
    children: Option<Box<AuthoredPayloadChildren<'a>>>,
}

struct AuthoredSequence<'a> {
    items: &'a [Value],
    is_header: bool,
    left: Option<usize>,
    right: Option<usize>,
}

impl<'a> AuthoredSequence<'a> {
    fn item(&self, index: usize) -> AuthoredPayload<'a> {
        AuthoredPayload {
            value: &self.items[index],
            annotations: None,
            is_header: self.is_header,
        }
    }
}

// This Cartesian tree preserves authored order in an in-order traversal.
// The longest sequence is at the root of each subtree, so a short root
// rules out every sequence below it for the requested index.
struct AuthoredSequenceIndex<'a> {
    sequences: Vec<AuthoredSequence<'a>>,
    root: Option<usize>,
}

impl<'a> AuthoredSequenceIndex<'a> {
    fn new(owners: impl Iterator<Item = AuthoredPayload<'a>>) -> Self {
        let mut sequences: Vec<AuthoredSequence<'a>> = Vec::new();
        let mut right_branch: Vec<usize> = Vec::new();
        for owner in owners {
            let Some(items) = owner.sequence().filter(|items| !items.is_empty()) else {
                continue;
            };
            let index = sequences.len();
            let mut left = None;
            while let Some(&parent) = right_branch.last()
                && sequences[parent].items.len() < items.len()
            {
                left = right_branch.pop();
            }
            if let Some(&parent) = right_branch.last() {
                sequences[parent].right = Some(index);
            }
            sequences.push(AuthoredSequence {
                items,
                is_header: owner.is_header,
                left,
                right: None,
            });
            right_branch.push(index);
        }
        Self {
            sequences,
            root: right_branch.first().copied(),
        }
    }

    fn items_at(&self, index: usize) -> impl Iterator<Item = AuthoredPayload<'a>> + '_ {
        let covers = move |branch: Option<usize>| {
            branch.filter(|&sequence| index < self.sequences[sequence].items.len())
        };
        let mut next = covers(self.root);
        let mut parents = Vec::new();
        std::iter::from_fn(move || {
            while let Some(current) = next {
                let sequence = &self.sequences[current];
                next = covers(sequence.left);
                if next.is_some() {
                    parents.push(current);
                    continue;
                }
                next = covers(sequence.right);
                return Some(sequence.item(index));
            }
            let sequence = &self.sequences[parents.pop()?];
            next = covers(sequence.right);
            Some(sequence.item(index))
        })
    }
}

#[derive(Default)]
struct AuthoredPayloadChildren<'a> {
    members: Option<HashMap<&'a str, AuthoredPayloadPath<'a>>>,
    items: HashMap<usize, AuthoredPayloadPath<'a>>,
    sequences: Option<AuthoredSequenceIndex<'a>>,
    body_sequence_len: Option<usize>,
}

impl<'a> AuthoredPayloadPath<'a> {
    fn new(payload: AuthoredPayload<'a>) -> Self {
        Self {
            first: payload,
            later: Vec::new(),
            selected: 0,
            children: None,
        }
    }

    fn selected(&self) -> AuthoredPayload<'a> {
        if self.selected == 0 {
            self.first
        } else {
            self.later[self.selected - 1]
        }
    }

    fn add(&mut self, payload: AuthoredPayload<'a>, recovery: bool) {
        // Body payloads shadow header payloads at this path. Within each
        // plane, recovery keeps the first occurrence, like event filtering.
        let selected_is_header = self.selected().is_header;
        if (selected_is_header && !payload.is_header)
            || (!recovery && selected_is_header == payload.is_header)
        {
            self.selected = self.later.len() + 1;
        }
        self.later.push(payload);
    }

    fn member(&mut self, key: &str, recovery: bool) -> Option<&mut Self> {
        let children = self.children.get_or_insert_with(Box::default);
        let members = children.members.get_or_insert_with(|| {
            let mut members = HashMap::<_, Self>::new();
            for owner in std::iter::once(self.first).chain(self.later.iter().copied()) {
                if let Value::ObjectNode { bindings } = owner.payload() {
                    for binding in bindings {
                        let child = AuthoredPayload::binding(binding, owner.is_header);
                        members
                            .entry(binding.key.as_str())
                            .and_modify(|path| path.add(child, recovery))
                            .or_insert_with(|| Self::new(child));
                    }
                }
            }
            members
        });
        members.get_mut(key)
    }

    fn body_sequence_covers(&mut self, index: usize) -> bool {
        let children = self.children.get_or_insert_with(Box::default);
        // Sequences have dense indexes. Their union is the longest body's
        // prefix, even when shorter or scalar occurrences share the path.
        let length = children.body_sequence_len.get_or_insert_with(|| {
            std::iter::once(self.first)
                .chain(self.later.iter().copied())
                .filter(|payload| !payload.is_header)
                .filter_map(AuthoredPayload::sequence)
                .map(<[Value]>::len)
                .max()
                .unwrap_or(0)
        });
        index < *length
    }

    fn item(&mut self, index: usize, recovery: bool) -> Option<&mut Self> {
        use std::collections::hash_map::Entry;
        let children = self.children.get_or_insert_with(Box::default);
        match children.items.entry(index) {
            Entry::Occupied(entry) => Some(entry.into_mut()),
            Entry::Vacant(entry) => {
                if self.later.is_empty() {
                    return Some(entry.insert(Self::new(self.first.item(index)?)));
                }
                let sequences = children.sequences.get_or_insert_with(|| {
                    AuthoredSequenceIndex::new(
                        std::iter::once(self.first).chain(self.later.iter().copied()),
                    )
                });
                let mut items = sequences.items_at(index);
                let mut path = Self::new(items.next()?);
                for item in items {
                    path.add(item, recovery);
                }
                Some(entry.insert(path))
            }
        }
    }
}

pub(crate) struct AuthoredPayloadPaths<'a> {
    bindings: &'a [Binding],
    recovery: bool,
    roots: Option<HashMap<&'a str, AuthoredPayloadPath<'a>>>,
}

impl<'a> AuthoredPayloadPaths<'a> {
    pub(crate) fn new(bindings: &'a [Binding], recovery: bool) -> Self {
        Self {
            bindings,
            recovery,
            roots: None,
        }
    }

    fn root(&mut self, key: &str) -> Option<&mut AuthoredPayloadPath<'a>> {
        let roots = self
            .roots
            .get_or_insert_with(|| index_authored_roots(self.bindings.iter(), self.recovery));
        roots.get_mut(key)
    }

    pub(crate) fn for_header_collisions(bindings: &'a [Binding]) -> Self {
        let headers: HashSet<_> = bindings
            .iter()
            .filter(|binding| binding.is_header)
            .map(|binding| binding.key.as_str())
            .collect();
        let roots = index_authored_roots(
            bindings
                .iter()
                .filter(|binding| !binding.is_header && headers.contains(binding.key.as_str())),
            false,
        );
        Self {
            bindings,
            recovery: false,
            roots: Some(roots),
        }
    }

    pub(crate) fn body_shadows_header(&mut self, path: &CanonicalPath) -> bool {
        let [PathSegment::Root, PathSegment::Member(root), rest @ ..] = &path.segments[..] else {
            return false;
        };
        let recovery = self.recovery;
        let Some(mut owner) = self.root(root) else {
            return false;
        };
        let (last_index, ancestors) = match rest.split_last() {
            Some((PathSegment::Index(index), ancestors)) => (Some(*index), ancestors),
            _ => (None, rest),
        };
        for segment in ancestors {
            let child = match segment {
                PathSegment::Member(key) => owner.member(key, recovery),
                PathSegment::Index(index) if owner.body_sequence_covers(*index) => {
                    owner.item(*index, recovery)
                }
                PathSegment::Index(_) => None,
                PathSegment::Root => return false,
            };
            let Some(child) = child else {
                return false;
            };
            owner = child;
        }
        match last_index {
            // The flattening walk visits every slot. Reuse the coverage
            // without creating an individual path entry for each visit.
            Some(index) => owner.body_sequence_covers(index),
            None => !owner.selected().is_header,
        }
    }
}

fn index_authored_roots<'a>(
    bindings: impl Iterator<Item = &'a Binding>,
    recovery: bool,
) -> HashMap<&'a str, AuthoredPayloadPath<'a>> {
    let mut roots = HashMap::<_, AuthoredPayloadPath<'_>>::new();
    for binding in bindings {
        let payload = AuthoredPayload::binding(binding, false);
        roots
            .entry(binding.key.as_str())
            .and_modify(|path| path.add(payload, recovery))
            .or_insert_with(|| AuthoredPayloadPath::new(payload));
    }
    roots
}

struct AuthoredDatatypeTargets<'a> {
    paths: AuthoredPayloadPaths<'a>,
    object_members: HashMap<*const Binding, HashMap<&'a str, &'a Binding>>,
}

impl<'a> AuthoredDatatypeTargets<'a> {
    fn new(bindings: &'a [Binding], recovery: bool) -> Self {
        Self {
            paths: AuthoredPayloadPaths::new(bindings, recovery),
            object_members: HashMap::new(),
        }
    }

    fn lookup(&mut self, segments: &[ReferenceSegment]) -> Option<&'a Value> {
        let [ReferenceSegment::Key(root), remainder @ ..] = segments else {
            return None;
        };
        let recovery = self.paths.recovery;
        let mut owner = self.paths.root(root)?;
        let owner_length = remainder
            .iter()
            .position(|segment| matches!(segment, ReferenceSegment::Attr(_)))
            .unwrap_or(remainder.len());
        for segment in &remainder[..owner_length] {
            owner = match segment {
                ReferenceSegment::Key(key) => owner.member(key, recovery),
                ReferenceSegment::Index(index) => owner.item(*index, recovery),
                ReferenceSegment::Attr(_) => {
                    unreachable!("owner path precedes the first attribute")
                }
            }?;
        }
        let owner = owner.selected();
        let object_members = &mut self.object_members;
        let target = resolve_reference_remainder_target(
            owner.value,
            owner.annotations,
            &remainder[owner_length..],
            &mut |bindings, key| {
                let members = object_members.entry(bindings.as_ptr()).or_insert_with(|| {
                    let mut members = HashMap::with_capacity(bindings.len());
                    for binding in bindings {
                        // Keep the first match, including in recovery with duplicate keys.
                        members.entry(binding.key.as_str()).or_insert(binding);
                    }
                    members
                });
                members.get(key).copied()
            },
        )?;
        Some(target.datatype_value())
    }
}

fn validate_resolved_attribute_datatypes(
    authored_targets: &mut AuthoredDatatypeTargets<'_>,
    mode: BehaviorMode,
    datatype_policy: DatatypePolicy,
    max_separator_depth: usize,
    max_generic_depth: usize,
    datatype_profile: Option<DatatypeProfile<'_>>,
    errors: &mut Vec<Diagnostic>,
) {
    let mut checks = Vec::new();
    collect_attribute_datatype_checks(
        authored_targets.paths.bindings,
        mode,
        Some(datatype_policy),
        max_separator_depth,
        max_generic_depth,
        &mut checks,
    );
    if let Some(profile) = datatype_profile
        && datatype_policy == DatatypePolicy::AllowCustom
    {
        crate::gp_attributes::collect_profile_attribute_value_checks(
            profile,
            authored_targets.paths.bindings,
            &mut checks,
        );
    }
    let mut references = DatatypeReferenceCache::default();
    for check in &checks {
        errors.extend(check.diagnostic(datatype_profile, |value| {
            references.resolve(value, |segments| authored_targets.lookup(segments))
        }));
    }
}

#[derive(Clone, Copy)]
enum AttributeValueScope {
    Projected,
    Metadata,
    NodePayload(Span),
}

fn check_metadata_payload_type(
    datatype: &str,
    value: &Value,
    path: &str,
    span: Span,
    mode: BehaviorMode,
    datatype_policy: DatatypePolicy,
    max_separator_depth: usize,
    max_generic_depth: usize,
) -> Option<AttributeDatatypeCheck> {
    if let Some(error) =
        invalid_inline_node_datatype(value, datatype, path, span, mode).or_else(|| {
            validate_datatype_shape_light(datatype, value, max_separator_depth, max_generic_depth)
                .map(|error| error.at_path(path).with_span(span))
        })
    {
        return Some(AttributeDatatypeCheck::Error(error));
    }
    if is_reserved_datatype(datatype)
        && matches!(
            value,
            Value::CloneReference { .. } | Value::PointerReference { .. }
        )
    {
        return Some(AttributeDatatypeCheck::Reference {
            path: path.to_owned(),
            datatype: datatype.to_owned(),
            value: value.clone(),
            profile_custom: false,
        });
    }
    datatype_value_error(
        datatype,
        &CompactDatatypeValue::from_value(value),
        path,
        span,
        mode,
        datatype_policy,
    )
    .map(AttributeDatatypeCheck::Error)
}

fn validate_attribute_datatypes_in_scope(
    bindings: &[Binding],
    parent: &str,
    scope: AttributeValueScope,
    mode: BehaviorMode,
    datatype_policy: DatatypePolicy,
    max_separator_depth: usize,
    max_generic_depth: usize,
    checks: &mut Vec<AttributeDatatypeCheck>,
) {
    for binding in bindings {
        let path = render_child_member_path(parent, &binding.key);
        if matches!(scope, AttributeValueScope::NodePayload(_))
            && !matches!(binding.value, Value::NodeLiteral { .. })
        {
            if let Some(datatype) = binding.datatype.as_deref() {
                checks.extend(check_metadata_payload_type(
                    datatype,
                    &binding.value,
                    &path,
                    binding.span,
                    mode,
                    datatype_policy,
                    max_separator_depth,
                    max_generic_depth,
                ));
            } else if matches!(mode, BehaviorMode::Strict | BehaviorMode::Custom) {
                checks.push(AttributeDatatypeCheck::Error(
                    Diagnostic::new(
                        "UNTYPED_VALUE_IN_STRICT_MODE",
                        format!("Untyped value in typed mode: '{path}' requires explicit type annotation"),
                    ).at_path(&path).with_span(binding.span),
                ));
            }
        }
        validate_attribute_datatype_map(
            &binding.attributes,
            &binding.attribute_order,
            format_args!("{path}.@"),
            mode,
            datatype_policy,
            max_separator_depth,
            max_generic_depth,
            checks,
        );
        validate_value_attribute_datatypes(
            &binding.value,
            &path,
            scope,
            mode,
            datatype_policy,
            max_separator_depth,
            max_generic_depth,
            checks,
        );
    }
}

fn validate_value_attribute_datatypes(
    value: &Value,
    path: &str,
    scope: AttributeValueScope,
    mode: BehaviorMode,
    datatype_policy: DatatypePolicy,
    max_separator_depth: usize,
    max_generic_depth: usize,
    checks: &mut Vec<AttributeDatatypeCheck>,
) {
    match value {
        Value::ObjectNode { bindings } => validate_attribute_datatypes_in_scope(
            bindings,
            path,
            scope,
            mode,
            datatype_policy,
            max_separator_depth,
            max_generic_depth,
            checks,
        ),
        Value::ListNode { items } | Value::TupleLiteral { items } => {
            for (index, item) in items.iter().enumerate() {
                validate_value_attribute_datatypes(
                    item,
                    &render_child_index_path(path, index),
                    scope,
                    mode,
                    datatype_policy,
                    max_separator_depth,
                    max_generic_depth,
                    checks,
                );
            }
        }
        Value::NodeLiteral {
            attributes,
            attribute_order,
            children,
            datatype,
            span,
            ..
        } => {
            let child_scope = if matches!(scope, AttributeValueScope::Projected) {
                scope
            } else {
                if let Some(datatype) = datatype {
                    checks.extend(check_metadata_payload_type(
                        datatype,
                        value,
                        path,
                        *span,
                        mode,
                        datatype_policy,
                        max_separator_depth,
                        max_generic_depth,
                    ));
                }
                AttributeValueScope::NodePayload(*span)
            };
            for (index, attribute) in attributes.iter().enumerate() {
                let order = if index == 0 {
                    attribute_order.as_slice()
                } else {
                    &[]
                };
                validate_attribute_datatype_map(
                    attribute,
                    order,
                    format_args!("{path}.@"),
                    mode,
                    datatype_policy,
                    max_separator_depth,
                    max_generic_depth,
                    checks,
                );
            }
            for (index, child) in children.iter().enumerate() {
                validate_value_attribute_datatypes(
                    child,
                    &render_child_index_path(path, index),
                    child_scope,
                    mode,
                    datatype_policy,
                    max_separator_depth,
                    max_generic_depth,
                    checks,
                );
            }
        }
        Value::TypedValue {
            datatype,
            attributes,
            attribute_order,
            value,
            ..
        } => {
            let AttributeValueScope::NodePayload(span) = scope else {
                return;
            };
            if let Some(datatype) = datatype {
                checks.extend(check_metadata_payload_type(
                    datatype,
                    value,
                    path,
                    span,
                    mode,
                    datatype_policy,
                    max_separator_depth,
                    max_generic_depth,
                ));
            }
            validate_attribute_datatype_map(
                attributes,
                attribute_order,
                format_args!("{path}.@"),
                mode,
                datatype_policy,
                max_separator_depth,
                max_generic_depth,
                checks,
            );
            validate_value_attribute_datatypes(
                value,
                path,
                scope,
                mode,
                datatype_policy,
                max_separator_depth,
                max_generic_depth,
                checks,
            );
        }
        _ => {}
    }
}

fn validate_attribute_datatype_map(
    attributes: &BTreeMap<String, AttributeValue>,
    attribute_order: &[String],
    parent_path: std::fmt::Arguments<'_>,
    mode: BehaviorMode,
    datatype_policy: DatatypePolicy,
    max_separator_depth: usize,
    max_generic_depth: usize,
    checks: &mut Vec<AttributeDatatypeCheck>,
) {
    if attribute_order.is_empty() {
        return;
    }
    let parent_path = parent_path.to_string();
    for key in attribute_order {
        let Some(entry) = attributes.get(key) else {
            continue;
        };
        let attr_path = render_child_member_path(&parent_path, key);
        if entry.datatype.is_none()
            && matches!(mode, BehaviorMode::Strict | BehaviorMode::Custom)
            && let Some(value) = &entry.value
            && !matches!(value, Value::NodeLiteral { .. })
        {
            if matches!(mode, BehaviorMode::Strict) && matches!(value, Value::ToggleLiteral { .. })
            {
                checks.push(AttributeDatatypeCheck::Error(
                    Diagnostic::new(
                        "UNTYPED_TOGGLE_LITERAL",
                        format!(
                            "Untyped toggle literal in typed mode: '{}' requires ':toggle' type annotation",
                            attr_path
                        ),
                    )
                    .at_path(attr_path.clone()),
                ));
            } else {
                checks.push(AttributeDatatypeCheck::Error(
                    Diagnostic::new(
                        "UNTYPED_VALUE_IN_STRICT_MODE",
                        format!(
                            "Untyped value in typed mode: '{}' requires explicit type annotation",
                            attr_path
                        ),
                    )
                    .at_path(attr_path.clone()),
                ));
            }
        } else if let Some(datatype) = &entry.datatype {
            let datatype_path = attr_path.as_str();
            let locate = |error: Diagnostic, path: &str| {
                let error = error.at_path(path);
                match entry.span {
                    Some(span) => error.with_span(span),
                    None => error,
                }
            };
            let value = entry.datatype_value();
            if let Some(error) = validate_datatype_shape_light(
                datatype,
                value,
                max_separator_depth,
                max_generic_depth,
            ) {
                let path_override = match error.code.as_str() {
                    "INVALID_NUMBER"
                    | "INVALID_SEPARATOR_CHAR"
                    | "CLARIFIER_VALUES_EXCEEDED"
                    | "GENERIC_DEPTH_EXCEEDED" => "$",
                    _ => datatype_path,
                };
                checks.push(AttributeDatatypeCheck::Error(locate(error, path_override)));
                continue;
            }
            if !is_reserved_datatype(datatype) {
                if datatype_policy == DatatypePolicy::ReservedOnly {
                    checks.push(AttributeDatatypeCheck::Error(locate(
                        Diagnostic::new(
                            "CUSTOM_DATATYPE_NOT_ALLOWED",
                            format!(
                                "Custom datatype not allowed in typed mode at '{}': ':{datatype}' requires --datatype-policy allow_custom",
                                datatype_path
                            ),
                        ),
                        datatype_path,
                    )));
                }
            } else if matches!(
                value,
                Value::CloneReference { .. } | Value::PointerReference { .. }
            ) {
                checks.push(AttributeDatatypeCheck::Reference {
                    path: attr_path.clone(),
                    datatype: datatype.clone(),
                    value: value.clone(),
                    profile_custom: false,
                });
            } else if !datatype_matches_value(datatype, value) {
                checks.push(AttributeDatatypeCheck::Error(locate(
                    Diagnostic::new(
                        "DATATYPE_LITERAL_MISMATCH",
                        datatype_mismatch_message(datatype_path, datatype, value.value_kind()),
                    ),
                    datatype_path,
                )));
            }
        }
        validate_attribute_datatype_map(
            &entry.nested_attrs,
            &entry.nested_attr_order,
            format_args!("{attr_path}.@"),
            mode,
            datatype_policy,
            max_separator_depth,
            max_generic_depth,
            checks,
        );
        validate_attribute_datatype_map(
            &entry.object_members,
            &entry.object_member_order,
            format_args!("{attr_path}"),
            mode,
            datatype_policy,
            max_separator_depth,
            max_generic_depth,
            checks,
        );
        if let Some(value) = &entry.value {
            validate_value_attribute_datatypes(
                value,
                &attr_path,
                AttributeValueScope::Metadata,
                mode,
                datatype_policy,
                max_separator_depth,
                max_generic_depth,
                checks,
            );
        }
    }
}

fn generic_depth(datatype: &str) -> usize {
    let mut depth = 0usize;
    let mut max_depth = 0usize;
    for ch in datatype.chars() {
        match ch {
            '<' => {
                depth += 1;
                max_depth = max_depth.max(depth);
            }
            '>' => depth = depth.saturating_sub(1),
            _ => {}
        }
    }
    // A single generic application (`list<int>`) is depth 0. Each generic
    // application nested inside another increments the recursion depth.
    max_depth.saturating_sub(1)
}

fn is_valid_number_literal(raw: &str) -> bool {
    if raw.is_empty() {
        return false;
    }

    let body = raw
        .strip_prefix('+')
        .or_else(|| raw.strip_prefix('-'))
        .unwrap_or(raw);
    if body.is_empty() {
        return false;
    }

    let (mantissa, exponent) = match body.split_once(['e', 'E']) {
        Some((mantissa, exponent)) => {
            if mantissa.is_empty() || exponent.is_empty() || exponent.contains(['e', 'E']) {
                return false;
            }
            (mantissa, Some(exponent))
        }
        None => (body, None),
    };

    if let Some(exponent) = exponent {
        let exponent_digits = exponent
            .strip_prefix('+')
            .or_else(|| exponent.strip_prefix('-'))
            .unwrap_or(exponent);
        if !is_valid_exponent_digits(exponent_digits) {
            return false;
        }
    }

    match mantissa.split_once('.') {
        Some((integer, fraction)) => {
            if fraction.is_empty() || fraction.contains('.') {
                return false;
            }
            if !integer.is_empty() && !is_valid_digit_group(integer) {
                return false;
            }
            if !is_valid_digit_group(fraction) {
                return false;
            }
            !has_invalid_leading_zero(integer)
        }
        None => is_valid_digit_group(mantissa) && !has_invalid_leading_zero(mantissa),
    }
}

fn is_valid_digit_group(raw: &str) -> bool {
    if raw.is_empty() {
        return false;
    }

    let mut chars = raw.chars().peekable();
    let mut previous_was_underscore = false;
    let mut saw_digit = false;

    while let Some(ch) = chars.next() {
        match ch {
            '0'..='9' => {
                saw_digit = true;
                previous_was_underscore = false;
            }
            '_' => {
                if previous_was_underscore || !saw_digit {
                    return false;
                }
                if !matches!(chars.peek(), Some(next) if next.is_ascii_digit()) {
                    return false;
                }
                previous_was_underscore = true;
            }
            _ => return false,
        }
    }

    saw_digit && !previous_was_underscore
}

fn is_valid_exponent_digits(raw: &str) -> bool {
    is_valid_digit_group(raw)
}

fn has_invalid_leading_zero(raw: &str) -> bool {
    raw.len() > 1 && raw.starts_with('0')
}
