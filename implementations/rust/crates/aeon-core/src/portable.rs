use std::collections::{BTreeMap, HashMap, HashSet};
use std::error::Error;
use std::fmt;

use aes_telex::{
    AEON_DOCUMENT_PROJECTION, AesCanonicalPath, AesEventAddress, AesEventRecord, AesValueKind,
    DatatypeClarifier, DatatypeDescriptor, GenericArgument, TelexEncodeError, TelexLimits,
    TelexRecord, encode_aes_event_records_with_projection_and_limits,
    encode_telex_with_projection_and_limits, parse_datatype_descriptor,
};
use sha2::{Digest, Sha256};

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

struct ProjectedAesEvent {
    path: AesCanonicalPath,
    kind: &'static str,
    identity: Option<String>,
    datatype: Option<String>,
    generics: Vec<GenericArgument>,
    clarifiers: Vec<DatatypeClarifier>,
    value: Option<String>,
    span: Option<Span>,
}

impl ProjectedAesEvent {
    fn into_portable(self) -> PortableAesEvent {
        PortableAesEvent {
            path: self.path.as_str().to_owned(),
            kind: self.kind,
            identity: self.identity,
            datatype: self.datatype,
            generics: self.generics,
            clarifiers: self.clarifiers,
            value: self.value,
            span: self.span,
        }
    }
}

pub const RUST_ASSIGNMENT_EVENTS_CONTRACT_V0: &str = "aeon.rust.assignment-events.v0";
pub const RUST_PORTABLE_AES_ADAPTER_V0: &str = "aeon.rust.assignment-events.v0-to-aes.events.v1";
pub const RUST_PORTABLE_AES_ADAPTER_VERSION_V1: &str = "1.0.0";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PortableAesSourceError {
    pub code: &'static str,
    pub detail: String,
}

impl fmt::Display for PortableAesSourceError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.detail)
    }
}

