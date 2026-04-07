use std::collections::{BTreeMap, BTreeSet};

use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;

#[derive(Debug, Clone, Deserialize)]
pub struct ValidationEnvelope {
    pub aes: Vec<AesEvent>,
    pub schema: Option<Schema>,
    #[serde(default)]
    pub options: ValidationOptions,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidationOptions {
    #[serde(default = "default_mode")]
    pub mode: String,
    #[serde(default = "default_trailing_separator_policy")]
    pub trailing_separator_delimiter_policy: String,
}

fn default_mode() -> String {
    String::from("v1")
}

fn default_trailing_separator_policy() -> String {
    String::from("off")
}

#[derive(Debug, Clone, Deserialize)]
pub struct Schema {
    #[serde(default)]
    pub rules: Vec<SchemaRule>,
    #[serde(default)]
    pub datatype_rules: BTreeMap<String, JsonValue>,
    #[serde(default)]
    pub datatype_allowlist: Vec<String>,
    #[serde(default = "default_world")]
    pub world: String,
    #[serde(default)]
    pub reference_policy: Option<String>,
}

fn default_world() -> String {
    String::from("open")
}

#[derive(Debug, Clone, Deserialize)]
pub struct SchemaRule {
    pub path: Option<String>,
    #[serde(default)]
    pub constraints: JsonValue,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AesEvent {
    pub path: EventPath,
    pub key: String,
    #[serde(default)]
    pub datatype: Option<String>,
    pub value: EventValue,
    #[serde(default)]
    pub span: Option<SpanInput>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct EventPath {
    #[serde(default)]
    pub segments: Vec<PathSegmentInput>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PathSegmentInput {
    #[serde(rename = "type")]
    pub segment_type: String,
    #[serde(default)]
    pub key: Option<String>,
    #[serde(default)]
    pub index: Option<JsonValue>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct EventValue {
    #[serde(rename = "type")]
    pub value_type: String,
    #[serde(default)]
    pub raw: Option<String>,
    #[serde(default)]
    pub value: Option<JsonValue>,
    #[serde(default)]
    pub elements: Vec<EventValue>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum SpanInput {
    Pair([usize; 2]),
    Object { start: OffsetOnly, end: OffsetOnly },
}

#[derive(Debug, Clone, Deserialize)]
pub struct OffsetOnly {
    pub offset: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResultEnvelope {
    pub ok: bool,
    pub errors: Vec<ValidationDiagnostic>,
    pub warnings: Vec<ValidationDiagnostic>,
    pub guarantees: BTreeMap<String, Vec<String>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ValidationDiagnostic {
    pub path: Option<String>,
    pub code: String,
    pub phase: String,
    pub span: Option<[usize; 2]>,
}

#[derive(Debug, Clone, Default)]
struct DiagContext {
    errors: Vec<ValidationDiagnostic>,
    warnings: Vec<ValidationDiagnostic>,
}

#[derive(Debug, Clone)]
struct EventInfo {
    value_type: String,
    datatype: Option<String>,
    raw: String,
    value: Option<JsonValue>,
    span: Option<[usize; 2]>,
}

const KNOWN_CONSTRAINT_KEYS: &[&str] = &[
    "required",
    "type",
    "reference",
    "reference_kind",
    "type_is",
    "length_exact",
    "sign",
    "min_digits",
    "max_digits",
    "min_length",
    "max_length",
    "pattern",
    "datatype",
];

#[must_use]
pub fn validate(envelope: &ValidationEnvelope) -> ResultEnvelope {
    validate_inner(&envelope.aes, envelope.schema.as_ref(), &envelope.options)
}

pub fn validate_cts_payload(payload: &str) -> Result<String, String> {
    let envelope: ValidationEnvelope =
        serde_json::from_str(payload).map_err(|_| String::from("Invalid JSON input"))?;

    if envelope.options.mode != "v1" {
        return Err(format!("Unsupported mode: {}", envelope.options.mode));
    }

    let result = validate(&envelope);
    serde_json::to_string_pretty(&result)
        .map_err(|error| format!("Failed to encode result: {error}"))
}

fn validate_inner(
    aes: &[AesEvent],
    schema: Option<&Schema>,
    options: &ValidationOptions,
) -> ResultEnvelope {
    let mut ctx = DiagContext::default();
    let mut seen = BTreeSet::new();
    let mut bound_paths = BTreeSet::new();
    let mut events_by_path = BTreeMap::<String, EventInfo>::new();
    let mut container_arity = BTreeMap::<String, usize>::new();

    for event in aes {
        let path = format_canonical_path(&event.path);
        if has_invalid_index_segment(&event.path) {
            emit_error(
                &mut ctx,
                ValidationDiagnostic {
                    path: Some(path.clone()),
                    code: String::from("invalid_index_format"),
                    phase: String::from("schema_validation"),
                    span: event.span_pair(),
                },
            );
        }

        if !seen.insert(path.clone()) {
            emit_error(
                &mut ctx,
                ValidationDiagnostic {
                    path: Some(path),
                    code: String::from("duplicate_binding"),
                    phase: String::from("schema_validation"),
                    span: event.span_pair(),
                },
            );
            continue;
        }

        bound_paths.insert(path.clone());
        events_by_path.insert(
            path.clone(),
            EventInfo {
                value_type: event.value.value_type.clone(),
                datatype: event.datatype.clone(),
                raw: event.value.raw.clone().unwrap_or_default(),
                value: event.value.value.clone(),
                span: event.span_pair(),
            },
        );

        if matches!(
            event.value.value_type.as_str(),
            "TupleLiteral" | "ListLiteral" | "ListNode"
        ) {
            container_arity.insert(path.clone(), event.value.elements.len());
            hydrate_indexed_fallback(
                &path,
                &event.value.elements,
                event.span_pair(),
                &mut events_by_path,
            );
        }
    }

    if matches!(
        options.trailing_separator_delimiter_policy.as_str(),
        "warn" | "error"
    ) {
        for event in aes {
            if event.value.value_type != "SeparatorLiteral" {
                continue;
            }
            let payload = string_value(event.value.value.as_ref());
            let Some(payload) = payload else {
                continue;
            };
            if payload.is_empty() {
                continue;
            }
            let separators = decode_separator_chars(event.datatype.as_deref());
            if separators.is_empty() {
                continue;
            }
            let trailing = payload.chars().last();
            if trailing.is_none() || !separators.contains(&trailing.unwrap_or_default()) {
                continue;
            }
            let diag = ValidationDiagnostic {
                path: Some(format_canonical_path(&event.path)),
                code: String::from("trailing_separator_delimiter"),
                phase: String::from("schema_validation"),
                span: event.span_pair(),
            };
            if options.trailing_separator_delimiter_policy == "warn" {
                emit_warning(&mut ctx, diag);
            } else {
                emit_error(&mut ctx, diag);
            }
        }
    }

    let Some(schema) = schema else {
        return finalize_result(ctx, &bound_paths, &events_by_path);
    };

    let rule_index = build_rule_index(schema, &mut ctx);
    let effective_rule_index =
        merge_datatype_rules(&rule_index, &schema.datatype_rules, &events_by_path);
    check_presence(&rule_index, &bound_paths, &mut ctx);
    check_types(&effective_rule_index, &events_by_path, &mut ctx);
    check_reference_forms(schema, &rule_index, &events_by_path, &mut ctx);
    check_tuple_arity(
        &effective_rule_index,
        &container_arity,
        &events_by_path,
        &mut ctx,
    );
    check_numeric_form(&effective_rule_index, &events_by_path, &mut ctx);
    check_string_form(&effective_rule_index, &events_by_path, &mut ctx);
    check_patterns(&effective_rule_index, &events_by_path, &mut ctx);
    check_world_policy(schema, aes, &bound_paths, &rule_index, &mut ctx);

    finalize_result(ctx, &bound_paths, &events_by_path)
}

fn finalize_result(
    ctx: DiagContext,
    bound_paths: &BTreeSet<String>,
    events_by_path: &BTreeMap<String, EventInfo>,
) -> ResultEnvelope {
    if !ctx.errors.is_empty() {
        return ResultEnvelope {
            ok: false,
            errors: ctx.errors,
            warnings: ctx.warnings,
            guarantees: BTreeMap::new(),
        };
    }

    ResultEnvelope {
        ok: true,
        errors: Vec::new(),
        warnings: ctx.warnings,
        guarantees: build_guarantees(bound_paths, events_by_path),
    }
}

fn build_rule_index(schema: &Schema, ctx: &mut DiagContext) -> BTreeMap<String, JsonValue> {
    let mut index = BTreeMap::new();
    let allowlist = &schema.datatype_allowlist;

    if let Some(reference_policy) = schema.reference_policy.as_deref()
        && !matches!(reference_policy, "allow" | "forbid")
    {
        emit_error(
            ctx,
            ValidationDiagnostic {
                path: Some(String::from("$")),
                code: String::from("invalid_reference_constraint"),
                phase: String::from("schema_validation"),
                span: None,
            },
        );
    }

    for rule in &schema.rules {
        let Some(path) = rule.path.as_ref() else {
            emit_error(
                ctx,
                ValidationDiagnostic {
                    path: None,
                    code: String::from("rule_missing_path"),
                    phase: String::from("schema_validation"),
                    span: None,
                },
            );
            continue;
        };

        if index.contains_key(path) {
            emit_error(
                ctx,
                ValidationDiagnostic {
                    path: Some(path.clone()),
                    code: String::from("duplicate_rule_path"),
                    phase: String::from("schema_validation"),
                    span: None,
                },
            );
            continue;
        }

        let constraints = match &rule.constraints {
            JsonValue::Object(map) => JsonValue::Object(map.clone()),
            _ => JsonValue::Object(Default::default()),
        };

        let JsonValue::Object(constraints_map) = &constraints else {
            continue;
        };

        if constraints_map
            .keys()
            .any(|key| !KNOWN_CONSTRAINT_KEYS.contains(&key.as_str()))
        {
            emit_error(
                ctx,
                ValidationDiagnostic {
                    path: Some(path.clone()),
                    code: String::from("unknown_constraint_key"),
                    phase: String::from("schema_validation"),
                    span: None,
                },
            );
            continue;
        }

        if !validate_reference_constraints(schema, path, constraints_map, ctx) {
            continue;
        }

        if let Some(datatype) = constraints_map.get("datatype").and_then(JsonValue::as_str)
            && !allowlist.is_empty()
            && !allowlist.iter().any(|allowed| allowed == datatype)
        {
            emit_error(
                ctx,
                ValidationDiagnostic {
                    path: Some(path.clone()),
                    code: String::from("datatype_allowlist_reject"),
                    phase: String::from("schema_validation"),
                    span: None,
                },
            );
        }

        index.insert(path.clone(), constraints);
    }

    index
}

fn validate_reference_constraints(
    schema: &Schema,
    path: &str,
    constraints: &serde_json::Map<String, JsonValue>,
    ctx: &mut DiagContext,
) -> bool {
    let reference = constraints.get("reference").and_then(JsonValue::as_str);
    let reference_kind = constraints
        .get("reference_kind")
        .and_then(JsonValue::as_str);
    let expected_type = constraints.get("type").and_then(JsonValue::as_str);

    if constraints.get("reference").is_some()
        && !matches!(reference, Some("allow" | "forbid" | "require"))
    {
        emit_error(
            ctx,
            ValidationDiagnostic {
                path: Some(String::from(path)),
                code: String::from("invalid_reference_constraint"),
                phase: String::from("schema_validation"),
                span: None,
            },
        );
        return false;
    }

    if constraints.get("reference_kind").is_some()
        && !matches!(reference_kind, Some("clone" | "pointer" | "either"))
    {
        emit_error(
            ctx,
            ValidationDiagnostic {
                path: Some(String::from(path)),
                code: String::from("invalid_reference_constraint"),
                phase: String::from("schema_validation"),
                span: None,
            },
        );
        return false;
    }

    if reference_kind.is_some() && reference != Some("require") {
        emit_error(
            ctx,
            ValidationDiagnostic {
                path: Some(String::from(path)),
                code: String::from("invalid_reference_constraint"),
                phase: String::from("schema_validation"),
                span: None,
            },
        );
        return false;
    }

    if reference == Some("forbid") && expected_type.is_some_and(is_reference_type) {
        emit_error(
            ctx,
            ValidationDiagnostic {
                path: Some(String::from(path)),
                code: String::from("invalid_reference_constraint"),
                phase: String::from("schema_validation"),
                span: None,
            },
        );
        return false;
    }

    if reference == Some("require") && expected_type.is_some_and(|value| !is_reference_type(value))
    {
        emit_error(
            ctx,
            ValidationDiagnostic {
                path: Some(String::from(path)),
                code: String::from("invalid_reference_constraint"),
                phase: String::from("schema_validation"),
                span: None,
            },
        );
        return false;
    }

    if reference_kind == Some("clone") && expected_type == Some("PointerReference") {
        emit_error(
            ctx,
            ValidationDiagnostic {
                path: Some(String::from(path)),
                code: String::from("invalid_reference_constraint"),
                phase: String::from("schema_validation"),
                span: None,
            },
        );
        return false;
    }

    if reference_kind == Some("pointer") && expected_type == Some("CloneReference") {
        emit_error(
            ctx,
            ValidationDiagnostic {
                path: Some(String::from(path)),
                code: String::from("invalid_reference_constraint"),
                phase: String::from("schema_validation"),
                span: None,
            },
        );
        return false;
    }

    if schema.reference_policy.as_deref() == Some("forbid")
        && (reference == Some("require") || expected_type.is_some_and(is_reference_type))
    {
        emit_error(
            ctx,
            ValidationDiagnostic {
                path: Some(String::from(path)),
                code: String::from("invalid_reference_constraint"),
                phase: String::from("schema_validation"),
                span: None,
            },
        );
        return false;
    }

    true
}

fn merge_datatype_rules(
    rule_index: &BTreeMap<String, JsonValue>,
    datatype_rules: &BTreeMap<String, JsonValue>,
    events_by_path: &BTreeMap<String, EventInfo>,
) -> BTreeMap<String, JsonValue> {
    let mut merged = rule_index.clone();

    for (path, event) in events_by_path {
        let Some(datatype) = event.datatype.as_deref() else {
            continue;
        };
        let Some(JsonValue::Object(datatype_constraints)) = datatype_rules.get(datatype) else {
            continue;
        };

        let mut effective = match merged.get(path) {
            Some(JsonValue::Object(existing)) => existing.clone(),
            _ => serde_json::Map::new(),
        };

        for (key, value) in datatype_constraints {
            effective
                .entry(key.clone())
                .or_insert_with(|| value.clone());
        }

        merged.insert(path.clone(), JsonValue::Object(effective));
    }

    merged
}

fn check_presence(
    rule_index: &BTreeMap<String, JsonValue>,
    bound_paths: &BTreeSet<String>,
    ctx: &mut DiagContext,
) {
    for (path, constraints) in rule_index {
        if constraints
            .get("required")
            .and_then(JsonValue::as_bool)
            .unwrap_or(false)
            && !bound_paths.contains(path)
        {
            emit_error(
                ctx,
                ValidationDiagnostic {
                    path: Some(path.clone()),
                    code: String::from("missing_required_field"),
                    phase: String::from("schema_validation"),
                    span: None,
                },
            );
        }
    }
}

fn check_types(
    rule_index: &BTreeMap<String, JsonValue>,
    events_by_path: &BTreeMap<String, EventInfo>,
    ctx: &mut DiagContext,
) {
    for (path, constraints) in rule_index {
        let Some(event) = events_by_path.get(path) else {
            continue;
        };

        if let Some(expected_container) = constraints.get("type_is").and_then(JsonValue::as_str) {
            let ok = match expected_container {
                "list" => matches!(event.value_type.as_str(), "ListLiteral" | "ListNode"),
                "tuple" => event.value_type == "TupleLiteral",
                _ => true,
            };
            if !ok {
                emit_error(
                    ctx,
                    ValidationDiagnostic {
                        path: Some(path.clone()),
                        code: String::from("WRONG_CONTAINER_KIND"),
                        phase: String::from("schema_validation"),
                        span: event.span,
                    },
                );
            }
        }

        if let Some(expected_type) = constraints.get("type").and_then(JsonValue::as_str)
            && !type_matches(expected_type, &event.value_type)
        {
            emit_error(
                ctx,
                ValidationDiagnostic {
                    path: Some(path.clone()),
                    code: String::from(if is_indexed_path(path) {
                        "TUPLE_ELEMENT_TYPE_MISMATCH"
                    } else {
                        "type_mismatch"
                    }),
                    phase: String::from("schema_validation"),
                    span: event.span,
                },
            );
        }
    }
}

fn check_reference_forms(
    schema: &Schema,
    rule_index: &BTreeMap<String, JsonValue>,
    events_by_path: &BTreeMap<String, EventInfo>,
    ctx: &mut DiagContext,
) {
    if schema.reference_policy.as_deref().unwrap_or("allow") == "forbid" {
        for (path, event) in events_by_path {
            if !is_reference_type(&event.value_type) {
                continue;
            }
            emit_error(
                ctx,
                ValidationDiagnostic {
                    path: Some(path.clone()),
                    code: String::from("reference_forbidden"),
                    phase: String::from("schema_validation"),
                    span: event.span,
                },
            );
        }
    }

    for (path, constraints) in rule_index {
        let Some(reference) = constraints.get("reference").and_then(JsonValue::as_str) else {
            continue;
        };
        let reference_kind = constraints
            .get("reference_kind")
            .and_then(JsonValue::as_str);
        let Some(event) = events_by_path.get(path) else {
            continue;
        };

        match reference {
            "allow" => {}
            "forbid" => {
                if is_reference_type(&event.value_type) {
                    emit_error(
                        ctx,
                        ValidationDiagnostic {
                            path: Some(path.clone()),
                            code: String::from("reference_forbidden"),
                            phase: String::from("schema_validation"),
                            span: event.span,
                        },
                    );
                }
            }
            "require" => {
                if !is_reference_type(&event.value_type) {
                    emit_error(
                        ctx,
                        ValidationDiagnostic {
                            path: Some(path.clone()),
                            code: String::from("reference_required"),
                            phase: String::from("schema_validation"),
                            span: event.span,
                        },
                    );
                    continue;
                }

                let expected_type = match reference_kind {
                    Some("clone") => Some("CloneReference"),
                    Some("pointer") => Some("PointerReference"),
                    _ => None,
                };
                if expected_type.is_some_and(|expected| event.value_type != expected) {
                    emit_error(
                        ctx,
                        ValidationDiagnostic {
                            path: Some(path.clone()),
                            code: String::from("reference_kind_mismatch"),
                            phase: String::from("schema_validation"),
                            span: event.span,
                        },
                    );
                }
            }
            _ => {}
        }
    }
}

fn check_tuple_arity(
    rule_index: &BTreeMap<String, JsonValue>,
    container_arity: &BTreeMap<String, usize>,
    events_by_path: &BTreeMap<String, EventInfo>,
    ctx: &mut DiagContext,
) {
    for (path, constraints) in rule_index {
        let Some(expected) = constraints.get("length_exact").and_then(JsonValue::as_u64) else {
            continue;
        };
        let Some(actual) = container_arity.get(path) else {
            continue;
        };
        if *actual != expected as usize {
            emit_error(
                ctx,
                ValidationDiagnostic {
                    path: Some(path.clone()),
                    code: String::from("TUPLE_ARITY_MISMATCH"),
                    phase: String::from("schema_validation"),
                    span: events_by_path.get(path).and_then(|event| event.span),
                },
            );
        }
    }
}

fn check_numeric_form(
    rule_index: &BTreeMap<String, JsonValue>,
    events_by_path: &BTreeMap<String, EventInfo>,
    ctx: &mut DiagContext,
) {
    for (path, constraints) in rule_index {
        let Some(event) = events_by_path.get(path) else {
            continue;
        };
        if !matches!(
            event.value_type.as_str(),
            "NumberLiteral" | "IntegerLiteral" | "FloatLiteral"
        ) {
            continue;
        }

        if constraints.get("sign").and_then(JsonValue::as_str) == Some("unsigned")
            && event.raw.starts_with('-')
        {
            emit_error(
                ctx,
                ValidationDiagnostic {
                    path: Some(path.clone()),
                    code: String::from("numeric_form_violation"),
                    phase: String::from("schema_validation"),
                    span: event.span,
                },
            );
            continue;
        }

        let digit_count = count_integer_digits(&event.raw);
        if let Some(min_digits) = constraints.get("min_digits").and_then(JsonValue::as_u64)
            && digit_count < min_digits as usize
        {
            emit_error(
                ctx,
                ValidationDiagnostic {
                    path: Some(path.clone()),
                    code: String::from("numeric_form_violation"),
                    phase: String::from("schema_validation"),
                    span: event.span,
                },
            );
            continue;
        }
        if let Some(max_digits) = constraints.get("max_digits").and_then(JsonValue::as_u64)
            && digit_count > max_digits as usize
        {
            emit_error(
                ctx,
                ValidationDiagnostic {
                    path: Some(path.clone()),
                    code: String::from("numeric_form_violation"),
                    phase: String::from("schema_validation"),
                    span: event.span,
                },
            );
        }
    }
}

fn check_string_form(
    rule_index: &BTreeMap<String, JsonValue>,
    events_by_path: &BTreeMap<String, EventInfo>,
    ctx: &mut DiagContext,
) {
    for (path, constraints) in rule_index {
        let Some(event) = events_by_path.get(path) else {
            continue;
        };
        if event.value_type != "StringLiteral" {
            continue;
        }
        let Some(value) = string_value(event.value.as_ref()) else {
            continue;
        };
        let length = value.chars().count();

        if let Some(min_length) = constraints.get("min_length").and_then(JsonValue::as_u64)
            && length < min_length as usize
        {
            emit_error(
                ctx,
                ValidationDiagnostic {
                    path: Some(path.clone()),
                    code: String::from("string_length_violation"),
                    phase: String::from("schema_validation"),
                    span: event.span,
                },
            );
            continue;
        }
        if let Some(max_length) = constraints.get("max_length").and_then(JsonValue::as_u64)
            && length > max_length as usize
        {
            emit_error(
                ctx,
                ValidationDiagnostic {
                    path: Some(path.clone()),
                    code: String::from("string_length_violation"),
                    phase: String::from("schema_validation"),
                    span: event.span,
                },
            );
        }
    }
}

fn check_patterns(
    rule_index: &BTreeMap<String, JsonValue>,
    events_by_path: &BTreeMap<String, EventInfo>,
    ctx: &mut DiagContext,
) {
    for (path, constraints) in rule_index {
        let Some(pattern) = constraints.get("pattern").and_then(JsonValue::as_str) else {
            continue;
        };
        let Some(event) = events_by_path.get(path) else {
            continue;
        };
        if event.value_type != "StringLiteral" {
            continue;
        }
        let Some(value) = string_value(event.value.as_ref()) else {
            continue;
        };
        let Ok(regex) = Regex::new(pattern) else {
            continue;
        };
        if !regex.is_match(&value) {
            emit_error(
                ctx,
                ValidationDiagnostic {
                    path: Some(path.clone()),
                    code: String::from("pattern_mismatch"),
                    phase: String::from("schema_validation"),
                    span: event.span,
                },
            );
        }
    }
}

fn check_world_policy(
    schema: &Schema,
    aes: &[AesEvent],
    bound_paths: &BTreeSet<String>,
    rule_index: &BTreeMap<String, JsonValue>,
    ctx: &mut DiagContext,
) {
    if schema.world != "closed" {
        return;
    }

    let allowed_paths = rule_index.keys().cloned().collect::<BTreeSet<_>>();
    for event in aes {
        if event.key.starts_with("aeon:") {
            continue;
        }
        let path = format_canonical_path(&event.path);
        if !bound_paths.contains(&path) || allowed_paths.contains(&path) {
            continue;
        }
        emit_error(
            ctx,
            ValidationDiagnostic {
                path: Some(path),
                code: String::from("unexpected_binding"),
                phase: String::from("schema_validation"),
                span: event.span_pair(),
            },
        );
    }
}

fn build_guarantees(
    bound_paths: &BTreeSet<String>,
    events_by_path: &BTreeMap<String, EventInfo>,
) -> BTreeMap<String, Vec<String>> {
    let mut guarantees = BTreeMap::new();

    for path in bound_paths {
        let Some(event) = events_by_path.get(path) else {
            continue;
        };
        let mut labels = vec![String::from("present")];
        match event.value_type.as_str() {
            "NumberLiteral" | "IntegerLiteral" => {
                labels.push(String::from("integer-representable"));
                labels.push(String::from("float-representable"));
            }
            "FloatLiteral" => {
                labels.push(String::from("float-representable"));
            }
            "StringLiteral" => {
                if string_value(event.value.as_ref())
                    .map(|value| !value.is_empty())
                    .unwrap_or(false)
                {
                    labels.push(String::from("non-empty-string"));
                }
            }
            _ => {}
        }
        if labels.len() > 1 {
            guarantees.insert(path.clone(), labels);
        }
    }

    guarantees
}

fn hydrate_indexed_fallback(
    path: &str,
    elements: &[EventValue],
    parent_span: Option<[usize; 2]>,
    events_by_path: &mut BTreeMap<String, EventInfo>,
) {
    for (index, element) in elements.iter().enumerate() {
        let child_path = format!("{path}[{index}]");
        events_by_path
            .entry(child_path)
            .or_insert_with(|| EventInfo {
                value_type: element.value_type.clone(),
                datatype: None,
                raw: element.raw.clone().unwrap_or_default(),
                value: element.value.clone(),
                span: parent_span,
            });
    }
}

fn emit_error(ctx: &mut DiagContext, diag: ValidationDiagnostic) {
    ctx.errors.push(diag);
}

fn emit_warning(ctx: &mut DiagContext, diag: ValidationDiagnostic) {
    ctx.warnings.push(diag);
}

fn type_matches(expected: &str, actual: &str) -> bool {
    match actual {
        "NumberLiteral" => matches!(
            expected,
            "NumberLiteral" | "IntegerLiteral" | "FloatLiteral"
        ),
        "ListLiteral" | "ListNode" => matches!(expected, "ListLiteral" | "ListNode"),
        _ => expected == actual,
    }
}

fn is_reference_type(value_type: &str) -> bool {
    matches!(value_type, "CloneReference" | "PointerReference")
}

fn is_indexed_path(path: &str) -> bool {
    path.ends_with(']') && path.contains('[')
}

fn count_integer_digits(raw: &str) -> usize {
    raw.chars()
        .skip_while(|ch| *ch == '-' || *ch == '+')
        .take_while(|ch| *ch != '.')
        .filter(|ch| ch.is_ascii_digit())
        .count()
}

fn string_value(value: Option<&JsonValue>) -> Option<String> {
    match value {
        Some(JsonValue::String(inner)) => Some(inner.clone()),
        _ => None,
    }
}

fn has_invalid_index_segment(path: &EventPath) -> bool {
    path.segments.iter().any(|segment| {
        segment.segment_type == "index"
            && !matches!(segment.index, Some(JsonValue::Number(ref number)) if number.as_u64().is_some())
    })
}

fn decode_separator_chars(datatype: Option<&str>) -> Vec<char> {
    let Some(datatype) = datatype else {
        return Vec::new();
    };
    let mut chars = Vec::new();
    let mut rest = datatype;
    while let Some(start) = rest.find('[') {
        let after = &rest[start + 1..];
        let Some(end) = after.find(']') else {
            break;
        };
        let inner = &after[..end];
        if inner.chars().count() == 1 {
            chars.extend(inner.chars());
        }
        rest = &after[end + 1..];
    }
    chars
}

fn format_canonical_path(path: &EventPath) -> String {
    let mut rendered = String::from("$");
    for segment in &path.segments {
        match segment.segment_type.as_str() {
            "root" => {}
            "member" => {
                let key = segment.key.as_deref().unwrap_or_default();
                if is_identifier(key) {
                    rendered.push('.');
                    rendered.push_str(key);
                } else {
                    rendered.push_str(".[\"");
                    rendered.push_str(&escape_quoted_key(key));
                    rendered.push_str("\"]");
                }
            }
            "index" => {
                rendered.push('[');
                match &segment.index {
                    Some(JsonValue::Number(number)) => rendered.push_str(&number.to_string()),
                    Some(JsonValue::String(value)) => rendered.push_str(value),
                    _ => rendered.push('?'),
                }
                rendered.push(']');
            }
            _ => {}
        }
    }
    rendered
}

fn is_identifier(key: &str) -> bool {
    let mut chars = key.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    (first == '_' || first.is_ascii_alphabetic())
        && chars.all(|ch| ch == '_' || ch.is_ascii_alphanumeric())
}

fn escape_quoted_key(key: &str) -> String {
    key.replace('\\', "\\\\").replace('"', "\\\"")
}

impl AesEvent {
    fn span_pair(&self) -> Option<[usize; 2]> {
        self.span.as_ref().map(SpanInput::pair)
    }
}

impl SpanInput {
    fn pair(&self) -> [usize; 2] {
        match self {
            Self::Pair(pair) => *pair,
            Self::Object { start, end } => [start.offset, end.offset],
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn empty_envelope_is_ok() {
        let envelope = ValidationEnvelope {
            aes: Vec::new(),
            schema: Some(Schema {
                rules: Vec::new(),
                datatype_rules: BTreeMap::new(),
                datatype_allowlist: Vec::new(),
                world: String::from("open"),
                reference_policy: None,
            }),
            options: ValidationOptions::default(),
        };
        let result = validate(&envelope);
        assert!(result.ok);
        assert!(result.errors.is_empty());
    }

    #[test]
    fn cts_payload_adapter_round_trips() {
        let payload = r#"{"aes":[],"schema":{"rules":[]},"options":{}}"#;
        let parsed = validate_cts_payload(payload).expect("payload should validate");
        let envelope: ResultEnvelope = serde_json::from_str(&parsed).expect("result JSON");
        assert!(envelope.ok);
    }

    #[test]
    fn schema_reference_policy_forbids_reference_bindings() {
        let envelope = ValidationEnvelope {
            aes: vec![AesEvent {
                path: EventPath {
                    segments: vec![
                        PathSegmentInput {
                            segment_type: String::from("root"),
                            key: None,
                            index: None,
                        },
                        PathSegmentInput {
                            segment_type: String::from("member"),
                            key: Some(String::from("a")),
                            index: None,
                        },
                    ],
                },
                key: String::from("a"),
                datatype: None,
                value: EventValue {
                    value_type: String::from("CloneReference"),
                    raw: None,
                    value: None,
                    elements: Vec::new(),
                },
                span: Some(SpanInput::Pair([0, 1])),
            }],
            schema: Some(Schema {
                rules: Vec::new(),
                datatype_rules: BTreeMap::new(),
                datatype_allowlist: Vec::new(),
                world: String::from("open"),
                reference_policy: Some(String::from("forbid")),
            }),
            options: ValidationOptions::default(),
        };

        let result = validate(&envelope);
        assert!(!result.ok);
        assert_eq!(result.errors[0].code, "reference_forbidden");
    }

    #[test]
    fn rule_reference_kind_requires_matching_reference_type() {
        let envelope = ValidationEnvelope {
            aes: vec![AesEvent {
                path: EventPath {
                    segments: vec![
                        PathSegmentInput {
                            segment_type: String::from("root"),
                            key: None,
                            index: None,
                        },
                        PathSegmentInput {
                            segment_type: String::from("member"),
                            key: Some(String::from("a")),
                            index: None,
                        },
                    ],
                },
                key: String::from("a"),
                datatype: None,
                value: EventValue {
                    value_type: String::from("PointerReference"),
                    raw: None,
                    value: None,
                    elements: Vec::new(),
                },
                span: Some(SpanInput::Pair([0, 1])),
            }],
            schema: Some(Schema {
                rules: vec![SchemaRule {
                    path: Some(String::from("$.a")),
                    constraints: json!({
                        "reference": "require",
                        "reference_kind": "clone"
                    }),
                }],
                datatype_rules: BTreeMap::new(),
                datatype_allowlist: Vec::new(),
                world: String::from("open"),
                reference_policy: None,
            }),
            options: ValidationOptions::default(),
        };

        let result = validate(&envelope);
        assert!(!result.ok);
        assert_eq!(result.errors[0].code, "reference_kind_mismatch");
    }

    #[test]
    fn invalid_reference_constraints_fail_schema_validation() {
        let envelope = ValidationEnvelope {
            aes: Vec::new(),
            schema: Some(Schema {
                rules: vec![SchemaRule {
                    path: Some(String::from("$.a")),
                    constraints: json!({
                        "reference_kind": "clone"
                    }),
                }],
                datatype_rules: BTreeMap::new(),
                datatype_allowlist: Vec::new(),
                world: String::from("open"),
                reference_policy: None,
            }),
            options: ValidationOptions::default(),
        };

        let result = validate(&envelope);
        assert!(!result.ok);
        assert_eq!(result.errors[0].code, "invalid_reference_constraint");
    }
}
