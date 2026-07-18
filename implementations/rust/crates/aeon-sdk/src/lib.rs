use std::collections::BTreeMap;
use std::fmt;
use std::fs;
use std::path::{Path, PathBuf};

use aeon_aeos::{
    AesEvent, EventPath, EventValue, OffsetOnly, PathSegmentInput, ReferencePathSegment,
    ResultEnvelope, Schema, SpanInput, ValidationEnvelope, ValidationOptions, validate,
};
use aeon_core::{
    AssignmentEvent, CompileOptions, DatatypePolicy, Diagnostic, NullLiteralMode, PathSegment,
    ReferenceSegment, Value, compile, normalize_number_literal,
};
use aeon_finalize::{FinalizeOptions, MaterializeError, finalize_into};
use serde::de::DeserializeOwned;
use serde_json::{Map as JsonMap, Value as JsonValue, json};

#[derive(Debug, Clone, Default)]
pub struct LoadOptions {
    pub compile: CompileOptions,
    pub finalize: FinalizeOptions,
    pub schema: Option<Schema>,
    pub schema_file: Option<PathBuf>,
    pub validation: ValidationOptions,
}

#[derive(Debug, Clone)]
pub struct LoadedDocument<T> {
    pub compiled: aeon_core::CompileResult,
    pub validation: Option<ResultEnvelope>,
    pub document: T,
}

#[derive(Debug)]
pub enum AeonLoadError {
    Read(std::io::Error),
    Compile(Vec<Diagnostic>),
    SchemaLoad(String),
    Schema(ResultEnvelope),
    Finalize(aeon_finalize::FinalizeMeta),
    Deserialize(serde_json::Error),
}

impl fmt::Display for AeonLoadError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Read(error) => write!(f, "failed to read AEON file: {error}"),
            Self::Compile(errors) => {
                write!(f, "AEON compile failed with {} error(s)", errors.len())
            }
            Self::SchemaLoad(message) => write!(f, "{message}"),
            Self::Schema(result) => {
                write!(
                    f,
                    "AEOS validation failed with {} error(s)",
                    result.errors.len()
                )
            }
            Self::Finalize(meta) => {
                write!(
                    f,
                    "AEON finalize failed with {} error(s)",
                    meta.errors.len()
                )
            }
            Self::Deserialize(error) => {
                write!(f, "failed to deserialize finalized AEON document: {error}")
            }
        }
    }
}

impl std::error::Error for AeonLoadError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Read(error) => Some(error),
            Self::Deserialize(error) => Some(error),
            Self::Compile(_) | Self::SchemaLoad(_) | Self::Schema(_) | Self::Finalize(_) => None,
        }
    }
}

pub fn load_str<T: DeserializeOwned>(
    source: &str,
    options: LoadOptions,
) -> Result<LoadedDocument<T>, AeonLoadError> {
    let compiled = compile(source, options.compile);
    if !compiled.errors.is_empty() {
        return Err(AeonLoadError::Compile(compiled.errors));
    }

    let schema = if let Some(schema) = options.schema {
        Some(schema)
    } else if let Some(schema_file) = options.schema_file.as_ref() {
        Some(load_schema_file(schema_file)?)
    } else {
        None
    };

    let validation = if let Some(schema) = schema {
        let result = validate(&ValidationEnvelope {
            aes: core_events_to_aeos(&compiled.events),
            schema: Some(schema),
            options: options.validation,
        });
        if !result.errors.is_empty() {
            return Err(AeonLoadError::Schema(result));
        }
        Some(result)
    } else {
        None
    };

    let document =
        finalize_into(&compiled.events, options.finalize).map_err(AeonLoadError::from)?;

    Ok(LoadedDocument {
        compiled,
        validation,
        document,
    })
}

pub fn load_file<T: DeserializeOwned, P: AsRef<Path>>(
    path: P,
    options: LoadOptions,
) -> Result<LoadedDocument<T>, AeonLoadError> {
    let source = fs::read_to_string(path).map_err(AeonLoadError::Read)?;
    load_str(&source, options)
}

pub fn load_schema_file<P: AsRef<Path>>(path: P) -> Result<Schema, AeonLoadError> {
    let path_ref = path.as_ref();
    let source = fs::read_to_string(path_ref).map_err(AeonLoadError::Read)?;
    if path_ref
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("json"))
    {
        return load_schema_str_with_label(&source, &path_ref.display().to_string(), true);
    }
    load_schema_str_with_label(&source, &path_ref.display().to_string(), false)
}

