use std::collections::{BTreeMap, HashSet};

use crate::pathing::{format_path, render_child_index_path, render_child_member_path, render_member_segment};
use crate::{AssignmentEvent, AttributeValue, Binding, BindingProjection, CanonicalPath, Span, Value};

#[derive(Debug, Clone)]
pub(crate) struct FlattenedDocument {
    pub(crate) events: Vec<AssignmentEvent>,
    pub(crate) rendered_event_paths: Vec<String>,
    pub(crate) bindings: Vec<BindingProjection>,
    pub(crate) reference_targets: HashSet<String>,
    pub(crate) reference_steps: Vec<ValidationReferenceStep>,
}

#[derive(Debug, Clone)]
pub(crate) struct FlattenedValidationDocument {
    pub(crate) events: Vec<ValidationEvent>,
    pub(crate) reference_targets: HashSet<String>,
    pub(crate) reference_steps: Vec<ValidationReferenceStep>,
}

#[derive(Debug, Clone)]
pub(crate) struct ValidationEvent {
    pub(crate) path: String,
    pub(crate) datatype: Option<String>,
    pub(crate) annotations: BTreeMap<String, AttributeValue>,
    pub(crate) value: Value,
    pub(crate) span: Span,
}

#[derive(Debug, Clone)]
pub(crate) enum ValidationReferenceStep {
    ValidateValue { path: String, value: Value },
    VisibleTarget(String),
}

pub(crate) fn flatten_document(
    bindings: &[Binding],
    root: &CanonicalPath,
    shallow_event_values: bool,
    emit_binding_projections: bool,
    include_event_annotations: bool,
) -> FlattenedDocument {
    let mut events = Vec::new();
    let mut rendered_event_paths = Vec::new();
    let mut projections = Vec::new();
    let mut reference_targets = HashSet::new();
    let mut reference_steps = Vec::new();
    flatten_bindings(
        bindings,
        root,
        shallow_event_values,
        emit_binding_projections,
        include_event_annotations,
        &mut events,
        &mut rendered_event_paths,
        &mut projections,
        &mut reference_targets,
        &mut reference_steps,
    );
    FlattenedDocument {
        events,
        rendered_event_paths,
        bindings: projections,
        reference_targets,
        reference_steps,
    }
}

pub(crate) fn flatten_validation_document(
    bindings: &[Binding],
    root: &CanonicalPath,
    shallow_event_values: bool,
) -> FlattenedValidationDocument {
    let mut events = Vec::new();
    let mut reference_targets = HashSet::new();
    let mut reference_steps = Vec::new();
    flatten_validation_bindings(
        bindings,
        root,
        shallow_event_values,
        &mut events,
        &mut reference_targets,
        &mut reference_steps,
    );
    FlattenedValidationDocument {
        events,
        reference_targets,
        reference_steps,
    }
}

fn track_reference_binding(
    reference_targets: &mut HashSet<String>,
    reference_steps: &mut Vec<ValidationReferenceStep>,
    parent_path: &str,
    key: &str,
    path_text: &str,
    attributes: &BTreeMap<String, AttributeValue>,
    attribute_order: &[String],
    value: &Value,
    shallow_event_values: bool,
) {
    let _ = reference_targets.insert(render_child_member_path(parent_path, key));
    collect_attribute_targets(path_text, attributes, attribute_order, reference_targets, String::new());
    reference_steps.push(ValidationReferenceStep::VisibleTarget(String::from(path_text)));
    reference_steps.push(ValidationReferenceStep::ValidateValue {
        path: String::from(path_text),
        value: clone_validation_value(value, shallow_event_values),
    });
    collect_attribute_reference_steps(
        path_text,
        attributes,
        attribute_order,
        reference_steps,
        shallow_event_values,
        String::new(),
    );
}

fn track_reference_sequence_item(
    reference_targets: &mut HashSet<String>,
    reference_steps: &mut Vec<ValidationReferenceStep>,
    parent_path: &str,
    index: usize,
    value: &Value,
    shallow_event_values: bool,
) {
    let item_target = render_child_index_path(parent_path, index);
    reference_steps.push(ValidationReferenceStep::ValidateValue {
        path: item_target.clone(),
        value: clone_validation_value(value, shallow_event_values),
    });
    let _ = reference_targets.insert(item_target.clone());
    reference_steps.push(ValidationReferenceStep::VisibleTarget(item_target));
}

