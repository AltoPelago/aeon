#![allow(clippy::too_many_arguments)]

use std::collections::{BTreeMap, HashSet};

use crate::flatten::{FlattenedDocument, ValidationEvent, ValidationReferenceStep};
use crate::pathing::{format_reference_base, format_reference_target};
use crate::temporal::invalid_temporal_literal;
use crate::{
    AssignmentEvent, AttributeValue, BehaviorMode, Binding, CanonicalPath, DatatypePolicy,
    Diagnostic, ReferenceSegment, Span, Value, format_path,
};

#[derive(Debug, Clone, Default)]
pub(crate) struct ValidationIndexes {
    pub(crate) event_lookup: BTreeMap<String, usize>,
}

pub(crate) fn build_validation_indexes(flattened: &FlattenedDocument) -> ValidationIndexes {
    let event_lookup = flattened
        .rendered_event_paths
        .iter()
        .enumerate()
        .map(|(index, path)| (path.clone(), index))
        .collect();
    ValidationIndexes { event_lookup }
}

pub(crate) fn build_validation_event_lookup(
    events: &[ValidationEvent],
    errors: &mut Vec<Diagnostic>,
) -> BTreeMap<String, usize> {
    let mut event_lookup = BTreeMap::new();
    let mut duplicate_indexes = Vec::new();
    for (index, event) in events.iter().enumerate() {
        if event_lookup.insert(event.path.clone(), index).is_some() {
            duplicate_indexes.push(index);
        }
    }
    for index in duplicate_indexes {
        let path = &events[index].path;
        errors.push(
            Diagnostic::new(
                "DUPLICATE_KEY",
                format!("Duplicate key: '{}'", key_from_path(path)),
            )
            .at_path(path.clone())
            .with_span(events[index].span),
        );
    }
    event_lookup
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
        for (index, (event, path)) in flattened
            .events
            .iter()
            .zip(flattened.rendered_event_paths.iter())
            .enumerate()
        {
            if !seen.insert((event.source_plane, path.as_str())) {
                duplicate_indexes.push(index);
            }
        }
        duplicate_indexes
    };
    if duplicate_indexes.is_empty() {
        return;
    }
    for index in &duplicate_indexes {
        let path = &flattened.rendered_event_paths[*index];
        errors.push(
            Diagnostic::new(
                "DUPLICATE_KEY",
                format!("Duplicate key: '{}'", key_from_path(path)),
            )
            .at_path(path.clone())
            .with_span(flattened.events[*index].span),
        );
    }
    if recovery {
        let mut retained = HashSet::new();
        let mut retained_events = Vec::with_capacity(flattened.events.len());
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
        flattened.events = retained_events;
        flattened.rendered_event_paths = retained_paths;
        let mut retained_bindings = HashSet::new();
        flattened
            .bindings
            .retain(|binding| retained_bindings.insert(binding.path.clone()));
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
        let path = root.member(binding.key.clone());
        found_duplicate |=
            validate_duplicate_object_member_keys_in_value(&binding.value, &path, errors);
    }
    found_duplicate
}