impl Error for PortableAesSourceError {}

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
pub struct PortableAesConversionReportV1 {
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
    /// Exact, unnormalized UTF-8 source artifact used for optional provenance.
    pub source_bytes: Option<Vec<u8>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PortableAesCompatibilityResultV1 {
    pub events: Vec<PortableAesCompatibilityEvent>,
    pub report: PortableAesConversionReportV1,
}

/// Run the named Rust legacy adapter and return a strict portable stream plus
/// its conversion report. Existing projection helpers retain their local span
/// behavior for same-process callers.
pub fn adapt_rust_assignment_events_to_portable_aes(
    events: &[AssignmentEvent],
    options: &PortableAesCompatibilityOptions,
) -> Result<PortableAesCompatibilityResultV1, PortableAesSourceError> {
    let source_context = options
        .source_bytes
        .as_deref()
        .map(create_source_context)
        .transpose()?;
    let is_header =
        |event: &AssignmentEvent| is_legacy_header_event(event, options.header.as_ref());
    let has_legacy_header_source = events.iter().any(is_header);
    let body = events
        .iter()
        .filter(|event| !is_header(event))
        .cloned()
        .collect::<Vec<_>>();
    let headers = if options.include_headers {
        events
            .iter()
            .filter(|event| is_header(event))
            .cloned()
            .collect::<Vec<_>>()
    } else {
        Vec::new()
    };
    let mut projected_headers = project_portable_events(&headers);
    if options.include_headers
        && let Some(header) = options.header.as_ref()
    {
        // Expanded legacy events may contain only inline descendants of a
        // structured header value. The retained header model establishes the
        // complete ordered plane; matching legacy records overlay it to keep
        // their richer local metadata.
        projected_headers =
            merge_header_projections(project_header_fields(header), projected_headers);
    }
    let mut projected = projected_headers
        .into_iter()
        .map(|event| compatibility_event(event, true, source_context.as_ref()))
        .collect::<Result<Vec<_>, _>>()?;
    projected.extend(
        project_portable_events(&body)
            .into_iter()
            .map(|event| compatibility_event(event, false, source_context.as_ref()))
            .collect::<Result<Vec<_>, _>>()?,
    );
    let mut changes = compatibility_changes(
        events,
        &body,
        &projected,
        options.include_headers,
        source_context.is_some(),
        options.header.as_ref(),
    );
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
    let has_header_source = has_legacy_header_source || options.header.is_some();
    let no_source_records = events.is_empty() && !has_header_source;
    let all_source_records_included = options.include_headers || !has_header_source;
    let provenance_lossless = no_source_records
        || (source_context.is_some()
            && all_source_records_included
            && !projected.is_empty()
            && projected.iter().all(|event| event.span.is_some()));
    Ok(PortableAesCompatibilityResultV1 {
        events: projected,
        report: PortableAesConversionReportV1 {
            source_contract: RUST_ASSIGNMENT_EVENTS_CONTRACT_V0,
            target_contract: "aes.events.v1",
            adapter: RUST_PORTABLE_AES_ADAPTER_V0,
            adapter_version: RUST_PORTABLE_AES_ADAPTER_VERSION_V1,
            profile: "aes.complete.v1",
            projection: options.include_headers.then_some(AEON_DOCUMENT_PROJECTION),
            semantic_lossless: true,
            record_lossless: events.is_empty() && !has_header_source,
            provenance_lossless,
            semantic_loss_authorized: false,
            changes,
        },
    })
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ExportTelexOptions {
    pub include_headers: bool,
    pub header: Option<crate::HeaderFields>,
    pub profile: Option<String>,
    pub projection: Option<String>,
    pub limits: TelexLimits,
    /// Exact, unnormalized UTF-8 source artifact used for optional provenance.
    pub source_bytes: Option<Vec<u8>>,
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
    if options
        .telex
        .source_bytes
        .as_deref()
        .is_some_and(|bytes| std::str::from_utf8(bytes).is_ok() && bytes != input.as_bytes())
    {
        return CompileToTelexResult {
            compile,
            records: Vec::new(),
            telex: None,
            encode_error: Some(TelexEncodeError {
                code: "AES_COMPAT_SOURCE_MISMATCH",
                detail: String::from(
                    "Exact source_bytes must match the AEON string compiled for Telex export.",
                ),
                counter: None,
                observed: None,
                limit: None,
            }),
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
    if supports_typed_body_projection(events, options) {
        let records = project_aes_event_records(events);
        return encode_aes_event_records_with_projection_and_limits(
            &records,
            options.profile.as_deref(),
            options.projection.as_deref(),
            &options.limits,
        );
    }
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
    // The common body-only export needs neither the compatibility report nor
    // provenance fields. Project it directly so large streams do not clone the
    // complete assignment-event tree and then materialize a second event model.
    if supports_typed_body_projection(events, options) {
        let mut records = Vec::with_capacity(events.len());
        project_portable_events_into(events, &mut TelexRecordSink(&mut records));
        return Ok(records);
    }

    project_telex_records_via_compatibility(events, options)
}

fn supports_typed_body_projection(
    events: &[AssignmentEvent],
    options: &ExportTelexOptions,
) -> bool {
    !options.include_headers
        && options.source_bytes.is_none()
        && events
            .iter()
            .all(|event| event.source_plane == crate::SourcePlane::Body)
}

/// Project body-plane assignments into AES's fixed-field producer model.
///
/// This is exposed for repository benchmark instrumentation; ordinary callers
/// should use [`export_telex`].
#[doc(hidden)]
#[must_use]
pub fn project_aes_event_records(events: &[AssignmentEvent]) -> Vec<AesEventRecord> {
    let mut records = Vec::with_capacity(events.len());
    project_portable_events_into(events, &mut AesEventRecordSink(&mut records));
    records
}

fn project_telex_records_via_compatibility(
    events: &[AssignmentEvent],
    options: &ExportTelexOptions,
) -> Result<Vec<TelexRecord>, TelexEncodeError> {
    let converted = adapt_rust_assignment_events_to_portable_aes(
        events,
        &PortableAesCompatibilityOptions {
            include_headers: options.include_headers,
            header: options.header.clone(),
            source_bytes: options.source_bytes.clone(),
        },
    )
    .map_err(source_error_to_telex)?;
    converted
        .events
        .iter()
        .map(compatibility_event_to_telex)
        .collect()
}

fn portable_body_event_to_telex(event: PortableAesEvent) -> TelexRecord {
    let mut fields = vec![
        ("path".to_owned(), event.path),
        ("kind".to_owned(), event.kind.to_owned()),
    ];
    let datatype = event.datatype.map(|datatype| DatatypeDescriptor {
        datatype,
        generics: event.generics,
        clarifiers: event.clarifiers,
    });
    if datatype.is_some() {
        fields.push(("datatype".to_owned(), String::new()));
    }
    if let Some(identity) = event.identity {
        fields.push(("identity".to_owned(), identity));
    }
    if let Some(value) = event.value {
        fields.push(("value".to_owned(), value));
    }
    match datatype {
        Some(datatype) => TelexRecord::with_datatype(fields, datatype),
        None => TelexRecord::new(fields),
    }
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
        let mut path = AesCanonicalPath::root();
        path.push_member(&format!("aeon:{key}"))
            .expect("header names produce nonempty canonical members");
        project_value_tree(
            path,
            value,
            ValueTreeMetadata {
                identity: None,
                datatype: None,
                attributes: None,
                span: header.spans.get(key).copied(),
            },
            &mut projected,
            &node_source_paths,
        );
    }
    split_projected_datatypes(&mut projected);
    projected
}

fn merge_header_projections(
    retained: Vec<PortableAesEvent>,
    legacy: Vec<PortableAesEvent>,
) -> Vec<PortableAesEvent> {
    let mut legacy_by_path = legacy
        .iter()
        .cloned()
        .map(|event| (event.path.clone(), event))
        .collect::<HashMap<_, _>>();
    let mut merged = retained
        .into_iter()
        .map(|event| legacy_by_path.remove(&event.path).unwrap_or(event))
        .collect::<Vec<_>>();
    merged.extend(
        legacy
            .into_iter()
            .filter(|event| legacy_by_path.contains_key(&event.path)),
    );
    merged
}

fn compatibility_event_to_telex(
    event: &PortableAesCompatibilityEvent,
) -> Result<TelexRecord, TelexEncodeError> {
    let (address_field, address) = match (&event.path, &event.header) {
        (Some(path), None) => ("path", path),
        (None, Some(header)) => ("header", header),
        _ => {
            return Err(TelexEncodeError {
                code: "AES_COMPAT_ADDRESS_INVALID",
                detail: String::from(
                    "Portable compatibility events require exactly one path or header address.",
                ),
                counter: None,
                observed: None,
                limit: None,
            });
        }
    };
    let mut fields = vec![
        (address_field.to_owned(), address.clone()),
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
    if let Some(origin) = &event.origin {
        fields.push(("origin".to_owned(), origin.clone()));
    }
    if let Some(span) = &event.span {
        fields.push(("span".to_owned(), span.clone()));
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
    let mut projected = Vec::with_capacity(events.len());
    project_portable_events_into(events, &mut projected);
    split_projected_datatypes(&mut projected);
    projected
}

type NodeSourcePaths = HashSet<Vec<PathSegment>>;
const MIN_REUSABLE_AES_PATH_DEPTH: usize = 8;
const MAX_REUSABLE_AES_PATH_EVENTS: usize = 1_024;

trait PortableEventSink {
    fn reserve(&mut self, additional: usize);
    fn push(&mut self, event: ProjectedAesEvent);
}

impl PortableEventSink for Vec<PortableAesEvent> {
    fn reserve(&mut self, additional: usize) {
        Vec::reserve(self, additional);
    }

    fn push(&mut self, event: ProjectedAesEvent) {
        Vec::push(self, event.into_portable());
    }
}

struct TelexRecordSink<'a>(&'a mut Vec<TelexRecord>);

impl PortableEventSink for TelexRecordSink<'_> {
    fn reserve(&mut self, additional: usize) {
        self.0.reserve(additional);
    }

    fn push(&mut self, event: ProjectedAesEvent) {
        let mut event = event.into_portable();
        split_projected_datatype(&mut event);
        self.0.push(portable_body_event_to_telex(event));
    }
}

struct AesEventRecordSink<'a>(&'a mut Vec<AesEventRecord>);

impl PortableEventSink for AesEventRecordSink<'_> {
    fn reserve(&mut self, additional: usize) {
        self.0.reserve(additional);
    }

    fn push(&mut self, event: ProjectedAesEvent) {
        let datatype = event.datatype.map(|raw| {
            parse_datatype_descriptor(&raw, &TelexLimits::default()).unwrap_or(DatatypeDescriptor {
                datatype: raw,
                generics: event.generics,
                clarifiers: event.clarifiers,
            })
        });
        self.0.push(AesEventRecord {
            address: AesEventAddress::Path(event.path),
            kind: aes_value_kind(event.kind),
            datatype,
            identity: event.identity,
            value: event.value,
            origin: None,
            span: None,
        });
    }
}

fn aes_value_kind(kind: &str) -> AesValueKind {
    match kind {
        "StringLiteral" => AesValueKind::StringLiteral,
        "NumberLiteral" => AesValueKind::NumberLiteral,
        "InfinityLiteral" => AesValueKind::InfinityLiteral,
        "NaNLiteral" => AesValueKind::NaNLiteral,
        "NullLiteral" => AesValueKind::NullLiteral,
        "BooleanLiteral" => AesValueKind::BooleanLiteral,
        "ToggleLiteral" => AesValueKind::ToggleLiteral,
        "HexLiteral" => AesValueKind::HexLiteral,
        "RadixLiteral" => AesValueKind::RadixLiteral,
        "EncodingLiteral" => AesValueKind::EncodingLiteral,
        "SeparatorLiteral" => AesValueKind::SeparatorLiteral,
        "SansaAddressLiteral" => AesValueKind::SansaAddressLiteral,
        "DateLiteral" => AesValueKind::DateLiteral,
        "TimeLiteral" => AesValueKind::TimeLiteral,
        "DateTimeLiteral" => AesValueKind::DateTimeLiteral,
        "WTCDateTimeLiteral" => AesValueKind::WtcDateTimeLiteral,
        "ObjectNode" => AesValueKind::ObjectNode,
        "ListNode" => AesValueKind::ListNode,
        "TupleLiteral" => AesValueKind::TupleLiteral,
        "NodeLiteral" => AesValueKind::NodeLiteral,
        "NodeHead" => AesValueKind::NodeHead,
        "CloneReference" => AesValueKind::CloneReference,
        "PointerReference" => AesValueKind::PointerReference,
        _ => unreachable!("Sofia projected an unknown AES value kind"),
    }
}

fn project_portable_events_into<S>(events: &[AssignmentEvent], emit: &mut S)
where
    S: PortableEventSink + ?Sized,
{
    let node_source_paths = events
        .iter()
        .filter(|event| matches!(unwrap_typed_value(&event.value), Value::NodeLiteral { .. }))
        .map(|event| event.path.segments.clone())
        .collect::<HashSet<_>>();
    emit.reserve(events.len());
    if events.len() > MAX_REUSABLE_AES_PATH_EVENTS
        || !events
            .iter()
            .any(|event| event.path.segments.len() >= MIN_REUSABLE_AES_PATH_DEPTH)
    {
        for event in events {
            let translated_path = aes_canonical_path(&event.path, &node_source_paths);
            emit_projected_assignment(event, translated_path, emit, &node_source_paths);
        }
        return;
    }

    let mut reusable_source_path: Option<&[PathSegment]> = None;
    let mut reusable_aes_path: Option<AesCanonicalPath> = None;

    for (event_index, event) in events.iter().enumerate() {
        let translated_path = match (&reusable_source_path, &reusable_aes_path) {
            (Some(source_path), Some(aes_path))
                if event.path.segments.len() == source_path.len().saturating_add(1)
                    && event.path.segments.starts_with(source_path) =>
            {
                let mut path = aes_path.clone();
                push_aes_path_segment(
                    &mut path,
                    event
                        .path
                        .segments
                        .last()
                        .expect("a direct child path has a final segment"),
                    &event.path.segments[..source_path.len()],
                    &node_source_paths,
                );
                path
            }
            _ => aes_canonical_path(&event.path, &node_source_paths),
        };
        let next_is_direct_child = event.path.segments.len() >= MIN_REUSABLE_AES_PATH_DEPTH
            && events
                .get(event_index.saturating_add(1))
                .is_some_and(|next| {
                    next.path.segments.len() == event.path.segments.len().saturating_add(1)
                        && next.path.segments.starts_with(&event.path.segments)
                });
        if next_is_direct_child {
            reusable_source_path = Some(&event.path.segments);
            reusable_aes_path = Some(translated_path.clone());
        } else {
            reusable_source_path = None;
            reusable_aes_path = None;
        }
        emit_projected_assignment(event, translated_path, emit, &node_source_paths);
    }
}

#[inline]
fn emit_projected_assignment<S>(
    event: &AssignmentEvent,
    translated_path: AesCanonicalPath,
    emit: &mut S,
    node_source_paths: &NodeSourcePaths,
) where
    S: PortableEventSink + ?Sized,
{
    let value = unwrap_typed_value(&event.value);
    if event.annotations.is_empty() && !matches!(value, Value::NodeLiteral { .. }) {
        emit.push(project_event(
            event,
            translated_path,
            value,
            node_source_paths,
        ));
        return;
    }
    emit.push(project_event(
        event,
        translated_path.clone(),
        value,
        node_source_paths,
    ));
    project_attributes(
        &event.annotations,
        &event.annotation_order,
        &translated_path,
        emit,
        node_source_paths,
    );

    if let Value::NodeLiteral {
        tag,
        structural_id,
        attributes,
        attribute_order,
        datatype,
        head_span,
        ..
    } = value
    {
        let head_path = append_index(&translated_path, 0);
        emit.push(ProjectedAesEvent {
            path: head_path.clone(),
            kind: "NodeHead",
            identity: structural_id.clone(),
            datatype: datatype.clone(),
            generics: Vec::new(),
            clarifiers: Vec::new(),
            value: Some(tag.clone()),
            span: Some(*head_span),
        });
        project_node_attributes(
            attributes,
            attribute_order,
            &head_path,
            emit,
            node_source_paths,
        );
    }
}

fn split_projected_datatypes(events: &mut [PortableAesEvent]) {
    for event in events {
        split_projected_datatype(event);
    }
}

fn split_projected_datatype(event: &mut PortableAesEvent) {
    let Some(raw) = event.datatype.clone() else {
        return;
    };
    if let Ok(descriptor) = parse_datatype_descriptor(&raw, &TelexLimits::default()) {
        event.datatype = Some(descriptor.datatype);
        event.generics = descriptor.generics;
        event.clarifiers = descriptor.clarifiers;
    }
}

fn project_event(
    event: &AssignmentEvent,
    path: AesCanonicalPath,
    value: &Value,
    node_source_paths: &NodeSourcePaths,
) -> ProjectedAesEvent {
    let (kind, projected_value) = project_value(value, node_source_paths);
    // Rust v0 assignment events inherit their owner's span for anonymous
    // sequence occurrences. That range is not occurrence-exact provenance.
    let span =
        (!matches!(event.path.segments.last(), Some(PathSegment::Index(_)))).then_some(event.span);
    ProjectedAesEvent {
        path,
        kind,
        identity: event.structural_id.clone(),
        datatype: event.datatype.clone(),
        generics: Vec::new(),
        clarifiers: Vec::new(),
        value: projected_value,
        span,
    }
}

fn project_attributes<S>(
    attributes: &BTreeMap<String, AttributeValue>,
    order: &[String],
    owner_path: &AesCanonicalPath,
    emit: &mut S,
    node_source_paths: &NodeSourcePaths,
) where
    S: PortableEventSink + ?Sized,
{
    emit.reserve(attributes.len());
    for key in ordered_keys(attributes, order) {
        let Some(entry) = attributes.get(key) else {
            continue;
        };
        let path = append_attribute(owner_path, key);
        project_attribute_value(path, entry, emit, node_source_paths);
    }
}

fn project_node_attributes<S>(
    attribute_blocks: &[BTreeMap<String, AttributeValue>],
    order: &[String],
    owner_path: &AesCanonicalPath,
    emit: &mut S,
    node_source_paths: &NodeSourcePaths,
) where
    S: PortableEventSink + ?Sized,
{
    for (index, attributes) in attribute_blocks.iter().enumerate() {
        project_attributes(
            attributes,
            if index == 0 { order } else { &[] },
            owner_path,
            emit,
            node_source_paths,
        );
    }
}

fn project_attribute_value<S>(
    path: AesCanonicalPath,
    entry: &AttributeValue,
    emit: &mut S,
    node_source_paths: &NodeSourcePaths,
) where
    S: PortableEventSink + ?Sized,
{
    let (kind, value) = entry
        .value
        .as_ref()
        .map_or(("ObjectNode", None), |raw_value| {
            project_value(unwrap_typed_value(raw_value), node_source_paths)
        });
    emit.push(ProjectedAesEvent {
        path: path.clone(),
        kind,
        identity: entry.structural_id.clone(),
        datatype: entry.datatype.clone(),
        generics: Vec::new(),
        clarifiers: Vec::new(),
        value,
        span: entry.span,
    });
    project_attributes(
        &entry.nested_attrs,
        &entry.nested_attr_order,
        &path,
        emit,
        node_source_paths,
    );

    if let Some(raw_value) = &entry.value {
        project_value_children(
            &path,
            unwrap_typed_value(raw_value),
            emit,
            node_source_paths,
        );
    } else {
        for key in ordered_keys(&entry.object_members, &entry.object_member_order) {
            let Some(member) = entry.object_members.get(key) else {
                continue;
            };
            project_attribute_value(append_member(&path, key), member, emit, node_source_paths);
        }
    }
}

struct ValueTreeMetadata<'a> {
    identity: Option<&'a String>,
    datatype: Option<&'a String>,
    attributes: Option<(&'a BTreeMap<String, AttributeValue>, &'a [String])>,
    span: Option<Span>,
}