fn flatten_validation_bindings(
    bindings: &[Binding],
    parent: &CanonicalPath,
    shallow_event_values: bool,
    events: &mut Vec<ValidationEvent>,
    reference_targets: &mut HashSet<String>,
    reference_steps: &mut Vec<ValidationReferenceStep>,
) {
    let parent_path = format_path(parent);
    for binding in bindings {
        let path = parent.member(binding.key.clone());
        let path_text = format_path(&path);
        track_reference_binding(
            reference_targets,
            reference_steps,
            &parent_path,
            &binding.key,
            &path_text,
            &binding.attributes,
            &binding.attribute_order,
            &binding.value,
            shallow_event_values,
        );
        if !binding.key.starts_with("aeon:") {
            events.push(ValidationEvent {
                path: path_text.clone(),
                datatype: binding.datatype.clone(),
                annotations: binding.attributes.clone(),
                value: clone_validation_value(&binding.value, shallow_event_values),
                span: binding.span,
            });
        }

        match &binding.value {
            Value::ListNode { items } => {
                let path_parent = format_path(&path);
                for (index, item) in items.iter().enumerate() {
                    let item_path = path.index(index);
                    track_reference_sequence_item(
                        reference_targets,
                        reference_steps,
                        &path_parent,
                        index,
                        item,
                        shallow_event_values,
                    );
                    if !matches!(item, Value::ObjectNode { .. } | Value::ListNode { .. } | Value::TupleLiteral { .. }) {
                        events.push(ValidationEvent {
                            path: format_path(&item_path),
                            datatype: None,
                            annotations: BTreeMap::new(),
                            value: clone_validation_value(item, shallow_event_values),
                            span: binding.span,
                        });
                    }
                    flatten_validation_value(
                        item,
                        &item_path,
                        binding.span,
                        shallow_event_values,
                        events,
                        reference_targets,
                        reference_steps,
                    );
                }
            }
            Value::TupleLiteral { items } => {
                let path_parent = format_path(&path);
                for (index, item) in items.iter().enumerate() {
                    let item_path = path.index(index);
                    track_reference_sequence_item(
                        reference_targets,
                        reference_steps,
                        &path_parent,
                        index,
                        item,
                        shallow_event_values,
                    );
                    if !matches!(item, Value::ObjectNode { .. } | Value::ListNode { .. } | Value::TupleLiteral { .. }) {
                        events.push(ValidationEvent {
                            path: format_path(&item_path),
                            datatype: None,
                            annotations: BTreeMap::new(),
                            value: clone_validation_value(item, shallow_event_values),
                            span: binding.span,
                        });
                    }
                    flatten_validation_value(
                        item,
                        &item_path,
                        binding.span,
                        shallow_event_values,
                        events,
                        reference_targets,
                        reference_steps,
                    );
                }
            }
            Value::ObjectNode { bindings: nested } => {
                flatten_validation_bindings(
                    nested,
                    &path,
                    shallow_event_values,
                    events,
                    reference_targets,
                    reference_steps,
                );
            }
            _ => {}
        }
    }
}

fn flatten_validation_value(
    value: &Value,
    parent: &CanonicalPath,
    owner_span: Span,
    shallow_event_values: bool,
    events: &mut Vec<ValidationEvent>,
    reference_targets: &mut HashSet<String>,
    reference_steps: &mut Vec<ValidationReferenceStep>,
) {
    match value {
        Value::ObjectNode { bindings } => {
            flatten_validation_bindings(
                bindings,
                parent,
                shallow_event_values,
                events,
                reference_targets,
                reference_steps,
            )
        }
        Value::ListNode { items } => {
            let parent_path = format_path(parent);
            for (index, item) in items.iter().enumerate() {
                let item_path = parent.index(index);
                track_reference_sequence_item(
                    reference_targets,
                    reference_steps,
                    &parent_path,
                    index,
                    item,
                    shallow_event_values,
                );
                if !matches!(item, Value::ObjectNode { .. } | Value::ListNode { .. } | Value::TupleLiteral { .. }) {
                    events.push(ValidationEvent {
                        path: format_path(&item_path),
                        datatype: None,
                        annotations: BTreeMap::new(),
                        value: clone_validation_value(item, shallow_event_values),
                        span: owner_span,
                    });
                }
                flatten_validation_value(
                    item,
                    &item_path,
                    owner_span,
                    shallow_event_values,
                    events,
                    reference_targets,
                    reference_steps,
                );
            }
        }
        Value::TupleLiteral { items } => {
            let parent_path = format_path(parent);
            for (index, item) in items.iter().enumerate() {
                let item_path = parent.index(index);
                track_reference_sequence_item(
                    reference_targets,
                    reference_steps,
                    &parent_path,
                    index,
                    item,
                    shallow_event_values,
                );
                if !matches!(item, Value::ObjectNode { .. } | Value::ListNode { .. } | Value::TupleLiteral { .. }) {
                    events.push(ValidationEvent {
                        path: format_path(&item_path),
                        datatype: None,
                        annotations: BTreeMap::new(),
                        value: clone_validation_value(item, shallow_event_values),
                        span: owner_span,
                    });
                }
                flatten_validation_value(
                    item,
                    &item_path,
                    owner_span,
                    shallow_event_values,
                    events,
                    reference_targets,
                    reference_steps,
                );
            }
        }
        _ => {}
    }
}

