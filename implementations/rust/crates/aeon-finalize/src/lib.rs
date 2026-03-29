use std::collections::{BTreeMap, BTreeSet};
use std::fmt;

use aeon_core::{
    compile, format_path, AssignmentEvent, AttributeValue, CompileOptions, Diagnostic,
    HeaderFields, ReferenceSegment, Span, Value,
};
use serde::de::DeserializeOwned;
use serde_json::{json, Map, Value as JsonValue};

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
}

impl Default for FinalizeOptions {
    fn default() -> Self {
        Self {
            mode: FinalizeMode::Strict,
            materialization: Materialization::All,
            include_paths: Vec::new(),
            scope: FinalizeScope::Payload,
            header: None,
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

#[derive(Debug)]
pub enum MaterializeError {
    Compile(Vec<Diagnostic>),
    Finalize(FinalizeMeta),
    Deserialize(serde_json::Error),
}

impl fmt::Display for MaterializeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Compile(errors) => write!(f, "AEON compile failed with {} error(s)", errors.len()),
            Self::Finalize(meta) => write!(f, "AEON finalize failed with {} error(s)", meta.errors.len()),
            Self::Deserialize(error) => write!(f, "failed to deserialize finalized AEON document: {error}"),
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
    let projection = Projection::new(options.materialization, options.include_paths.clone());
    let path_values = index_event_values(events);

    let payload = if matches!(options.scope, FinalizeScope::Payload | FinalizeScope::Full) {
        payload_to_json(events, &projection, &path_values, options.mode, &mut errors, &mut warnings)
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

    if matches!(options.scope, FinalizeScope::Header | FinalizeScope::Full) {
        if let Some(header) = options.header.as_ref() {
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
            "value": raw,
        }),
        Value::InfinityLiteral { raw } => json!({
            "type": "InfinityLiteral",
            "raw": raw,
            "value": raw,
        }),
        Value::StringLiteral { value, .. } => json!({
            "type": "StringLiteral",
            "raw": value,
            "value": value,
        }),
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
            "value": raw,
            "raw": raw,
        }),
        Value::SeparatorLiteral { raw } => json!({
            "type": "SeparatorLiteral",
            "value": raw.trim_start_matches('^'),
            "raw": raw,
        }),
        Value::EncodingLiteral { raw } => json!({
            "type": "EncodingLiteral",
            "value": raw,
            "raw": raw,
        }),
        Value::RadixLiteral { raw } => json!({
            "type": "RadixLiteral",
            "value": raw,
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
        Value::CloneReference { segments } => json!({
            "type": "CloneReference",
            "path": reference_segments_json(segments),
        }),
        Value::PointerReference { segments } => json!({
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
                errors.push(Diagnostic::new("FINALIZE_RESERVED_KEY", format!("Reserved key: {key}")).at_path(&path));
                continue;
            }
            object.insert(
                key.clone(),
                value_to_json(value, &path, projection, path_values, mode, errors, warnings),
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
            errors.push(Diagnostic::new("FINALIZE_RESERVED_KEY", format!("Reserved key: {key}")).at_path(&path));
            continue;
        }
        document.insert(
            key.clone(),
            value_to_json(&event.value, &path, projection, path_values, mode, errors, warnings),
        );
        if !event.annotations.is_empty() {
            attrs.insert(
                key.clone(),
                attributes_to_json(&event.annotations, path_values, mode, errors, warnings),
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
) -> JsonValue {
    match value {
        Value::StringLiteral { value, .. } => JsonValue::String(value.clone()),
        Value::NumberLiteral { raw } => parse_number(raw, path, mode, errors, warnings),
        Value::InfinityLiteral { raw } => JsonValue::String(raw.clone()),
        Value::SwitchLiteral { raw } => JsonValue::Bool(matches!(raw.as_str(), "yes" | "on" | "true")),
        Value::BooleanLiteral { raw } => JsonValue::Bool(raw == "true"),
        Value::HexLiteral { raw }
        | Value::SeparatorLiteral { raw }
        | Value::EncodingLiteral { raw }
        | Value::RadixLiteral { raw }
        | Value::DateLiteral { raw }
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
            let attr_json = node_attributes_to_json(attributes, path_values, mode, errors, warnings);
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
                            value_to_json(child, &child_path, projection, path_values, mode, errors, warnings)
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
                    output.push(value_to_json(item, &item_path, projection, path_values, mode, errors, warnings));
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
                        ),
                    );
                    if !binding.attributes.is_empty() {
                        attrs.insert(
                            binding.key.clone(),
                            attributes_to_json(&binding.attributes, path_values, mode, errors, warnings),
                        );
                    }
                }
            }
            if !attrs.is_empty() {
                output.insert(String::from("@"), JsonValue::Object(attrs));
            }
            JsonValue::Object(output)
        }
        Value::CloneReference { segments } => {
            let target = reference_target_path(segments);
            if let Some(resolved) = path_values.get(&target) {
                value_to_json(resolved, &target, projection, path_values, mode, errors, warnings)
            } else {
                JsonValue::String(format!("~{}", render_reference_segments(segments)))
            }
        }
        Value::PointerReference { segments } => {
            JsonValue::String(format!("~>{}", render_reference_segments(segments)))
        }
    }
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
                    out.push_str(&format!("[\"{}\"]", key.replace('\\', "\\\\").replace('"', "\\\"")));
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
        let mut rendered = value_to_ast_json(value);
        if let JsonValue::Object(ref mut value_obj) = rendered {
            if matches!(value, Value::StringLiteral { .. }) {
                value_obj.insert(String::from("delimiter"), JsonValue::String(String::from("\"")));
            }
        }
        object.insert(String::from("value"), rendered);
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
    if let Ok(value) = normalized.parse::<f64>() {
        if value.is_finite() {
            return json!(value);
        }
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

fn is_identifier(value: &str) -> bool {
    let mut chars = value.chars();
    match chars.next() {
        Some(first) if first == '_' || first.is_ascii_alphabetic() => {}
        _ => return false,
    }
    chars.all(|ch| ch == '_' || ch.is_ascii_alphanumeric())
}

fn is_reserved_key(key: &str) -> bool {
    matches!(key, "@" | "$" | "$node" | "$children" | "__proto__" | "constructor")
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
    path_values: &BTreeMap<String, Value>,
    mode: FinalizeMode,
    errors: &mut Vec<Diagnostic>,
    warnings: &mut Vec<Diagnostic>,
) -> JsonValue {
    let mut object = Map::new();
    let mut nested = Map::new();
    for (key, entry) in attributes {
        let value = attribute_value_to_json(entry, path_values, mode, errors, warnings);
        object.insert(key.clone(), value);
        if !entry.nested_attrs.is_empty() {
            nested.insert(
                key.clone(),
                attributes_to_json(&entry.nested_attrs, path_values, mode, errors, warnings),
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
    path_values: &BTreeMap<String, Value>,
    mode: FinalizeMode,
    errors: &mut Vec<Diagnostic>,
    warnings: &mut Vec<Diagnostic>,
) -> JsonValue {
    let mut merged = Map::new();
    for block in attributes {
        let JsonValue::Object(current) = attributes_to_json(block, path_values, mode, errors, warnings) else {
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
    path_values: &BTreeMap<String, Value>,
    mode: FinalizeMode,
    errors: &mut Vec<Diagnostic>,
    warnings: &mut Vec<Diagnostic>,
) -> JsonValue {
    if !entry.object_members.is_empty() {
        return attributes_to_json(&entry.object_members, path_values, mode, errors, warnings);
    }
    if let Some(value) = &entry.value {
        return value_to_json(value, "$", &Projection::new(Materialization::All, Vec::new()), path_values, mode, errors, warnings);
    }
    JsonValue::Null
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

        self.include_paths.iter().any(|include| {
            candidate == include
                || has_path_prefix(candidate, include)
                || has_path_prefix(include, candidate)
        })
    }
}

fn has_path_prefix(path: &str, prefix: &str) -> bool {
    path.strip_prefix(prefix)
        .map(|rest| rest.starts_with('.') || rest.starts_with('['))
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use aeon_core::{compile, CompileOptions};
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
        let rendered = serde_json::to_string_pretty(&finalized.document).expect("serialize finalized json");
        let c_index = rendered.find("\"c\"").expect("c key present");
        let b_index = rendered.find("\"b\"").expect("b key present");
        assert!(c_index < b_index, "expected source order to keep c before b, got: {rendered}");
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
        assert_eq!(finalized.document, json!({ "config": { "host": "localhost" } }));
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
        assert_eq!(finalized.document, json!({ "ptr": "~>target", "target": 99 }));
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