fn project_value_tree<S>(
    path: AesCanonicalPath,
    raw_value: &Value,
    metadata: ValueTreeMetadata<'_>,
    emit: &mut S,
    node_source_paths: &NodeSourcePaths,
) where
    S: PortableEventSink + ?Sized,
{
    let value = unwrap_typed_value(raw_value);
    let (kind, projected_value) = project_value(value, node_source_paths);
    emit.push(ProjectedAesEvent {
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
        project_attributes(mapped, order, &path, emit, node_source_paths);
    }
    project_value_children(&path, value, emit, node_source_paths);
}

fn project_value_children<S>(
    path: &AesCanonicalPath,
    value: &Value,
    emit: &mut S,
    node_source_paths: &NodeSourcePaths,
) where
    S: PortableEventSink + ?Sized,
{
    match value {
        Value::ObjectNode { bindings } => {
            emit.reserve(bindings.len());
            for binding in bindings {
                project_binding_tree(
                    append_member(path, &binding.key),
                    binding,
                    emit,
                    node_source_paths,
                );
            }
        }
        Value::ListNode { items } | Value::TupleLiteral { items } => {
            emit.reserve(items.len());
            for (index, item) in items.iter().enumerate() {
                project_anonymous_tree(append_index(path, index), item, emit, node_source_paths);
            }
        }
        Value::NodeLiteral {
            tag,
            structural_id,
            attributes,
            attribute_order,
            datatype,
            children,
            head_span,
            ..
        } => {
            emit.reserve(children.len().saturating_add(1));
            let head_path = append_index(path, 0);
            emit.push(ProjectedAesEvent {
                path: head_path.clone(),
                kind: "NodeHead",
                identity: structural_id.clone(),
                datatype: datatype.clone(),
                generics: Vec::new(),
                clarifiers: Vec::new(),
                value: Some(tag.clone()),
                span: Some(*head_span),
            });
            project_node_attributes(
                attributes,
                attribute_order,
                &head_path,
                emit,
                node_source_paths,
            );
            for (index, child) in children.iter().enumerate() {
                project_anonymous_tree(
                    append_index(&head_path, index),
                    child,
                    emit,
                    node_source_paths,
                );
            }
        }
        _ => {}
    }
}

fn project_binding_tree<S>(
    path: AesCanonicalPath,
    binding: &Binding,
    emit: &mut S,
    node_source_paths: &NodeSourcePaths,
) where
    S: PortableEventSink + ?Sized,
{
    project_value_tree(
        path,
        &binding.value,
        ValueTreeMetadata {
            identity: binding.structural_id.as_ref(),
            datatype: binding.datatype.as_ref(),
            attributes: Some((&binding.attributes, &binding.attribute_order)),
            span: Some(binding.span),
        },
        emit,
        node_source_paths,
    );
}

fn project_anonymous_tree<S>(
    path: AesCanonicalPath,
    raw_value: &Value,
    emit: &mut S,
    node_source_paths: &NodeSourcePaths,
) where
    S: PortableEventSink + ?Sized,
{
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
            emit,
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
            emit,
            node_source_paths,
        );
    }
}

