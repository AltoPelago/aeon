use std::collections::{BTreeMap, HashSet};

use crate::pathing::{format_path, render_member_segment};
use crate::{
    AssignmentEvent, AttributeValue, Binding, CanonicalPath, PathSegment, ReferenceSegment, Span,
    Value, normalize_number_literal,
};

/// Encoding-neutral AES event shape used by the portable projection work.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PortableAesEvent {
    pub path: String,
    pub kind: &'static str,
    pub identity: Option<String>,
    pub datatype: Option<String>,
    pub value: Option<String>,
    pub span: Option<Span>,
}

/// Project legacy Rust assignment events into the portable flat AES shape.
///
/// Node values become a value-less `node` event followed by a synthetic
/// `node-head` event. Each crossed node boundary inserts the head index into
/// descendant and reference paths. Attributes are emitted as ordinary events
/// in source preorder beneath their owner's `.@` address space.
#[must_use]
pub fn project_portable_events(events: &[AssignmentEvent]) -> Vec<PortableAesEvent> {
    let node_source_paths = events
        .iter()
        .filter(|event| matches!(unwrap_typed_value(&event.value), Value::NodeLiteral { .. }))
        .map(|event| format_path(&event.path))
        .collect::<HashSet<_>>();
    let mut projected = Vec::new();

    for event in events {
        let translated_path = translate_node_path(&event.path, &node_source_paths);
        let translated_path_text = format_path(&translated_path);
        let value = unwrap_typed_value(&event.value);
        projected.push(project_event(
            event,
            translated_path_text.clone(),
            value,
            &node_source_paths,
        ));
        project_attributes(
            &event.annotations,
            &event.annotation_order,
            &translated_path_text,
            &mut projected,
            &node_source_paths,
        );

        if let Value::NodeLiteral {
            tag,
            structural_id,
            attributes,
            attribute_order,
            datatype,
            ..
        } = value
        {
            let head_path = format!("{translated_path_text}[0]");
            projected.push(PortableAesEvent {
                path: head_path.clone(),
                kind: "node-head",
                identity: structural_id.clone(),
                datatype: datatype.clone(),
                value: Some(tag.clone()),
                span: None,
            });
            project_node_attributes(
                attributes,
                attribute_order,
                &head_path,
                &mut projected,
                &node_source_paths,
            );
        }
    }

    projected
}

fn project_event(
    event: &AssignmentEvent,
    path: String,
    value: &Value,
    node_source_paths: &HashSet<String>,
) -> PortableAesEvent {
    let (kind, projected_value) = project_value(value, node_source_paths);
    PortableAesEvent {
        path,
        kind,
        identity: event.structural_id.clone(),
        datatype: event.datatype.clone(),
        value: projected_value,
        span: Some(event.span),
    }
}

fn project_attributes(
    attributes: &BTreeMap<String, AttributeValue>,
    order: &[String],
    owner_path: &str,
    projected: &mut Vec<PortableAesEvent>,
    node_source_paths: &HashSet<String>,
) {
    for key in ordered_keys(attributes, order) {
        let Some(entry) = attributes.get(key) else {
            continue;
        };
        let path = append_attribute(owner_path, key);
        project_attribute_value(path, entry, projected, node_source_paths);
    }
}

fn project_node_attributes(
    attribute_blocks: &[BTreeMap<String, AttributeValue>],
    order: &[String],
    owner_path: &str,
    projected: &mut Vec<PortableAesEvent>,
    node_source_paths: &HashSet<String>,
) {
    for (index, attributes) in attribute_blocks.iter().enumerate() {
        project_attributes(
            attributes,
            if index == 0 { order } else { &[] },
            owner_path,
            projected,
            node_source_paths,
        );
    }
}

fn project_attribute_value(
    path: String,
    entry: &AttributeValue,
    projected: &mut Vec<PortableAesEvent>,
    node_source_paths: &HashSet<String>,
) {
    let (kind, value) = entry.value.as_ref().map_or(("object", None), |raw_value| {
        project_value(unwrap_typed_value(raw_value), node_source_paths)
    });
    projected.push(PortableAesEvent {
        path: path.clone(),
        kind,
        identity: entry.structural_id.clone(),
        datatype: entry.datatype.clone(),
        value,
        span: None,
    });
    project_attributes(
        &entry.nested_attrs,
        &entry.nested_attr_order,
        &path,
        projected,
        node_source_paths,
    );

    if let Some(raw_value) = &entry.value {
        project_value_children(
            &path,
            unwrap_typed_value(raw_value),
            projected,
            node_source_paths,
        );
    } else {
        for key in ordered_keys(&entry.object_members, &entry.object_member_order) {
            let Some(member) = entry.object_members.get(key) else {
                continue;
            };
            project_attribute_value(
                append_member(&path, key),
                member,
                projected,
                node_source_paths,
            );
        }
    }
}

