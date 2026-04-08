#![allow(clippy::too_many_arguments)]

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;

use aeon_core::{
    AssignmentEvent, AttributeValue, CompileOptions, Diagnostic, HeaderFields, ReferenceSegment,
    Span, Value, compile, format_path, normalize_number_literal,
};
use serde::de::DeserializeOwned;
use serde_json::{Map, Value as JsonValue, json};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FinalizeMode {
    Strict,
    Loose,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Materialization {
    All,
    Projected,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FinalizeScope {
    Payload,
    Header,
    Full,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FinalizeOptions {
    pub mode: FinalizeMode,
    pub materialization: Materialization,
    pub include_paths: Vec<String>,
    pub scope: FinalizeScope,
    pub header: Option<HeaderFields>,
    pub max_materialized_weight: Option<usize>,
}

impl Default for FinalizeOptions {
    fn default() -> Self {
        Self {
            mode: FinalizeMode::Strict,
            materialization: Materialization::All,
            include_paths: Vec::new(),
            scope: FinalizeScope::Payload,
            header: None,
            max_materialized_weight: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FinalizeMeta {
    pub errors: Vec<Diagnostic>,
    pub warnings: Vec<Diagnostic>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct FinalizeJsonResult {
    pub document: JsonValue,
    pub meta: FinalizeMeta,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FinalizedEntry {
    pub path: String,
    pub value: Value,
    pub span: Span,
    pub datatype: Option<String>,
    pub annotations: BTreeMap<String, AttributeValue>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FinalizedMap {
    pub entries: Vec<FinalizedEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FinalizeMapResult {
    pub document: FinalizedMap,
    pub meta: FinalizeMeta,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct MaterializationTracker {
    max_materialized_weight: Option<usize>,
    materialized_weight: usize,
    materialized_weight_cache: BTreeMap<String, usize>,
}

impl MaterializationTracker {
    fn new(max_materialized_weight: Option<usize>) -> Self {
        Self {
            max_materialized_weight,
            materialized_weight: 0,
            materialized_weight_cache: BTreeMap::new(),
        }
    }
}

#[derive(Debug)]
pub enum MaterializeError {
    Compile(Vec<Diagnostic>),
    Finalize(FinalizeMeta),
    Deserialize(serde_json::Error),
}

impl fmt::Display for MaterializeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Compile(errors) => {
                write!(f, "AEON compile failed with {} error(s)", errors.len())
            }
            Self::Finalize(meta) => write!(
                f,
                "AEON finalize failed with {} error(s)",
                meta.errors.len()
            ),
            Self::Deserialize(error) => {
                write!(f, "failed to deserialize finalized AEON document: {error}")
            }
        }
    }
}

impl std::error::Error for MaterializeError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Deserialize(error) => Some(error),
            Self::Compile(_) | Self::Finalize(_) => None,
        }
    }
}

pub fn finalize_into<T: DeserializeOwned>(
    events: &[AssignmentEvent],
    options: FinalizeOptions,
) -> Result<T, MaterializeError> {
    let finalized = finalize_json(events, options);
    if !finalized.meta.errors.is_empty() {
        return Err(MaterializeError::Finalize(finalized.meta));
    }
    serde_json::from_value(finalized.document).map_err(MaterializeError::Deserialize)
}

pub fn from_aeon_str<T: DeserializeOwned>(
    source: &str,
    compile_options: CompileOptions,
    finalize_options: FinalizeOptions,
) -> Result<T, MaterializeError> {
    let compiled = compile(source, compile_options);
    if !compiled.errors.is_empty() {
        return Err(MaterializeError::Compile(compiled.errors));
    }
    finalize_into(&compiled.events, finalize_options)
}

#[must_use]
pub fn finalize_json(events: &[AssignmentEvent], options: FinalizeOptions) -> FinalizeJsonResult {
    let mut errors = Vec::new();
    let mut warnings = Vec::new();
    let mut active_paths = BTreeSet::new();
    let mut tracker = MaterializationTracker::new(options.max_materialized_weight);
    let projection = Projection::new(options.materialization, options.include_paths.clone());
    let path_values = index_event_values(events);

    let payload = if matches!(options.scope, FinalizeScope::Payload | FinalizeScope::Full) {
        payload_to_json(
            events,
            &projection,
            &path_values,
            options.mode,
            &mut errors,
            &mut warnings,
            &mut active_paths,
            &mut tracker,
        )
    } else {
        JsonValue::Object(Map::new())
    };

    let header = if matches!(options.scope, FinalizeScope::Header | FinalizeScope::Full) {
        header_to_json(
            options.header.as_ref(),
            &projection,
            &path_values,
            options.scope,
            options.mode,
            &mut errors,
            &mut warnings,
            &mut active_paths,
            &mut tracker,
        )
    } else {
        JsonValue::Object(Map::new())
    };

    let document = match options.scope {
        FinalizeScope::Payload => payload,
        FinalizeScope::Header => header,
        FinalizeScope::Full => json!({
            "header": header,
            "payload": payload,
        }),
    };

    FinalizeJsonResult {
        document,
        meta: FinalizeMeta { errors, warnings },
    }
}

#[must_use]
pub fn finalize_map(events: &[AssignmentEvent], options: FinalizeOptions) -> FinalizeMapResult {
    let projection = Projection::new(options.materialization, options.include_paths.clone());
    let mut seen = BTreeSet::new();
    let mut errors = Vec::new();
    let mut warnings = Vec::new();
    let mut entries = Vec::new();

    if matches!(options.scope, FinalizeScope::Header | FinalizeScope::Full)
        && let Some(header) = options.header.as_ref()
    {
        for (key, value) in &header.fields {
            let path = match options.scope {
                FinalizeScope::Header => format!("$.{key}"),
                FinalizeScope::Full => format!("$.header.{key}"),
                FinalizeScope::Payload => continue,
            };
            if !projection.includes(&path) {
                continue;
            }
            push_map_entry(
                &mut seen,
                &mut entries,
                &mut errors,
                &mut warnings,
                options.mode,
                path,
                value.clone(),
                Span::zero(),
                None,
                BTreeMap::new(),
            );
        }
    }

    if matches!(options.scope, FinalizeScope::Payload | FinalizeScope::Full) {
        for event in events {
            let base = format_path(&event.path);
            let path = match options.scope {
                FinalizeScope::Payload => base,
                FinalizeScope::Full => format!("$.payload{}", &base[1..]),
                FinalizeScope::Header => continue,
            };
            if !projection.includes(&path) {
                continue;
            }
            push_map_entry(
                &mut seen,
                &mut entries,
                &mut errors,
                &mut warnings,
                options.mode,
                path,
                event.value.clone(),
                event.span,
                event.datatype.clone(),
                event.annotations.clone(),
            );
        }
    }

    FinalizeMapResult {
        document: FinalizedMap { entries },
        meta: FinalizeMeta { errors, warnings },
    }
}

#[must_use]
pub fn value_to_ast_json(value: &Value) -> JsonValue {
    match value {
        Value::NumberLiteral { raw } => json!({
            "type": "NumberLiteral",
            "raw": raw,
            "value": normalize_number_literal(raw),
        }),
        Value::InfinityLiteral { raw } => json!({
            "type": "InfinityLiteral",
            "raw": raw,
            "value": raw,
        }),
        Value::StringLiteral {
            value,
            raw,
            delimiter,
            trimticks,
        } => {
            let mut object = Map::new();
            object.insert(
                String::from("type"),
                JsonValue::String(String::from("StringLiteral")),
            );
            object.insert(String::from("raw"), JsonValue::String(raw.clone()));
            object.insert(String::from("value"), JsonValue::String(value.clone()));
            object.insert(
                String::from("delimiter"),
                JsonValue::String(delimiter.to_string()),
            );
            if let Some(metadata) = trimticks {
                object.insert(
                    String::from("trimticks"),
                    json!({
                        "markerWidth": metadata.marker_width,
                        "rawValue": metadata.raw_value,
                    }),
                );
            }
            JsonValue::Object(object)
        }
        Value::SwitchLiteral { raw } => json!({
            "type": "SwitchLiteral",
            "value": raw,
        }),
        Value::BooleanLiteral { raw } => json!({
            "type": "BooleanLiteral",
            "value": raw == "true",
            "raw": raw,
        }),
        Value::HexLiteral { raw } => json!({
            "type": "HexLiteral",
            "value": raw.trim_start_matches('#'),
            "raw": raw,
        }),
        Value::SeparatorLiteral { raw } => json!({
            "type": "SeparatorLiteral",
            "value": raw.trim_start_matches('^'),
            "raw": raw,
        }),
        Value::EncodingLiteral { raw } => json!({
            "type": "EncodingLiteral",
            "value": raw.trim_start_matches('$'),
            "raw": raw,
        }),
        Value::RadixLiteral { raw } => json!({
            "type": "RadixLiteral",
            "value": raw.trim_start_matches('%'),
            "raw": raw,
        }),
        Value::DateLiteral { raw } => json!({
            "type": "DateLiteral",
            "value": raw,
            "raw": raw,
        }),
        Value::DateTimeLiteral { raw } => json!({
            "type": "DateTimeLiteral",
            "value": raw,
            "raw": raw,
        }),
        Value::TimeLiteral { raw } => json!({
            "type": "TimeLiteral",
            "value": raw,
            "raw": raw,
        }),
        Value::NodeLiteral {
            raw,
            tag,
            attributes,
            datatype,
            children,
        } => json!({
            "type": "NodeLiteral",
            "raw": raw,
            "tag": tag,
            "datatype": datatype.as_ref().map(|name| json!({ "type": "TypeAnnotation", "name": name })),
            "attributes": attributes.iter().map(attribute_entries_to_ast_json).collect::<Vec<_>>(),
            "children": children.iter().map(value_to_ast_json).collect::<Vec<_>>(),
        }),
        Value::ListNode { items } => json!({
            "type": "ListNode",
            "elements": items.iter().map(value_to_ast_json).collect::<Vec<_>>(),
        }),
        Value::TupleLiteral { items } => json!({
            "type": "TupleLiteral",
            "elements": items.iter().map(value_to_ast_json).collect::<Vec<_>>(),
        }),
        Value::ObjectNode { bindings } => json!({
            "type": "ObjectNode",
            "bindings": bindings.iter().map(|binding| {
                json!({
                    "type": "Binding",
                    "key": binding.key,
                    "datatype": binding.datatype,
                    "value": value_to_ast_json(&binding.value),
                })
            }).collect::<Vec<_>>(),
        }),
        Value::CloneReference { segments, .. } => json!({
            "type": "CloneReference",
            "path": reference_segments_json(segments),
        }),
        Value::PointerReference { segments, .. } => json!({
            "type": "PointerReference",
            "path": reference_segments_json(segments),
        }),
    }
}

fn header_to_json(
    header: Option<&HeaderFields>,
    projection: &Projection,
    path_values: &BTreeMap<String, Value>,
    scope: FinalizeScope,
    mode: FinalizeMode,
    errors: &mut Vec<Diagnostic>,
    warnings: &mut Vec<Diagnostic>,
    active_paths: &mut BTreeSet<String>,
    tracker: &mut MaterializationTracker,
) -> JsonValue {
    let mut object = Map::new();
    if let Some(header) = header {
        for (key, value) in &header.fields {
            let path = match scope {
                FinalizeScope::Header => format!("$.{key}"),
                FinalizeScope::Full => format!("$.header.{key}"),
                FinalizeScope::Payload => continue,
            };
            if !projection.includes(&path) {
                continue;
            }
            if is_reserved_key(key) {
                errors.push(
                    Diagnostic::new("FINALIZE_RESERVED_KEY", format!("Reserved key: {key}"))
                        .at_path(&path),
                );
                continue;
            }
            object.insert(
                key.clone(),
                value_to_json(
                    value,
                    &path,
                    projection,
                    path_values,
                    mode,
                    errors,
                    warnings,
                    None,
                    active_paths,
                    tracker,
                ),
            );
        }
    }
    JsonValue::Object(object)
}

fn payload_to_json(
    events: &[AssignmentEvent],
    projection: &Projection,
    path_values: &BTreeMap<String, Value>,
    mode: FinalizeMode,
    errors: &mut Vec<Diagnostic>,
    warnings: &mut Vec<Diagnostic>,
    active_paths: &mut BTreeSet<String>,
    tracker: &mut MaterializationTracker,
) -> JsonValue {
    let mut document = Map::new();
    let mut attrs = Map::new();
    for event in events {
        if event.path.segments.len() != 2 {
            continue;
        }
        let path = format_path(&event.path);
        if !projection.includes(&path) {
            continue;
        }
        let key = &event.key;
        if is_reserved_key(key) {
            errors.push(
                Diagnostic::new("FINALIZE_RESERVED_KEY", format!("Reserved key: {key}"))
                    .at_path(&path),
            );
            continue;
        }
        document.insert(
            key.clone(),
            value_to_json(
                &event.value,
                &path,
                projection,
                path_values,
                mode,
                errors,
                warnings,
                event.datatype.as_deref(),
                active_paths,
                tracker,
            ),
        );
        if !event.annotations.is_empty() {
            attrs.insert(
                key.clone(),
                attributes_to_json(
                    &event.annotations,
                    &path,
                    projection,
                    path_values,
                    mode,
                    errors,
                    warnings,
                    active_paths,
                    tracker,
                ),
            );
        }
    }
    if !attrs.is_empty() {
        document.insert(String::from("@"), JsonValue::Object(attrs));
    }
    JsonValue::Object(document)
}

fn value_to_json(
    value: &Value,
    path: &str,
    projection: &Projection,
    path_values: &BTreeMap<String, Value>,
    mode: FinalizeMode,
    errors: &mut Vec<Diagnostic>,
    warnings: &mut Vec<Diagnostic>,
    datatype: Option<&str>,
    active_paths: &mut BTreeSet<String>,
    tracker: &mut MaterializationTracker,
) -> JsonValue {
    value_to_json_with_active_key(
        value,
        path,
        path,
        projection,
        path_values,
        mode,
        errors,
        warnings,
        datatype,
        active_paths,
        tracker,
    )
}

fn value_to_json_with_active_key(
    value: &Value,
    path: &str,
    active_key: &str,
    projection: &Projection,
    path_values: &BTreeMap<String, Value>,
    mode: FinalizeMode,
    errors: &mut Vec<Diagnostic>,
    warnings: &mut Vec<Diagnostic>,
    datatype: Option<&str>,
    active_paths: &mut BTreeSet<String>,
    tracker: &mut MaterializationTracker,
) -> JsonValue {
    let inserted = active_paths.insert(String::from(active_key));
    if !inserted {
        let diag = Diagnostic::new(
            "FINALIZE_REFERENCE_CYCLE",
            format!("Reference cycle during finalization at '{path}'"),
        )
        .at_path(path);
        errors.push(diag);
        return JsonValue::Null;
    }

    let result = match value {
        Value::StringLiteral { value, .. } => JsonValue::String(value.clone()),
        Value::NumberLiteral { raw } => parse_number(raw, path, mode, errors, warnings),
        Value::InfinityLiteral { raw } => {
            let diag = Diagnostic::new(
                "FINALIZE_JSON_PROFILE_INFINITY",
                format!("Infinity literal is not representable in the strict JSON profile: {raw}"),
            )
            .at_path(path);
            if matches!(mode, FinalizeMode::Strict) {
                errors.push(diag);
            } else {
                warnings.push(diag);
            }
            JsonValue::String(raw.clone())
        }
        Value::SwitchLiteral { raw } => {
            JsonValue::Bool(matches!(raw.as_str(), "yes" | "on" | "true"))
        }
        Value::BooleanLiteral { raw } => JsonValue::Bool(raw == "true"),
        Value::HexLiteral { raw } => {
            JsonValue::String(raw.trim_start_matches('#').replace('_', ""))
        }
        Value::SeparatorLiteral { raw } => {
            JsonValue::String(raw.trim_start_matches('^').to_owned())
        }
        Value::EncodingLiteral { raw } => JsonValue::String(raw.trim_start_matches('$').to_owned()),
        Value::RadixLiteral { raw } => {
            let normalized = raw.trim_start_matches('%').replace('_', "");
            if let Some(base) = declared_radix_base(datatype)
                && exceeds_declared_radix(&normalized, base)
            {
                let diag = Diagnostic::new(
                    "FINALIZE_INVALID_RADIX_BASE",
                    format!("Radix literal exceeds declared radix {base}: {raw}"),
                )
                .at_path(path);
                if matches!(mode, FinalizeMode::Strict) {
                    errors.push(diag);
                } else {
                    warnings.push(diag);
                }
            }
            JsonValue::String(normalized)
        }
        Value::DateLiteral { raw }
        | Value::DateTimeLiteral { raw }
        | Value::TimeLiteral { raw } => JsonValue::String(raw.clone()),
        Value::NodeLiteral {
            tag,
            attributes,
            children,
            ..
        } => {
            let mut output = Map::new();
            output.insert(String::from("$node"), JsonValue::String(tag.clone()));
            let attr_json = node_attributes_to_json(
                attributes,
                &format!("{path}@"),
                projection,
                path_values,
                mode,
                errors,
                warnings,
                active_paths,
                tracker,
            );
            if matches!(&attr_json, JsonValue::Object(map) if !map.is_empty()) {
                output.insert(String::from("@"), attr_json);
            }
            output.insert(
                String::from("$children"),
                JsonValue::Array(
                    children
                        .iter()
                        .enumerate()
                        .map(|(index, child)| {
                            let child_path = format!("{path}<{index}>");
                            value_to_json(
                                child,
                                &child_path,
                                projection,
                                path_values,
                                mode,
                                errors,
                                warnings,
                                None,
                                active_paths,
                                tracker,
                            )
                        })
                        .collect(),
                ),
            );
            JsonValue::Object(output)
        }
        Value::ListNode { items } | Value::TupleLiteral { items } => {
            let mut output = Vec::new();
            for (index, item) in items.iter().enumerate() {
                let item_path = format!("{path}[{index}]");
                if projection.includes(&item_path) {
                    output.push(value_to_json(
                        item,
                        &item_path,
                        projection,
                        path_values,
                        mode,
                        errors,
                        warnings,
                        None,
                        active_paths,
                        tracker,
                    ));
                }
            }
            JsonValue::Array(output)
        }
        Value::ObjectNode { bindings } => {
            let mut output = Map::new();
            let mut attrs = Map::new();
            for binding in bindings {
                let child_path = format!("{path}.{}", render_member_segment(&binding.key));
                if projection.includes(&child_path) {
                    if is_reserved_key(&binding.key) {
                        errors.push(
                            Diagnostic::new(
                                "FINALIZE_RESERVED_KEY",
                                format!("Reserved key: {}", binding.key),
                            )
                            .at_path(&child_path),
                        );
                        continue;
                    }
                    output.insert(
                        binding.key.clone(),
                        value_to_json(
                            &binding.value,
                            &child_path,
                            projection,
                            path_values,
                            mode,
                            errors,
                            warnings,
                            binding.datatype.as_deref(),
                            active_paths,
                            tracker,
                        ),
                    );
                    if !binding.attributes.is_empty() {
                        attrs.insert(
                            binding.key.clone(),
                            attributes_to_json(
                                &binding.attributes,
                                &child_path,
                                projection,
                                path_values,
                                mode,
                                errors,
                                warnings,
                                active_paths,
                                tracker,
                            ),
                        );
                    }
                }
            }
            if !attrs.is_empty() {
                output.insert(String::from("@"), JsonValue::Object(attrs));
            }
            JsonValue::Object(output)
        }
        Value::CloneReference { segments, .. } => {
            let target = reference_target_path(segments);
            if let Some(resolved) = path_values.get(&target) {
                if active_paths.contains(&target) {
                    errors.push(Diagnostic::new(
                        "FINALIZE_REFERENCE_CYCLE",
                        format!("Reference cycle during finalization: '{path}' resolves through '{target}'"),
                    )
                    .at_path(path));
                    JsonValue::String(format!("~{}", render_reference_segments(segments)))
                } else if !consume_clone_budget(
                    &target,
                    resolved,
                    path,
                    segments,
                    path_values,
                    errors,
                    tracker,
                ) {
                    JsonValue::String(format!("~{}", render_reference_segments(segments)))
                } else {
                    value_to_json_with_active_key(
                        resolved,
                        path,
                        &target,
                        projection,
                        path_values,
                        mode,
                        errors,
                        warnings,
                        datatype,
                        active_paths,
                        tracker,
                    )
                }
            } else {
                JsonValue::String(format!("~{}", render_reference_segments(segments)))
            }
        }
        Value::PointerReference { segments, .. } => {
            JsonValue::String(format!("~>{}", render_reference_segments(segments)))
        }
    };
    active_paths.remove(active_key);
    result
}

fn consume_clone_budget(
    target_path: &str,
    value: &Value,
    path: &str,
    _segments: &[ReferenceSegment],
    path_values: &BTreeMap<String, Value>,
    errors: &mut Vec<Diagnostic>,
    tracker: &mut MaterializationTracker,
) -> bool {
    let Some(limit) = tracker.max_materialized_weight else {
        return true;
    };

    let weight = measure_materialized_weight(
        value,
        target_path,
        path_values,
        tracker,
        &mut BTreeSet::new(),
    );
    let next_weight = tracker.materialized_weight.saturating_add(weight);
    if next_weight <= limit {
        tracker.materialized_weight = next_weight;
        return true;
    }

    errors.push(
        Diagnostic::new(
            "FINALIZE_REFERENCE_BUDGET_EXCEEDED",
            format!(
                "Reference materialization budget exceeded for '{target_path}' (budget=maxMaterializedWeight, observed={next_weight}, limit={limit})"
            ),
        )
        .at_path(path),
    );
    false
}

fn measure_materialized_weight(
    value: &Value,
    current_path: &str,
    path_values: &BTreeMap<String, Value>,
    tracker: &mut MaterializationTracker,
    stack: &mut BTreeSet<String>,
) -> usize {
    if stack.contains(current_path) {
        return 1;
    }

    match value {
        Value::StringLiteral { .. }
        | Value::NumberLiteral { .. }
        | Value::InfinityLiteral { .. }
        | Value::SwitchLiteral { .. }
        | Value::BooleanLiteral { .. }
        | Value::HexLiteral { .. }
        | Value::SeparatorLiteral { .. }
        | Value::EncodingLiteral { .. }
        | Value::RadixLiteral { .. }
        | Value::DateLiteral { .. }
        | Value::DateTimeLiteral { .. }
        | Value::TimeLiteral { .. }
        | Value::PointerReference { .. } => 1,
        Value::CloneReference { segments, .. } => {
            let target_path = reference_target_path(segments);
            if let Some(weight) = tracker.materialized_weight_cache.get(&target_path) {
                return *weight;
            }
            let Some(resolved) = path_values.get(&target_path) else {
                return 1;
            };
            let mut next_stack = stack.clone();
            next_stack.insert(String::from(current_path));
            let weight = measure_materialized_weight(
                resolved,
                &target_path,
                path_values,
                tracker,
                &mut next_stack,
            );
            tracker
                .materialized_weight_cache
                .insert(target_path, weight);
            weight
        }
        Value::ObjectNode { bindings } => bindings
            .iter()
            .map(|binding| {
                let child_path = format!("{current_path}.{}", render_member_segment(&binding.key));
                measure_materialized_weight(
                    &binding.value,
                    &child_path,
                    path_values,
                    tracker,
                    stack,
                ) + measure_attribute_weight(
                    &binding.attributes,
                    &child_path,
                    path_values,
                    tracker,
                    stack,
                )
            })
            .sum(),
        Value::ListNode { items } | Value::TupleLiteral { items } => items
            .iter()
            .enumerate()
            .map(|(index, item)| {
                let child_path = format!("{current_path}[{index}]");
                measure_materialized_weight(item, &child_path, path_values, tracker, stack)
            })
            .sum(),
        Value::NodeLiteral {
            attributes,
            children,
            ..
        } => {
            let attributes_weight: usize = attributes
                .iter()
                .map(|block| {
                    measure_attribute_weight(
                        block,
                        &format!("{current_path}@"),
                        path_values,
                        tracker,
                        stack,
                    )
                })
                .sum();
            1 + attributes_weight
                + children
                    .iter()
                    .enumerate()
                    .map(|(index, child)| {
                        let child_path = format!("{current_path}<{index}>");
                        measure_materialized_weight(child, &child_path, path_values, tracker, stack)
                    })
                    .sum::<usize>()
        }
    }
}

fn measure_attribute_weight(
    attributes: &BTreeMap<String, AttributeValue>,
    path: &str,
    path_values: &BTreeMap<String, Value>,
    tracker: &mut MaterializationTracker,
    stack: &mut BTreeSet<String>,
) -> usize {
    attributes
        .iter()
        .map(|(key, entry)| {
            let entry_path = format!("{path}@{}", render_attribute_segment(key));
            measure_attribute_value_weight(entry, &entry_path, path_values, tracker, stack)
        })
        .sum()
}

fn measure_attribute_value_weight(
    entry: &AttributeValue,
    path: &str,
    path_values: &BTreeMap<String, Value>,
    tracker: &mut MaterializationTracker,
    stack: &mut BTreeSet<String>,
) -> usize {
    let mut total = 0;
    if let Some(value) = &entry.value {
        total += measure_materialized_weight(value, path, path_values, tracker, stack);
    }
    if !entry.nested_attrs.is_empty() {
        total += measure_attribute_weight(&entry.nested_attrs, path, path_values, tracker, stack);
    }
    if !entry.object_members.is_empty() {
        total += entry
            .object_members
            .iter()
            .map(|(key, member)| {
                let member_path = format!("{path}.{}", render_member_segment(key));
                measure_attribute_value_weight(member, &member_path, path_values, tracker, stack)
            })
            .sum::<usize>();
    }
    total
}

fn render_reference_segments(segments: &[ReferenceSegment]) -> String {
    let mut out = String::new();
    for (index, segment) in segments.iter().enumerate() {
        match segment {
            ReferenceSegment::Key(key) => {
                if index == 0 && is_identifier(key) {
                    out.push_str(key);
                } else if is_identifier(key) {
                    out.push('.');
                    out.push_str(key);
                } else {
                    out.push_str(&format!(
                        "[\"{}\"]",
                        key.replace('\\', "\\\\").replace('"', "\\\"")
                    ));
                }
            }
            ReferenceSegment::Index(index) => out.push_str(&format!("[{index}]")),
            ReferenceSegment::Attr(key) => out.push_str(&format!("@{key}")),
        }
    }
    out
}

fn reference_segments_json(segments: &[ReferenceSegment]) -> Vec<JsonValue> {
    segments
        .iter()
        .map(|segment| match segment {
            ReferenceSegment::Key(key) => JsonValue::String(key.clone()),
            ReferenceSegment::Index(index) => json!(index),
            ReferenceSegment::Attr(key) => json!({ "type": "attr", "key": key }),
        })
        .collect()
}

fn attribute_entries_to_ast_json(entries: &BTreeMap<String, AttributeValue>) -> JsonValue {
    let mut mapped = Map::new();
    for (key, entry) in entries {
        mapped.insert(key.clone(), attribute_entry_to_ast_json(entry));
    }
    json!({
        "entries": mapped,
    })
}

fn attribute_entry_to_ast_json(entry: &AttributeValue) -> JsonValue {
    let mut object = Map::new();
    object.insert(
        String::from("datatype"),
        entry
            .datatype
            .as_ref()
            .map(|name| json!({ "type": "TypeAnnotation", "name": name }))
            .unwrap_or(JsonValue::Null),
    );
    if let Some(value) = &entry.value {
        object.insert(String::from("value"), value_to_ast_json(value));
    }
    if !entry.nested_attrs.is_empty() {
        object.insert(
            String::from("attributes"),
            JsonValue::Array(vec![attribute_entries_to_ast_json(&entry.nested_attrs)]),
        );
    }
    JsonValue::Object(object)
}

fn reference_target_path(segments: &[ReferenceSegment]) -> String {
    let mut output = String::from("$");
    for segment in segments {
        match segment {
            ReferenceSegment::Key(key) => {
                if is_identifier(key) {
                    output.push('.');
                    output.push_str(key);
                } else {
                    output.push_str(".[\"");
                    output.push_str(&key.replace('\\', "\\\\").replace('"', "\\\""));
                    output.push_str("\"]");
                }
            }
            ReferenceSegment::Index(index) => output.push_str(&format!("[{index}]")),
            ReferenceSegment::Attr(key) => output.push_str(&format!("@{key}")),
        }
    }
    output
}

fn parse_number(
    raw: &str,
    path: &str,
    mode: FinalizeMode,
    errors: &mut Vec<Diagnostic>,
    warnings: &mut Vec<Diagnostic>,
) -> JsonValue {
    let normalized = raw.replace('_', "");
    if let Ok(value) = normalized.parse::<i64>() {
        if value.abs() > 9_007_199_254_740_991 {
            let diag = Diagnostic::new(
                "FINALIZE_UNSAFE_NUMBER",
                format!("Numeric literal exceeds JSON safe range: {raw}"),
            )
            .at_path(path);
            if matches!(mode, FinalizeMode::Strict) {
                errors.push(diag);
            } else {
                warnings.push(diag);
            }
            return JsonValue::String(raw.to_owned());
        }
        return json!(value);
    }
    if let Ok(value) = normalized.parse::<f64>()
        && value.is_finite()
    {
        if value.abs() > 9_007_199_254_740_991.0 {
            let diag = Diagnostic::new(
                "FINALIZE_UNSAFE_NUMBER",
                format!("Numeric literal exceeds JSON safe range: {raw}"),
            )
            .at_path(path);
            if matches!(mode, FinalizeMode::Strict) {
                errors.push(diag);
            } else {
                warnings.push(diag);
            }
            return JsonValue::String(raw.to_owned());
        }
        return json!(value);
    }
    errors.push(
        Diagnostic::new(
            "FINALIZE_INVALID_NUMBER",
            format!("Numeric literal `{raw}` cannot be represented in JSON"),
        )
        .at_path(path),
    );
    JsonValue::String(raw.to_owned())
}

fn render_member_segment(key: &str) -> String {
    if is_identifier(key) {
        key.to_owned()
    } else {
        format!("[\"{}\"]", key.replace('\\', "\\\\").replace('"', "\\\""))
    }
}

fn render_attribute_segment(key: &str) -> String {
    render_member_segment(key)
}

fn is_identifier(value: &str) -> bool {
    let mut chars = value.chars();
    match chars.next() {
        Some(first) if first == '_' || first.is_ascii_alphabetic() => {}
        _ => return false,
    }
    chars.all(|ch| ch == '_' || ch.is_ascii_alphanumeric())
}

fn is_reserved_key(key: &str) -> bool {
    matches!(
        key,
        "@" | "$" | "$node" | "$children" | "__proto__" | "constructor"
    )
}

fn index_event_values(events: &[AssignmentEvent]) -> BTreeMap<String, Value> {
    let mut values = BTreeMap::new();
    for event in events {
        let _ = values.insert(format_path(&event.path), event.value.clone());
    }
    values
}

fn push_map_entry(
    seen: &mut BTreeSet<String>,
    entries: &mut Vec<FinalizedEntry>,
    errors: &mut Vec<Diagnostic>,
    warnings: &mut Vec<Diagnostic>,
    mode: FinalizeMode,
    path: String,
    value: Value,
    span: Span,
    datatype: Option<String>,
    annotations: BTreeMap<String, AttributeValue>,
) {
    if !seen.insert(path.clone()) {
        let diag = Diagnostic::new(
            "FINALIZE_DUPLICATE_PATH",
            format!("Duplicate path during finalization: {path}"),
        )
        .at_path(&path);
        if matches!(mode, FinalizeMode::Strict) {
            errors.push(diag);
            return;
        }
        warnings.push(diag);
    }
    entries.push(FinalizedEntry {
        path,
        value,
        span,
        datatype,
        annotations,
    });
}

fn attributes_to_json(
    attributes: &BTreeMap<String, AttributeValue>,
    path: &str,
    projection: &Projection,
    path_values: &BTreeMap<String, Value>,
    mode: FinalizeMode,
    errors: &mut Vec<Diagnostic>,
    warnings: &mut Vec<Diagnostic>,
    active_paths: &mut BTreeSet<String>,
    tracker: &mut MaterializationTracker,
) -> JsonValue {
    let mut object = Map::new();
    let mut nested = Map::new();
    for (key, entry) in attributes {
        let entry_path = format!("{path}@{}", render_attribute_segment(key));
        if !projection.includes(&entry_path) {
            continue;
        }
        let value = attribute_value_to_json(
            entry,
            &entry_path,
            projection,
            path_values,
            mode,
            errors,
            warnings,
            active_paths,
            tracker,
        );
        object.insert(key.clone(), value);
        if !entry.nested_attrs.is_empty() {
            nested.insert(
                key.clone(),
                attributes_to_json(
                    &entry.nested_attrs,
                    &entry_path,
                    projection,
                    path_values,
                    mode,
                    errors,
                    warnings,
                    active_paths,
                    tracker,
                ),
            );
        }
    }
    if !nested.is_empty() {
        object.insert(String::from("@"), JsonValue::Object(nested));
    }
    JsonValue::Object(object)
}

fn node_attributes_to_json(
    attributes: &[BTreeMap<String, AttributeValue>],
    path: &str,
    projection: &Projection,
    path_values: &BTreeMap<String, Value>,
    mode: FinalizeMode,
    errors: &mut Vec<Diagnostic>,
    warnings: &mut Vec<Diagnostic>,
    active_paths: &mut BTreeSet<String>,
    tracker: &mut MaterializationTracker,
) -> JsonValue {
    let mut merged = Map::new();
    for block in attributes {
        let JsonValue::Object(current) = attributes_to_json(
            block,
            path,
            projection,
            path_values,
            mode,
            errors,
            warnings,
            active_paths,
            tracker,
        ) else {
            continue;
        };
        merge_json_object(&mut merged, current);
    }
    JsonValue::Object(merged)
}

fn merge_json_object(target: &mut Map<String, JsonValue>, source: Map<String, JsonValue>) {
    for (key, value) in source {
        match (target.get_mut(&key), value) {
            (Some(JsonValue::Object(existing)), JsonValue::Object(incoming)) => {
                merge_json_object(existing, incoming);
            }
            (_, replacement) => {
                target.insert(key, replacement);
            }
        }
    }
}

fn attribute_value_to_json(
    entry: &AttributeValue,
    path: &str,
    projection: &Projection,
    path_values: &BTreeMap<String, Value>,
    mode: FinalizeMode,
    errors: &mut Vec<Diagnostic>,
    warnings: &mut Vec<Diagnostic>,
    active_paths: &mut BTreeSet<String>,
    tracker: &mut MaterializationTracker,
) -> JsonValue {
    if !entry.object_members.is_empty() {
        return object_attribute_members_to_json(
            &entry.object_members,
            path,
            projection,
            path_values,
            mode,
            errors,
            warnings,
            active_paths,
            tracker,
        );
    }
    if let Some(value) = &entry.value {
        return value_to_json(
            value,
            path,
            projection,
            path_values,
            mode,
            errors,
            warnings,
            entry.datatype.as_deref(),
            active_paths,
            tracker,
        );
    }
    JsonValue::Null
}

fn object_attribute_members_to_json(
    members: &BTreeMap<String, AttributeValue>,
    path: &str,
    projection: &Projection,
    path_values: &BTreeMap<String, Value>,
    mode: FinalizeMode,
    errors: &mut Vec<Diagnostic>,
    warnings: &mut Vec<Diagnostic>,
    active_paths: &mut BTreeSet<String>,
    tracker: &mut MaterializationTracker,
) -> JsonValue {
    let mut object = Map::new();
    let mut attrs = Map::new();
    for (key, entry) in members {
        let child_path = format!("{path}.{}", render_member_segment(key));
        if !projection.includes(&child_path) {
            continue;
        }
        object.insert(
            key.clone(),
            attribute_value_to_json(
                entry,
                &child_path,
                projection,
                path_values,
                mode,
                errors,
                warnings,
                active_paths,
                tracker,
            ),
        );
        if !entry.nested_attrs.is_empty() {
            attrs.insert(
                key.clone(),
                attributes_to_json(
                    &entry.nested_attrs,
                    &child_path,
                    projection,
                    path_values,
                    mode,
                    errors,
                    warnings,
                    active_paths,
                    tracker,
                ),
            );
        }
    }
    if !attrs.is_empty() {
        object.insert(String::from("@"), JsonValue::Object(attrs));
    }
    JsonValue::Object(object)
}

fn declared_radix_base(datatype: Option<&str>) -> Option<usize> {
    match datatype?.trim() {
        "radix2" => Some(2),
        "radix6" => Some(6),
        "radix8" => Some(8),
        "radix12" => Some(12),
        value => {
            let body = value.strip_prefix("radix[")?.strip_suffix(']')?;
            let base = body.parse::<usize>().ok()?;
            (2..=64).contains(&base).then_some(base)
        }
    }
}

fn exceeds_declared_radix(value: &str, base: usize) -> bool {
    value.chars().any(|ch| match ch {
        '+' | '-' | '.' => false,
        _ => radix_digit_value(ch).is_none_or(|digit| digit >= base),
    })
}

fn radix_digit_value(ch: char) -> Option<usize> {
    match ch {
        '0'..='9' => Some((ch as u8 - b'0') as usize),
        'A'..='Z' => Some((ch as u8 - b'A') as usize + 10),
        'a'..='z' => Some((ch as u8 - b'a') as usize + 36),
        '&' => Some(62),
        '!' => Some(63),
        _ => None,
    }
}

#[derive(Debug, Clone)]
struct Projection {
    materialization: Materialization,
    include_paths: Vec<String>,
}

impl Projection {
    fn new(materialization: Materialization, include_paths: Vec<String>) -> Self {
        Self {
            materialization,
            include_paths,
        }
    }

    fn includes(&self, candidate: &str) -> bool {
        if matches!(self.materialization, Materialization::All) {
            return true;
        }
        let normalized_candidate = normalize_projection_path(candidate);

        self.include_paths.iter().any(|include| {
            let normalized_include = normalize_projection_path(include);
            normalized_candidate == normalized_include
                || has_path_prefix(&normalized_candidate, &normalized_include)
                || has_path_prefix(&normalized_include, &normalized_candidate)
        })
    }
}

fn has_path_prefix(path: &str, prefix: &str) -> bool {
    path.strip_prefix(prefix)
        .map(|rest| {
            rest.starts_with('.')
                || rest.starts_with('[')
                || rest.starts_with('@')
                || rest.starts_with('<')
        })
        .unwrap_or(false)
}

fn normalize_projection_path(path: &str) -> String {
    let bytes = path.as_bytes();
    let mut out = String::new();
    let mut index = 0;

    while index < bytes.len() {
        let current = bytes[index] as char;
        if matches!(current, '.' | '@' | '$')
            && index + 3 < bytes.len()
            && bytes[index + 1] == b'['
            && bytes[index + 2] == b'"'
        {
            let mut key = String::new();
            let mut cursor = index + 3;
            let mut escaped = false;
            while cursor < bytes.len() {
                let ch = bytes[cursor] as char;
                if escaped {
                    key.push(ch);
                    escaped = false;
                    cursor += 1;
                    continue;
                }
                if ch == '\\' {
                    escaped = true;
                    cursor += 1;
                    continue;
                }
                if ch == '"' {
                    break;
                }
                key.push(ch);
                cursor += 1;
            }
            if cursor + 1 < bytes.len()
                && bytes[cursor] == b'"'
                && bytes[cursor + 1] == b']'
                && is_identifier(&key)
            {
                if current == '$' {
                    out.push_str("$.");
                } else {
                    out.push(current);
                }
                out.push_str(&key);
                index = cursor + 2;
                continue;
            }
        }
        out.push(current);
        index += 1;
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use aeon_core::{CompileOptions, compile};
    use serde::Deserialize;

    #[test]
    fn finalizes_basic_payload_to_json() {
        let source = "name = \"AEON\"\nflags = [true, false]\n";
        let result = compile(source, CompileOptions::default());
        let finalized = finalize_json(&result.events, FinalizeOptions::default());
        assert_eq!(finalized.document["name"], json!("AEON"));
        assert_eq!(finalized.document["flags"], json!([true, false]));
    }

    #[test]
    fn finalized_json_preserves_object_source_order() {
        let source = "a:o = {\n  a:n = 2\n  c:list = [2, 2]\n  b:n = 3\n}\n";
        let result = compile(source, CompileOptions::default());
        let finalized = finalize_json(&result.events, FinalizeOptions::default());
        let rendered =
            serde_json::to_string_pretty(&finalized.document).expect("serialize finalized json");
        let c_index = rendered.find("\"c\"").expect("c key present");
        let b_index = rendered.find("\"b\"").expect("b key present");
        assert!(
            c_index < b_index,
            "expected source order to keep c before b, got: {rendered}"
        );
    }

    #[test]
    fn projected_materialization_keeps_selected_descendants() {
        let source = "config = {\n  host = \"localhost\"\n  port = 5432\n}\n";
        let result = compile(source, CompileOptions::default());
        let finalized = finalize_json(
            &result.events,
            FinalizeOptions {
                materialization: Materialization::Projected,
                include_paths: vec![String::from("$.config.host")],
                ..FinalizeOptions::default()
            },
        );
        assert_eq!(
            finalized.document,
            json!({ "config": { "host": "localhost" } })
        );
    }

    #[test]
    fn projected_json_keeps_exact_top_level_attribute_selection_without_siblings() {
        let source = "title@{lang = \"en\", tone = \"warm\"} = \"Hello\"\n";
        let result = compile(source, CompileOptions::default());
        let finalized = finalize_json(
            &result.events,
            FinalizeOptions {
                materialization: Materialization::Projected,
                include_paths: vec![String::from("$.title@lang")],
                ..FinalizeOptions::default()
            },
        );
        assert_eq!(
            finalized.document,
            json!({
                "title": "Hello",
                "@": {
                    "title": {
                        "lang": "en"
                    }
                }
            })
        );
    }

    #[test]
    fn projected_json_keeps_attribute_descendants_without_leaking_siblings() {
        let source =
            "card = { title@{meta = { keep = 2, \"x.y\" = 1 }, tone = \"warm\"} = \"Hello\" }\n";
        let result = compile(source, CompileOptions::default());
        let finalized = finalize_json(
            &result.events,
            FinalizeOptions {
                materialization: Materialization::Projected,
                include_paths: vec![String::from("$.card.title@meta.keep")],
                ..FinalizeOptions::default()
            },
        );
        assert_eq!(
            finalized.document,
            json!({
                "card": {
                    "title": "Hello",
                    "@": {
                        "title": {
                            "meta": {
                                "keep": 2
                            }
                        }
                    }
                }
            })
        );
    }

    #[test]
    fn projected_json_keeps_exact_node_head_attribute_selection_without_siblings() {
        let source = "badge = <pill@{id = \"main\", class = \"hero\"}(\"new\")>\n";
        let result = compile(source, CompileOptions::default());
        let finalized = finalize_json(
            &result.events,
            FinalizeOptions {
                materialization: Materialization::Projected,
                include_paths: vec![String::from("$.badge@@[\"id\"]")],
                ..FinalizeOptions::default()
            },
        );
        assert_eq!(
            finalized.document,
            json!({
                "badge": {
                    "$node": "pill",
                    "@": {
                        "id": "main"
                    },
                    "$children": ["new"]
                }
            })
        );
    }

    #[test]
    fn projected_map_preserves_assignment_chain_for_attribute_paths() {
        let source = "title@{lang = \"en\", meta = { keep = 2 }} = \"Hello\"\ncard = { label@{meta = { keep = 3, \"x.y\" = 4 }} = \"Hi\" }\nrich = <pill@{id = \"main\", meta = { keep = 5 }}(\"new\")>\n";
        let result = compile(source, CompileOptions::default());

        let top_level = finalize_map(
            &result.events,
            FinalizeOptions {
                materialization: Materialization::Projected,
                include_paths: vec![
                    String::from("$.title@lang"),
                    String::from("$.title@meta.keep"),
                ],
                ..FinalizeOptions::default()
            },
        );
        assert_eq!(
            top_level
                .document
                .entries
                .iter()
                .map(|entry| entry.path.as_str())
                .collect::<Vec<_>>(),
            vec!["$.title"]
        );

        let nested = finalize_map(
            &result.events,
            FinalizeOptions {
                materialization: Materialization::Projected,
                include_paths: vec![
                    String::from("$.card.label@meta.keep"),
                    String::from("$.card.label@meta.[\"x.y\"]"),
                ],
                ..FinalizeOptions::default()
            },
        );
        assert_eq!(
            nested
                .document
                .entries
                .iter()
                .map(|entry| entry.path.as_str())
                .collect::<Vec<_>>(),
            vec!["$.card", "$.card.label"]
        );

        let node = finalize_map(
            &result.events,
            FinalizeOptions {
                materialization: Materialization::Projected,
                include_paths: vec![
                    String::from("$.rich@@id"),
                    String::from("$.rich@@meta.keep"),
                ],
                ..FinalizeOptions::default()
            },
        );
        assert_eq!(
            node.document
                .entries
                .iter()
                .map(|entry| entry.path.as_str())
                .collect::<Vec<_>>(),
            vec!["$.rich"]
        );
    }

    #[test]
    fn surfaced_string_ast_preserves_delimiters_and_trimtick_metadata() {
        let result = compile(
            "single = 'alpha'\nraw = `beta`\ntrim:trimtick = >`\n  one\n  two\n`\n",
            CompileOptions::default(),
        );
        assert!(result.errors.is_empty(), "{:?}", result.errors);

        let by_path = result
            .events
            .iter()
            .map(|event| (format_path(&event.path), value_to_ast_json(&event.value)))
            .collect::<std::collections::BTreeMap<_, _>>();

        assert_eq!(by_path["$.single"]["delimiter"], "'");
        assert_eq!(by_path["$.single"]["raw"], "alpha");
        assert_eq!(by_path["$.raw"]["delimiter"], "`");
        assert_eq!(by_path["$.raw"]["raw"], "beta");
        assert_eq!(by_path["$.trim"]["delimiter"], "`");
        assert_eq!(by_path["$.trim"]["raw"], "\n  one\n  two\n");
        assert_eq!(by_path["$.trim"]["trimticks"]["markerWidth"], 1);
        assert_eq!(
            by_path["$.trim"]["trimticks"]["rawValue"],
            "\n  one\n  two\n"
        );
    }

    #[test]
    fn surfaced_number_ast_preserves_raw_and_normalizes_value() {
        let result = compile("a = 1_000_000\nb = 1_2.3_4\n", CompileOptions::default());
        assert!(result.errors.is_empty(), "{:?}", result.errors);

        let by_path = result
            .events
            .iter()
            .map(|event| (format_path(&event.path), value_to_ast_json(&event.value)))
            .collect::<std::collections::BTreeMap<_, _>>();

        assert_eq!(by_path["$.a"]["raw"], "1_000_000");
        assert_eq!(by_path["$.a"]["value"], "1000000");
        assert_eq!(by_path["$.b"]["raw"], "1_2.3_4");
        assert_eq!(by_path["$.b"]["value"], "12.34");
    }

    #[test]
    fn resolves_clone_references_into_json_values() {
        let source = "source = 99\ncopy = ~source\n";
        let result = compile(source, CompileOptions::default());
        let finalized = finalize_json(&result.events, FinalizeOptions::default());
        assert_eq!(finalized.document, json!({ "copy": 99, "source": 99 }));
    }

    #[test]
    fn keeps_pointer_references_symbolic_in_json_values() {
        let source = "target = 99\nptr = ~>target\n";
        let result = compile(source, CompileOptions::default());
        let finalized = finalize_json(&result.events, FinalizeOptions::default());
        assert_eq!(
            finalized.document,
            json!({ "ptr": "~>target", "target": 99 })
        );
    }

    #[test]
    fn projected_clone_references_preserve_the_clone_path() {
        let source = "a = { x = 1 }\nb = ~a\n";
        let result = compile(source, CompileOptions::default());
        let finalized = finalize_json(
            &result.events,
            FinalizeOptions {
                materialization: Materialization::Projected,
                include_paths: vec![String::from("$.b.x")],
                ..FinalizeOptions::default()
            },
        );
        assert_eq!(finalized.document, json!({ "b": { "x": 1 } }));
    }

    #[test]
    fn finalize_json_enforces_max_materialized_weight_for_repeated_clone_expansion() {
        let source = "big = { a = 1, b = 2, c = 3 }\ncopy1 = ~big\ncopy2 = ~big\n";
        let result = compile(source, CompileOptions::default());
        let finalized = finalize_json(
            &result.events,
            FinalizeOptions {
                max_materialized_weight: Some(4),
                ..FinalizeOptions::default()
            },
        );

        assert_eq!(
            finalized.document,
            json!({
                "big": { "a": 1, "b": 2, "c": 3 },
                "copy1": { "a": 1, "b": 2, "c": 3 },
                "copy2": "~big"
            })
        );
        assert!(
            finalized
                .meta
                .errors
                .iter()
                .any(|error| error.code == "FINALIZE_REFERENCE_BUDGET_EXCEEDED"),
            "{:?}",
            finalized.meta.errors
        );
    }

    #[test]
    fn finalize_json_enforces_max_materialized_weight_for_transitive_clone_chains() {
        let source = "base = { a = 1, b = 2 }\ncopy1 = ~base\ncopy2 = ~copy1\n";
        let result = compile(source, CompileOptions::default());
        let finalized = finalize_json(
            &result.events,
            FinalizeOptions {
                max_materialized_weight: Some(3),
                ..FinalizeOptions::default()
            },
        );

        assert_eq!(
            finalized.document,
            json!({
                "base": { "a": 1, "b": 2 },
                "copy1": { "a": 1, "b": 2 },
                "copy2": "~copy1"
            })
        );
        assert!(
            finalized
                .meta
                .errors
                .iter()
                .any(|error| error.code == "FINALIZE_REFERENCE_BUDGET_EXCEEDED"),
            "{:?}",
            finalized.meta.errors
        );
    }

    #[test]
    fn finalize_json_reports_reference_cycles_instead_of_recursing() {
        let events = vec![AssignmentEvent {
            path: aeon_core::CanonicalPath::root().member("a"),
            key: String::from("a"),
            datatype: Some(String::from("list")),
            annotations: BTreeMap::new(),
            value: Value::ListNode {
                items: vec![Value::CloneReference {
                    segments: vec![ReferenceSegment::Key(String::from("a"))],
                    span: Span::zero(),
                }],
            },
            span: Span::zero(),
        }];
        let finalized = finalize_json(
            &events,
            FinalizeOptions {
                mode: FinalizeMode::Strict,
                ..FinalizeOptions::default()
            },
        );
        assert_eq!(finalized.document, json!({ "a": ["~a"] }));
        assert!(
            finalized
                .meta
                .errors
                .iter()
                .any(|error| error.code == "FINALIZE_REFERENCE_CYCLE"),
            "{:?}",
            finalized.meta.errors
        );
    }

    #[test]
    fn rejects_reserved_projection_keys() {
        let source = "\"@\" = 1\n";
        let result = compile(source, CompileOptions::default());
        let finalized = finalize_json(
            &result.events,
            FinalizeOptions {
                mode: FinalizeMode::Loose,
                ..FinalizeOptions::default()
            },
        );
        assert_eq!(finalized.document, json!({}));
        assert_eq!(finalized.meta.errors.len(), 1);
        assert_eq!(finalized.meta.errors[0].code, "FINALIZE_RESERVED_KEY");
    }

    #[test]
    fn projects_top_level_attributes_under_at_key() {
        let source = "title@{lang = \"en\"} = \"Hello\"\n";
        let result = compile(source, CompileOptions::default());
        let finalized = finalize_json(&result.events, FinalizeOptions::default());
        assert_eq!(
            finalized.document,
            json!({
                "title": "Hello",
                "@": {
                    "title": {
                        "lang": "en"
                    }
                }
            })
        );
    }

    #[test]
    fn localizes_nested_object_attributes() {
        let source = "a@{b = 1} = { c@{d = 3} = 2 }\n";
        let result = compile(source, CompileOptions::default());
        let finalized = finalize_json(&result.events, FinalizeOptions::default());
        assert_eq!(
            finalized.document,
            json!({
                "a": {
                    "c": 2,
                    "@": {
                        "c": {
                            "d": 3
                        }
                    }
                },
                "@": {
                    "a": {
                        "b": 1
                    }
                }
            })
        );
    }

    #[test]
    fn materializes_node_literals_with_reserved_projection_keys() {
        let source = "view = <div@{id = \"main\"}(\"hello\")>\n";
        let result = compile(source, CompileOptions::default());
        let finalized = finalize_json(&result.events, FinalizeOptions::default());
        assert_eq!(
            finalized.document,
            json!({
                "view": {
                    "$node": "div",
                    "@": {
                        "id": "main"
                    },
                    "$children": ["hello"]
                }
            })
        );
    }

    #[test]
    fn materializes_nested_node_list_and_tuple_children_like_typescript() {
        let source = "b = <a(<a(1,2,3)>)>\nc = <a([1,2])>\nd = <a((1,2))>\n";
        let result = compile(source, CompileOptions::default());
        let finalized = finalize_json(
            &result.events,
            FinalizeOptions {
                mode: FinalizeMode::Loose,
                ..FinalizeOptions::default()
            },
        );
        assert_eq!(
            finalized.document,
            json!({
                "b": {
                    "$node": "a",
                    "$children": [
                        {
                            "$node": "a",
                            "$children": [1, 2, 3]
                        }
                    ]
                },
                "c": {
                    "$node": "a",
                    "$children": [
                        [1, 2]
                    ]
                },
                "d": {
                    "$node": "a",
                    "$children": [
                        [1, 2]
                    ]
                }
            })
        );
    }

    #[test]
    fn strips_literal_sigils_in_finalized_json_like_typescript() {
        let source = "hex = #Ff_FF\nrad = %1011\nenc = $QmFzZTY0\n";
        let result = compile(source, CompileOptions::default());
        let finalized = finalize_json(&result.events, FinalizeOptions::default());
        assert_eq!(
            finalized.document,
            json!({
                "hex": "FfFF",
                "rad": "1011",
                "enc": "QmFzZTY0"
            })
        );
    }

    #[test]
    fn strips_underscore_separators_from_finalized_radix_strings() {
        let source = "mask = %101_0101\n";
        let result = compile(source, CompileOptions::default());
        let finalized = finalize_json(&result.events, FinalizeOptions::default());
        assert_eq!(finalized.document, json!({ "mask": "1010101" }));
    }

    #[test]
    fn reports_radix_digits_that_exceed_declared_base_during_finalization() {
        let source = "mask:radix[10] = %1A\n";
        let result = compile(source, CompileOptions::default());
        let finalized = finalize_json(&result.events, FinalizeOptions::default());
        assert_eq!(finalized.document, json!({ "mask": "1A" }));
        assert_eq!(finalized.meta.errors.len(), 1);
        assert!(
            finalized.meta.errors[0]
                .message
                .contains("declared radix 10")
        );
    }

    #[test]
    fn reports_unsafe_floating_numbers_during_finalization() {
        let source = "n = 9007199254740993.0\n";
        let result = compile(source, CompileOptions::default());
        let finalized = finalize_json(&result.events, FinalizeOptions::default());
        assert_eq!(finalized.document, json!({ "n": "9007199254740993.0" }));
        assert_eq!(finalized.meta.errors.len(), 1);
        assert_eq!(finalized.meta.errors[0].code, "FINALIZE_UNSAFE_NUMBER");
    }

    #[test]
    fn reports_infinity_as_outside_strict_json_profile() {
        let source = "limit:infinity = Infinity\n";
        let result = compile(source, CompileOptions::default());
        let finalized = finalize_json(&result.events, FinalizeOptions::default());
        assert_eq!(finalized.document, json!({ "limit": "Infinity" }));
        assert_eq!(finalized.meta.errors.len(), 1);
        assert_eq!(
            finalized.meta.errors[0].code,
            "FINALIZE_JSON_PROFILE_INFINITY"
        );
    }

    #[derive(Debug, Deserialize, PartialEq)]
    struct GreetingDoc {
        greeting: String,
    }

    #[test]
    fn materializes_typed_struct_from_events() {
        let source = "greeting = \"Hello\"\n";
        let result = compile(source, CompileOptions::default());
        let document: GreetingDoc =
            finalize_into(&result.events, FinalizeOptions::default()).expect("typed finalize");
        assert_eq!(
            document,
            GreetingDoc {
                greeting: String::from("Hello"),
            }
        );
    }

    #[test]
    fn materializes_typed_struct_from_source() {
        let document: GreetingDoc = from_aeon_str(
            "greeting = \"Hello\"\n",
            CompileOptions::default(),
            FinalizeOptions::default(),
        )
        .expect("typed materialization");
        assert_eq!(
            document,
            GreetingDoc {
                greeting: String::from("Hello"),
            }
        );
    }

    #[test]
    fn returns_compile_errors_when_source_is_invalid() {
        let error = from_aeon_str::<GreetingDoc>(
            "greeting = {\n",
            CompileOptions::default(),
            FinalizeOptions::default(),
        )
        .expect_err("compile failure");
        assert!(matches!(error, MaterializeError::Compile(_)));
    }

    #[test]
    fn returns_finalize_errors_when_json_materialization_fails() {
        let source = "\"@\" = 1\n";
        let result = compile(source, CompileOptions::default());
        let error = finalize_into::<serde_json::Value>(
            &result.events,
            FinalizeOptions {
                mode: FinalizeMode::Loose,
                ..FinalizeOptions::default()
            },
        )
        .expect_err("finalize failure");
        assert!(matches!(error, MaterializeError::Finalize(_)));
    }

    #[test]
    fn returns_deserialize_errors_when_target_type_mismatches() {
        #[allow(dead_code)]
        #[derive(Debug, Deserialize)]
        struct WrongDoc {
            greeting: usize,
        }

        let error = from_aeon_str::<WrongDoc>(
            "greeting = \"Hello\"\n",
            CompileOptions::default(),
            FinalizeOptions::default(),
        )
        .expect_err("deserialize failure");
        assert!(matches!(error, MaterializeError::Deserialize(_)));
    }
}