pub fn load_schema_str(source: &str) -> Result<Schema, AeonLoadError> {
    load_schema_str_with_label(source, "<memory>", false)
}

impl From<MaterializeError> for AeonLoadError {
    fn from(value: MaterializeError) -> Self {
        match value {
            MaterializeError::Compile(errors) => Self::Compile(errors),
            MaterializeError::Finalize(meta) => Self::Finalize(meta),
            MaterializeError::Deserialize(error) => Self::Deserialize(error),
        }
    }
}

fn load_schema_str_with_label(
    source: &str,
    label: &str,
    force_json: bool,
) -> Result<Schema, AeonLoadError> {
    if force_json || source.trim_start().starts_with('{') {
        let parsed: JsonValue = serde_json::from_str(source).map_err(|error| {
            AeonLoadError::SchemaLoad(format!("failed to parse schema {label}: {error}"))
        })?;
        return normalize_legacy_schema_contract_value(parsed, label)
            .map_err(AeonLoadError::SchemaLoad);
    }

    let compiled = compile(
        source,
        CompileOptions {
            datatype_policy: Some(DatatypePolicy::AllowCustom),
            ..CompileOptions::default()
        },
    );
    if !compiled.errors.is_empty() {
        return Err(AeonLoadError::SchemaLoad(format!(
            "Schema contract AEON file failed to parse: {label}"
        )));
    }
    let document: JsonValue =
        finalize_into(&compiled.events, FinalizeOptions::default()).map_err(AeonLoadError::from)?;
    if !has_aeos_schema_root(&compiled.events) {
        return normalize_legacy_schema_contract_value(document, label)
            .map_err(AeonLoadError::SchemaLoad);
    }
    let aeos_root = document
        .as_object()
        .and_then(|object| object.get("aeos"))
        .and_then(JsonValue::as_object)
        .cloned()
        .ok_or_else(|| {
            AeonLoadError::SchemaLoad(format!(
                "Schema document missing required '$.aeos' object: {label}"
            ))
        })?;
    normalize_aeos_schema_value(JsonValue::Object(aeos_root), label)
        .map_err(AeonLoadError::SchemaLoad)
}

fn has_aeos_schema_root(events: &[AssignmentEvent]) -> bool {
    events.iter().any(|event| {
        event.key == "aeos"
            && event.datatype.as_deref() == Some("schema")
            && matches!(event.path.segments.as_slice(), [PathSegment::Root, PathSegment::Member(key)] if key == "aeos")
    })
}

fn normalize_legacy_schema_contract_value(parsed: JsonValue, file: &str) -> Result<Schema, String> {
    let object = parsed
        .as_object()
        .ok_or_else(|| format!("Schema file must be a JSON object: {file}"))?;
    let allowed_top_level = [
        "schema_id",
        "schema_version",
        "rules",
        "world",
        "reference_policy",
        "datatype_rules",
        "datatype_allowlist",
    ];
    for key in object.keys() {
        if !allowed_top_level.contains(&key.as_str()) {
            return Err(format!("Unknown schema contract key '{key}' in {file}"));
        }
    }
    match object.get("schema_id") {
        Some(JsonValue::String(value)) if !value.is_empty() => {}
        _ => {
            return Err(format!(
                "Schema contract missing required string field 'schema_id': {file}"
            ));
        }
    }
    match object.get("schema_version") {
        Some(JsonValue::String(value)) if !value.is_empty() => {}
        _ => {
            return Err(format!(
                "Schema contract missing required string field 'schema_version': {file}"
            ));
        }
    }
    materialize_schema(
        object.get("rules").ok_or_else(|| {
            format!("Schema contract missing required array field 'rules': {file}")
        })?,
        object.get("world"),
        object.get("reference_policy"),
        object.get("datatype_allowlist"),
        object.get("datatype_rules"),
        file,
        false,
    )
}