fn validate_duplicate_object_member_keys_in_value(
    value: &Value,
    path: &CanonicalPath,
    errors: &mut Vec<Diagnostic>,
) -> bool {
    let mut found_duplicate = false;
    match value {
        Value::TypedValue { value, .. } => {
            found_duplicate |= validate_duplicate_object_member_keys_in_value(value, path, errors);
        }
        Value::ObjectNode { bindings } => {
            let mut seen = HashSet::new();
            for binding in bindings {
                let member_path = path.member(binding.key.clone());
                if !seen.insert(binding.key.clone()) {
                    found_duplicate = true;
                    errors.push(
                        Diagnostic::new(
                            "DUPLICATE_KEY",
                            format!("Duplicate key: '{}'", binding.key),
                        )
                        .at_path(format_path(&member_path))
                        .with_span(binding.span),
                    );
                }
                found_duplicate |= validate_duplicate_object_member_keys_in_value(
                    &binding.value,
                    &member_path,
                    errors,
                );
            }
        }
        Value::ListNode { items } | Value::TupleLiteral { items } => {
            for (index, item) in items.iter().enumerate() {
                found_duplicate |= validate_duplicate_object_member_keys_in_value(
                    item,
                    &path.index(index),
                    errors,
                );
            }
        }
        Value::NodeLiteral { children, .. } => {
            for (index, child) in children.iter().enumerate() {
                found_duplicate |= validate_duplicate_object_member_keys_in_value(
                    child,
                    &path.index(index),
                    errors,
                );
            }
        }
        _ => {}
    }
    found_duplicate
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
    steps: &[ValidationReferenceStep],
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
        Value::ObjectNode { bindings } => {
            for binding in bindings {
                collect_compact_attribute_references(
                    &binding.attributes,
                    &binding.attribute_order,
                    current_path,
                    compact,
                );
            }
        }
        Value::ListNode { .. } | Value::TupleLiteral { .. } => {}
        Value::NodeLiteral {
            attributes,
            children,
            ..
        } => {
            for attribute in attributes {
                let attribute_order = attribute.keys().cloned().collect::<Vec<_>>();
                collect_compact_attribute_references(
                    attribute,
                    &attribute_order,
                    current_path,
                    compact,
                );
            }
            for child in children {
                collect_compact_value_references(child, current_path, owner_path, compact);
            }
        }
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
            Value::ObjectNode { .. }
                | Value::ListNode { .. }
                | Value::TupleLiteral { .. }
                | Value::NodeLiteral { .. }
        )
    {
        return;
    }
    collect_compact_value_references(value, current_path, owner_path, compact);
}

