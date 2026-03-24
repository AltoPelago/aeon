use std::collections::{BTreeMap, HashSet};

use crate::flatten::{FlattenedDocument, ValidationEvent, ValidationReferenceStep};
use crate::pathing::{format_reference_base, format_reference_target};
use crate::temporal::invalid_temporal_literal;
use crate::{
    format_path, AssignmentEvent, AttributeValue, BehaviorMode, Binding, CanonicalPath,
    DatatypePolicy, Diagnostic, ReferenceSegment, Value,
};

#[derive(Debug, Clone)]
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
    let mut seen = HashSet::new();
    let mut duplicates = HashSet::new();
    for (index, event) in events.iter().enumerate() {
        let _ = event_lookup.insert(event.path.clone(), index);
        if !seen.insert(event.path.clone()) {
            let _ = duplicates.insert(event.path.clone());
        }
    }
    for path in &duplicates {
        errors.push(
            Diagnostic::new(
                "DUPLICATE_CANONICAL_PATH",
                format!("Canonical path `{path}` is assigned more than once"),
            )
            .at_path(path.clone()),
        );
    }
    event_lookup
}

pub(crate) fn validate_duplicate_canonical_paths(
    flattened: &mut FlattenedDocument,
    recovery: bool,
    errors: &mut Vec<Diagnostic>,
) {
    let mut seen = HashSet::new();
    let mut duplicates = HashSet::new();
    for path in &flattened.rendered_event_paths {
        if !seen.insert(path.clone()) {
            let _ = duplicates.insert(path.clone());
        }
    }
    if duplicates.is_empty() {
        return;
    }
    for path in &duplicates {
        errors.push(
            Diagnostic::new(
                "DUPLICATE_CANONICAL_PATH",
                format!("Canonical path `{path}` is assigned more than once"),
            )
            .at_path(path.clone()),
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
            if retained.insert(path.clone()) {
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

pub(crate) fn validate_reference_steps(
    steps: &[ValidationReferenceStep],
    all_targets: &HashSet<String>,
    max_attribute_depth: usize,
    errors: &mut Vec<Diagnostic>,
) {
    let mut seen_base = HashSet::new();
    for step in steps {
        match step {
            ValidationReferenceStep::ValidateValue { path, value } => {
                validate_value_reference(value, path, all_targets, &seen_base, max_attribute_depth, errors);
            }
            ValidationReferenceStep::VisibleTarget(path) => {
                let _ = seen_base.insert(path.clone());
            }
        }
    }
}

fn validate_value_reference(
    value: &Value,
    current_path: &str,
    all_targets: &HashSet<String>,
    seen_base: &HashSet<String>,
    max_attribute_depth: usize,
    errors: &mut Vec<Diagnostic>,
) {
    match value {
        Value::CloneReference { segments } | Value::PointerReference { segments } => {
            let attr_depth = segments
                .iter()
                .filter(|segment| matches!(segment, ReferenceSegment::Attr(_)))
                .count();
            if attr_depth > max_attribute_depth {
                errors.push(
                    Diagnostic::new(
                        "ATTRIBUTE_DEPTH_EXCEEDED",
                        format!("Reference at {current_path} exceeds max attribute depth"),
                    )
                    .at_path("$"),
                );
                return;
            }
            let target = format_reference_target(segments);
            if target == current_path {
                errors.push(
                    Diagnostic::new(
                        "SELF_REFERENCE",
                        format!("Reference at {current_path} references itself"),
                    )
                    .at_path("$"),
                );
                return;
            }
            if !all_targets.contains(&target) {
                let base = format_reference_base(segments);
                let code = if all_targets.contains(&base) {
                    "MISSING_REFERENCE_TARGET"
                } else {
                    "FORWARD_REFERENCE"
                };
                errors.push(
                    Diagnostic::new(code, format!("Reference target `{target}` is not visible"))
                        .at_path("$"),
                );
                return;
            }
            let base = format_reference_base(segments);
            if !seen_base.contains(&base) {
                errors.push(
                    Diagnostic::new("FORWARD_REFERENCE", format!("Reference target `{target}` is forward"))
                        .at_path("$"),
                );
            }
        }
        Value::ObjectNode { bindings } => {
            for binding in bindings {
                validate_attribute_reference_map(
                    &binding.attributes,
                    current_path,
                    all_targets,
                    seen_base,
                    max_attribute_depth,
                    errors,
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
                validate_attribute_reference_map(
                    attribute,
                    current_path,
                    all_targets,
                    seen_base,
                    max_attribute_depth,
                    errors,
                );
            }
            for child in children {
                validate_value_reference(
                    child,
                    current_path,
                    all_targets,
                    seen_base,
                    max_attribute_depth,
                    errors,
                );
            }
        }
        _ => {}
    }
}

fn validate_attribute_reference_map(
    attributes: &BTreeMap<String, AttributeValue>,
    current_path: &str,
    all_targets: &HashSet<String>,
    seen_base: &HashSet<String>,
    max_attribute_depth: usize,
    errors: &mut Vec<Diagnostic>,
) {
    for entry in attributes.values() {
        for nested in [&entry.nested_attrs, &entry.object_members] {
            validate_attribute_reference_map(
                nested,
                current_path,
                all_targets,
                seen_base,
                max_attribute_depth,
                errors,
            );
        }
        if let Some(value) = &entry.value {
            validate_value_reference(
                value,
                current_path,
                all_targets,
                seen_base,
                max_attribute_depth,
                errors,
            );
        }
    }
}

pub(crate) fn validate_datatypes(
    events: &[AssignmentEvent],
    rendered_event_paths: &[String],
    event_lookup: &BTreeMap<String, usize>,
    bindings: &[Binding],
    datatype_policy: Option<DatatypePolicy>,
    max_separator_depth: usize,
    max_generic_depth: usize,
    errors: &mut Vec<Diagnostic>,
) {
    let mode = extract_behavior_mode(bindings);
    let datatype_policy = effective_datatype_policy(mode, datatype_policy);
    for (event, path) in events.iter().zip(rendered_event_paths.iter()) {
        if event.key.starts_with("aeon:") {
            continue;
        }
        if let Some(datatype) = &event.datatype {
            if let Some(error) =
                validate_datatype_shape(datatype, event, max_separator_depth, max_generic_depth)
            {
                let path_override = match error.code.as_str() {
                    "INVALID_NUMBER"
                    | "INVALID_SEPARATOR_CHAR"
                    | "SEPARATOR_DEPTH_EXCEEDED"
                    | "GENERIC_DEPTH_EXCEEDED" => "$",
                    _ => path.as_str(),
                };
                errors.push(error.at_path(path_override));
                continue;
            }
            if !is_reserved_datatype(datatype) {
                if datatype_policy == DatatypePolicy::ReservedOnly {
                    errors.push(
                        Diagnostic::new(
                            "CUSTOM_DATATYPE_NOT_ALLOWED",
                            format!("Custom datatype `{datatype}` requires allow_custom"),
                        )
                        .at_path(path.clone()),
                    );
                }
                continue;
            }
            let resolved_value =
                resolve_reference_value(&event.value, events, event_lookup).unwrap_or(&event.value);
            if !datatype_matches_value(datatype, resolved_value) {
                errors.push(
                    Diagnostic::new(
                        "DATATYPE_LITERAL_MISMATCH",
                        format!(
                            "Datatype `{datatype}` does not match {}",
                            resolved_value.value_kind()
                        ),
                    )
                    .at_path(path.clone()),
                );
            }
        }
    }
    validate_attribute_datatypes_in_scope(
        bindings,
        &CanonicalPath::root(),
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
    datatype_policy: Option<DatatypePolicy>,
    max_separator_depth: usize,
    max_generic_depth: usize,
    errors: &mut Vec<Diagnostic>,
) {
    let mode = extract_behavior_mode(bindings);
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
                    | "SEPARATOR_DEPTH_EXCEEDED"
                    | "GENERIC_DEPTH_EXCEEDED" => "$",
                    _ => event.path.as_str(),
                };
                errors.push(error.at_path(path_override));
                continue;
            }
            if !is_reserved_datatype(datatype) {
                if datatype_policy == DatatypePolicy::ReservedOnly {
                    errors.push(
                        Diagnostic::new(
                            "CUSTOM_DATATYPE_NOT_ALLOWED",
                            format!("Custom datatype `{datatype}` requires allow_custom"),
                        )
                        .at_path(event.path.clone()),
                    );
                }
                continue;
            }
            let resolved_value =
                resolve_reference_value_light(&event.value, events, event_lookup).unwrap_or(&event.value);
            if !datatype_matches_value(datatype, resolved_value) {
                errors.push(
                    Diagnostic::new(
                        "DATATYPE_LITERAL_MISMATCH",
                        format!(
                            "Datatype `{datatype}` does not match {}",
                            resolved_value.value_kind()
                        ),
                    )
                    .at_path(event.path.clone()),
                );
            }
        }
    }
    validate_attribute_datatypes_in_scope(
        bindings,
        &CanonicalPath::root(),
        datatype_policy,
        max_separator_depth,
        max_generic_depth,
        errors,
    );
}

pub(crate) fn validate_header_typing(bindings: &[Binding], errors: &mut Vec<Diagnostic>) {
    for binding in bindings {
        if binding.key.starts_with("aeon:")
            && binding.key != "aeon:mode"
            && binding.datatype.is_none()
            && matches!(
                binding.value,
                Value::ObjectNode { .. } | Value::ListNode { .. } | Value::TupleLiteral { .. }
            )
        {
            errors.push(
                Diagnostic::new(
                    "UNTYPED_VALUE_IN_STRICT_MODE",
                    format!("Structured header binding `{}` must be typed", binding.key),
                )
                .at_path(format_path(&CanonicalPath::root().member(binding.key.clone()))),
            );
        }
    }
}

pub(crate) fn validate_typed_mode_rules(bindings: &[Binding], errors: &mut Vec<Diagnostic>) {
    let mode = extract_behavior_mode(bindings);
    if !matches!(mode, BehaviorMode::Strict | BehaviorMode::Custom) {
        return;
    }
    validate_typed_mode_rules_in_scope(bindings, &CanonicalPath::root(), mode, errors);
}

pub(crate) fn extract_behavior_mode(bindings: &[Binding]) -> BehaviorMode {
    for binding in bindings {
        if binding.key != "aeon:mode" {
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
        Value::CloneReference { segments } | Value::PointerReference { segments } => segments,
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
        Value::CloneReference { segments } | Value::PointerReference { segments } => segments,
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
            resolve_reference_remainder(
                &binding.value,
                Some(&binding.attributes),
                &remainder[1..],
            )
        }
        ReferenceSegment::Index(index) => match value {
            Value::ListNode { items } | Value::TupleLiteral { items } => {
                resolve_reference_remainder(items.get(*index)?, None, &remainder[1..])
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
        ReferenceSegment::Index(_) => resolve_reference_remainder(attr.value.as_ref()?, None, remainder),
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
        if !binding.key.starts_with("aeon:") && binding.datatype.is_none() {
            errors.push(
                Diagnostic::new(
                    "UNTYPED_VALUE_IN_STRICT_MODE",
                    format!(
                        "Value at {} requires an explicit datatype annotation in typed mode",
                        format_path(&path)
                    ),
                )
                .at_path(format_path(&path)),
            );
        }
        validate_switch_literal_in_value(&binding.value, &path, binding.datatype.as_deref(), errors);
        validate_node_head_datatypes_in_value(&binding.value, &path, mode, errors);
        if let Value::ObjectNode { bindings: nested } = &binding.value {
            validate_typed_mode_rules_in_scope(nested, &path, mode, errors);
        }
    }
}

fn validate_node_head_datatypes_in_value(
    value: &Value,
    path: &CanonicalPath,
    mode: BehaviorMode,
    errors: &mut Vec<Diagnostic>,
) {
    match value {
        Value::NodeLiteral {
            datatype,
            children,
            ..
        } => {
            if matches!(mode, BehaviorMode::Strict) {
                if let Some(datatype) = datatype {
                    if datatype_base(datatype) != "node" {
                        errors.push(
                            Diagnostic::new(
                                "INVALID_NODE_HEAD_DATATYPE",
                                format!(
                                    "Node head datatype at {} must be `:node` in strict mode, got `:{}`",
                                    format_path(path),
                                    datatype
                                ),
                            )
                            .at_path(format_path(path)),
                        );
                    }
                }
            }
            for (index, child) in children.iter().enumerate() {
                validate_node_head_datatypes_in_value(child, &path.index(index), mode, errors);
            }
        }
        Value::ObjectNode { bindings } => {
            for binding in bindings {
                validate_node_head_datatypes_in_value(
                    &binding.value,
                    &path.member(binding.key.clone()),
                    mode,
                    errors,
                );
            }
        }
        Value::ListNode { items } | Value::TupleLiteral { items } => {
            for (index, item) in items.iter().enumerate() {
                validate_node_head_datatypes_in_value(item, &path.index(index), mode, errors);
            }
        }
        _ => {}
    }
}

fn validate_switch_literal_in_value(
    value: &Value,
    path: &CanonicalPath,
    datatype: Option<&str>,
    errors: &mut Vec<Diagnostic>,
) {
    match value {
        Value::SwitchLiteral { .. } => {
            if datatype != Some("switch") {
                errors.push(
                    Diagnostic::new(
                        "UNTYPED_SWITCH_LITERAL",
                        format!(
                            "Switch literal at {} must be typed as `:switch` in strict mode",
                            format_path(path)
                        ),
                    )
                    .at_path(format_path(path)),
                );
            }
        }
        Value::ObjectNode { .. } => {}
        Value::ListNode { items } | Value::TupleLiteral { items } => {
            let nested_datatype = if datatype.is_some() { Some("switch") } else { None };
            for (index, item) in items.iter().enumerate() {
                validate_switch_literal_in_value(item, &path.index(index), nested_datatype, errors);
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
    if datatype.contains("[,]") {
        return Some(Diagnostic::new(
            "INVALID_SEPARATOR_CHAR",
            format!("Datatype `{datatype}` uses a reserved separator character"),
        ));
    }
    if datatype.matches('[').count() > max_separator_depth {
        return Some(Diagnostic::new(
            "SEPARATOR_DEPTH_EXCEEDED",
            format!("Datatype `{datatype}` exceeds separator depth limit"),
        ));
    }
    if generic_depth(datatype) > max_generic_depth {
        return Some(Diagnostic::new(
            "GENERIC_DEPTH_EXCEEDED",
            format!("Datatype `{datatype}` exceeds generic depth limit"),
        ));
    }
    if let Value::NumberLiteral { raw } = &event.value && !is_valid_number_literal(raw) {
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
    if datatype.matches('[').count() > max_separator_depth {
        return Some(Diagnostic::new(
            "SEPARATOR_DEPTH_EXCEEDED",
            format!("Datatype `{datatype}` exceeds separator depth limit"),
        ));
    }
    if generic_depth(datatype) > max_generic_depth {
        return Some(Diagnostic::new(
            "GENERIC_DEPTH_EXCEEDED",
            format!("Datatype `{datatype}` exceeds generic depth limit"),
        ));
    }
    if let Value::NumberLiteral { raw } = value && !is_valid_number_literal(raw) {
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
            | "string"
            | "trimtick"
            | "boolean"
            | "bool"
            | "switch"
            | "hex"
            | "radix"
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
            | "zrut"
            | "sep"
            | "set"
            | "tuple"
            | "list"
            | "object"
            | "obj"
            | "envelope"
            | "o"
            | "node"
            | "null"
    )
}

fn datatype_matches_value(datatype: &str, value: &Value) -> bool {
    match datatype_base(datatype) {
        "number" | "n" | "int" | "int8" | "int16" | "int32" | "int64" | "uint" | "uint8"
        | "uint16" | "uint32" | "uint64" | "float" | "float32" | "float64" => {
            matches!(value, Value::NumberLiteral { .. })
        }
        "infinity" => matches!(value, Value::InfinityLiteral { .. }),
        "string" => matches!(value, Value::StringLiteral { is_trimtick: false, .. }),
        "trimtick" => matches!(value, Value::StringLiteral { is_trimtick: true, .. }),
        "boolean" | "bool" => matches!(value, Value::BooleanLiteral { .. }),
        "switch" => matches!(value, Value::SwitchLiteral { .. }),
        "hex" => matches!(value, Value::HexLiteral { raw } if has_valid_literal_underscores(raw)),
        "radix" | "radix2" | "radix6" | "radix8" | "radix12" => {
            matches!(value, Value::RadixLiteral { raw } if has_valid_radix_literal(raw))
        }
        "encoding" | "base64" | "embed" | "inline" => {
            matches!(value, Value::EncodingLiteral { raw } if has_valid_encoding_literal(raw))
        }
        "date" => matches!(value, Value::DateLiteral { .. }),
        "time" => matches!(value, Value::TimeLiteral { .. }),
        "datetime" => matches!(value, Value::DateTimeLiteral { .. }),
        "zrut" => matches!(value, Value::DateTimeLiteral { raw } if raw.contains('&')),
        "sep" | "set" => matches!(value, Value::SeparatorLiteral { raw } if !raw.starts_with("^ ")),
        "tuple" => matches!(value, Value::TupleLiteral { .. }),
        "list" => matches!(value, Value::ListNode { .. }),
        "object" | "obj" | "envelope" | "o" => matches!(value, Value::ObjectNode { .. }),
        "node" => matches!(value, Value::NodeLiteral { .. }),
        "null" => false,
        _ => true,
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
    let mut index = if matches!(chars.first(), Some('+' | '-')) { 1 } else { 0 };
    if index >= chars.len() {
        return false;
    }
    let mut saw_digit = false;
    let mut saw_decimal = false;
    let mut prev_was_digit = false;
    while index < chars.len() {
        let ch = chars[index];
        if is_radix_digit(ch) {
            saw_digit = true;
            prev_was_digit = true;
        } else if ch == '_' {
            if !prev_was_digit || index + 1 >= chars.len() || !is_radix_digit(chars[index + 1]) {
                return false;
            }
            prev_was_digit = false;
        } else if ch == '.' {
            if saw_decimal || !prev_was_digit || index + 1 >= chars.len() || !is_radix_digit(chars[index + 1]) {
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
    let body = &raw[1..];
    if body.is_empty() {
        return false;
    }
    if !body
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '+' | '/' | '=' | '-' | '_'))
    {
        return false;
    }
    match body.find('=') {
        None => true,
        Some(index) => body[index..].chars().all(|ch| ch == '='),
    }
}

fn validate_attribute_datatypes_in_scope(
    bindings: &[Binding],
    parent: &CanonicalPath,
    datatype_policy: DatatypePolicy,
    max_separator_depth: usize,
    max_generic_depth: usize,
    errors: &mut Vec<Diagnostic>,
) {
    for binding in bindings {
        let path = parent.member(binding.key.clone());
        validate_attribute_datatype_map(
            &binding.attributes,
            &path,
            datatype_policy,
            max_separator_depth,
            max_generic_depth,
            errors,
        );
        validate_value_attribute_datatypes(
            &binding.value,
            &path,
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
    datatype_policy: DatatypePolicy,
    max_separator_depth: usize,
    max_generic_depth: usize,
    errors: &mut Vec<Diagnostic>,
) {
    match value {
        Value::ObjectNode { bindings } => validate_attribute_datatypes_in_scope(
            bindings,
            path,
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
                validate_attribute_datatype_map(
                    attribute,
                    path,
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
    owner_path: &CanonicalPath,
    datatype_policy: DatatypePolicy,
    max_separator_depth: usize,
    max_generic_depth: usize,
    errors: &mut Vec<Diagnostic>,
) {
    for (key, entry) in attributes {
        let attr_path = format!("{}@{}", format_path(owner_path), key);
        if let Some(datatype) = &entry.datatype {
            if let Some(value) = &entry.value {
                if let Some(error) =
                    validate_datatype_shape_light(datatype, value, max_separator_depth, max_generic_depth)
                {
                    let path_override = match error.code.as_str() {
                        "INVALID_NUMBER"
                        | "INVALID_SEPARATOR_CHAR"
                        | "SEPARATOR_DEPTH_EXCEEDED"
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
                                format!("Custom datatype `{datatype}` requires allow_custom"),
                            )
                            .at_path(attr_path.clone()),
                        );
                    }
                } else {
                    if !datatype_matches_value(datatype, value) {
                        errors.push(
                            Diagnostic::new(
                                "DATATYPE_LITERAL_MISMATCH",
                                format!(
                                    "Datatype `{datatype}` does not match {}",
                                    value.value_kind()
                                ),
                            )
                            .at_path(attr_path.clone()),
                        );
                    }
                }
            }
        }
        validate_attribute_datatype_map(
            &entry.nested_attrs,
            owner_path,
            datatype_policy,
            max_separator_depth,
            max_generic_depth,
            errors,
        );
        validate_attribute_datatype_map(
            &entry.object_members,
            owner_path,
            datatype_policy,
            max_separator_depth,
            max_generic_depth,
            errors,
        );
        if let Some(value) = &entry.value {
            validate_value_attribute_datatypes(
                value,
                owner_path,
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
    max_depth
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