fn normalize_aeos_schema_value(parsed: JsonValue, file: &str) -> Result<Schema, String> {
    let object = parsed
        .as_object()
        .ok_or_else(|| format!("Schema document root must be an object: {file}"))?;
    let allowed_top_level = [
        "id",
        "version",
        "rules",
        "patterns",
        "charsets",
        "world",
        "reference_policy",
        "datatype_rules",
        "datatype_allowlist",
    ];
    for key in object.keys() {
        if !allowed_top_level.contains(&key.as_str()) {
            return Err(format!("Unknown schema document key '{key}' in {file}"));
        }
    }
    match object.get("id") {
        Some(JsonValue::String(value)) if !value.is_empty() => {}
        _ => {
            return Err(format!(
                "Schema document missing required string field 'id': {file}"
            ));
        }
    }
    match object.get("version") {
        Some(JsonValue::String(value)) if !value.is_empty() => {}
        _ => {
            return Err(format!(
                "Schema document missing required string field 'version': {file}"
            ));
        }
    }
    materialize_schema(
        object
            .get("rules")
            .ok_or_else(|| format!("Schema document missing required field 'rules': {file}"))?,
        object.get("world"),
        object.get("reference_policy"),
        object.get("datatype_allowlist"),
        object.get("datatype_rules"),
        file,
        true,
    )
}

fn materialize_schema(
    rules_raw: &JsonValue,
    world: Option<&JsonValue>,
    reference_policy: Option<&JsonValue>,
    datatype_allowlist: Option<&JsonValue>,
    datatype_rules: Option<&JsonValue>,
    file: &str,
    allow_object_rules: bool,
) -> Result<Schema, String> {
    let world_value = match world {
        Some(JsonValue::String(value)) if value == "open" || value == "closed" => value.clone(),
        Some(_) => {
            return Err(format!(
                "Schema contract field 'world' must be \"open\" or \"closed\": {file}"
            ));
        }
        None => String::from("open"),
    };
    let reference_policy_value = match reference_policy {
        Some(JsonValue::String(value)) if value == "allow" || value == "forbid" => {
            Some(value.clone())
        }
        Some(_) => {
            return Err(format!(
                "Schema contract field 'reference_policy' must be \"allow\" or \"forbid\": {file}"
            ));
        }
        None => None,
    };
    let datatype_allowlist_value = match datatype_allowlist {
        Some(JsonValue::Array(items)) => {
            let mut values = Vec::with_capacity(items.len());
            for item in items {
                let Some(value) = item.as_str() else {
                    return Err(format!(
                        "Schema contract field 'datatype_allowlist' must be array<string>: {file}"
                    ));
                };
                values.push(value.to_string());
            }
            values
        }
        Some(_) => {
            return Err(format!(
                "Schema contract field 'datatype_allowlist' must be array<string>: {file}"
            ));
        }
        None => Vec::new(),
    };
    let datatype_rules_value = match datatype_rules {
        Some(JsonValue::Object(map)) => {
            let mut projected = std::collections::BTreeMap::new();
            for (key, value) in map {
                let projected_value =
                    project_constraints(value, &format!("datatype_rules.{key}"), file)?;
                projected.insert(key.clone(), projected_value);
            }
            projected
        }
        Some(_) => {
            return Err(format!(
                "Schema contract field 'datatype_rules' must be object: {file}"
            ));
        }
        None => std::collections::BTreeMap::new(),
    };
    let rules = materialize_rules(rules_raw, file, allow_object_rules)?;

    Ok(Schema {
        rules,
        datatype_rules: datatype_rules_value,
        datatype_allowlist: datatype_allowlist_value,
        world: world_value,
        reference_policy: reference_policy_value,
        resource_policy: None,
    })
}

fn materialize_rules(
    rules_raw: &JsonValue,
    file: &str,
    allow_object_rules: bool,
) -> Result<Vec<aeon_aeos::SchemaRule>, String> {
    match rules_raw {
        JsonValue::Array(items) => items
            .iter()
            .enumerate()
            .map(|(index, rule)| {
                let object = rule.as_object().ok_or_else(|| {
                    format!("Schema contract rule at index {index} is not an object: {file}")
                })?;
                let path = object
                    .get("path")
                    .and_then(JsonValue::as_str)
                    .filter(|value| !value.is_empty());
                let selector = object
                    .get("selector")
                    .and_then(JsonValue::as_str)
                    .filter(|value| !value.is_empty());
                if path.is_none() && selector.is_none() {
                    return Err(format!(
                        "Schema contract rule at index {index} missing string 'path' or 'selector': {file}"
                    ));
                }
                if path.is_some() && selector.is_some() {
                    return Err(format!(
                        "Schema contract rule at index {index} must use either 'path' or 'selector': {file}"
                    ));
                }
                let constraints = object.get("constraints").ok_or_else(|| {
                    format!(
                        "Schema contract rule at index {index} missing object 'constraints': {file}"
                    )
                })?;
                let owner = path.or(selector).expect("target checked above");
                Ok(aeon_aeos::SchemaRule {
                    path: path.map(ToOwned::to_owned),
                    selector: selector.map(ToOwned::to_owned),
                    constraints: project_constraints(constraints, owner, file)?,
                })
            })
            .collect(),
        JsonValue::Object(map) if allow_object_rules => map
            .iter()
            .map(|(path, constraints)| {
                Ok(aeon_aeos::SchemaRule {
                    path: Some(path.clone()),
                    selector: None,
                    constraints: project_constraints(constraints, path, file)?,
                })
            })
            .collect(),
        _ if allow_object_rules => Err(format!(
            "Schema contract field 'rules' must be object or array: {file}"
        )),
        _ => Err(format!(
            "Schema contract missing required array field 'rules': {file}"
        )),
    }
}