fn flatten_bindings(
    bindings: &[Binding],
    parent: &CanonicalPath,
    shallow_event_values: bool,
    emit_binding_projections: bool,
    include_event_annotations: bool,
    events: &mut Vec<AssignmentEvent>,
    rendered_event_paths: &mut Vec<String>,
    bindings_out: &mut Vec<BindingProjection>,
    reference_targets: &mut HashSet<String>,
    reference_steps: &mut Vec<ValidationReferenceStep>,
) {
    let parent_path = format_path(parent);
    for binding in bindings {
        let path = parent.member(binding.key.clone());
        let path_text = format_path(&path);
        track_reference_binding(
            reference_targets,
            reference_steps,
            &parent_path,
            &binding.key,
            &path_text,
            &binding.attributes,
            &binding.attribute_order,
            &binding.value,
            shallow_event_values,
        );
        let visible = !binding.key.starts_with("aeon:");
        if visible {
            events.push(AssignmentEvent {
                path: path.clone(),
                key: binding.key.clone(),
                datatype: binding.datatype.clone(),
                annotations: if include_event_annotations {
                    binding.attributes.clone()
                } else {
                    BTreeMap::new()
                },
                value: clone_event_value(&binding.value, shallow_event_values),
                span: binding.span,
            });
            rendered_event_paths.push(path_text.clone());
            if emit_binding_projections {
                bindings_out.push(BindingProjection {
                    path: path_text,
                    datatype: binding.datatype.clone(),
                    kind: "binding",
                });
            }
        }

        match &binding.value {
            Value::ListNode { items } => {
                let path_parent = format_path(&path);
                for (index, item) in items.iter().enumerate() {
                    let item_path = path.index(index);
                    let item_text = format_path(&item_path);
                    track_reference_sequence_item(
                        reference_targets,
                        reference_steps,
                        &path_parent,
                        index,
                        item,
                        shallow_event_values,
                    );
                    events.push(AssignmentEvent {
                        path: item_path,
                        key: index.to_string(),
                        datatype: None,
                        annotations: BTreeMap::new(),
                        value: clone_event_value(item, shallow_event_values),
                        span: binding.span,
                    });
                    rendered_event_paths.push(item_text.clone());
                    if emit_binding_projections {
                        bindings_out.push(BindingProjection {
                            path: item_text,
                            datatype: None,
                            kind: "binding",
                        });
                    }
                    flatten_container_item(
                        item,
                        &path.index(index),
                        shallow_event_values,
                        emit_binding_projections,
                        include_event_annotations,
                        events,
                        rendered_event_paths,
                        bindings_out,
                        reference_targets,
                        reference_steps,
                        binding.span,
                    );
                }
            }
            Value::TupleLiteral { items } => {
                let path_parent = format_path(&path);
                for (index, item) in items.iter().enumerate() {
                    let item_path = path.index(index);
                    let item_text = format_path(&item_path);
                    track_reference_sequence_item(
                        reference_targets,
                        reference_steps,
                        &path_parent,
                        index,
                        item,
                        shallow_event_values,
                    );
                    events.push(AssignmentEvent {
                        path: item_path,
                        key: index.to_string(),
                        datatype: None,
                        annotations: BTreeMap::new(),
                        value: clone_event_value(item, shallow_event_values),
                        span: binding.span,
                    });
                    rendered_event_paths.push(item_text.clone());
                    if emit_binding_projections {
                        bindings_out.push(BindingProjection {
                            path: item_text,
                            datatype: None,
                            kind: "binding",
                        });
                    }
                    flatten_container_item(
                        item,
                        &path.index(index),
                        shallow_event_values,
                        emit_binding_projections,
                        include_event_annotations,
                        events,
                        rendered_event_paths,
                        bindings_out,
                        reference_targets,
                        reference_steps,
                        binding.span,
                    );
                }
            }
            Value::ObjectNode { bindings: nested } => {
                flatten_bindings(
                    nested,
                    &path,
                    shallow_event_values,
                    emit_binding_projections,
                    include_event_annotations,
                    events,
                    rendered_event_paths,
                    bindings_out,
                    reference_targets,
                    reference_steps,
                );
            }
            _ => {}
        }
    }
}