struct ValueTreeMetadata<'a> {
    identity: Option<&'a String>,
    datatype: Option<&'a String>,
    attributes: Option<(&'a BTreeMap<String, AttributeValue>, &'a [String])>,
    span: Option<Span>,
}

fn project_value_tree(
    path: String,
    raw_value: &Value,
    metadata: ValueTreeMetadata<'_>,
    projected: &mut Vec<PortableAesEvent>,
    node_source_paths: &HashSet<String>,
) {
    let value = unwrap_typed_value(raw_value);
    let (kind, projected_value) = project_value(value, node_source_paths);
    projected.push(PortableAesEvent {
        path: path.clone(),
        kind,
        identity: metadata.identity.cloned(),
        datatype: metadata.datatype.cloned(),
        value: projected_value,
        span: metadata.span,
    });
    if let Some((mapped, order)) = metadata.attributes {
        project_attributes(mapped, order, &path, projected, node_source_paths);
    }
    project_value_children(&path, value, projected, node_source_paths);
}

fn project_value_children(
    path: &str,
    value: &Value,
    projected: &mut Vec<PortableAesEvent>,
    node_source_paths: &HashSet<String>,
) {
    match value {
        Value::ObjectNode { bindings } => {
            for binding in bindings {
                project_binding_tree(
                    append_member(path, &binding.key),
                    binding,
                    projected,
                    node_source_paths,
                );
            }
        }
        Value::ListNode { items } | Value::TupleLiteral { items } => {
            for (index, item) in items.iter().enumerate() {
                project_anonymous_tree(
                    format!("{path}[{index}]"),
                    item,
                    projected,
                    node_source_paths,
                );
            }
        }
        Value::NodeLiteral {
            tag,
            structural_id,
            attributes,
            attribute_order,
            datatype,
            children,
            ..
        } => {
            let head_path = format!("{path}[0]");
            projected.push(PortableAesEvent {
                path: head_path.clone(),
                kind: "node-head",
                identity: structural_id.clone(),
                datatype: datatype.clone(),
                value: Some(tag.clone()),
                span: None,
            });
            project_node_attributes(
                attributes,
                attribute_order,
                &head_path,
                projected,
                node_source_paths,
            );
            for (index, child) in children.iter().enumerate() {
                project_anonymous_tree(
                    format!("{head_path}[{index}]"),
                    child,
                    projected,
                    node_source_paths,
                );
            }
        }
        _ => {}
    }
}

fn project_binding_tree(
    path: String,
    binding: &Binding,
    projected: &mut Vec<PortableAesEvent>,
    node_source_paths: &HashSet<String>,
) {
    project_value_tree(
        path,
        &binding.value,
        ValueTreeMetadata {
            identity: binding.structural_id.as_ref(),
            datatype: binding.datatype.as_ref(),
            attributes: Some((&binding.attributes, &binding.attribute_order)),
            span: Some(binding.span),
        },
        projected,
        node_source_paths,
    );
}

fn project_anonymous_tree(
    path: String,
    raw_value: &Value,
    projected: &mut Vec<PortableAesEvent>,
    node_source_paths: &HashSet<String>,
) {
    if let Value::TypedValue {
        structural_id,
        datatype,
        attributes,
        attribute_order,
        value,
    } = raw_value
    {
        project_value_tree(
            path,
            value,
            ValueTreeMetadata {
                identity: structural_id.as_ref(),
                datatype: datatype.as_ref(),
                attributes: Some((attributes, attribute_order)),
                span: None,
            },
            projected,
            node_source_paths,
        );
    } else {
        project_value_tree(
            path,
            raw_value,
            ValueTreeMetadata {
                identity: None,
                datatype: None,
                attributes: None,
                span: None,
            },
            projected,
            node_source_paths,
        );
    }
}