fn project_constraints(
    constraints: &JsonValue,
    owner: &str,
    file: &str,
) -> Result<JsonValue, String> {
    let object = constraints.as_object().ok_or_else(|| {
        format!("Schema rule '{owner}' must define constraints as an object: {file}")
    })?;
    let mut projected: JsonMap<String, JsonValue> = object.clone();
    if let Some(path_selector) = projected.remove("reference_target_path") {
        if projected.contains_key("reference_target_pattern") {
            return Err(format!(
                "Schema rule '{owner}' cannot declare both 'reference_target_path' and 'reference_target_pattern': {file}"
            ));
        }
        let selector = path_selector.as_str().filter(|value| !value.is_empty()).ok_or_else(|| {
            format!(
                "Schema rule '{owner}' field 'reference_target_path' must be a non-empty string: {file}"
            )
        })?;
        projected.insert(
            String::from("reference_target_pattern"),
            JsonValue::String(reference_target_path_to_pattern(selector)?),
        );
    }
    Ok(JsonValue::Object(projected))
}

fn reference_target_path_to_pattern(selector: &str) -> Result<String, String> {
    if selector.contains('*') {
        return Err(format!(
            "Unsupported reference_target_path selector: {selector}"
        ));
    }
    Ok(format!("^{}$", escape_regex(selector)))
}

fn escape_regex(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for ch in value.chars() {
        match ch {
            '.' | '+' | '*' | '?' | '^' | '$' | '(' | ')' | '[' | ']' | '{' | '}' | '|' | '\\' => {
                escaped.push('\\');
                escaped.push(ch);
            }
            _ => escaped.push(ch),
        }
    }
    escaped
}

fn core_events_to_aeos(events: &[AssignmentEvent]) -> Vec<AesEvent> {
    events
        .iter()
        .map(|event| AesEvent {
            path: EventPath {
                segments: event
                    .path
                    .segments
                    .iter()
                    .filter_map(|segment| match segment {
                        PathSegment::Root => None,
                        PathSegment::Member(key) => Some(PathSegmentInput {
                            segment_type: String::from("member"),
                            key: Some(key.clone()),
                            index: None,
                        }),
                        PathSegment::Index(index) => Some(PathSegmentInput {
                            segment_type: String::from("index"),
                            key: None,
                            index: Some(json!(index)),
                        }),
                    })
                    .collect(),
            },
            key: event.key.clone(),
            datatype: event.datatype.clone(),
            value: core_value_to_aeos(&event.value),
            annotations: BTreeMap::new(),
            span: Some(SpanInput::Object {
                start: OffsetOnly {
                    offset: event.span.start.offset,
                },
                end: OffsetOnly {
                    offset: event.span.end.offset,
                },
            }),
        })
        .collect()
}