fn flatten_container_item(
    value: &Value,
    parent: &CanonicalPath,
    shallow_event_values: bool,
    emit_binding_projections: bool,
    include_event_annotations: bool,
    events: &mut Vec<AssignmentEvent>,
    rendered_event_paths: &mut Vec<String>,
    bindings_out: &mut Vec<BindingProjection>,
    reference_targets: &mut HashSet<String>,
    reference_steps: &mut Vec<ValidationReferenceStep>,
    span: Span,
) {
    match value {
        Value::ObjectNode { bindings } => {
            flatten_bindings(
                bindings,
                parent,
                shallow_event_values,
                emit_binding_projections,
                include_event_annotations,
                events,
                rendered_event_paths,
                bindings_out,
                reference_targets,
                reference_steps,
            )
        }
        Value::ListNode { items } | Value::TupleLiteral { items } => {
            let parent_path = format_path(parent);
            for (index, item) in items.iter().enumerate() {
                let item_path = parent.index(index);
                let item_text = format_path(&item_path);
                track_reference_sequence_item(
                    reference_targets,
                    reference_steps,
                    &parent_path,
                    index,
                    item,
                    shallow_event_values,
                );
                events.push(AssignmentEvent {
                    path: item_path.clone(),
                    key: index.to_string(),
                    datatype: None,
                    annotations: BTreeMap::new(),
                    value: clone_event_value(item, shallow_event_values),
                    span,
                });
                rendered_event_paths.push(item_text.clone());
                if emit_binding_projections {
                    bindings_out.push(BindingProjection {
                        path: item_text,
                        datatype: None,
                        kind: "binding",
                    });
                }
                flatten_container_item(
                    item,
                    &item_path,
                    shallow_event_values,
                    emit_binding_projections,
                    include_event_annotations,
                    events,
                    rendered_event_paths,
                    bindings_out,
                    reference_targets,
                    reference_steps,
                    span,
                );
            }
        }
        _ => {}
    }
}

fn clone_event_value(value: &Value, shallow_event_values: bool) -> Value {
    if !shallow_event_values {
        return value.clone();
    }
    match value {
        Value::ObjectNode { .. } => Value::ObjectNode { bindings: Vec::new() },
        Value::ListNode { .. } => Value::ListNode { items: Vec::new() },
        Value::TupleLiteral { .. } => Value::TupleLiteral { items: Vec::new() },
        Value::NodeLiteral {
            raw,
            tag,
            attributes,
            datatype,
            ..
        } => Value::NodeLiteral {
            raw: raw.clone(),
            tag: tag.clone(),
            attributes: attributes.clone(),
            datatype: datatype.clone(),
            children: Vec::new(),
        },
        _ => value.clone(),
    }
}

fn clone_validation_value(value: &Value, shallow_event_values: bool) -> Value {
    if !shallow_event_values {
        return value.clone();
    }
    match value {
        Value::NumberLiteral { raw } => Value::NumberLiteral { raw: raw.clone() },
        Value::InfinityLiteral { raw } => Value::InfinityLiteral { raw: raw.clone() },
        Value::StringLiteral { delimiter, trimticks, .. } => Value::StringLiteral {
            value: String::new(),
            raw: String::new(),
            delimiter: *delimiter,
            trimticks: trimticks.clone(),
        },
        Value::SwitchLiteral { .. } => Value::SwitchLiteral {
            raw: String::new(),
        },
        Value::BooleanLiteral { .. } => Value::BooleanLiteral {
            raw: String::new(),
        },
        Value::HexLiteral { .. } => Value::HexLiteral { raw: String::new() },
        Value::SeparatorLiteral { .. } => Value::SeparatorLiteral {
            raw: String::new(),
        },
        Value::EncodingLiteral { .. } => Value::EncodingLiteral {
            raw: String::new(),
        },
        Value::RadixLiteral { .. } => Value::RadixLiteral { raw: String::new() },
        Value::DateLiteral { .. } => Value::DateLiteral { raw: String::new() },
        Value::DateTimeLiteral { .. } => Value::DateTimeLiteral {
            raw: String::new(),
        },
        Value::TimeLiteral { .. } => Value::TimeLiteral { raw: String::new() },
        Value::NodeLiteral { .. } => Value::NodeLiteral {
            raw: String::new(),
            tag: String::new(),
            attributes: Vec::new(),
            datatype: None,
            children: Vec::new(),
        },
        Value::ListNode { .. } => Value::ListNode { items: Vec::new() },
        Value::TupleLiteral { .. } => Value::TupleLiteral { items: Vec::new() },
        Value::ObjectNode { .. } => Value::ObjectNode { bindings: Vec::new() },
        Value::CloneReference { segments, span } => Value::CloneReference {
            segments: segments.clone(),
            span: *span,
        },
        Value::PointerReference { segments, span } => Value::PointerReference {
            segments: segments.clone(),
            span: *span,
        },
    }
}

