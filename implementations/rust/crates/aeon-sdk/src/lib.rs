use std::fmt;
use std::fs;
use std::path::Path;

use aeon_aeos::{
    AesEvent, EventPath, EventValue, OffsetOnly, PathSegmentInput, ResultEnvelope, Schema,
    SpanInput, ValidationEnvelope, ValidationOptions, validate,
};
use aeon_core::{
    AssignmentEvent, CompileOptions, Diagnostic, PathSegment, ReferenceSegment, Value, compile,
    normalize_number_literal,
};
use aeon_finalize::{FinalizeOptions, MaterializeError, finalize_into};
use serde::de::DeserializeOwned;
use serde_json::{Value as JsonValue, json};

#[derive(Debug, Clone)]
pub struct LoadOptions {
    pub compile: CompileOptions,
    pub finalize: FinalizeOptions,
    pub schema: Option<Schema>,
    pub validation: ValidationOptions,
}

impl Default for LoadOptions {
    fn default() -> Self {
        Self {
            compile: CompileOptions::default(),
            finalize: FinalizeOptions::default(),
            schema: None,
            validation: ValidationOptions::default(),
        }
    }
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
            Self::Compile(_) | Self::Schema(_) | Self::Finalize(_) => None,
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

    let validation = if let Some(schema) = options.schema {
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

impl From<MaterializeError> for AeonLoadError {
    fn from(value: MaterializeError) -> Self {
        match value {
            MaterializeError::Compile(errors) => Self::Compile(errors),
            MaterializeError::Finalize(meta) => Self::Finalize(meta),
            MaterializeError::Deserialize(error) => Self::Deserialize(error),
        }
    }
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
        Value::InfinityLiteral { raw } => scalar_value(
            "InfinityLiteral",
            raw.clone(),
            JsonValue::String(raw.clone()),
        ),
        Value::NumberLiteral { raw } => {
            scalar_value(
                "NumberLiteral",
                raw.clone(),
                JsonValue::String(normalize_number_literal(raw)),
            )
        }
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
        Value::SwitchLiteral { raw } => {
            scalar_value("SwitchLiteral", raw.clone(), JsonValue::String(raw.clone()))
        }
        Value::HexLiteral { raw } => {
            scalar_value("HexLiteral", raw.clone(), JsonValue::String(raw.clone()))
        }
        Value::SeparatorLiteral { raw } => scalar_value(
            "SeparatorLiteral",
            raw.clone(),
            JsonValue::String(raw.trim_start_matches('^').to_string()),
        ),
        Value::EncodingLiteral { raw } => scalar_value(
            "EncodingLiteral",
            raw.clone(),
            JsonValue::String(raw.trim_start_matches('$').to_string()),
        ),
        Value::RadixLiteral { raw } => {
            scalar_value(
                "RadixLiteral",
                raw.clone(),
                JsonValue::String(raw.trim_start_matches('%').to_string()),
            )
        }
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
        Value::NodeLiteral { raw, .. } => {
            scalar_value("NodeLiteral", raw.clone(), JsonValue::String(raw.clone()))
        }
        Value::ListNode { items } => EventValue {
            value_type: String::from("ListNode"),
            raw: None,
            value: None,
            elements: items.iter().map(core_value_to_aeos).collect(),
        },
        Value::TupleLiteral { items } => EventValue {
            value_type: String::from("TupleLiteral"),
            raw: None,
            value: None,
            elements: items.iter().map(core_value_to_aeos).collect(),
        },
        Value::ObjectNode { .. } => EventValue {
            value_type: String::from("ObjectNode"),
            raw: None,
            value: None,
            elements: Vec::new(),
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
        elements: Vec::new(),
    }
}

fn reference_value(value_type: &str, segments: &[ReferenceSegment]) -> EventValue {
    EventValue {
        value_type: String::from(value_type),
        raw: None,
        value: Some(JsonValue::Array(
            segments.iter().map(reference_segment_to_json).collect(),
        )),
        elements: Vec::new(),
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
            "encoding = $QmFzZTY0IQ==\nradix = %+A_!_&z\n",
            LoadOptions::default(),
        )
        .expect("load success");

        let events = core_events_to_aeos(&loaded.compiled.events);
        let by_key = events
            .iter()
            .map(|event| (event.key.as_str(), &event.value))
            .collect::<BTreeMap<_, _>>();

        assert_eq!(by_key["encoding"].raw, Some(String::from("$QmFzZTY0IQ==")));
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
        }
    }

    fn rule(path: &str, constraints: JsonValue) -> SchemaRule {
        SchemaRule {
            path: Some(String::from(path)),
            constraints,
        }
    }
}