fn project_value(
    value: &Value,
    node_source_paths: &HashSet<String>,
) -> (&'static str, Option<String>) {
    match value {
        Value::TypedValue { value, .. } => project_value(value, node_source_paths),
        Value::StringLiteral { value, .. } => ("string", Some(value.clone())),
        Value::NumberLiteral { raw } => ("number", Some(normalize_number_literal(raw))),
        Value::InfinityLiteral { raw, .. } => ("infinity", Some(raw.clone())),
        Value::NaNLiteral { raw, .. } => ("nan", Some(raw.clone())),
        Value::NullLiteral { value, .. } => ("null", Some(value.clone())),
        Value::BooleanLiteral { raw } => ("boolean", Some(raw.clone())),
        Value::ToggleLiteral { raw } => ("toggle", Some(raw.clone())),
        Value::HexLiteral { raw } => ("hex", Some(raw.trim_start_matches('#').to_owned())),
        Value::RadixLiteral { raw } => ("radix", Some(raw.trim_start_matches('%').to_owned())),
        Value::EncodingLiteral { raw } => {
            ("encoding", Some(raw.trim_start_matches('&').to_owned()))
        }
        Value::SeparatorLiteral { raw } => {
            ("separator", Some(raw.trim_start_matches('^').to_owned()))
        }
        Value::SansaAddressLiteral { canonical, .. } => ("sansa-address", Some(canonical.clone())),
        Value::DateLiteral { raw } => ("date", Some(raw.clone())),
        Value::TimeLiteral { raw } => ("time", Some(raw.clone())),
        Value::DateTimeLiteral { raw } => ("datetime", Some(raw.clone())),
        Value::ObjectNode { .. } => ("object", None),
        Value::ListNode { .. } => ("list", None),
        Value::TupleLiteral { .. } => ("tuple", None),
        Value::NodeLiteral { .. } => ("node", None),
        Value::CloneReference { segments, .. } => (
            "clone-reference",
            Some(translate_reference_target(segments, node_source_paths)),
        ),
        Value::PointerReference { segments, .. } => (
            "pointer-reference",
            Some(translate_reference_target(segments, node_source_paths)),
        ),
    }
}

fn ordered_keys<'a>(
    values: &'a BTreeMap<String, AttributeValue>,
    order: &'a [String],
) -> Vec<&'a str> {
    let mut keys = Vec::with_capacity(values.len());
    for key in order {
        if values.contains_key(key) && !keys.contains(&key.as_str()) {
            keys.push(key.as_str());
        }
    }
    for key in values.keys() {
        if !keys.contains(&key.as_str()) {
            keys.push(key);
        }
    }
    keys
}

fn append_member(owner_path: &str, key: &str) -> String {
    format!("{owner_path}{}", render_member_segment(key))
}

fn append_attribute(owner_path: &str, key: &str) -> String {
    format!("{owner_path}.@{}", render_member_segment(key))
}

fn unwrap_typed_value(value: &Value) -> &Value {
    match value {
        Value::TypedValue { value, .. } => unwrap_typed_value(value),
        _ => value,
    }
}

fn translate_node_path(path: &CanonicalPath, node_source_paths: &HashSet<String>) -> CanonicalPath {
    let mut source_segments = Vec::new();
    let mut target_segments = Vec::new();

    for segment in &path.segments {
        if matches!(segment, PathSegment::Index(_))
            && !source_segments.is_empty()
            && node_source_paths.contains(&format_path(&CanonicalPath {
                segments: source_segments.clone(),
            }))
        {
            target_segments.push(PathSegment::Index(0));
        }
        source_segments.push(segment.clone());
        target_segments.push(segment.clone());
    }

    CanonicalPath {
        segments: target_segments,
    }
}