fn core_value_to_aeos(value: &Value) -> EventValue {
    match value {
        Value::TypedValue { value, .. } => core_value_to_aeos(value),
        Value::InfinityLiteral { raw, .. } => scalar_value(
            "InfinityLiteral",
            raw.clone(),
            JsonValue::String(raw.clone()),
        ),
        Value::NaNLiteral { raw, .. } => {
            scalar_value("NaNLiteral", raw.clone(), JsonValue::String(raw.clone()))
        }
        Value::NullLiteral { mode, value, raw } => scalar_value(
            "NullLiteral",
            raw.clone(),
            json!({
                "mode": match mode {
                    NullLiteralMode::Reserved => "reserved",
                    NullLiteralMode::Reason => "reason",
                },
                "value": value,
            }),
        ),
        Value::NumberLiteral { raw } => scalar_value(
            "NumberLiteral",
            raw.clone(),
            JsonValue::String(normalize_number_literal(raw)),
        ),
        Value::StringLiteral { value, .. } => scalar_value(
            "StringLiteral",
            value.clone(),
            JsonValue::String(value.clone()),
        ),
        Value::BooleanLiteral { raw } => scalar_value(
            "BooleanLiteral",
            raw.clone(),
            JsonValue::Bool(raw == "true"),
        ),
        Value::ToggleLiteral { raw } => {
            scalar_value("ToggleLiteral", raw.clone(), JsonValue::String(raw.clone()))
        }
        Value::HexLiteral { raw } => scalar_value(
            "HexLiteral",
            raw.clone(),
            JsonValue::String(raw.trim_start_matches('#').to_string()),
        ),
        Value::SeparatorLiteral { raw } => scalar_value(
            "SeparatorLiteral",
            raw.clone(),
            JsonValue::String(raw.trim_start_matches('^').to_string()),
        ),
        Value::EncodingLiteral { raw } => scalar_value(
            "EncodingLiteral",
            raw.clone(),
            JsonValue::String(raw.trim_start_matches('&').to_string()),
        ),
        Value::RadixLiteral { raw } => scalar_value(
            "RadixLiteral",
            raw.clone(),
            JsonValue::String(raw.trim_start_matches('%').to_string()),
        ),
        Value::DateLiteral { raw } => {
            scalar_value("DateLiteral", raw.clone(), JsonValue::String(raw.clone()))
        }
        Value::DateTimeLiteral { raw } => scalar_value(
            "DateTimeLiteral",
            raw.clone(),
            JsonValue::String(raw.clone()),
        ),
        Value::TimeLiteral { raw } => {
            scalar_value("TimeLiteral", raw.clone(), JsonValue::String(raw.clone()))
        }
        Value::SansaAddressLiteral { raw, canonical, .. } => scalar_value(
            "SansaAddressLiteral",
            raw.clone(),
            JsonValue::String(canonical.clone()),
        ),
        Value::NodeLiteral { raw, .. } => {
            scalar_value("NodeLiteral", raw.clone(), JsonValue::String(raw.clone()))
        }
        Value::ListNode { items } => EventValue {
            value_type: String::from("ListNode"),
            raw: None,
            value: None,
            path: None,
            elements: items.iter().map(core_value_to_aeos).collect(),
            bindings: Vec::new(),
        },
        Value::TupleLiteral { items } => EventValue {
            value_type: String::from("TupleLiteral"),
            raw: None,
            value: None,
            path: None,
            elements: items.iter().map(core_value_to_aeos).collect(),
            bindings: Vec::new(),
        },
        Value::ObjectNode { .. } => EventValue {
            value_type: String::from("ObjectNode"),
            raw: None,
            value: None,
            path: None,
            elements: Vec::new(),
            bindings: Vec::new(),
        },
        Value::CloneReference { segments, .. } => reference_value("CloneReference", segments),
        Value::PointerReference { segments, .. } => reference_value("PointerReference", segments),
    }
}

fn scalar_value(value_type: &str, raw: String, value: JsonValue) -> EventValue {
    EventValue {
        value_type: String::from(value_type),
        raw: Some(raw),
        value: Some(value),
        path: None,
        elements: Vec::new(),
        bindings: Vec::new(),
    }
}

fn reference_value(value_type: &str, segments: &[ReferenceSegment]) -> EventValue {
    EventValue {
        value_type: String::from(value_type),
        raw: None,
        value: Some(JsonValue::Array(
            segments.iter().map(reference_segment_to_json).collect(),
        )),
        path: Some(segments.iter().map(reference_segment_to_aeos).collect()),
        elements: Vec::new(),
        bindings: Vec::new(),
    }
}

fn reference_segment_to_aeos(segment: &ReferenceSegment) -> ReferencePathSegment {
    match segment {
        ReferenceSegment::Key(key) => ReferencePathSegment::Member(key.clone()),
        ReferenceSegment::Index(index) => ReferencePathSegment::Index(*index as i64),
        ReferenceSegment::Attr(key) => ReferencePathSegment::Attribute {
            segment_type: String::from("attr"),
            key: key.clone(),
        },
    }
}

