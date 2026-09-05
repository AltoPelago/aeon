use std::collections::BTreeMap;

use crate::token_parser::parse_document_from_tokens;
use crate::{Binding, CompileOptions, NullLiteralMode, Value, compile};

pub const AEONIC_LIMITS_ID: &str = "altopelago.aeonic-limits.v1";
pub const AEONIC_LIMITS_VERSION: &str = "1.0.0";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LimitsBootstrap {
    pub max_input_bytes: usize,
    pub max_events: usize,
    pub max_path_depth: usize,
    pub max_value_nesting_depth: usize,
    pub max_attribute_depth: usize,
    pub max_generic_depth: usize,
    pub max_generic_arguments: usize,
    pub max_clarifier_values: usize,
    pub max_datatype_components: usize,
}

pub const LIMITS_BOOTSTRAP: LimitsBootstrap = LimitsBootstrap {
    max_input_bytes: 65_536,
    max_events: 256,
    max_path_depth: 8,
    max_value_nesting_depth: 8,
    max_attribute_depth: 0,
    max_generic_depth: 0,
    max_generic_arguments: 0,
    max_clarifier_values: 0,
    max_datatype_components: 1,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LimitSetting {
    Value(usize),
    UnBound,
    UseImplementation,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StructureLimits {
    pub max_attribute_depth: LimitSetting,
    pub max_generic_depth: LimitSetting,
    pub max_generic_arguments: LimitSetting,
    pub max_clarifier_values: LimitSetting,
    pub max_datatype_components: LimitSetting,
    pub max_value_nesting_depth: LimitSetting,
    pub max_path_depth: LimitSetting,
    pub max_string_codepoints: LimitSetting,
    pub max_key_segment_codepoints: LimitSetting,
    pub max_list_items: LimitSetting,
    pub max_tuple_items: LimitSetting,
    pub max_path_characters: LimitSetting,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcessingLimits {
    pub max_events: LimitSetting,
    pub max_reference_depth: LimitSetting,
    pub max_materialized_weight: LimitSetting,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AeonFormatLimits {
    pub max_input_bytes: LimitSetting,
    pub max_numeric_literal_characters: LimitSetting,
    pub max_structured_comment_characters: LimitSetting,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TelexFormatLimits {
    pub max_input_bytes: LimitSetting,
    pub max_line_bytes: LimitSetting,
    pub max_fields_per_event: LimitSetting,
    pub max_decoded_payload_bytes: LimitSetting,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TransportLimits {
    pub max_frame_bytes: LimitSetting,
    pub max_buffer_bytes: LimitSetting,
    pub max_header_bytes: LimitSetting,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AeonicLimitsV1 {
    pub limits_id: String,
    pub limits_version: String,
    pub profile_claims: Vec<String>,
    pub structure: StructureLimits,
    pub processing: ProcessingLimits,
    pub aeon: AeonFormatLimits,
    pub telex: TelexFormatLimits,
    pub transport: TransportLimits,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LimitsDiagnostic {
    pub code: String,
    pub path: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AeonCompileLimits {
    pub max_attribute_depth: usize,
    pub max_clarifier_values: usize,
    pub max_generic_depth: usize,
    pub max_generic_arguments: usize,
    pub max_datatype_components: usize,
    pub max_value_nesting_depth: usize,
    pub max_path_depth: usize,
    pub max_string_codepoints: usize,
    pub max_key_segment_codepoints: usize,
    pub max_list_items: usize,
    pub max_tuple_items: usize,
    pub max_path_characters: usize,
    pub max_numeric_literal_characters: usize,
    pub max_structured_comment_characters: usize,
    pub max_input_bytes: Option<usize>,
    pub max_events: Option<usize>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FinalizationLimits {
    pub max_reference_depth: Option<usize>,
    pub max_materialized_weight: Option<usize>,
}

pub fn load_aeonic_limits(source: &str) -> Result<AeonicLimitsV1, Vec<LimitsDiagnostic>> {
    let result = compile(
        source,
        CompileOptions {
            max_input_bytes: Some(LIMITS_BOOTSTRAP.max_input_bytes),
            max_events: Some(LIMITS_BOOTSTRAP.max_events),
            max_attribute_depth: LIMITS_BOOTSTRAP.max_attribute_depth,
            max_clarifier_values: Some(LIMITS_BOOTSTRAP.max_clarifier_values),
            max_generic_depth: LIMITS_BOOTSTRAP.max_generic_depth,
            max_generic_arguments: LIMITS_BOOTSTRAP.max_generic_arguments,
            max_datatype_components: LIMITS_BOOTSTRAP.max_datatype_components,
            max_value_nesting_depth: Some(LIMITS_BOOTSTRAP.max_value_nesting_depth),
            include_header: true,
            ..CompileOptions::default()
        },
    );
    if !result.errors.is_empty() {
        return Err(result
            .errors
            .into_iter()
            .map(|error| LimitsDiagnostic {
                code: error.code,
                path: error.path.unwrap_or_else(|| String::from("$")),
                message: error.message,
            })
            .collect());
    }
    if result
        .header
        .as_ref()
        .is_some_and(|header| !header.fields.is_empty())
    {
        return Err(vec![diagnostic(
            "LIMITS_HEADER_NOT_ALLOWED",
            "$",
            "Limits files must not contain an AEON header",
        )]);
    }
    let bindings = parse_document_from_tokens(
        source,
        LIMITS_BOOTSTRAP.max_value_nesting_depth,
        LIMITS_BOOTSTRAP.max_attribute_depth,
        LIMITS_BOOTSTRAP.max_clarifier_values,
        LIMITS_BOOTSTRAP.max_generic_depth,
        LIMITS_BOOTSTRAP.max_generic_arguments,
        LIMITS_BOOTSTRAP.max_datatype_components,
    )
    .map_err(|error| {
        vec![LimitsDiagnostic {
            code: error.code,
            path: error.path.unwrap_or_else(|| String::from("$")),
            message: error.message,
        }]
    })?;
    validate_bindings(&bindings).map_err(|error| vec![error])
}

pub fn aeon_compile_limits(limits: &AeonicLimitsV1) -> Result<AeonCompileLimits, LimitsDiagnostic> {
    Ok(AeonCompileLimits {
        max_attribute_depth: bounded(
            limits.structure.max_attribute_depth,
            1,
            64,
            "max_attribute_depth",
        )?,
        max_clarifier_values: bounded(
            limits.structure.max_clarifier_values,
            1,
            4_096,
            "max_clarifier_values",
        )?,
        max_generic_depth: bounded(
            limits.structure.max_generic_depth,
            1,
            64,
            "max_generic_depth",
        )?,
        max_generic_arguments: bounded(
            limits.structure.max_generic_arguments,
            32,
            4_096,
            "max_generic_arguments",
        )?,
        max_datatype_components: bounded(
            limits.structure.max_datatype_components,
            64,
            4_096,
            "max_datatype_components",
        )?,
        max_value_nesting_depth: bounded(
            limits.structure.max_value_nesting_depth,
            256,
            512,
            "max_value_nesting_depth",
        )?,
        max_path_depth: bounded(
            limits.structure.max_path_depth,
            1024,
            4096,
            "max_path_depth",
        )?,
        max_string_codepoints: bounded(
            limits.structure.max_string_codepoints,
            1_048_576,
            16_777_216,
            "max_string_codepoints",
        )?,
        max_key_segment_codepoints: bounded(
            limits.structure.max_key_segment_codepoints,
            1024,
            65_536,
            "max_key_segment_codepoints",
        )?,
        max_list_items: bounded(
            limits.structure.max_list_items,
            65_536,
            1_000_000,
            "max_list_items",
        )?,
        max_tuple_items: bounded(
            limits.structure.max_tuple_items,
            65_536,
            1_000_000,
            "max_tuple_items",
        )?,
        max_path_characters: bounded(
            limits.structure.max_path_characters,
            8192,
            65_536,
            "max_path_characters",
        )?,
        max_numeric_literal_characters: bounded(
            limits.aeon.max_numeric_literal_characters,
            1024,
            65_536,
            "max_numeric_literal_characters",
        )?,
        max_structured_comment_characters: bounded(
            limits.aeon.max_structured_comment_characters,
            1_048_576,
            16_777_216,
            "max_structured_comment_characters",
        )?,
        max_input_bytes: optional(limits.aeon.max_input_bytes, 16_777_216),
        max_events: optional(limits.processing.max_events, 100_000),
    })
}

#[must_use]
pub const fn finalization_limits(limits: &AeonicLimitsV1) -> FinalizationLimits {
    FinalizationLimits {
        max_reference_depth: optional_processing(limits.processing.max_reference_depth),
        max_materialized_weight: optional_processing(limits.processing.max_materialized_weight),
    }
}

fn validate_bindings(bindings: &[Binding]) -> Result<AeonicLimitsV1, LimitsDiagnostic> {
    let root = binding_map(
        bindings,
        "$",
        &[
            "limits_id",
            "limits_version",
            "profile_claims",
            "structure",
            "processing",
            "formats",
            "transport",
        ],
    )?;
    let limits_id = string_value(required(&root, "limits_id", "$"), "$.limits_id")?;
    let limits_version = string_value(required(&root, "limits_version", "$"), "$.limits_version")?;
    if limits_id != AEONIC_LIMITS_ID {
        return Err(diagnostic(
            "INVALID_LIMITS_FILE",
            "$.limits_id",
            format!("Unsupported limits_id {limits_id:?}"),
        ));
    }
    if limits_version != AEONIC_LIMITS_VERSION {
        return Err(diagnostic(
            "INVALID_LIMITS_FILE",
            "$.limits_version",
            format!("Unsupported limits_version {limits_version:?}"),
        ));
    }
    let profile_claims = string_list(required(&root, "profile_claims", "$"), "$.profile_claims")?;
    let structure = object_value(required(&root, "structure", "$"), "$.structure")?;
    let processing = object_value(required(&root, "processing", "$"), "$.processing")?;
    let formats = object_value(required(&root, "formats", "$"), "$.formats")?;
    let formats = binding_map(formats, "$.formats", &["aeon", "telex"])?;
    let aeon = object_value(required(&formats, "aeon", "$.formats"), "$.formats.aeon")?;
    let telex = object_value(required(&formats, "telex", "$.formats"), "$.formats.telex")?;
    let transport = object_value(required(&root, "transport", "$"), "$.transport")?;

    let structure = setting_map(
        structure,
        "$.structure",
        &[
            "max_attribute_depth",
            "max_generic_depth",
            "max_generic_arguments",
            "max_clarifier_values",
            "max_datatype_components",
            "max_value_nesting_depth",
            "max_path_depth",
            "max_string_codepoints",
            "max_key_segment_codepoints",
            "max_list_items",
            "max_tuple_items",
            "max_path_characters",
        ],
    )?;
    let processing = setting_map(
        processing,
        "$.processing",
        &[
            "max_events",
            "max_reference_depth",
            "max_materialized_weight",
        ],
    )?;
    let aeon = setting_map(
        aeon,
        "$.formats.aeon",
        &[
            "max_input_bytes",
            "max_numeric_literal_characters",
            "max_structured_comment_characters",
        ],
    )?;
    let telex = setting_map(
        telex,
        "$.formats.telex",
        &[
            "max_input_bytes",
            "max_line_bytes",
            "max_fields_per_event",
            "max_decoded_payload_bytes",
        ],
    )?;
    let transport = setting_map(
        transport,
        "$.transport",
        &["max_frame_bytes", "max_buffer_bytes", "max_header_bytes"],
    )?;

    Ok(AeonicLimitsV1 {
        limits_id,
        limits_version,
        profile_claims,
        structure: StructureLimits {
            max_attribute_depth: structure["max_attribute_depth"],
            max_generic_depth: structure["max_generic_depth"],
            max_generic_arguments: structure["max_generic_arguments"],
            max_clarifier_values: structure["max_clarifier_values"],
            max_datatype_components: structure["max_datatype_components"],
            max_value_nesting_depth: structure["max_value_nesting_depth"],
            max_path_depth: structure["max_path_depth"],
            max_string_codepoints: structure["max_string_codepoints"],
            max_key_segment_codepoints: structure["max_key_segment_codepoints"],
            max_list_items: structure["max_list_items"],
            max_tuple_items: structure["max_tuple_items"],
            max_path_characters: structure["max_path_characters"],
        },
        processing: ProcessingLimits {
            max_events: processing["max_events"],
            max_reference_depth: processing["max_reference_depth"],
            max_materialized_weight: processing["max_materialized_weight"],
        },
        aeon: AeonFormatLimits {
            max_input_bytes: aeon["max_input_bytes"],
            max_numeric_literal_characters: aeon["max_numeric_literal_characters"],
            max_structured_comment_characters: aeon["max_structured_comment_characters"],
        },
        telex: TelexFormatLimits {
            max_input_bytes: telex["max_input_bytes"],
            max_line_bytes: telex["max_line_bytes"],
            max_fields_per_event: telex["max_fields_per_event"],
            max_decoded_payload_bytes: telex["max_decoded_payload_bytes"],
        },
        transport: TransportLimits {
            max_frame_bytes: transport["max_frame_bytes"],
            max_buffer_bytes: transport["max_buffer_bytes"],
            max_header_bytes: transport["max_header_bytes"],
        },
    })
}

fn binding_map<'a>(
    bindings: &'a [Binding],
    path: &str,
    expected: &[&str],
) -> Result<BTreeMap<&'a str, &'a Value>, LimitsDiagnostic> {
    let mut result = BTreeMap::new();
    for binding in bindings {
        let child_path = format!("{path}.{}", binding.key);
        if binding.structural_id.is_some()
            || binding.datatype.is_some()
            || !binding.attributes.is_empty()
        {
            return Err(diagnostic(
                "LIMITS_DECORATION_NOT_ALLOWED",
                child_path,
                "Limits bindings may not use datatypes, attributes, or structural identities",
            ));
        }
        if !expected.contains(&binding.key.as_str()) {
            return Err(diagnostic(
                "INVALID_LIMITS_FILE",
                child_path,
                "Unknown limits field",
            ));
        }
        result.insert(binding.key.as_str(), &binding.value);
    }
    for key in expected {
        if !result.contains_key(key) {
            return Err(diagnostic(
                "INVALID_LIMITS_FILE",
                path,
                format!("Missing field {path}.{key}"),
            ));
        }
    }
    Ok(result)
}

fn setting_map(
    bindings: &[Binding],
    path: &str,
    expected: &[&str],
) -> Result<BTreeMap<String, LimitSetting>, LimitsDiagnostic> {
    let values = binding_map(bindings, path, expected)?;
    values
        .into_iter()
        .map(|(key, value)| {
            setting_value(value, &format!("{path}.{key}")).map(|setting| (key.to_owned(), setting))
        })
        .collect()
}

fn required<'a>(values: &'a BTreeMap<&str, &'a Value>, key: &str, path: &str) -> &'a Value {
    values
        .get(key)
        .copied()
        .unwrap_or_else(|| panic!("validated missing field {path}.{key}"))
}

fn string_value(value: &Value, path: &str) -> Result<String, LimitsDiagnostic> {
    match value {
        Value::StringLiteral { value, .. } => Ok(value.clone()),
        _ => Err(diagnostic("INVALID_LIMITS_FILE", path, "Expected string")),
    }
}

fn string_list(value: &Value, path: &str) -> Result<Vec<String>, LimitsDiagnostic> {
    let Value::ListNode { items } = value else {
        return Err(diagnostic(
            "INVALID_LIMITS_FILE",
            path,
            "Expected list of strings",
        ));
    };
    items
        .iter()
        .enumerate()
        .map(|(index, item)| string_value(item, &format!("{path}[{index}]")))
        .collect()
}

fn object_value<'a>(value: &'a Value, path: &str) -> Result<&'a [Binding], LimitsDiagnostic> {
    match value {
        Value::ObjectNode { bindings } => Ok(bindings),
        _ => Err(diagnostic("INVALID_LIMITS_FILE", path, "Expected object")),
    }
}

fn setting_value(value: &Value, path: &str) -> Result<LimitSetting, LimitsDiagnostic> {
    match value {
        Value::NumberLiteral { raw } => raw
            .replace('_', "")
            .parse::<usize>()
            .map(LimitSetting::Value)
            .map_err(|_| {
                diagnostic(
                    "INVALID_LIMIT_VALUE",
                    path,
                    "Limit values must be non-negative integers",
                )
            }),
        Value::NullLiteral {
            mode: NullLiteralMode::Reason,
            value,
            ..
        } if value == "unBound" => Ok(LimitSetting::UnBound),
        Value::NullLiteral {
            mode: NullLiteralMode::Reason,
            value,
            ..
        } if value == "useImplementation" => Ok(LimitSetting::UseImplementation),
        _ => Err(diagnostic(
            "INVALID_LIMIT_VALUE",
            path,
            "Expected a non-negative integer, !\"unBound\", or !\"useImplementation\"",
        )),
    }
}

fn bounded(
    setting: LimitSetting,
    implementation_default: usize,
    ceiling: usize,
    name: &str,
) -> Result<usize, LimitsDiagnostic> {
    match setting {
        LimitSetting::UseImplementation => Ok(implementation_default),
        LimitSetting::UnBound => Ok(ceiling),
        LimitSetting::Value(value) if value <= ceiling => Ok(value),
        LimitSetting::Value(value) => Err(diagnostic(
            "LIMIT_EXCEEDS_SAFETY_CEILING",
            "$",
            format!("{name} {value} exceeds implementation safety ceiling {ceiling}"),
        )),
    }
}

const fn optional(setting: LimitSetting, implementation_default: usize) -> Option<usize> {
    match setting {
        LimitSetting::UseImplementation => Some(implementation_default),
        LimitSetting::UnBound => None,
        LimitSetting::Value(value) => Some(value),
    }
}

const fn optional_processing(setting: LimitSetting) -> Option<usize> {
    match setting {
        LimitSetting::Value(value) => Some(value),
        LimitSetting::UnBound | LimitSetting::UseImplementation => None,
    }
}

fn diagnostic(
    code: impl Into<String>,
    path: impl Into<String>,
    message: impl Into<String>,
) -> LimitsDiagnostic {
    LimitsDiagnostic {
        code: code.into(),
        path: path.into(),
        message: message.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::{LimitSetting, aeon_compile_limits, finalization_limits, load_aeonic_limits};

    const SOURCE: &str = r#"limits_id = "altopelago.aeonic-limits.v1"
limits_version = "1.0.0"
profile_claims = ["aeon.gp.profile.v1"]
structure = {
  max_attribute_depth = 1
  max_generic_depth = 1
  max_generic_arguments = 32
  max_clarifier_values = 1
  max_datatype_components = 64
  max_value_nesting_depth = 256
  max_path_depth = 1024
  max_string_codepoints = 1048576
  max_key_segment_codepoints = 1024
  max_list_items = 65536
  max_tuple_items = 65536
  max_path_characters = 8192
}
processing = { max_events = 100000, max_reference_depth = 64, max_materialized_weight = 1000000 }
formats = {
  aeon = { max_input_bytes = 16777216, max_numeric_literal_characters = 1024, max_structured_comment_characters = 1048576 }
  telex = { max_input_bytes = 67108864, max_line_bytes = 1048576, max_fields_per_event = 64, max_decoded_payload_bytes = 33554432 }
}
transport = { max_frame_bytes = 16777216, max_buffer_bytes = 33554432, max_header_bytes = 65536 }
"#;

    #[test]
    fn loads_and_normalizes_closed_v1_limits() {
        let limits = load_aeonic_limits(SOURCE).expect("limits should load");
        assert_eq!(
            limits.structure.max_generic_arguments,
            LimitSetting::Value(32)
        );
        let effective = aeon_compile_limits(&limits).expect("effective limits");
        assert_eq!(effective.max_datatype_components, 64);
        assert_eq!(effective.max_path_depth, 1024);
        let finalize = finalization_limits(&limits);
        assert_eq!(finalize.max_reference_depth, Some(64));
        assert_eq!(finalize.max_materialized_weight, Some(1_000_000));
    }

    #[test]
    fn rejects_unknown_fields() {
        let source = SOURCE.replace(
            "max_header_bytes = 65536",
            "max_header_bytes = 65536, surprise = 1",
        );
        let errors = load_aeonic_limits(&source).expect_err("unknown field must fail");
        assert_eq!(errors[0].code, "INVALID_LIMITS_FILE");
    }
}