fn project_value(
    value: &Value,
    node_source_paths: &NodeSourcePaths,
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
        Value::HexLiteral { raw } => (
            "HexLiteral",
            Some(
                raw.trim_start_matches('#')
                    .bytes()
                    .filter(|byte| *byte != b'_')
                    .map(|byte| char::from(byte.to_ascii_lowercase()))
                    .collect(),
            ),
        ),
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

fn aes_canonical_path(
    path: &CanonicalPath,
    node_source_paths: &NodeSourcePaths,
) -> AesCanonicalPath {
    let mut rendered = AesCanonicalPath::root();
    for (index, segment) in path.segments.iter().enumerate() {
        push_aes_path_segment(
            &mut rendered,
            segment,
            &path.segments[..index],
            node_source_paths,
        );
    }
    rendered
}

fn push_aes_path_segment(
    rendered: &mut AesCanonicalPath,
    segment: &PathSegment,
    parent_segments: &[PathSegment],
    node_source_paths: &NodeSourcePaths,
) {
    if matches!(segment, PathSegment::Index(_))
        && !parent_segments.is_empty()
        && node_source_paths.contains(parent_segments)
    {
        rendered.push_index(0);
    }
    match segment {
        PathSegment::Root => {}
        PathSegment::Member(member) => rendered
            .push_member(member)
            .expect("validated AEON paths have nonempty members"),
        PathSegment::Index(index) => rendered.push_index(*index),
    }
}

fn append_member(owner_path: &AesCanonicalPath, key: &str) -> AesCanonicalPath {
    let mut path = owner_path.clone();
    path.push_member(key)
        .expect("validated AEON paths have nonempty members");
    path
}

fn append_attribute(owner_path: &AesCanonicalPath, key: &str) -> AesCanonicalPath {
    let mut path = owner_path.clone();
    path.push_attribute(key)
        .expect("validated AEON paths have nonempty attributes");
    path
}

fn append_index(owner_path: &AesCanonicalPath, index: usize) -> AesCanonicalPath {
    let mut path = owner_path.clone();
    path.push_index(index);
    path
}

fn unwrap_typed_value(value: &Value) -> &Value {
    match value {
        Value::TypedValue { value, .. } => unwrap_typed_value(value),
        _ => value,
    }
}

fn translate_node_path(path: &CanonicalPath, node_source_paths: &NodeSourcePaths) -> CanonicalPath {
    let mut target_segments = Vec::with_capacity(path.segments.len().saturating_add(1));

    for (index, segment) in path.segments.iter().enumerate() {
        if matches!(segment, PathSegment::Index(_))
            && index > 0
            && node_source_paths.contains(&path.segments[..index])
        {
            target_segments.push(PathSegment::Index(0));
        }
        target_segments.push(segment.clone());
    }

    CanonicalPath {
        segments: target_segments,
    }
}

fn translate_reference_target(
    segments: &[ReferenceSegment],
    node_source_paths: &NodeSourcePaths,
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
                if source_path_is_trackable && node_source_paths.contains(&source_segments) {
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

fn is_legacy_header_event(event: &AssignmentEvent, _header: Option<&crate::HeaderFields>) -> bool {
    event.source_plane == crate::SourcePlane::Header
}

struct PortableSourceContext<'a> {
    source: &'a str,
    origin: String,
}

fn create_source_context(
    source_bytes: &[u8],
) -> Result<PortableSourceContext<'_>, PortableAesSourceError> {
    let source = std::str::from_utf8(source_bytes).map_err(|_| PortableAesSourceError {
        code: "AES_SOURCE_INVALID_UTF8",
        detail: String::from("Portable source provenance requires a valid UTF-8 artifact."),
    })?;
    let digest = Sha256::digest(source_bytes);
    let origin = format!(
        "sha256:{}",
        digest
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    );
    Ok(PortableSourceContext { source, origin })
}

fn compatibility_event(
    event: PortableAesEvent,
    header: bool,
    source_context: Option<&PortableSourceContext<'_>>,
) -> Result<PortableAesCompatibilityEvent, PortableAesSourceError> {
    let (origin, span) = match source_context {
        None => (None, None),
        Some(context) => {
            let span = event
                .span
                .map(|span| validate_portable_source_span(span, context.source))
                .transpose()?;
            (Some(context.origin.clone()), span)
        }
    };
    Ok(PortableAesCompatibilityEvent {
        path: (!header).then(|| event.path.clone()),
        header: header.then_some(event.path),
        kind: event.kind,
        identity: event.identity,
        datatype: event.datatype,
        generics: event.generics,
        clarifiers: event.clarifiers,
        value: event.value,
        origin,
        span,
    })
}

fn validate_portable_source_span(
    span: Span,
    source: &str,
) -> Result<String, PortableAesSourceError> {
    let start = span.start.offset;
    let end = span.end.offset;
    if start >= end
        || end > source.len()
        || !source.is_char_boundary(start)
        || !source.is_char_boundary(end)
    {
        return Err(PortableAesSourceError {
            code: "AES_COMPAT_SOURCE_RANGE_INVALID",
            detail: format!(
                "Native source span {start}:{end} is outside the exact UTF-8 artifact, is not positive, or splits a Unicode scalar."
            ),
        });
    }
    Ok(format!("{start}:{end}"))
}

fn source_error_to_telex(error: PortableAesSourceError) -> TelexEncodeError {
    TelexEncodeError {
        code: error.code,
        detail: error.detail,
        counter: None,
        observed: None,
        limit: None,
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
    source_backed: bool,
    header: Option<&crate::HeaderFields>,
) -> Vec<PortableAesConversionChange> {
    let mut changes = Vec::new();
    let node_source_paths = body_events
        .iter()
        .filter(|event| matches!(unwrap_typed_value(&event.value), Value::NodeLiteral { .. }))
        .map(|event| event.path.segments.clone())
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
        let header_event = is_legacy_header_event(event, header);
        let target_path = if header_event && include_headers {
            Some(source_path.clone())
        } else {
            path_map.get(&source_path).cloned()
        };
        if !source_backed {
            changes.push(compatibility_change(
                "omitted",
                "AES_COMPAT_PROVENANCE_OMITTED",
                "span",
                "The local source span is omitted because it is not bound to an immutable portable origin.",
                Some(source_path.clone()),
                target_path.clone(),
            ));
        }
        changes.push(compatibility_change(
            "transformed",
            "AES_COMPAT_SOURCE_REPRESENTATION_REDUCED",
            "key,value",
            "Implementation-specific navigation fields and AST representation are reduced to portable AES fields.",
            Some(source_path.clone()),
            target_path.clone(),
        ));
        if header_event && !include_headers {
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
        if header_event {
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
        if source_backed {
            changes.push(compatibility_change(
                if event.span.is_some() {
                    "retained"
                } else {
                    "omitted"
                },
                if event.span.is_some() {
                    "AES_COMPAT_UTF8_BYTE_SPAN_RETAINED"
                } else {
                    "AES_COMPAT_PROVENANCE_RANGE_OMITTED"
                },
                "span",
                if event.span.is_some() {
                    "The native UTF-8 byte range is retained against the exact source artifact."
                } else {
                    "The exact source is identified, but this occurrence has no independently retained source range."
                },
                None,
                target_path.clone(),
            ));
        }
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
        )
        .expect("portable adaptation");
        assert_eq!(
            converted.report.source_contract,
            RUST_ASSIGNMENT_EVENTS_CONTRACT_V0
        );
        assert_eq!(converted.report.target_contract, "aes.events.v1");
        assert_eq!(converted.report.adapter, RUST_PORTABLE_AES_ADAPTER_V0);
        assert_eq!(converted.report.profile, "aes.complete.v1");
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
        let source = "aeon:mode = \"transport\"\r\na = 1";
        let result = compile(source, CompileOptions::default());
        assert!(result.errors.is_empty(), "{:?}", result.errors);
        let body = adapt_rust_assignment_events_to_portable_aes(
            &result.events,
            &PortableAesCompatibilityOptions {
                header: result.header.clone(),
                ..PortableAesCompatibilityOptions::default()
            },
        )
        .expect("body projection");
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
                ..PortableAesCompatibilityOptions::default()
            },
        )
        .expect("document projection");
        assert_eq!(document.report.projection, Some(AEON_DOCUMENT_PROJECTION));
        assert_eq!(
            document.events[0].header.as_deref(),
            Some("$.[\"aeon:mode\"]")
        );
        assert_eq!(document.events[1].path.as_deref(), Some("$.a"));

        let source_backed = adapt_rust_assignment_events_to_portable_aes(
            &result.events,
            &PortableAesCompatibilityOptions {
                include_headers: true,
                header: result.header.clone(),
                source_bytes: Some(source.as_bytes().to_vec()),
            },
        )
        .expect("source-backed document projection");
        assert_eq!(source_backed.events[0].span.as_deref(), Some("0:23"));
        assert_eq!(source_backed.events[1].span.as_deref(), Some("25:30"));
        assert!(source_backed.report.provenance_lossless);
    }

    #[test]
    fn document_projection_completes_structured_header_containers() {
        let source = concat!(
            "aeon:header = {\n",
            "  mode = \"transport\"\n",
            "  conventions = [\"one\", \"two\"]\n",
            "}\n",
            "a = 1\n",
        );
        let result = compile(source, CompileOptions::default());
        assert!(result.errors.is_empty(), "{:?}", result.errors);
        let document = adapt_rust_assignment_events_to_portable_aes(
            &result.events,
            &PortableAesCompatibilityOptions {
                include_headers: true,
                header: result.header.clone(),
                ..PortableAesCompatibilityOptions::default()
            },
        )
        .expect("document projection");
        assert_eq!(
            document.events[..4]
                .iter()
                .map(|event| event.header.as_deref())
                .collect::<Vec<_>>(),
            vec![
                Some("$.[\"aeon:mode\"]"),
                Some("$.[\"aeon:conventions\"]"),
                Some("$.[\"aeon:conventions\"][0]"),
                Some("$.[\"aeon:conventions\"][1]"),
            ]
        );
        assert_eq!(
            document.events[..4]
                .iter()
                .map(|event| event.kind)
                .collect::<Vec<_>>(),
            vec![
                "StringLiteral",
                "ListNode",
                "StringLiteral",
                "StringLiteral"
            ]
        );
        assert_eq!(document.events[4].path.as_deref(), Some("$.a"));
    }

    fn shapes(events: &[PortableAesEvent]) -> Vec<(&str, &str, Option<&str>)> {
        events
            .iter()
            .map(|event| (event.path.as_str(), event.kind, event.identity.as_deref()))
            .collect()
    }

    #[test]
    fn separates_node_identities_at_expanded_paths() {
        let source = r#"a\BINDING\ = <tag\HEAD\(\CHILD\ = "value")>"#;
        let events = project(source);
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
        let span = events[1].span.expect("node-head span");
        assert_eq!(&source[span.start.offset..span.end.offset], r#"tag\HEAD\"#);
    }

    #[test]
    fn node_head_span_excludes_layout_after_datatype() {
        let source = "a = <tag:node\n(\"value\")>";
        let events = project(source);
        let head = events
            .iter()
            .find(|event| event.path == "$.a[0]")
            .expect("node head");
        let span = head.span.expect("node-head span");
        assert_eq!(&source[span.start.offset..span.end.offset], "tag:node");
    }

    #[test]
    fn retains_exact_utf8_byte_ranges_and_unicode_scalar_columns() {
        let source = concat!(
            "\u{feff}",
            r#"a = <tag\HEAD\@{role = "café"}:node("😀")>"#,
            "\r\n",
            "b = \"nai\u{308}ve\"",
        );
        let result = compile(
            source,
            CompileOptions {
                max_attribute_depth: 8,
                ..CompileOptions::default()
            },
        );
        assert!(result.errors.is_empty(), "{:?}", result.errors);
        assert_eq!(result.source, source);
        assert_eq!(result.events[0].span.start.offset, 3);
        assert_eq!(result.events[0].span.start.column, 2);
        let b_event = result
            .events
            .iter()
            .find(|event| format_path(&event.path) == "$.b")
            .expect("b event");
        assert_eq!(b_event.span.start.offset, 50);
        assert_eq!(b_event.span.start.line, 2);
        assert_eq!(b_event.span.start.column, 1);

        let projected = project_portable_events(&result.events);
        let head = projected
            .iter()
            .find(|event| event.path == "$.a[0]")
            .expect("node head");
        let head_span = head.span.expect("node-head span");
        assert_eq!((head_span.start.offset, head_span.end.offset), (8, 39));
        assert_eq!(head_span.start.column, 7);
        let role = projected
            .iter()
            .find(|event| event.path == "$.a[0].@.role")
            .expect("role attribute");
        assert_eq!(
            role.span.map(|span| (span.start.offset, span.end.offset)),
            Some((19, 33))
        );

        let converted = adapt_rust_assignment_events_to_portable_aes(
            &result.events,
            &PortableAesCompatibilityOptions {
                source_bytes: Some(source.as_bytes().to_vec()),
                ..PortableAesCompatibilityOptions::default()
            },
        )
        .expect("source-backed projection");
        let origin = "sha256:c9063ff2481e76331f175afa8a6bd4d7f850048591e737047d8a0b6fc2a701b7";
        assert!(
            converted
                .events
                .iter()
                .all(|event| event.origin.as_deref() == Some(origin))
        );
        assert_eq!(converted.events[0].span.as_deref(), Some("3:48"));
        assert_eq!(converted.events[1].span.as_deref(), Some("8:39"));
        assert_eq!(converted.events[2].span.as_deref(), Some("19:33"));
        assert_eq!(converted.events[3].span, None);
        assert_eq!(converted.events[4].span.as_deref(), Some("50:63"));
        assert!(!converted.report.provenance_lossless);
        assert!(converted.report.changes.iter().any(|change| {
            change.code == "AES_COMPAT_PROVENANCE_RANGE_OMITTED"
                && change.target_path.as_deref() == Some("$.a[0][0]")
        }));
    }

    #[test]
    fn rejects_invalid_utf8_and_invalid_native_source_ranges() {
        let source = "a = \"😀\"";
        let result = compile(source, CompileOptions::default());
        assert!(result.errors.is_empty(), "{:?}", result.errors);

        let invalid_utf8 = adapt_rust_assignment_events_to_portable_aes(
            &result.events,
            &PortableAesCompatibilityOptions {
                source_bytes: Some(vec![0xff]),
                ..PortableAesCompatibilityOptions::default()
            },
        )
        .expect_err("invalid UTF-8 must fail");
        assert_eq!(invalid_utf8.code, "AES_SOURCE_INVALID_UTF8");

        let mut invalid_events = result.events.clone();
        invalid_events[0].span.end.offset = 99;
        let invalid_range = adapt_rust_assignment_events_to_portable_aes(
            &invalid_events,
            &PortableAesCompatibilityOptions {
                source_bytes: Some(source.as_bytes().to_vec()),
                ..PortableAesCompatibilityOptions::default()
            },
        )
        .expect_err("out-of-range span must fail");
        assert_eq!(invalid_range.code, "AES_COMPAT_SOURCE_RANGE_INVALID");
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
        assert!(telex.starts_with("telex.aes=1\n"));
        assert!(
            telex.contains("path=$.a\nkind=ListNode\ndatatype=list<int>"),
            "{telex}"
        );
    }

    #[test]
    fn direct_body_telex_projection_matches_the_named_compatibility_adapter() {
        let source = concat!(
            "a@{role = \"root\"} = <tag\\HEAD\\(\"child\")>\n",
            "copy = ~a[0]\n",
            "items:list<int> = [1, 2]\n",
            "metadata = { enabled = true }",
        );
        let result = compile(
            source,
            CompileOptions {
                max_attribute_depth: 8,
                ..CompileOptions::default()
            },
        );
        assert!(result.errors.is_empty(), "{:?}", result.errors);
        let options = ExportTelexOptions::default();
        let direct = project_telex_records(&result.events, &options).expect("direct projection");
        let compatibility = project_telex_records_via_compatibility(&result.events, &options)
            .expect("compatibility projection");
        assert_eq!(direct, compatibility);
    }

    #[test]
    fn typed_body_export_matches_extensible_telex_record_encoding() {
        let source = concat!(
            "a@{role = \"root\"} = <tag\\HEAD\\(\"child\")>\n",
            "copy = ~a[0]\n",
            "items:list<int> = [1, 2]\n",
            "metadata = { enabled = true }",
        );
        let result = compile(
            source,
            CompileOptions {
                max_attribute_depth: 8,
                ..CompileOptions::default()
            },
        );
        assert!(result.errors.is_empty(), "{:?}", result.errors);
        let options = ExportTelexOptions::default();
        let typed = export_telex(&result.events, &options).expect("typed AES export");
        let extensible = project_telex_records(&result.events, &options)
            .and_then(|records| {
                encode_telex_with_projection_and_limits(
                    &records,
                    options.profile.as_deref(),
                    options.projection.as_deref(),
                    &options.limits,
                )
            })
            .expect("extensible Telex record export");
        assert_eq!(typed, extensible);
    }

    #[test]
    fn compiles_to_telex_with_exact_source_backed_provenance() {
        let source = "\u{feff}answer = \"😀\"";
        let result = compile_to_telex(
            source,
            CompileToTelexOptions {
                telex: ExportTelexOptions {
                    source_bytes: Some(source.as_bytes().to_vec()),
                    ..ExportTelexOptions::default()
                },
                ..CompileToTelexOptions::default()
            },
        );
        assert!(
            result.compile.errors.is_empty(),
            "{:?}",
            result.compile.errors
        );
        assert!(result.encode_error.is_none(), "{:?}", result.encode_error);
        assert_eq!(
            result.records[0].get("origin"),
            Some("sha256:c1c6f9dfcbb991dadfd099abb19a091d85e5f1e2b722634dfb83e56f73f57a18")
        );
        assert_eq!(result.records[0].get("span"), Some("3:18"));
        let telex = result.telex.expect("encoded Telex");
        assert!(telex.contains("origin=sha256:"), "{telex}");
        assert!(telex.contains("span=3:18"), "{telex}");
    }

    #[test]
    fn compile_to_telex_rejects_a_different_source_artifact() {
        let result = compile_to_telex(
            "answer = 1",
            CompileToTelexOptions {
                telex: ExportTelexOptions {
                    source_bytes: Some(b"answer = 2".to_vec()),
                    ..ExportTelexOptions::default()
                },
                ..CompileToTelexOptions::default()
            },
        );
        assert_eq!(
            result.encode_error.map(|error| error.code),
            Some("AES_COMPAT_SOURCE_MISMATCH")
        );
        assert!(result.records.is_empty());
        assert!(result.telex.is_none());
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
    fn canonicalizes_hex_values_for_portable_aes() {
        let result = compile("color:hex = #FF_00_aA", CompileOptions::default());
        assert!(result.errors.is_empty(), "{:?}", result.errors);
        let records = project_telex_records(&result.events, &ExportTelexOptions::default())
            .expect("Telex projection");
        assert_eq!(records[0].get("kind"), Some("HexLiteral"));
        assert_eq!(records[0].get("value"), Some("ff00aa"));
        let validation = aes_telex::validate_telex_records_with_projection_and_limits(
            &records,
            "aes.complete.v1",
            None,
            &[],
            &TelexLimits::default(),
        );
        assert!(validation.valid, "{:?}", validation.diagnostics);
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
        assert!(telex.contains("projection=aeon.document.v1"));
        assert!(telex.contains("header=$.[\"aeon:mode\"]"), "{telex}");
    }

    #[test]
    fn same_name_quoted_aeon_prefix_key_remains_in_the_body_plane() {
        let result = compile_to_telex(
            "aeon:mode = \"transport\"\n\"aeon:mode\" = 1",
            CompileToTelexOptions {
                telex: ExportTelexOptions {
                    include_headers: true,
                    ..ExportTelexOptions::default()
                },
                ..CompileToTelexOptions::default()
            },
        );
        assert!(
            result.compile.errors.is_empty(),
            "{:?}",
            result.compile.errors
        );
        assert_eq!(result.compile.events.len(), 1);
        assert_eq!(result.compile.events[0].key, "aeon:mode");
        assert_eq!(
            result.compile.events[0].source_plane,
            crate::SourcePlane::Body
        );
        let telex = result.telex.expect("encoded Telex");
        assert!(telex.contains("header=$.[\"aeon:mode\"]"), "{telex}");
        assert!(telex.contains("path=$.[\"aeon:mode\"]"), "{telex}");
    }
}
