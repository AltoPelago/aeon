use std::collections::{BTreeMap, HashSet};

use aes_telex::{
    AEON_DOCUMENT_PROJECTION, DatatypeClarifier, DatatypeDescriptor, GenericArgument,
    TelexEncodeError, TelexLimits, TelexRecord, encode_telex_with_projection_and_limits,
    parse_datatype_descriptor,
};

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
    pub generics: Vec<GenericArgument>,
    pub clarifiers: Vec<DatatypeClarifier>,
    pub value: Option<String>,
    pub span: Option<Span>,
}

pub const RUST_ASSIGNMENT_EVENTS_CONTRACT_V0: &str = "aeon.rust.assignment-events.v0";
pub const RUST_PORTABLE_AES_ADAPTER_V0: &str = "aeon.rust.assignment-events.v0-to-aes.events.v0";
pub const RUST_PORTABLE_AES_ADAPTER_VERSION_V0: &str = "0.1.0-candidate";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PortableAesCompatibilityEvent {
    pub path: Option<String>,
    pub header: Option<String>,
    pub kind: &'static str,
    pub identity: Option<String>,
    pub datatype: Option<String>,
    pub generics: Vec<GenericArgument>,
    pub clarifiers: Vec<DatatypeClarifier>,
    pub value: Option<String>,
    pub origin: Option<String>,
    pub span: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PortableAesConversionChange {
    pub kind: &'static str,
    pub code: &'static str,
    pub field: &'static str,
    pub message: String,
    pub source_path: Option<String>,
    pub target_path: Option<String>,
    pub requires_authorization: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PortableAesConversionReportV0 {
    pub source_contract: &'static str,
    pub target_contract: &'static str,
    pub adapter: &'static str,
    pub adapter_version: &'static str,
    pub profile: &'static str,
    pub projection: Option<&'static str>,
    pub semantic_lossless: bool,
    pub record_lossless: bool,
    pub provenance_lossless: bool,
    pub semantic_loss_authorized: bool,
    pub changes: Vec<PortableAesConversionChange>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PortableAesCompatibilityOptions {
    pub include_headers: bool,
    pub header: Option<crate::HeaderFields>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PortableAesCompatibilityResultV0 {
    pub events: Vec<PortableAesCompatibilityEvent>,
    pub report: PortableAesConversionReportV0,
}

/// Run the named Rust legacy adapter and return a strict portable stream plus
/// its conversion report. Existing projection helpers retain their local span
/// behavior for same-process callers.
#[must_use]
pub fn adapt_rust_assignment_events_to_portable_aes(
    events: &[AssignmentEvent],
    options: &PortableAesCompatibilityOptions,
) -> PortableAesCompatibilityResultV0 {
    let body = events
        .iter()
        .filter(|event| !is_legacy_header_event(event))
        .cloned()
        .collect::<Vec<_>>();
    let headers = if options.include_headers {
        events
            .iter()
            .filter(|event| is_legacy_header_event(event))
            .cloned()
            .collect::<Vec<_>>()
    } else {
        Vec::new()
    };
    let mut projected_headers = project_portable_events(&headers);
    if options.include_headers
        && projected_headers.is_empty()
        && let Some(header) = options.header.as_ref()
    {
        projected_headers = project_header_fields(header);
    }
    let mut projected = projected_headers
        .into_iter()
        .map(|event| compatibility_event(event, true))
        .collect::<Vec<_>>();
    projected.extend(
        project_portable_events(&body)
            .into_iter()
            .map(|event| compatibility_event(event, false)),
    );
    let mut changes = compatibility_changes(events, &body, &projected, options.include_headers);
    if options.header.is_some() && headers.is_empty() && !options.include_headers {
        changes.push(compatibility_change(
            "omitted",
            "AES_COMPAT_HEADER_EXCLUDED",
            "header",
            "The separate AEON header is excluded by the default body-only projection.",
            None,
            None,
        ));
    }
    let has_header_source = !headers.is_empty() || options.header.is_some();
    PortableAesCompatibilityResultV0 {
        events: projected,
        report: PortableAesConversionReportV0 {
            source_contract: RUST_ASSIGNMENT_EVENTS_CONTRACT_V0,
            target_contract: "aes.events.v0",
            adapter: RUST_PORTABLE_AES_ADAPTER_V0,
            adapter_version: RUST_PORTABLE_AES_ADAPTER_VERSION_V0,
            profile: "aes.complete.v0",
            projection: options.include_headers.then_some(AEON_DOCUMENT_PROJECTION),
            semantic_lossless: true,
            record_lossless: events.is_empty() && !has_header_source,
            provenance_lossless: events.is_empty() && !has_header_source,
            semantic_loss_authorized: false,
            changes,
        },
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ExportTelexOptions {
    pub include_headers: bool,
    pub header: Option<crate::HeaderFields>,
    pub profile: Option<String>,
    pub projection: Option<String>,
    pub limits: TelexLimits,
}

#[derive(Debug, Clone, Default)]
pub struct CompileToTelexOptions {
    pub compile: crate::CompileOptions,
    pub telex: ExportTelexOptions,
}

#[derive(Debug, Clone)]
pub struct CompileToTelexResult {
    pub compile: crate::CompileResult,
    pub records: Vec<TelexRecord>,
    pub telex: Option<String>,
    pub encode_error: Option<TelexEncodeError>,
}

/// Compile AEON and export an interoperable Telex stream. `compile` remains
/// the native in-memory entry point; this additive helper is the wire boundary.
#[must_use]
pub fn compile_to_telex(input: &str, mut options: CompileToTelexOptions) -> CompileToTelexResult {
    if options.telex.include_headers {
        options.compile.include_header = true;
    }
    let compile = crate::compile(input, options.compile);
    if !compile.errors.is_empty() {
        return CompileToTelexResult {
            compile,
            records: Vec::new(),
            telex: None,
            encode_error: None,
        };
    }
    if options.telex.include_headers {
        options.telex.header = compile.header.clone();
    }
    match project_telex_records(&compile.events, &options.telex) {
        Ok(records) => {
            let projection = if options.telex.include_headers {
                Some(AEON_DOCUMENT_PROJECTION)
            } else {
                options.telex.projection.as_deref()
            };
            match encode_telex_with_projection_and_limits(
                &records,
                options.telex.profile.as_deref(),
                projection,
                &options.telex.limits,
            ) {
                Ok(telex) => CompileToTelexResult {
                    compile,
                    records,
                    telex: Some(telex),
                    encode_error: None,
                },
                Err(error) => CompileToTelexResult {
                    compile,
                    records,
                    telex: None,
                    encode_error: Some(error),
                },
            }
        }
        Err(error) => CompileToTelexResult {
            compile,
            records: Vec::new(),
            telex: None,
            encode_error: Some(error),
        },
    }
}

pub fn export_telex(
    events: &[AssignmentEvent],
    options: &ExportTelexOptions,
) -> Result<String, TelexEncodeError> {
    let records = project_telex_records(events, options)?;
    let projection = if options.include_headers {
        Some(AEON_DOCUMENT_PROJECTION)
    } else {
        options.projection.as_deref()
    };
    encode_telex_with_projection_and_limits(
        &records,
        options.profile.as_deref(),
        projection,
        &options.limits,
    )
}

pub fn project_telex_records(
    events: &[AssignmentEvent],
    options: &ExportTelexOptions,
) -> Result<Vec<TelexRecord>, TelexEncodeError> {
    let is_header = |event: &AssignmentEvent| matches!(event.path.segments.get(1), Some(PathSegment::Member(key)) if key.starts_with("aeon:"));
    let body = project_portable_events(
        &events
            .iter()
            .filter(|event| !is_header(event))
            .cloned()
            .collect::<Vec<_>>(),
    );
    let mut records = Vec::new();
    if options.include_headers {
        let mut header = project_portable_events(
            &events
                .iter()
                .filter(|event| is_header(event))
                .cloned()
                .collect::<Vec<_>>(),
        );
        if header.is_empty()
            && let Some(fields) = options.header.as_ref()
        {
            header = project_header_fields(fields);
        }
        for event in &header {
            records.push(portable_to_telex(event, "header")?);
        }
    }
    for event in &body {
        records.push(portable_to_telex(event, "path")?);
    }
    Ok(records)
}

fn project_header_fields(header: &crate::HeaderFields) -> Vec<PortableAesEvent> {
    let mut projected = Vec::new();
    let node_source_paths = HashSet::new();
    let mut emitted = HashSet::new();
    for key in header.order.iter().chain(header.fields.keys()) {
        if !emitted.insert(key.as_str()) {
            continue;
        }
        let Some(value) = header.fields.get(key) else {
            continue;
        };
        project_value_tree(
            append_member("$", &format!("aeon:{key}")),
            value,
            ValueTreeMetadata {
                identity: None,
                datatype: None,
                attributes: None,
                span: None,
            },
            &mut projected,
            &node_source_paths,
        );
    }
    split_projected_datatypes(&mut projected);
    projected
}

fn portable_to_telex(
    event: &PortableAesEvent,
    address_field: &str,
) -> Result<TelexRecord, TelexEncodeError> {
    let mut fields = vec![
        (address_field.to_owned(), event.path.clone()),
        ("kind".to_owned(), event.kind.to_owned()),
    ];
    let datatype = event.datatype.as_ref().map(|datatype| DatatypeDescriptor {
        datatype: datatype.clone(),
        generics: event.generics.clone(),
        clarifiers: event.clarifiers.clone(),
    });
    if datatype.is_some() {
        fields.push(("datatype".to_owned(), String::new()));
    }
    if let Some(identity) = &event.identity {
        fields.push(("identity".to_owned(), identity.clone()));
    }
    if let Some(value) = &event.value {
        fields.push(("value".to_owned(), value.clone()));
    }
    Ok(match datatype {
        Some(datatype) => TelexRecord::with_datatype(fields, datatype),
        None => TelexRecord::new(fields),
    })
}

/// Project legacy Rust assignment events into the portable flat AES shape.
///
/// Node values become a value-less `NodeLiteral` event followed by a synthetic
/// `NodeHead` event. Each crossed node boundary inserts the head index into
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
                kind: "NodeHead",
                identity: structural_id.clone(),
                datatype: datatype.clone(),
                generics: Vec::new(),
                clarifiers: Vec::new(),
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

    split_projected_datatypes(&mut projected);
    projected
}

fn split_projected_datatypes(events: &mut [PortableAesEvent]) {
    for event in events {
        let Some(raw) = event.datatype.clone() else {
            continue;
        };
        if let Ok(descriptor) = parse_datatype_descriptor(&raw, &TelexLimits::default()) {
            event.datatype = Some(descriptor.datatype);
            event.generics = descriptor.generics;
            event.clarifiers = descriptor.clarifiers;
        }
    }
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
        generics: Vec::new(),
        clarifiers: Vec::new(),
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
    let (kind, value) = entry
        .value
        .as_ref()
        .map_or(("ObjectNode", None), |raw_value| {
            project_value(unwrap_typed_value(raw_value), node_source_paths)
        });
    projected.push(PortableAesEvent {
        path: path.clone(),
        kind,
        identity: entry.structural_id.clone(),
        datatype: entry.datatype.clone(),
        generics: Vec::new(),
        clarifiers: Vec::new(),
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
        generics: Vec::new(),
        clarifiers: Vec::new(),
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
                kind: "NodeHead",
                identity: structural_id.clone(),
                datatype: datatype.clone(),
                generics: Vec::new(),
                clarifiers: Vec::new(),
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
        Value::StringLiteral { value, .. } => ("StringLiteral", Some(value.clone())),
        Value::NumberLiteral { raw } => ("NumberLiteral", Some(normalize_number_literal(raw))),
        Value::InfinityLiteral { raw, .. } => ("InfinityLiteral", Some(raw.clone())),
        Value::NaNLiteral { raw, .. } => ("NaNLiteral", Some(raw.clone())),
        Value::NullLiteral { value, .. } => ("NullLiteral", Some(value.clone())),
        Value::BooleanLiteral { raw } => ("BooleanLiteral", Some(raw.clone())),
        Value::ToggleLiteral { raw } => ("ToggleLiteral", Some(raw.clone())),
        Value::HexLiteral { raw } => ("HexLiteral", Some(raw.trim_start_matches('#').to_owned())),
        Value::RadixLiteral { raw } => {
            ("RadixLiteral", Some(raw.trim_start_matches('%').to_owned()))
        }
        Value::EncodingLiteral { raw } => (
            "EncodingLiteral",
            Some(raw.trim_start_matches('&').to_owned()),
        ),
        Value::SeparatorLiteral { raw } => (
            "SeparatorLiteral",
            Some(raw.trim_start_matches('^').to_owned()),
        ),
        Value::SansaAddressLiteral { canonical, .. } => {
            ("SansaAddressLiteral", Some(canonical.clone()))
        }
        Value::DateLiteral { raw } => ("DateLiteral", Some(raw.clone())),
        Value::TimeLiteral { raw } => ("TimeLiteral", Some(raw.clone())),
        Value::DateTimeLiteral { raw } => (
            if raw.contains('&') {
                "WTCDateTimeLiteral"
            } else {
                "DateTimeLiteral"
            },
            Some(raw.clone()),
        ),
        Value::ObjectNode { .. } => ("ObjectNode", None),
        Value::ListNode { .. } => ("ListNode", None),
        Value::TupleLiteral { .. } => ("TupleLiteral", None),
        Value::NodeLiteral { .. } => ("NodeLiteral", None),
        Value::CloneReference { segments, .. } => (
            "CloneReference",
            Some(translate_reference_target(segments, node_source_paths)),
        ),
        Value::PointerReference { segments, .. } => (
            "PointerReference",
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

fn is_legacy_header_event(event: &AssignmentEvent) -> bool {
    matches!(event.path.segments.get(1), Some(PathSegment::Member(key)) if key.starts_with("aeon:"))
}

fn compatibility_event(event: PortableAesEvent, header: bool) -> PortableAesCompatibilityEvent {
    PortableAesCompatibilityEvent {
        path: (!header).then(|| event.path.clone()),
        header: header.then_some(event.path),
        kind: event.kind,
        identity: event.identity,
        datatype: event.datatype,
        generics: event.generics,
        clarifiers: event.clarifiers,
        value: event.value,
        origin: None,
        span: None,
    }
}

fn compatibility_change(
    kind: &'static str,
    code: &'static str,
    field: &'static str,
    message: impl Into<String>,
    source_path: Option<String>,
    target_path: Option<String>,
) -> PortableAesConversionChange {
    PortableAesConversionChange {
        kind,
        code,
        field,
        message: message.into(),
        source_path,
        target_path,
        requires_authorization: kind == "semantic-loss",
    }
}

fn compatibility_changes(
    source_events: &[AssignmentEvent],
    body_events: &[AssignmentEvent],
    projected: &[PortableAesCompatibilityEvent],
    include_headers: bool,
) -> Vec<PortableAesConversionChange> {
    let mut changes = Vec::new();
    let node_source_paths = body_events
        .iter()
        .filter(|event| matches!(unwrap_typed_value(&event.value), Value::NodeLiteral { .. }))
        .map(|event| format_path(&event.path))
        .collect::<HashSet<_>>();
    let path_map = body_events
        .iter()
        .map(|event| {
            (
                format_path(&event.path),
                format_path(&translate_node_path(&event.path, &node_source_paths)),
            )
        })
        .collect::<BTreeMap<_, _>>();

    for event in source_events {
        let source_path = format_path(&event.path);
        let header = is_legacy_header_event(event);
        let target_path = if header && include_headers {
            Some(source_path.clone())
        } else {
            path_map.get(&source_path).cloned()
        };
        changes.push(compatibility_change(
            "omitted",
            "AES_COMPAT_PROVENANCE_OMITTED",
            "span",
            "The local source span is omitted because it is not bound to an immutable portable origin.",
            Some(source_path.clone()),
            target_path.clone(),
        ));
        changes.push(compatibility_change(
            "transformed",
            "AES_COMPAT_SOURCE_REPRESENTATION_REDUCED",
            "key,value",
            "Implementation-specific navigation fields and AST representation are reduced to portable AES fields.",
            Some(source_path.clone()),
            target_path.clone(),
        ));
        if header && !include_headers {
            changes.push(compatibility_change(
                "omitted",
                "AES_COMPAT_HEADER_EXCLUDED",
                "event",
                "The synthetic AEON header event is excluded by the default body-only projection.",
                Some(source_path),
                None,
            ));
            continue;
        }
        if header {
            changes.push(compatibility_change(
                "transformed",
                "AES_COMPAT_HEADER_PROJECTED",
                "path",
                "The recognized synthetic AEON header event is moved to the header address plane.",
                Some(source_path.clone()),
                Some(source_path.clone()),
            ));
        } else if target_path.as_deref() != Some(source_path.as_str()) {
            changes.push(compatibility_change(
                "transformed",
                "AES_COMPAT_PATH_TRANSLATED",
                "path",
                "The source occurrence path is translated through the explicit portable node-head level.",
                Some(source_path.clone()),
                target_path.clone(),
            ));
        }
        match unwrap_typed_value(&event.value) {
            Value::CloneReference { segments, .. } | Value::PointerReference { segments, .. } => {
                let source_target = translate_reference_target(segments, &HashSet::new());
                let portable_target = translate_reference_target(segments, &node_source_paths);
                if source_target != portable_target {
                    changes.push(compatibility_change(
                        "transformed",
                        "AES_COMPAT_REFERENCE_TRANSLATED",
                        "value.segments",
                        format!(
                            "The reference target is translated from {source_target} to {portable_target}."
                        ),
                        Some(source_path),
                        target_path,
                    ));
                }
            }
            _ => {}
        }
    }

    for event in projected {
        let target_path = event.path.clone().or_else(|| event.header.clone());
        if event.header.is_some() {
            changes.push(compatibility_change(
                "transformed",
                "AES_COMPAT_HEADER_PROJECTED",
                "header",
                "The recognized AEON header field is emitted in the header address plane.",
                None,
                target_path.clone(),
            ));
        }
        if event.kind == "NodeHead" {
            changes.push(compatibility_change(
                "synthesized",
                "AES_COMPAT_NODE_HEAD_SYNTHESIZED",
                "NodeHead",
                "The implicit implementation node tag is emitted as an explicit portable NodeHead event.",
                None,
                target_path.clone(),
            ));
        }
        if target_path
            .as_deref()
            .is_some_and(|path| path.contains(".@"))
        {
            changes.push(compatibility_change(
                "transformed",
                "AES_COMPAT_ATTRIBUTE_FLATTENED",
                "attributes",
                "The nested implementation attribute entry is emitted as an ordinary flat AES event.",
                None,
                target_path.clone(),
            ));
        }
        if event.datatype.is_some() {
            changes.push(compatibility_change(
                "transformed",
                "AES_COMPAT_DATATYPE_EXPANDED",
                "datatype",
                "The combined datatype descriptor is expanded into datatype, generics, and clarifiers.",
                None,
                target_path,
            ));
        }
    }
    changes
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

    #[test]
    fn named_legacy_adapter_returns_an_explicit_conversion_report() {
        let result = compile(
            "a@{role = \"root\"} = <tag(\"child\")>\ncopy = ~a[0]\nitems:list<int> = [1]",
            CompileOptions {
                max_attribute_depth: 8,
                ..CompileOptions::default()
            },
        );
        assert!(result.errors.is_empty(), "{:?}", result.errors);
        let converted = adapt_rust_assignment_events_to_portable_aes(
            &result.events,
            &PortableAesCompatibilityOptions::default(),
        );
        assert_eq!(
            converted.report.source_contract,
            RUST_ASSIGNMENT_EVENTS_CONTRACT_V0
        );
        assert_eq!(converted.report.target_contract, "aes.events.v0");
        assert_eq!(converted.report.adapter, RUST_PORTABLE_AES_ADAPTER_V0);
        assert_eq!(converted.report.profile, "aes.complete.v0");
        assert_eq!(converted.report.projection, None);
        assert!(converted.report.semantic_lossless);
        assert!(!converted.report.record_lossless);
        assert!(!converted.report.provenance_lossless);
        assert!(converted.events.iter().all(|event| event.span.is_none()));
        let codes = converted
            .report
            .changes
            .iter()
            .map(|change| change.code)
            .collect::<HashSet<_>>();
        for expected in [
            "AES_COMPAT_NODE_HEAD_SYNTHESIZED",
            "AES_COMPAT_ATTRIBUTE_FLATTENED",
            "AES_COMPAT_DATATYPE_EXPANDED",
            "AES_COMPAT_REFERENCE_TRANSLATED",
            "AES_COMPAT_PROVENANCE_OMITTED",
        ] {
            assert!(codes.contains(expected), "missing {expected}: {codes:?}");
        }
    }

    #[test]
    fn named_legacy_adapter_keeps_headers_opt_in() {
        let result = compile(
            "aeon:mode = \"transport\"\na = 1",
            CompileOptions::default(),
        );
        assert!(result.errors.is_empty(), "{:?}", result.errors);
        let body = adapt_rust_assignment_events_to_portable_aes(
            &result.events,
            &PortableAesCompatibilityOptions {
                header: result.header.clone(),
                ..PortableAesCompatibilityOptions::default()
            },
        );
        assert_eq!(body.events.len(), 1);
        assert_eq!(body.events[0].path.as_deref(), Some("$.a"));
        assert!(
            body.report
                .changes
                .iter()
                .any(|change| change.code == "AES_COMPAT_HEADER_EXCLUDED")
        );
        let document = adapt_rust_assignment_events_to_portable_aes(
            &result.events,
            &PortableAesCompatibilityOptions {
                include_headers: true,
                header: result.header.clone(),
            },
        );
        assert_eq!(document.report.projection, Some(AEON_DOCUMENT_PROJECTION));
        assert_eq!(
            document.events[0].header.as_deref(),
            Some("$.[\"aeon:mode\"]")
        );
        assert_eq!(document.events[1].path.as_deref(), Some("$.a"));
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
                ("$.a", "NodeLiteral", Some("BINDING")),
                ("$.a[0]", "NodeHead", Some("HEAD")),
                ("$.a[0][0]", "StringLiteral", Some("CHILD")),
            ]
        );
        assert_eq!(events[0].value, None);
        assert_eq!(events[1].value.as_deref(), Some("tag"));
        assert_eq!(events[1].span, None);
    }

    #[test]
    fn distinguishes_datetime_and_wtc_representation_kinds() {
        let events = project("ordinary = 2025-01-01T09:30Z\nworld = 2025-01-01T09:30&local");
        assert_eq!(events[0].kind, "DateTimeLiteral");
        assert_eq!(events[1].kind, "WTCDateTimeLiteral");
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
                ("$.a", "NodeLiteral"),
                ("$.a[0]", "NodeHead"),
                ("$.a[0][0]", "NodeLiteral"),
                ("$.a[0][0][0]", "NodeHead"),
                ("$.a[0][0][0][0]", "StringLiteral"),
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
                ("$.a", "NodeLiteral", Some("ROOT")),
                ("$.a.@.x", "ObjectNode", Some("X")),
                ("$.a.@.x.@.deep", "NumberLiteral", Some("D")),
                ("$.a.@.x.b", "NumberLiteral", Some("B")),
                ("$.a[0]", "NodeHead", Some("HEAD")),
                ("$.a[0].@.role", "StringLiteral", Some("R")),
                ("$.a[0][0]", "StringLiteral", Some("CHILD")),
                ("$.a[0][0].@.unit", "StringLiteral", Some("U")),
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

    #[test]
    fn compiles_to_telex_without_changing_the_native_compile_api() {
        let result = compile_to_telex(
            "aeon:mode = \"transport\"\na:list<int> = [2, 3]",
            CompileToTelexOptions::default(),
        );
        assert!(
            result.compile.errors.is_empty(),
            "{:?}",
            result.compile.errors
        );
        assert_eq!(result.records.len(), 3);
        let telex = result.telex.expect("encoded Telex");
        assert!(telex.starts_with("telex.aes=0\n"));
        assert!(
            telex.contains("path=$.a\nkind=ListNode\ndatatype=list<int>"),
            "{telex}"
        );
    }

    #[test]
    fn exposes_datatype_generics_and_clarifiers_as_separate_event_components() {
        let events = project("a:list<int> = [2]\nb:sep[\".\"] = ^one.two");
        assert_eq!(events[0].datatype.as_deref(), Some("list"));
        assert!(matches!(
            events[0].generics.as_slice(),
            [GenericArgument::Datatype(datatype)] if datatype.datatype == "int"
        ));
        let separator = events
            .iter()
            .find(|event| event.path == "$.b")
            .expect("separator event");
        assert_eq!(separator.datatype.as_deref(), Some("sep"));
        assert!(matches!(
            separator.clarifiers.as_slice(),
            [DatatypeClarifier { kind: aes_telex::ClarifierKind::StringLiteral, value }] if value == "."
        ));
    }

    #[test]
    fn exports_headers_only_under_the_document_projection() {
        let result = compile_to_telex(
            "aeon:mode = \"transport\"\na = 1",
            CompileToTelexOptions {
                telex: ExportTelexOptions {
                    include_headers: true,
                    ..ExportTelexOptions::default()
                },
                ..CompileToTelexOptions::default()
            },
        );
        let telex = result.telex.expect("encoded Telex");
        assert!(telex.contains("projection=aeon.document.v0"));
        assert!(telex.contains("header=$.[\"aeon:mode\"]"), "{telex}");
    }
}