fn collect_compact_attribute_references(
    attributes: &BTreeMap<String, AttributeValue>,
    attribute_order: &[String],
    current_path: &str,
    compact: &mut Vec<CompactReferenceStep>,
) {
    for key in attribute_order {
        let Some(entry) = attributes.get(key) else {
            continue;
        };
        collect_compact_attribute_references(
            &entry.object_members,
            &entry.object_member_order,
            current_path,
            compact,
        );
        collect_compact_attribute_references(
            &entry.nested_attrs,
            &entry.nested_attr_order,
            current_path,
            compact,
        );
        if let Some(value) = &entry.value {
            collect_compact_value_references(value, current_path, current_path, compact);
        }
    }
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
    let requires_exact_attr_visibility = target.contains(".@")
        && !(current_path == base && target.starts_with(&format!("{current_path}.@")));
    let is_visible = if requires_exact_attr_visibility {
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
    current_path
        .split_once(".@")
        .is_some_and(|(binding_path, _)| target == binding_path)
}

pub(crate) fn validate_datatypes(
    events: &[AssignmentEvent],
    rendered_event_paths: &[String],
    event_lookup: &BTreeMap<String, usize>,
    bindings: &[Binding],
    effective_mode: Option<BehaviorMode>,
    datatype_policy: Option<DatatypePolicy>,
    max_separator_depth: usize,
    max_generic_depth: usize,
    errors: &mut Vec<Diagnostic>,
) {
    let mode = effective_mode.unwrap_or_else(|| extract_behavior_mode(bindings));
    let datatype_policy = effective_datatype_policy(mode, datatype_policy);
    for (event, path) in events.iter().zip(rendered_event_paths.iter()) {
        if let Some(datatype) = &event.datatype {
            if let Some(error) =
                validate_datatype_shape(datatype, event, max_separator_depth, max_generic_depth)
            {
                let path_override = match error.code.as_str() {
                    "INVALID_NUMBER"
                    | "INVALID_SEPARATOR_CHAR"
                    | "CLARIFIER_VALUES_EXCEEDED"
                    | "GENERIC_DEPTH_EXCEEDED" => "$",
                    _ => path.as_str(),
                };
                errors.push(error.with_span(event.span).at_path(path_override));
                continue;
            }
            let resolved_value =
                resolve_reference_value(&event.value, events, event_lookup).unwrap_or(&event.value);
            if let Some(error) = datatype_value_error(
                datatype,
                &CompactDatatypeValue::from_value(resolved_value),
                path,
                event.span,
                mode,
                datatype_policy,
            ) {
                errors.push(error);
            }
        }
    }
    validate_attribute_datatypes_in_scope(
        bindings,
        &CanonicalPath::root(),
        mode,
        datatype_policy,
        max_separator_depth,
        max_generic_depth,
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
    Encoding(bool),
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
            Value::EncodingLiteral { raw } => Self::Encoding(has_valid_encoding_literal(raw)),
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

    fn value_kind(&self) -> &'static str {
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
            Self::Encoding(_) => "EncodingLiteral",
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

pub(crate) fn validate_attribute_datatypes(
    bindings: &[Binding],
    mode: BehaviorMode,
    datatype_policy: Option<DatatypePolicy>,
    max_separator_depth: usize,
    max_generic_depth: usize,
    errors: &mut Vec<Diagnostic>,
) {
    validate_datatypes(
        &[],
        &[],
        &BTreeMap::new(),
        bindings,
        Some(mode),
        datatype_policy,
        max_separator_depth,
        max_generic_depth,
        errors,
    );
}

pub(crate) fn validate_datatypes_light(
    events: &[ValidationEvent],
    event_lookup: &BTreeMap<String, usize>,
    bindings: &[Binding],
    effective_mode: Option<BehaviorMode>,
    datatype_policy: Option<DatatypePolicy>,
    max_separator_depth: usize,
    max_generic_depth: usize,
    errors: &mut Vec<Diagnostic>,
) {
    let mode = effective_mode.unwrap_or_else(|| extract_behavior_mode(bindings));
    let datatype_policy = effective_datatype_policy(mode, datatype_policy);
    for event in events {
        if let Some(datatype) = &event.datatype {
            if let Some(error) = validate_datatype_shape_light(
                datatype,
                &event.value,
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
            let resolved_value = resolve_reference_value_light(&event.value, events, event_lookup)
                .unwrap_or(&event.value);
            if datatype_base(datatype) == "switch" && resolved_value.value_kind() == "ToggleLiteral"
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
                && resolved_value.value_kind() == "ToggleLiteral"
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
            if !datatype_matches_value(datatype, resolved_value) {
                let message =
                    datatype_mismatch_message(&event.path, datatype, resolved_value.value_kind());
                errors.push(
                    Diagnostic::new("DATATYPE_LITERAL_MISMATCH", message)
                        .at_path(event.path.clone())
                        .with_span(event.span),
                );
            }
        }
    }
    validate_attribute_datatypes_in_scope(
        bindings,
        &CanonicalPath::root(),
        mode,
        datatype_policy,
        max_separator_depth,
        max_generic_depth,
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

fn resolve_reference_value<'a>(
    value: &'a Value,
    events: &'a [AssignmentEvent],
    event_lookup: &BTreeMap<String, usize>,
) -> Option<&'a Value> {
    let mut seen = HashSet::new();
    resolve_reference_value_inner(value, events, event_lookup, &mut seen)
}

fn resolve_reference_value_light<'a>(
    value: &'a Value,
    events: &'a [ValidationEvent],
    event_lookup: &BTreeMap<String, usize>,
) -> Option<&'a Value> {
    let mut seen = HashSet::new();
    resolve_reference_value_light_inner(value, events, event_lookup, &mut seen)
}

fn resolve_reference_value_inner<'a>(
    value: &'a Value,
    events: &'a [AssignmentEvent],
    event_lookup: &BTreeMap<String, usize>,
    seen: &mut HashSet<String>,
) -> Option<&'a Value> {
    let segments = match value {
        Value::CloneReference { segments, .. } | Value::PointerReference { segments, .. } => {
            segments
        }
        _ => return Some(value),
    };
    let target = format_reference_target(segments);
    if !seen.insert(target.clone()) {
        return Some(value);
    }
    let resolved = resolve_reference_target_value(segments, events, event_lookup)?;
    resolve_reference_value_inner(resolved, events, event_lookup, seen)
}

