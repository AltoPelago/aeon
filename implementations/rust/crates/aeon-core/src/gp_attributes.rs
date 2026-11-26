//! GP metadata and node-head claims do not have AssignmentEvents. Walk authored occurrences
//! before projection can discard metadata, without following references.
use super::pathing::is_identifier;
use super::validation::AttributeDatatypeCheck;
use super::{
    AttributeValue, Binding, Diagnostic, GpDatatypePosition, Span, Value,
    gp_custom_clarifier_literal, parse_gp_datatype_surface, validate_gp_datatype_surface,
};
use std::collections::BTreeMap;
use std::fmt::Write;

fn render_child_member_path(parent: &str, key: &str) -> String {
    if is_identifier(key) {
        format!("{parent}.{key}")
    } else {
        // Diagnostic metadata addresses must escape controls as well as
        // quotes/backslashes, matching the other public implementations.
        let mut output = format!("{parent}.[\"");
        for ch in key.chars() {
            match ch {
                '"' => output.push_str("\\\""),
                '\\' => output.push_str("\\\\"),
                '\n' => output.push_str("\\n"),
                '\r' => output.push_str("\\r"),
                '\t' => output.push_str("\\t"),
                '\u{08}' => output.push_str("\\b"),
                '\u{0c}' => output.push_str("\\f"),
                ch if ch <= '\u{1f}' => {
                    write!(&mut output, "\\u{:04x}", u32::from(ch)).expect("String write")
                }
                _ => output.push(ch),
            }
        }
        output.push_str("\"]");
        output
    }
}