fn translate_reference_target(
    segments: &[ReferenceSegment],
    node_source_paths: &HashSet<String>,
) -> String {
    let mut source_segments = vec![PathSegment::Root];
    let mut source_path_is_trackable = true;
    let mut output = String::from("$");

    for segment in segments {
        match segment {
            ReferenceSegment::Key(key) => {
                output.push_str(&render_member_segment(key));
                if source_path_is_trackable {
                    source_segments.push(PathSegment::Member(key.clone()));
                }
            }
            ReferenceSegment::Index(index) => {
                if source_path_is_trackable
                    && node_source_paths.contains(&format_path(&CanonicalPath {
                        segments: source_segments.clone(),
                    }))
                {
                    output.push_str("[0]");
                }
                output.push_str(&format!("[{index}]"));
                if source_path_is_trackable {
                    source_segments.push(PathSegment::Index(*index));
                }
            }
            ReferenceSegment::Attr(key) => {
                output.push_str(".@");
                output.push_str(&render_member_segment(key));
                source_path_is_trackable = false;
            }
        }
    }

    output
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{CompileOptions, compile};

    fn project(source: &str) -> Vec<PortableAesEvent> {
        let result = compile(
            source,
            CompileOptions {
                max_attribute_depth: 8,
                ..CompileOptions::default()
            },
        );
        assert!(result.errors.is_empty(), "{:?}", result.errors);
        project_portable_events(&result.events)
    }

    fn shapes(events: &[PortableAesEvent]) -> Vec<(&str, &str, Option<&str>)> {
        events
            .iter()
            .map(|event| (event.path.as_str(), event.kind, event.identity.as_deref()))
            .collect()
    }

    #[test]
    fn separates_node_identities_at_expanded_paths() {
        let events = project(r#"a\BINDING\ = <tag\HEAD\(\CHILD\ = "value")>"#);
        assert_eq!(
            shapes(&events),
            vec![
                ("$.a", "node", Some("BINDING")),
                ("$.a[0]", "node-head", Some("HEAD")),
                ("$.a[0][0]", "string", Some("CHILD")),
            ]
        );
        assert_eq!(events[0].value, None);
        assert_eq!(events[1].value.as_deref(), Some("tag"));
        assert_eq!(events[1].span, None);
    }

    #[test]
    fn expands_nested_nodes_and_reference_targets() {
        let events = project("a = <outer(<inner(\"leaf\")>)>\ncopy = ~a[0]\nalias = ~>a[0]");
        let paths = events
            .iter()
            .map(|event| (event.path.as_str(), event.kind))
            .collect::<Vec<_>>();
        assert_eq!(
            &paths[..5],
            &[
                ("$.a", "node"),
                ("$.a[0]", "node-head"),
                ("$.a[0][0]", "node"),
                ("$.a[0][0][0]", "node-head"),
                ("$.a[0][0][0][0]", "string"),
            ]
        );
        assert_eq!(events[5].value.as_deref(), Some("$.a[0][0]"));
        assert_eq!(events[6].value.as_deref(), Some("$.a[0][0]"));
    }

    #[test]
    fn flattens_attributes_in_source_preorder() {
        let events = project(
            r#"a\ROOT\@{x\X\@{deep\D\ = 3} = { b\B\ = 2 }} = <tag\HEAD\@{role\R\ = "button"}(\CHILD\@{unit\U\ = "cm"} = "value")>"#,
        );
        assert_eq!(
            shapes(&events),
            vec![
                ("$.a", "node", Some("ROOT")),
                ("$.a.@.x", "object", Some("X")),
                ("$.a.@.x.@.deep", "number", Some("D")),
                ("$.a.@.x.b", "number", Some("B")),
                ("$.a[0]", "node-head", Some("HEAD")),
                ("$.a[0].@.role", "string", Some("R")),
                ("$.a[0][0]", "string", Some("CHILD")),
                ("$.a[0][0].@.unit", "string", Some("U")),
            ]
        );
    }

    #[test]
    fn expands_nodes_and_quoted_members_inside_attribute_space() {
        let events = project(r#"a@{"x.y" = <inner\HEAD\(\CHILD\ = "value")>} = 1"#);
        assert_eq!(
            events
                .iter()
                .map(|event| event.path.as_str())
                .collect::<Vec<_>>(),
            vec![
                "$.a",
                "$.a.@.[\"x.y\"]",
                "$.a.@.[\"x.y\"][0]",
                "$.a.@.[\"x.y\"][0][0]",
            ]
        );
    }

    #[test]
    fn preserves_attribute_declaration_order() {
        let events = project("a@{z = 1, a = 2} = 0");
        assert_eq!(
            events
                .iter()
                .map(|event| event.path.as_str())
                .collect::<Vec<_>>(),
            vec!["$.a", "$.a.@.z", "$.a.@.a"]
        );
    }
}