fn resolve_reference_value_light_inner<'a>(
    value: &'a Value,
    events: &'a [ValidationEvent],
    event_lookup: &BTreeMap<String, usize>,
    seen: &mut HashSet<String>,
) -> Option<&'a Value> {
    let segments = match value {
        Value::CloneReference { segments, .. } | Value::PointerReference { segments, .. } => {
            segments
        }
        _ => return Some(value),
    };
    let target = format_reference_target(segments);
    if !seen.insert(target.clone()) {
        return Some(value);
    }
    let resolved = resolve_reference_target_value_light(segments, events, event_lookup)?;
    resolve_reference_value_light_inner(resolved, events, event_lookup, seen)
}

fn resolve_reference_target_value<'a>(
    segments: &[ReferenceSegment],
    events: &'a [AssignmentEvent],
    event_lookup: &BTreeMap<String, usize>,
) -> Option<&'a Value> {
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
            return Some(&event.value);
        }
        if let Some(value) =
            resolve_reference_remainder(&event.value, Some(&event.annotations), remainder)
        {
            return Some(value);
        }
    }
    None
}

fn resolve_reference_target_value_light<'a>(
    segments: &[ReferenceSegment],
    events: &'a [ValidationEvent],
    event_lookup: &BTreeMap<String, usize>,
) -> Option<&'a Value> {
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
            return Some(&event.value);
        }
        if let Some(value) =
            resolve_reference_remainder(&event.value, Some(&event.annotations), remainder)
        {
            return Some(value);
        }
    }
    None
}

fn resolve_reference_remainder<'a>(
    value: &'a Value,
    annotations: Option<&'a BTreeMap<String, AttributeValue>>,
    remainder: &[ReferenceSegment],
) -> Option<&'a Value> {
    if remainder.is_empty() {
        return Some(value);
    }
    match &remainder[0] {
        ReferenceSegment::Attr(key) => {
            let attr = annotations?.get(key)?;
            resolve_reference_remainder_from_attr(attr, &remainder[1..])
        }
        ReferenceSegment::Key(key) => {
            let Value::ObjectNode { bindings } = value else {
                return None;
            };
            let binding = bindings.iter().find(|candidate| candidate.key == *key)?;
            resolve_reference_remainder(&binding.value, Some(&binding.attributes), &remainder[1..])
        }
        ReferenceSegment::Index(index) => match value {
            Value::ListNode { items } | Value::TupleLiteral { items } => {
                resolve_reference_remainder(items.get(*index)?, None, &remainder[1..])
            }
            Value::NodeLiteral { children, .. } => {
                resolve_reference_remainder(children.get(*index)?, None, &remainder[1..])
            }
            _ => None,
        },
    }
}