fn reference_segment_to_json(segment: &ReferenceSegment) -> JsonValue {
    match segment {
        ReferenceSegment::Key(key) => JsonValue::String(key.clone()),
        ReferenceSegment::Index(index) => json!(index),
        ReferenceSegment::Attr(key) => json!({ "type": "attr", "key": key }),
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::fs;

    use super::*;
    use aeon_aeos::{Schema, SchemaRule};
    use aeon_core::DatatypePolicy;
    use serde::Deserialize;

    #[derive(Debug, Deserialize, PartialEq, Eq)]
    struct GreetingDoc {
        greeting: String,
    }

    #[derive(Debug, Deserialize, PartialEq, Eq)]
    struct FarewellDoc {
        sun: Farewell,
    }

    #[derive(Debug, Deserialize, PartialEq, Eq)]
    #[serde(rename_all = "camelCase")]
    struct Farewell {
        version: String,
        daytime: String,
        farewell: String,
        sunset_hour: i64,
        cooldown_hours: i64,
    }

    #[test]
    fn loads_typed_document_from_string() {
        let loaded = load_str::<GreetingDoc>("greeting = \"Hello\"\n", LoadOptions::default())
            .expect("load success");
        assert_eq!(
            loaded.document,
            GreetingDoc {
                greeting: String::from("Hello"),
            }
        );
        assert!(loaded.validation.is_none());
    }

    #[test]
    fn returns_compile_errors_for_invalid_source() {
        let error = load_str::<GreetingDoc>("greeting = {\n", LoadOptions::default())
            .expect_err("compile failure");
        assert!(matches!(error, AeonLoadError::Compile(_)));
    }

    #[test]
    fn surfaced_literal_values_drop_encoding_and_radix_sigils() {
        let loaded = load_str::<BTreeMap<String, JsonValue>>(
            "encoding = &QmFzZTY0IQ==\nradix = %+A_!_&z\n",
            LoadOptions::default(),
        )
        .expect("load success");

        let events = core_events_to_aeos(&loaded.compiled.events);
        let by_key = events
            .iter()
            .map(|event| (event.key.as_str(), &event.value))
            .collect::<BTreeMap<_, _>>();

        assert_eq!(by_key["encoding"].raw, Some(String::from("&QmFzZTY0IQ==")));
        assert_eq!(
            by_key["encoding"].value,
            Some(JsonValue::String(String::from("QmFzZTY0IQ==")))
        );
        assert_eq!(by_key["radix"].raw, Some(String::from("%+A_!_&z")));
        assert_eq!(
            by_key["radix"].value,
            Some(JsonValue::String(String::from("+A_!_&z")))
        );
    }

    #[test]
    fn surfaced_hex_values_keep_raw_and_drop_sigil_from_value() {
        let loaded =
            load_str::<BTreeMap<String, JsonValue>>("color = #Ff_00_Aa\n", LoadOptions::default())
                .expect("load success");

        let events = core_events_to_aeos(&loaded.compiled.events);
        let by_key = events
            .iter()
            .map(|event| (event.key.as_str(), &event.value))
            .collect::<BTreeMap<_, _>>();

        assert_eq!(by_key["color"].raw, Some(String::from("#Ff_00_Aa")));
        assert_eq!(
            by_key["color"].value,
            Some(JsonValue::String(String::from("Ff_00_Aa")))
        );
    }

    #[test]
    fn surfaced_number_values_preserve_raw_and_normalize_value() {
        let loaded = load_str::<BTreeMap<String, JsonValue>>(
            "a = 1_000_000\nb = 1_2.3_4\n",
            LoadOptions::default(),
        )
        .expect("load success");

        let events = core_events_to_aeos(&loaded.compiled.events);
        let by_key = events
            .iter()
            .map(|event| (event.key.as_str(), &event.value))
            .collect::<BTreeMap<_, _>>();

        assert_eq!(by_key["a"].raw, Some(String::from("1_000_000")));
        assert_eq!(
            by_key["a"].value,
            Some(JsonValue::String(String::from("1000000")))
        );
        assert_eq!(by_key["b"].raw, Some(String::from("1_2.3_4")));
        assert_eq!(
            by_key["b"].value,
            Some(JsonValue::String(String::from("12.34")))
        );
    }

    #[test]
    fn validates_schema_when_provided() {
        let source = "aeon:header = {\n  mode:string = \"strict\"\n}\n\nsun:farewell = {\n  version:ver[.] = ^1.1.0\n  daytime:string = \"Hello, Sun\"\n  farewell:string = \"Sayonara, Sun\"\n  sunsetHour:number = 18\n  cooldownHours:number = 3\n}\n";
        let loaded = load_str::<FarewellDoc>(
            source,
            LoadOptions {
                compile: CompileOptions {
                    datatype_policy: Some(DatatypePolicy::AllowCustom),
                    ..CompileOptions::default()
                },
                schema: Some(build_schema()),
                ..LoadOptions::default()
            },
        )
        .expect("schema-valid load");
        assert!(loaded.validation.as_ref().is_some_and(|result| result.ok));
        assert_eq!(loaded.document.sun.farewell, "Sayonara, Sun");
    }

    #[test]
    fn returns_schema_errors_when_schema_fails() {
        let source = "aeon:header = {\n  mode:string = \"strict\"\n}\n\nsun:farewell = {\n  version:ver[.] = ^1.1.0\n}\n";
        let error = load_str::<FarewellDoc>(
            source,
            LoadOptions {
                compile: CompileOptions {
                    datatype_policy: Some(DatatypePolicy::AllowCustom),
                    ..CompileOptions::default()
                },
                schema: Some(build_schema()),
                ..LoadOptions::default()
            },
        )
        .expect_err("schema failure");
        assert!(matches!(error, AeonLoadError::Schema(_)));
    }

    #[test]
    fn loads_schema_from_aeos_document() {
        let schema = load_schema_str(
            "aeos:schema = {\n  id = \"com.example.person\"\n  version = \"1\"\n  world = \"closed\"\n  rules:list<object> = [\n    {\n      selector:sansa = $.ages.*\n      constraints:object = {\n        type:string = \"IntegerLiteral\"\n        reference_target_pattern:string = \"^\\\\$\\\\.people\\\\[\\\\d+\\\\]\\\\.age$\"\n      }\n    }\n  ]\n}\n",
        )
        .expect("schema load success");
        assert_eq!(schema.world, "closed");
        assert_eq!(schema.rules[0].selector.as_deref(), Some("$.ages.*"));
        assert_eq!(
            schema.rules[0]
                .constraints
                .get("reference_target_pattern")
                .and_then(JsonValue::as_str),
            Some(r"^\$\.people\[\d+\]\.age$")
        );
    }

    #[test]
    fn loads_document_with_schema_file_option() {
        let schema_path = std::env::temp_dir().join(format!(
            "aeon-schema-{}.aeos",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("duration")
                .as_nanos()
        ));
        fs::write(
            &schema_path,
            "aeos:schema = {\n  id = \"com.example.port\"\n  version = \"1\"\n  rules = {\n    \"$.port\" = { required = true, type = \"IntegerLiteral\" }\n  }\n}\n",
        )
        .expect("write schema");

        let loaded = load_str::<BTreeMap<String, JsonValue>>(
            "port = 8080\n",
            LoadOptions {
                schema_file: Some(schema_path.clone()),
                ..LoadOptions::default()
            },
        )
        .expect("load success");
        assert!(loaded.validation.as_ref().is_some_and(|result| result.ok));

        let _ = fs::remove_file(schema_path);
    }

    fn build_schema() -> Schema {
        Schema {
            rules: vec![
                rule("$.sun", json!({"required": true, "type": "ObjectNode"})),
                rule(
                    "$.sun.version",
                    json!({"required": true, "type": "SeparatorLiteral"}),
                ),
                rule(
                    "$.sun.daytime",
                    json!({"required": true, "type": "StringLiteral"}),
                ),
                rule(
                    "$.sun.farewell",
                    json!({"required": true, "type": "StringLiteral"}),
                ),
                rule(
                    "$.sun.sunsetHour",
                    json!({"required": true, "type": "NumberLiteral", "sign": "unsigned", "min_digits": 1, "max_digits": 2}),
                ),
                rule(
                    "$.sun.cooldownHours",
                    json!({"required": true, "type": "NumberLiteral", "sign": "unsigned", "min_digits": 1, "max_digits": 1}),
                ),
            ],
            datatype_rules: BTreeMap::new(),
            datatype_allowlist: vec![String::from("farewell")],
            world: String::from("open"),
            reference_policy: None,
            resource_policy: None,
        }
    }

    fn rule(path: &str, constraints: JsonValue) -> SchemaRule {
        SchemaRule {
            path: Some(String::from(path)),
            selector: None,
            constraints,
        }
    }
}