fn collect_attribute_targets(
    base: &str,
    attributes: &BTreeMap<String, AttributeValue>,
    attribute_order: &[String],
    targets: &mut HashSet<String>,
    prefix: String,
) {
    for key in attribute_order {
        let Some(value) = attributes.get(key) else {
            continue;
        };
        let next_prefix = if prefix.is_empty() {
            format!("@{key}")
        } else {
            format!("{prefix}@{key}")
        };
        let _ = targets.insert(format!("{base}{next_prefix}"));
        collect_attribute_targets(
            base,
            &value.nested_attrs,
            &value.nested_attr_order,
            targets,
            next_prefix.clone(),
        );
        collect_attribute_object_targets(
            base,
            &value.object_members,
            &value.object_member_order,
            targets,
            next_prefix,
        );
    }
}

fn collect_attribute_object_targets(
    base: &str,
    members: &BTreeMap<String, AttributeValue>,
    member_order: &[String],
    targets: &mut HashSet<String>,
    prefix: String,
) {
    for key in member_order {
        let Some(value) = members.get(key) else {
            continue;
        };
        let member_segment = render_member_segment(key);
        let next_prefix = format!("{prefix}{member_segment}");
        let member_path = format!("{base}{next_prefix}");
        let _ = targets.insert(member_path.clone());
        collect_attribute_object_targets(
            base,
            &value.object_members,
            &value.object_member_order,
            targets,
            next_prefix.clone(),
        );
        collect_attribute_targets(
            base,
            &value.nested_attrs,
            &value.nested_attr_order,
            targets,
            next_prefix,
        );
    }
}

fn collect_attribute_reference_steps(
    base: &str,
    attributes: &BTreeMap<String, AttributeValue>,
    attribute_order: &[String],
    steps: &mut Vec<ValidationReferenceStep>,
    shallow_event_values: bool,
    prefix: String,
) {
    for key in attribute_order {
        let Some(value) = attributes.get(key) else {
            continue;
        };
        let next_prefix = if prefix.is_empty() {
            format!("@{key}")
        } else {
            format!("{prefix}@{key}")
        };
        let current_path = format!("{base}{next_prefix}");
        if let Some(entry_value) = &value.value {
            steps.push(ValidationReferenceStep::ValidateValue {
                path: current_path.clone(),
                value: clone_validation_value(entry_value, shallow_event_values),
            });
        }
        collect_attribute_object_reference_steps(
            base,
            &value.object_members,
            &value.object_member_order,
            steps,
            shallow_event_values,
            next_prefix.clone(),
        );
        collect_attribute_reference_steps(
            base,
            &value.nested_attrs,
            &value.nested_attr_order,
            steps,
            shallow_event_values,
            next_prefix.clone(),
        );
        steps.push(ValidationReferenceStep::VisibleTarget(current_path));
    }
}

fn collect_attribute_object_reference_steps(
    base: &str,
    members: &BTreeMap<String, AttributeValue>,
    member_order: &[String],
    steps: &mut Vec<ValidationReferenceStep>,
    shallow_event_values: bool,
    prefix: String,
) {
    for key in member_order {
        let Some(value) = members.get(key) else {
            continue;
        };
        let next_prefix = format!("{prefix}{}", render_member_segment(key));
        let current_path = format!("{base}{next_prefix}");
        if let Some(entry_value) = &value.value {
            steps.push(ValidationReferenceStep::ValidateValue {
                path: current_path.clone(),
                value: clone_validation_value(entry_value, shallow_event_values),
            });
        }
        collect_attribute_object_reference_steps(
            base,
            &value.object_members,
            &value.object_member_order,
            steps,
            shallow_event_values,
            next_prefix.clone(),
        );
        collect_attribute_reference_steps(
            base,
            &value.nested_attrs,
            &value.nested_attr_order,
            steps,
            shallow_event_values,
            next_prefix.clone(),
        );
        steps.push(ValidationReferenceStep::VisibleTarget(current_path));
    }
}