enum Task<'a> {
    Binding(&'a Binding, String, bool),
    Attribute(&'a AttributeValue, String, Span),
    Value(&'a Value, String, Span, bool),
}

fn push_attributes<'a>(
    tasks: &mut Vec<Task<'a>>,
    attributes: &'a BTreeMap<String, AttributeValue>,
    order: &[String],
    owner: &str,
    span: Span,
) {
    if order.is_empty() {
        for (key, entry) in attributes.iter().rev() {
            tasks.push(Task::Attribute(
                entry,
                render_child_member_path(&format!("{owner}.@"), key),
                span,
            ));
        }
    } else {
        for key in order.iter().rev() {
            if let Some(entry) = attributes.get(key) {
                tasks.push(Task::Attribute(
                    entry,
                    render_child_member_path(&format!("{owner}.@"), key),
                    span,
                ));
            }
        }
    }
}

pub(crate) fn validate_gp_unprojected_datatypes(
    bindings: &[Binding],
    errors: &mut Vec<Diagnostic>,
    mut value_checks: Option<&mut Vec<AttributeDatatypeCheck>>,
) {
    visit_gp_unprojected_datatypes(bindings, |datatype, value, path, span, position| {
        if let Some(checks) = value_checks.as_deref_mut() {
            collect_value_check(checks, datatype, value, path, position);
        }
        if let Some(surface) = parse_gp_datatype_surface(datatype) {
            validate_gp_datatype_surface(
                &surface,
                path,
                span,
                errors,
                value.is_some_and(gp_custom_clarifier_literal),
                position,
            );
        }
    });
}

pub(crate) fn collect_gp_attribute_value_checks(
    bindings: &[Binding],
    checks: &mut Vec<AttributeDatatypeCheck>,
) {
    visit_gp_unprojected_datatypes(bindings, |datatype, value, path, _, position| {
        collect_value_check(checks, datatype, value, path, position);
    });
}

fn collect_value_check(
    checks: &mut Vec<AttributeDatatypeCheck>,
    datatype: &str,
    value: Option<&Value>,
    path: &str,
    position: GpDatatypePosition,
) {
    if position == GpDatatypePosition::Binding
        && let Some(value) = value
        && let Some(check) = AttributeDatatypeCheck::gp_custom_value(datatype, value, path)
    {
        checks.push(check);
    }
}

fn visit_gp_unprojected_datatypes(
    bindings: &[Binding],
    mut visit: impl FnMut(&str, Option<&Value>, &str, Span, GpDatatypePosition),
) {
    let mut tasks = Vec::new();
    for binding in bindings.iter().rev().filter(|b| !b.is_header) {
        tasks.push(Task::Binding(
            binding,
            render_child_member_path("$", &binding.key),
            false,
        ));
    }
    while let Some(task) = tasks.pop() {
        match task {
            Task::Binding(binding, path, metadata) => {
                if metadata && let Some(datatype) = binding.datatype.as_deref() {
                    visit(
                        datatype,
                        Some(&binding.value),
                        &path,
                        binding.span,
                        GpDatatypePosition::Binding,
                    );
                }
                tasks.push(Task::Value(
                    &binding.value,
                    path.clone(),
                    binding.span,
                    metadata,
                ));
                push_attributes(
                    &mut tasks,
                    &binding.attributes,
                    &binding.attribute_order,
                    &path,
                    binding.span,
                );
            }
            Task::Attribute(entry, path, fallback_span) => {
                let span = entry.span.unwrap_or(fallback_span);
                if let Some(datatype) = entry.datatype.as_deref() {
                    visit(
                        datatype,
                        entry.value.as_ref(),
                        &path,
                        span,
                        GpDatatypePosition::Binding,
                    );
                }
                if let Some(value) = &entry.value {
                    tasks.push(Task::Value(value, path.clone(), span, true));
                }
                // Bare metadata objects have a dedicated representation rather
                // than a Value::ObjectNode; these are members, not attributes.
                for key in entry.object_member_order.iter().rev() {
                    if let Some(child) = entry.object_members.get(key) {
                        tasks.push(Task::Attribute(
                            child,
                            render_child_member_path(&path, key),
                            span,
                        ));
                    }
                }
                push_attributes(
                    &mut tasks,
                    &entry.nested_attrs,
                    &entry.nested_attr_order,
                    &path,
                    span,
                );
            }
            Task::Value(value, path, span, metadata) => match value {
                Value::TypedValue {
                    datatype,
                    attributes,
                    attribute_order,
                    value,
                    ..
                } => {
                    if metadata && let Some(datatype) = datatype.as_deref() {
                        visit(
                            datatype,
                            Some(value),
                            &path,
                            span,
                            GpDatatypePosition::Binding,
                        );
                    }
                    tasks.push(Task::Value(value, path.clone(), span, metadata));
                    push_attributes(&mut tasks, attributes, attribute_order, &path, span);
                }
                Value::ObjectNode { bindings } => {
                    for binding in bindings.iter().rev() {
                        tasks.push(Task::Binding(
                            binding,
                            render_child_member_path(&path, &binding.key),
                            metadata,
                        ));
                    }
                }
                Value::ListNode { items } | Value::TupleLiteral { items } => {
                    for (index, item) in items.iter().enumerate().rev() {
                        tasks.push(Task::Value(
                            item,
                            format!("{path}[{index}]"),
                            span,
                            metadata,
                        ));
                    }
                }
                Value::NodeLiteral {
                    datatype,
                    attributes,
                    attribute_order,
                    children,
                    head_span,
                    ..
                } => {
                    let head = format!("{path}[0]");
                    // Node-head datatypes have no payload AssignmentEvent,
                    // even when the node itself belongs to the body payload.
                    if let Some(datatype) = datatype.as_deref() {
                        visit(
                            datatype,
                            Some(value),
                            &head,
                            *head_span,
                            GpDatatypePosition::NodeHead,
                        );
                    }
                    for (index, child) in children.iter().enumerate().rev() {
                        tasks.push(Task::Value(
                            child,
                            format!("{head}[{index}]"),
                            span,
                            metadata,
                        ));
                    }
                    for attributes in attributes.iter().rev() {
                        push_attributes(&mut tasks, attributes, attribute_order, &head, *head_span);
                    }
                }
                _ => {}
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::render_child_member_path;

    #[test]
    fn metadata_member_paths_use_json_escaping_for_every_ascii_control() {
        for key in (0_u8..=31)
            .map(|ch| format!("a{}b", char::from(ch)))
            .chain(["a\\b".to_owned(), "a\"b".to_owned(), "雪".to_owned()])
        {
            assert_eq!(
                render_child_member_path("$", &key),
                format!("$.[{}]", serde_json::to_string(&key).expect("key"))
            );
        }
    }
}