fn resolve_reference_remainder_from_attr<'a>(
    attr: &'a AttributeValue,
    remainder: &[ReferenceSegment],
) -> Option<&'a Value> {
    if remainder.is_empty() {
        return attr.value.as_ref();
    }
    match &remainder[0] {
        ReferenceSegment::Attr(key) => {
            resolve_reference_remainder_from_attr(attr.nested_attrs.get(key)?, &remainder[1..])
        }
        ReferenceSegment::Key(key) => {
            if let Some(member) = attr.object_members.get(key) {
                resolve_reference_remainder_from_attr(member, &remainder[1..])
            } else {
                resolve_reference_remainder(attr.value.as_ref()?, None, remainder)
            }
        }
        ReferenceSegment::Index(_) => {
            resolve_reference_remainder(attr.value.as_ref()?, None, remainder)
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
        let should_emit_untyped_value_error = !binding.is_header
            && binding.datatype.is_none()
            && !(matches!(mode, BehaviorMode::Strict)
                && matches!(binding.value, Value::ToggleLiteral { .. }));
        if should_emit_untyped_value_error {
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
        validate_node_head_datatypes_in_value(&binding.value, &path, binding.span, mode, errors);
        if let Value::ObjectNode { bindings: nested } = &binding.value {
            validate_typed_mode_rules_in_scope(nested, &path, mode, errors);
        }
    }
}

fn validate_node_head_datatypes_in_value(
    value: &Value,
    path: &CanonicalPath,
    owner_span: Span,
    mode: BehaviorMode,
    errors: &mut Vec<Diagnostic>,
) {
    match value {
        Value::NodeLiteral {
            datatype, children, ..
        } => {
            if matches!(mode, BehaviorMode::Strict)
                && let Some(datatype) = datatype
                && datatype_base(datatype) != "node"
            {
                errors.push(
                    Diagnostic::new(
                        "INVALID_NODE_HEAD_DATATYPE",
                        format!(
                            "Invalid node head datatype in strict mode at '{}': node heads must use ':node', got ':{}'",
                            format_path(path),
                            datatype
                        ),
                    )
                    .at_path(format_path(path))
                    .with_span(owner_span),
                );
            }
            for (index, child) in children.iter().enumerate() {
                validate_node_head_datatypes_in_value(
                    child,
                    &path.index(index),
                    owner_span,
                    mode,
                    errors,
                );
            }
        }
        Value::ObjectNode { bindings } => {
            for binding in bindings {
                validate_node_head_datatypes_in_value(
                    &binding.value,
                    &path.member(binding.key.clone()),
                    binding.span,
                    mode,
                    errors,
                );
            }
        }
        Value::ListNode { items } | Value::TupleLiteral { items } => {
            for (index, item) in items.iter().enumerate() {
                validate_node_head_datatypes_in_value(
                    item,
                    &path.index(index),
                    owner_span,
                    mode,
                    errors,
                );
            }
        }
        _ => {}
    }
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

fn datatype_base(datatype: &str) -> &str {
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

fn is_reserved_datatype(datatype: &str) -> bool {
    let base = datatype_base(datatype);
    matches!(
        base,
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
        "radix" | "decimal" | "radix2" | "radix6" | "radix8" | "radix12" => {
            Some(vec!["RadixLiteral"])
        }
        "encoding" | "base64" | "embed" | "inline" => Some(vec!["EncodingLiteral"]),
        "date" => Some(vec!["DateLiteral"]),
        "time" => Some(vec!["TimeLiteral"]),
        "datetime" => Some(vec!["DateTimeLiteral"]),
        "wtc" => Some(vec!["WTCDateTimeLiteral"]),
        "sep" | "kadot" => Some(vec!["SeparatorLiteral"]),
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
    if let Some(expected) = expected_kinds_for_custom_datatype(datatype) {
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

fn expected_kinds_for_custom_datatype(datatype: &str) -> Option<Vec<&'static str>> {
    if datatype_has_generic_args(datatype) {
        Some(vec!["ListNode", "TupleLiteral"])
    } else {
        None
    }
}

pub(crate) fn datatype_has_generic_args(datatype: &str) -> bool {
    let mut bracket_depth = 0usize;
    let mut generic_start = None;

    for ch in datatype.chars() {
        match ch {
            '[' => bracket_depth += 1,
            ']' => bracket_depth = bracket_depth.saturating_sub(1),
            _ if bracket_depth > 0 => {}
            '<' => generic_start = Some(()),
            '>' if generic_start.is_some() => return true,
            _ => {}
        }
    }

    false
}

fn datatype_matches_value(datatype: &str, value: &Value) -> bool {
    datatype_matches_compact_value(datatype, &CompactDatatypeValue::from_value(value))
}

fn datatype_matches_compact_value(datatype: &str, value: &CompactDatatypeValue) -> bool {
    let custom_expected = expected_kinds_for_custom_datatype(datatype);
    match datatype_base(datatype) {
        "number" | "n" | "int" | "int8" | "int16" | "int32" | "int64" | "uint" | "uint8"
        | "uint16" | "uint32" | "uint64" | "float" | "float32" | "float64" => {
            matches!(value, CompactDatatypeValue::Number)
        }
        "infinity" => matches!(value, CompactDatatypeValue::Infinity),
        "nan" => matches!(value, CompactDatatypeValue::NaN),
        "string" => matches!(value, CompactDatatypeValue::String),
        "trimtick" => matches!(value, CompactDatatypeValue::TrimtickString),
        "boolean" | "bool" => matches!(value, CompactDatatypeValue::Boolean),
        "toggle" => matches!(value, CompactDatatypeValue::Toggle),
        "hex" => matches!(value, CompactDatatypeValue::Hex(true)),
        "radix" | "decimal" | "radix2" | "radix6" | "radix8" | "radix12" => {
            matches!(value, CompactDatatypeValue::Radix(true))
        }
        "encoding" | "base64" | "embed" | "inline" => {
            matches!(value, CompactDatatypeValue::Encoding(true))
        }
        "date" => matches!(value, CompactDatatypeValue::Date),
        "time" => matches!(value, CompactDatatypeValue::Time),
        "datetime" => matches!(value, CompactDatatypeValue::DateTime),
        "wtc" => matches!(value, CompactDatatypeValue::WtcDateTime),
        "sep" | "kadot" => matches!(value, CompactDatatypeValue::Separator),
        "tuple" | "triple" => matches!(value, CompactDatatypeValue::Tuple),
        "list" => matches!(value, CompactDatatypeValue::List),
        "object" | "obj" | "envelope" | "o" => matches!(value, CompactDatatypeValue::Object),
        "node" => matches!(value, CompactDatatypeValue::Node),
        "sansa" => matches!(value, CompactDatatypeValue::Sansa),
        "null" => matches!(value, CompactDatatypeValue::Null),
        _ if custom_expected.is_some() => {
            let expected = custom_expected.as_ref().expect("checked is_some");
            expected.contains(&value.value_kind())
        }
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
    use super::{datatype_bracket_specs, separator_spec_depth};

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

fn validate_attribute_datatypes_in_scope(
    bindings: &[Binding],
    parent: &CanonicalPath,
    mode: BehaviorMode,
    datatype_policy: DatatypePolicy,
    max_separator_depth: usize,
    max_generic_depth: usize,
    errors: &mut Vec<Diagnostic>,
) {
    for binding in bindings {
        let path = parent.member(binding.key.clone());
        validate_attribute_datatype_map(
            &binding.attributes,
            &binding.attribute_order,
            &path,
            mode,
            datatype_policy,
            max_separator_depth,
            max_generic_depth,
            errors,
        );
        validate_value_attribute_datatypes(
            &binding.value,
            &path,
            mode,
            datatype_policy,
            max_separator_depth,
            max_generic_depth,
            errors,
        );
    }
}

fn validate_value_attribute_datatypes(
    value: &Value,
    path: &CanonicalPath,
    mode: BehaviorMode,
    datatype_policy: DatatypePolicy,
    max_separator_depth: usize,
    max_generic_depth: usize,
    errors: &mut Vec<Diagnostic>,
) {
    match value {
        Value::ObjectNode { bindings } => validate_attribute_datatypes_in_scope(
            bindings,
            path,
            mode,
            datatype_policy,
            max_separator_depth,
            max_generic_depth,
            errors,
        ),
        Value::ListNode { items } | Value::TupleLiteral { items } => {
            for (index, item) in items.iter().enumerate() {
                validate_value_attribute_datatypes(
                    item,
                    &path.index(index),
                    mode,
                    datatype_policy,
                    max_separator_depth,
                    max_generic_depth,
                    errors,
                );
            }
        }
        Value::NodeLiteral {
            attributes,
            children,
            ..
        } => {
            for attribute in attributes {
                let attribute_order = attribute.keys().cloned().collect::<Vec<_>>();
                validate_attribute_datatype_map(
                    attribute,
                    &attribute_order,
                    path,
                    mode,
                    datatype_policy,
                    max_separator_depth,
                    max_generic_depth,
                    errors,
                );
            }
            for (index, child) in children.iter().enumerate() {
                validate_value_attribute_datatypes(
                    child,
                    &path.index(index),
                    mode,
                    datatype_policy,
                    max_separator_depth,
                    max_generic_depth,
                    errors,
                );
            }
        }
        _ => {}
    }
}

fn validate_attribute_datatype_map(
    attributes: &BTreeMap<String, AttributeValue>,
    attribute_order: &[String],
    owner_path: &CanonicalPath,
    mode: BehaviorMode,
    datatype_policy: DatatypePolicy,
    max_separator_depth: usize,
    max_generic_depth: usize,
    errors: &mut Vec<Diagnostic>,
) {
    for key in attribute_order {
        let Some(entry) = attributes.get(key) else {
            continue;
        };
        let attr_path = format!("{}.@.{}", format_path(owner_path), key);
        if entry.datatype.is_none()
            && matches!(mode, BehaviorMode::Strict | BehaviorMode::Custom)
            && let Some(value) = &entry.value
        {
            if matches!(mode, BehaviorMode::Strict) && matches!(value, Value::ToggleLiteral { .. })
            {
                errors.push(
                    Diagnostic::new(
                        "UNTYPED_TOGGLE_LITERAL",
                        format!(
                            "Untyped toggle literal in typed mode: '{}' requires ':toggle' type annotation",
                            attr_path
                        ),
                    )
                    .at_path(attr_path.clone()),
                );
            } else {
                errors.push(
                    Diagnostic::new(
                        "UNTYPED_VALUE_IN_STRICT_MODE",
                        format!(
                            "Untyped value in typed mode: '{}' requires explicit type annotation",
                            attr_path
                        ),
                    )
                    .at_path(attr_path.clone()),
                );
            }
        } else if let Some(datatype) = &entry.datatype
            && let Some(value) = &entry.value
        {
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
                    _ => attr_path.as_str(),
                };
                errors.push(error.at_path(path_override));
                continue;
            }
            if !is_reserved_datatype(datatype) {
                if datatype_policy == DatatypePolicy::ReservedOnly {
                    errors.push(
                        Diagnostic::new(
                            "CUSTOM_DATATYPE_NOT_ALLOWED",
                            format!(
                                "Custom datatype not allowed in typed mode at '{}': ':{datatype}' requires --datatype-policy allow_custom",
                                attr_path
                            ),
                        )
                        .at_path(attr_path.clone()),
                    );
                }
            } else if !datatype_matches_value(datatype, value) {
                errors.push(
                    Diagnostic::new(
                        "DATATYPE_LITERAL_MISMATCH",
                        datatype_mismatch_message(&attr_path, datatype, value.value_kind()),
                    )
                    .at_path(attr_path.clone()),
                );
            }
        }
        validate_attribute_datatype_map(
            &entry.nested_attrs,
            &entry.nested_attr_order,
            owner_path,
            mode,
            datatype_policy,
            max_separator_depth,
            max_generic_depth,
            errors,
        );
        validate_attribute_datatype_map(
            &entry.object_members,
            &entry.object_member_order,
            owner_path,
            mode,
            datatype_policy,
            max_separator_depth,
            max_generic_depth,
            errors,
        );
        if let Some(value) = &entry.value {
            validate_value_attribute_datatypes(
                value,
                owner_path,
                mode,
                datatype_policy,
                max_separator_depth,
                max_generic_depth,
                errors,
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
    raw.len() > 1 && raw.starts_with('0') && !raw.starts_with("0_")
}
