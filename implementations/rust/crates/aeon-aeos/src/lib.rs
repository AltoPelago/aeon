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
    pub selector: Option<String>,
    #[serde(default)]
    pub constraints: JsonValue,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AesEvent {
    pub path: EventPath,
    pub key: String,
    #[serde(default)]
    pub datatype: Option<String>,
    #[serde(default)]
    pub annotations: BTreeMap<String, AttributeEntry>,
    pub value: EventValue,
    #[serde(default)]
    pub span: Option<SpanInput>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AttributeEntry {
    pub value: EventValue,
    #[serde(default)]
    pub datatype: Option<String>,
    #[serde(default)]
    pub annotations: BTreeMap<String, AttributeEntry>,
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
    pub path: Option<Vec<ReferencePathSegment>>,
    #[serde(default)]
    pub elements: Vec<EventValue>,
    #[serde(default)]
    pub bindings: Vec<JsonValue>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum ReferencePathSegment {
    Member(String),
    Index(i64),
    Attribute {
        #[serde(rename = "type")]
        segment_type: String,
        key: String,
    },
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
    attributes: BTreeMap<String, AttributeInfo>,
    reference_path: Option<Vec<ReferencePathSegment>>,
}

#[derive(Debug, Clone)]
struct AttributeInfo {
    value_type: String,
    datatype: Option<String>,
    raw: String,
    value: Option<JsonValue>,
    span: Option<[usize; 2]>,
    attributes: BTreeMap<String, AttributeInfo>,
}

const KNOWN_CONSTRAINT_KEYS: &[&str] = &[
    "required",
    "type",
    "any_of",
    "nullable",
    "allow_infinity",
    "allow_nan",
    "null_value",
    "null_values",
    "toggle_pair",
    "reference",
    "reference_kind",
    "reference_target_pattern",
    "resolve_reference_form",
    "type_is",
    "length_exact",
    "min_children",
    "max_children",
    "sign",
    "min_digits",
    "max_digits",
    "radix",
    "min_value",
    "max_value",
    "min_length",
    "max_length",
    "pattern",
    "datatype",
    "attributes",
    "closed_attributes",
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
                attributes: build_attribute_info_map(&event.annotations),
                reference_path: event.value.path.clone(),
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
        } else if event.value.value_type == "ObjectNode" {
            container_arity.insert(path.clone(), event.value.bindings.len());
        } else if event.value.value_type == "NodeLiteral" {
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
    let selector_rule_index = expand_selector_rules(&rule_index, schema, &events_by_path, &mut ctx);
    let expanded_rule_index = expand_wildcard_rules(&selector_rule_index, &events_by_path);
    let effective_rule_index = merge_datatype_rules(
        &expanded_rule_index,
        &schema.datatype_rules,
        &events_by_path,
    );
    check_presence(&effective_rule_index, &bound_paths, &mut ctx);
    check_reference_forms(schema, &effective_rule_index, &events_by_path, &mut ctx);
    let effective_events_by_path =
        resolve_reference_form_events(&effective_rule_index, &events_by_path);
    let selected_rule_index =
        select_any_of_rules(&effective_rule_index, &effective_events_by_path, &mut ctx);
    check_types(&selected_rule_index, &effective_events_by_path, &mut ctx);
    check_tuple_arity(
        &selected_rule_index,
        &container_arity,
        &effective_events_by_path,
        &mut ctx,
    );
    check_literal_lexical_constraints(&selected_rule_index, &effective_events_by_path, &mut ctx);
    check_numeric_form(&selected_rule_index, &effective_events_by_path, &mut ctx);
    check_string_form(&selected_rule_index, &effective_events_by_path, &mut ctx);
    check_patterns(&selected_rule_index, &effective_events_by_path, &mut ctx);
    check_attribute_constraints(
        &selected_rule_index,
        &effective_events_by_path,
        &schema.datatype_rules,
        &mut ctx,
    );
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
        let path = rule.path.as_ref().filter(|path| !path.is_empty());
        let selector = rule
            .selector
            .as_ref()
            .filter(|selector| !selector.is_empty());
        let Some(rule_path) = path.or(selector) else {
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
        if path.is_some() && selector.is_some() {
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
        }

        if path.is_none() {
            let constraints = match &rule.constraints {
                JsonValue::Object(map) => JsonValue::Object(map.clone()),
                _ => JsonValue::Object(Default::default()),
            };
            let JsonValue::Object(constraints_map) = &constraints else {
                continue;
            };
            validate_constraint_tree(schema, rule_path, constraints_map, ctx);
            continue;
        }
        let path = path.expect("path checked above");

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

        if !validate_constraint_tree(schema, path, constraints_map, ctx) {
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

fn validate_constraint_tree(
    schema: &Schema,
    path: &str,
    constraints: &serde_json::Map<String, JsonValue>,
    ctx: &mut DiagContext,
) -> bool {
    if constraints
        .keys()
        .any(|key| !KNOWN_CONSTRAINT_KEYS.contains(&key.as_str()))
    {
        emit_error(
            ctx,
            ValidationDiagnostic {
                path: Some(String::from(path)),
                code: String::from("unknown_constraint_key"),
                phase: String::from("schema_validation"),
                span: None,
            },
        );
        return false;
    }

    if !validate_reference_constraints(schema, path, constraints, ctx) {
        return false;
    }

    if let Some(any_of) = constraints.get("any_of") {
        let Some(branches) = any_of.as_array() else {
            emit_error(
                ctx,
                ValidationDiagnostic {
                    path: Some(String::from(path)),
                    code: String::from("unknown_constraint_key"),
                    phase: String::from("schema_validation"),
                    span: None,
                },
            );
            return false;
        };
        if branches.is_empty() {
            emit_error(
                ctx,
                ValidationDiagnostic {
                    path: Some(String::from(path)),
                    code: String::from("unknown_constraint_key"),
                    phase: String::from("schema_validation"),
                    span: None,
                },
            );
            return false;
        }
        for (index, branch) in branches.iter().enumerate() {
            let Some(branch_constraints) = branch.as_object() else {
                emit_error(
                    ctx,
                    ValidationDiagnostic {
                        path: Some(format!("{path}.any_of[{index}]")),
                        code: String::from("unknown_constraint_key"),
                        phase: String::from("schema_validation"),
                        span: None,
                    },
                );
                return false;
            };
            if !validate_constraint_tree(
                schema,
                &format!("{path}.any_of[{index}]"),
                branch_constraints,
                ctx,
            ) {
                return false;
            }
        }
    }

    let Some(JsonValue::Object(attribute_rules)) = constraints.get("attributes") else {
        return true;
    };

    for (key, value) in attribute_rules {
        let JsonValue::Object(child_constraints) = value else {
            emit_error(
                ctx,
                ValidationDiagnostic {
                    path: Some(format!("{path}@{key}")),
                    code: String::from("unknown_constraint_key"),
                    phase: String::from("schema_validation"),
                    span: None,
                },
            );
            return false;
        };
        if !validate_constraint_tree(schema, &format!("{path}@{key}"), child_constraints, ctx) {
            return false;
        }
    }

    true
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
    let reference_target_pattern = constraints
        .get("reference_target_pattern")
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

    if constraints.get("reference_target_pattern").is_some() && reference_target_pattern.is_none() {
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

    if let Some(pattern) = reference_target_pattern {
        if Regex::new(pattern).is_err() || reference == Some("forbid") {
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
    }

    if constraints.get("resolve_reference_form").is_some()
        && constraints
            .get("resolve_reference_form")
            .and_then(JsonValue::as_bool)
            .is_none()
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
            && !path.contains("[*]")
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
            && !type_matches(expected_type, &event.value_type, constraints)
        {
            let code = if is_tuple_element_path(path, events_by_path) {
                "TUPLE_ELEMENT_TYPE_MISMATCH"
            } else {
                "type_mismatch"
            };
            emit_error(
                ctx,
                ValidationDiagnostic {
                    path: Some(path.clone()),
                    code: String::from(code),
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
        let reference = constraints.get("reference").and_then(JsonValue::as_str);
        let reference_kind = constraints
            .get("reference_kind")
            .and_then(JsonValue::as_str);
        let reference_target_pattern = constraints
            .get("reference_target_pattern")
            .and_then(JsonValue::as_str);
        let Some(event) = events_by_path.get(path) else {
            continue;
        };

        match reference {
            Some("allow") | None => {}
            Some("forbid") => {
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
            Some("require") => {
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

        if let Some(pattern) = reference_target_pattern
            && is_reference_type(&event.value_type)
            && event.reference_path.as_ref().is_some_and(|segments| {
                Regex::new(pattern)
                    .is_ok_and(|regex| !regex.is_match(&format_reference_target_path(segments)))
            })
        {
            emit_error(
                ctx,
                ValidationDiagnostic {
                    path: Some(path.clone()),
                    code: String::from("reference_target_mismatch"),
                    phase: String::from("schema_validation"),
                    span: event.span,
                },
            );
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
        let Some(actual) = container_arity.get(path) else {
            continue;
        };
        if let Some(expected) = constraints.get("length_exact").and_then(JsonValue::as_u64)
            && *actual != expected as usize
        {
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
        if let Some(minimum) = constraints.get("min_children").and_then(JsonValue::as_u64)
            && *actual < minimum as usize
        {
            emit_error(
                ctx,
                ValidationDiagnostic {
                    path: Some(path.clone()),
                    code: String::from("container_cardinality_mismatch"),
                    phase: String::from("schema_validation"),
                    span: events_by_path.get(path).and_then(|event| event.span),
                },
            );
        }
        if let Some(maximum) = constraints.get("max_children").and_then(JsonValue::as_u64)
            && *actual > maximum as usize
        {
            emit_error(
                ctx,
                ValidationDiagnostic {
                    path: Some(path.clone()),
                    code: String::from("container_cardinality_mismatch"),
                    phase: String::from("schema_validation"),
                    span: events_by_path.get(path).and_then(|event| event.span),
                },
            );
        }
    }
}

fn check_literal_lexical_constraints(
    rule_index: &BTreeMap<String, JsonValue>,
    events_by_path: &BTreeMap<String, EventInfo>,
    ctx: &mut DiagContext,
) {
    for (path, constraints) in rule_index {
        let Some(event) = events_by_path.get(path) else {
            continue;
        };

        if event.value_type == "NullLiteral"
            && !null_value_matches(
                string_value(event.value.as_ref())
                    .as_deref()
                    .unwrap_or_default(),
                constraints,
            )
        {
            emit_error(
                ctx,
                ValidationDiagnostic {
                    path: Some(path.clone()),
                    code: String::from("null_value_mismatch"),
                    phase: String::from("schema_validation"),
                    span: event.span,
                },
            );
        }

        if event.value_type == "ToggleLiteral"
            && let Some(pair) = constraints.get("toggle_pair").and_then(JsonValue::as_str)
            && pair != "any"
        {
            let value = event.raw.to_lowercase();
            let allowed = match pair {
                "yes_no" => matches!(value.as_str(), "yes" | "no"),
                "on_off" => matches!(value.as_str(), "on" | "off"),
                _ => true,
            };
            if !allowed {
                emit_error(
                    ctx,
                    ValidationDiagnostic {
                        path: Some(path.clone()),
                        code: String::from("toggle_pair_mismatch"),
                        phase: String::from("schema_validation"),
                        span: event.span,
                    },
                );
            }
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
        if !is_digit_form_literal(&event.value_type) {
            continue;
        }

        if constraints.get("sign").and_then(JsonValue::as_str) == Some("unsigned")
            && matches!(
                event.value_type.as_str(),
                "NumberLiteral" | "IntegerLiteral" | "FloatLiteral" | "RadixLiteral"
            )
            && is_form_negative(&event.raw)
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

        let digit_count = count_form_digits(&event.value_type, &event.raw);
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
            continue;
        }

        if event.value_type == "RadixLiteral"
            && let Some(radix) = constraints.get("radix").and_then(JsonValue::as_u64)
            && let Some(_invalid_digit) = first_invalid_radix_digit(&event.raw, radix as usize)
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

        if constraints.get("min_value").is_some() || constraints.get("max_value").is_some() {
            let Some(normalized) = normalize_integer_literal(&event.raw) else {
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
            };
            let numeric = normalized.parse::<i128>().ok();
            let Some(numeric) = numeric else {
                continue;
            };
            if let Some(min_value) = constraints.get("min_value").and_then(JsonValue::as_str)
                && min_value
                    .parse::<i128>()
                    .ok()
                    .is_some_and(|min| numeric < min)
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
            if let Some(max_value) = constraints.get("max_value").and_then(JsonValue::as_str)
                && max_value
                    .parse::<i128>()
                    .ok()
                    .is_some_and(|max| numeric > max)
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

fn check_attribute_constraints(
    rule_index: &BTreeMap<String, JsonValue>,
    events_by_path: &BTreeMap<String, EventInfo>,
    datatype_rules: &BTreeMap<String, JsonValue>,
    ctx: &mut DiagContext,
) {
    for (path, constraints) in rule_index {
        let Some(event) = events_by_path.get(path) else {
            continue;
        };
        let has_attribute_rules = constraints
            .get("attributes")
            .is_some_and(|value| value.is_object());
        let closed_attributes = constraints
            .get("closed_attributes")
            .and_then(JsonValue::as_bool)
            .unwrap_or(false);
        if !has_attribute_rules && !closed_attributes {
            continue;
        }
        validate_attribute_map(path, &event.attributes, constraints, datatype_rules, ctx);
    }
}

fn validate_attribute_map(
    base_path: &str,
    attributes: &BTreeMap<String, AttributeInfo>,
    constraints: &JsonValue,
    datatype_rules: &BTreeMap<String, JsonValue>,
    ctx: &mut DiagContext,
) {
    let attribute_rules = constraints.get("attributes").and_then(JsonValue::as_object);

    if let Some(attribute_rules) = attribute_rules {
        for (key, child_constraints_value) in attribute_rules {
            let child_path = format!("{base_path}@{key}");
            let required = child_constraints_value
                .get("required")
                .and_then(JsonValue::as_bool)
                .unwrap_or(false);
            let entry = attributes.get(key);
            if required && entry.is_none() {
                emit_error(
                    ctx,
                    ValidationDiagnostic {
                        path: Some(child_path),
                        code: String::from("missing_required_field"),
                        phase: String::from("schema_validation"),
                        span: None,
                    },
                );
                continue;
            }
            let Some(entry) = entry else {
                continue;
            };
            validate_attribute_entry(
                &child_path,
                entry,
                child_constraints_value,
                datatype_rules,
                ctx,
            );
        }
    }

    let closed_attributes = constraints
        .get("closed_attributes")
        .and_then(JsonValue::as_bool)
        .unwrap_or(false);
    if closed_attributes {
        let allowed: BTreeSet<&str> = attribute_rules
            .map(|rules| rules.keys().map(String::as_str).collect())
            .unwrap_or_default();
        for (key, entry) in attributes {
            if allowed.contains(key.as_str()) {
                continue;
            }
            emit_error(
                ctx,
                ValidationDiagnostic {
                    path: Some(format!("{base_path}@{key}")),
                    code: String::from("unexpected_attribute_entry"),
                    phase: String::from("schema_validation"),
                    span: entry.span,
                },
            );
        }
    }
}

fn validate_attribute_entry(
    path: &str,
    entry: &AttributeInfo,
    constraints: &JsonValue,
    datatype_rules: &BTreeMap<String, JsonValue>,
    ctx: &mut DiagContext,
) {
    let effective_constraints =
        merge_attribute_datatype_rules(constraints, entry.datatype.as_deref(), datatype_rules);

    if let Some(expected_container) = effective_constraints
        .get("type_is")
        .and_then(JsonValue::as_str)
    {
        let ok = match expected_container {
            "list" => matches!(entry.value_type.as_str(), "ListLiteral" | "ListNode"),
            "tuple" => entry.value_type == "TupleLiteral",
            _ => true,
        };
        if !ok {
            emit_error(
                ctx,
                ValidationDiagnostic {
                    path: Some(String::from(path)),
                    code: String::from("WRONG_CONTAINER_KIND"),
                    phase: String::from("schema_validation"),
                    span: entry.span,
                },
            );
        }
    }

    if let Some(expected_type) = effective_constraints
        .get("type")
        .and_then(JsonValue::as_str)
        && !type_matches(expected_type, &entry.value_type, &effective_constraints)
    {
        emit_error(
            ctx,
            ValidationDiagnostic {
                path: Some(String::from(path)),
                code: String::from("type_mismatch"),
                phase: String::from("schema_validation"),
                span: entry.span,
            },
        );
    }

    if let Some(expected_datatype) = effective_constraints
        .get("datatype")
        .and_then(JsonValue::as_str)
        && entry.datatype.as_deref() != Some(expected_datatype)
    {
        emit_error(
            ctx,
            ValidationDiagnostic {
                path: Some(String::from(path)),
                code: String::from("type_mismatch"),
                phase: String::from("schema_validation"),
                span: entry.span,
            },
        );
    }

    check_attribute_lexical_constraints(path, entry, &effective_constraints, ctx);

    if let Some(reference) = effective_constraints
        .get("reference")
        .and_then(JsonValue::as_str)
    {
        match reference {
            "forbid" if is_reference_type(&entry.value_type) => emit_error(
                ctx,
                ValidationDiagnostic {
                    path: Some(String::from(path)),
                    code: String::from("reference_forbidden"),
                    phase: String::from("schema_validation"),
                    span: entry.span,
                },
            ),
            "require" if !is_reference_type(&entry.value_type) => emit_error(
                ctx,
                ValidationDiagnostic {
                    path: Some(String::from(path)),
                    code: String::from("reference_required"),
                    phase: String::from("schema_validation"),
                    span: entry.span,
                },
            ),
            _ => {}
        }
    }

    if effective_constraints
        .get("reference")
        .and_then(JsonValue::as_str)
        == Some("require")
    {
        if let Some(reference_kind) = effective_constraints
            .get("reference_kind")
            .and_then(JsonValue::as_str)
        {
            let expected = match reference_kind {
                "clone" => Some("CloneReference"),
                "pointer" => Some("PointerReference"),
                _ => None,
            };
            if expected.is_some_and(|expected_type| entry.value_type != expected_type) {
                emit_error(
                    ctx,
                    ValidationDiagnostic {
                        path: Some(String::from(path)),
                        code: String::from("reference_kind_mismatch"),
                        phase: String::from("schema_validation"),
                        span: entry.span,
                    },
                );
            }
        }
    }

    if is_digit_form_literal(&entry.value_type) {
        let digit_count = count_form_digits(&entry.value_type, &entry.raw);
        if effective_constraints
            .get("sign")
            .and_then(JsonValue::as_str)
            == Some("unsigned")
            && matches!(
                entry.value_type.as_str(),
                "NumberLiteral" | "IntegerLiteral" | "FloatLiteral" | "RadixLiteral"
            )
            && is_form_negative(&entry.raw)
        {
            emit_error(
                ctx,
                ValidationDiagnostic {
                    path: Some(String::from(path)),
                    code: String::from("numeric_form_violation"),
                    phase: String::from("schema_validation"),
                    span: entry.span,
                },
            );
        }
        if let Some(min_digits) = effective_constraints
            .get("min_digits")
            .and_then(JsonValue::as_u64)
            && digit_count < min_digits as usize
        {
            emit_error(
                ctx,
                ValidationDiagnostic {
                    path: Some(String::from(path)),
                    code: String::from("numeric_form_violation"),
                    phase: String::from("schema_validation"),
                    span: entry.span,
                },
            );
        }
        if let Some(max_digits) = effective_constraints
            .get("max_digits")
            .and_then(JsonValue::as_u64)
            && digit_count > max_digits as usize
        {
            emit_error(
                ctx,
                ValidationDiagnostic {
                    path: Some(String::from(path)),
                    code: String::from("numeric_form_violation"),
                    phase: String::from("schema_validation"),
                    span: entry.span,
                },
            );
        }
        if entry.value_type == "RadixLiteral"
            && let Some(radix) = effective_constraints
                .get("radix")
                .and_then(JsonValue::as_u64)
            && let Some(_invalid_digit) = first_invalid_radix_digit(&entry.raw, radix as usize)
        {
            emit_error(
                ctx,
                ValidationDiagnostic {
                    path: Some(String::from(path)),
                    code: String::from("numeric_form_violation"),
                    phase: String::from("schema_validation"),
                    span: entry.span,
                },
            );
        }
        if effective_constraints.get("min_value").is_some()
            || effective_constraints.get("max_value").is_some()
        {
            let Some(normalized) = normalize_integer_literal(&entry.raw) else {
                emit_error(
                    ctx,
                    ValidationDiagnostic {
                        path: Some(String::from(path)),
                        code: String::from("numeric_form_violation"),
                        phase: String::from("schema_validation"),
                        span: entry.span,
                    },
                );
                return;
            };
            let Some(numeric) = normalized.parse::<i128>().ok() else {
                return;
            };
            if let Some(min_value) = effective_constraints
                .get("min_value")
                .and_then(JsonValue::as_str)
                && min_value
                    .parse::<i128>()
                    .ok()
                    .is_some_and(|min| numeric < min)
            {
                emit_error(
                    ctx,
                    ValidationDiagnostic {
                        path: Some(String::from(path)),
                        code: String::from("numeric_form_violation"),
                        phase: String::from("schema_validation"),
                        span: entry.span,
                    },
                );
            }
            if let Some(max_value) = effective_constraints
                .get("max_value")
                .and_then(JsonValue::as_str)
                && max_value
                    .parse::<i128>()
                    .ok()
                    .is_some_and(|max| numeric > max)
            {
                emit_error(
                    ctx,
                    ValidationDiagnostic {
                        path: Some(String::from(path)),
                        code: String::from("numeric_form_violation"),
                        phase: String::from("schema_validation"),
                        span: entry.span,
                    },
                );
            }
        }
    }

    if entry.value_type == "StringLiteral" {
        let value = string_value(entry.value.as_ref()).unwrap_or_default();
        if let Some(min_length) = effective_constraints
            .get("min_length")
            .and_then(JsonValue::as_u64)
            && value.len() < min_length as usize
        {
            emit_error(
                ctx,
                ValidationDiagnostic {
                    path: Some(String::from(path)),
                    code: String::from("string_length_violation"),
                    phase: String::from("schema_validation"),
                    span: entry.span,
                },
            );
        }
        if let Some(max_length) = effective_constraints
            .get("max_length")
            .and_then(JsonValue::as_u64)
            && value.len() > max_length as usize
        {
            emit_error(
                ctx,
                ValidationDiagnostic {
                    path: Some(String::from(path)),
                    code: String::from("string_length_violation"),
                    phase: String::from("schema_validation"),
                    span: entry.span,
                },
            );
        }
        if let Some(pattern) = effective_constraints
            .get("pattern")
            .and_then(JsonValue::as_str)
            && Regex::new(pattern).is_ok_and(|regex| !regex.is_match(&value))
        {
            emit_error(
                ctx,
                ValidationDiagnostic {
                    path: Some(String::from(path)),
                    code: String::from("pattern_mismatch"),
                    phase: String::from("schema_validation"),
                    span: entry.span,
                },
            );
        }
    }

    let closed_attributes = effective_constraints
        .get("closed_attributes")
        .and_then(JsonValue::as_bool)
        .unwrap_or(false);
    let has_nested_rules = effective_constraints
        .get("attributes")
        .is_some_and(|value| value.is_object());
    if has_nested_rules || closed_attributes {
        validate_attribute_map(
            path,
            &entry.attributes,
            &effective_constraints,
            datatype_rules,
            ctx,
        );
    }
}

fn merge_attribute_datatype_rules(
    constraints: &JsonValue,
    datatype: Option<&str>,
    datatype_rules: &BTreeMap<String, JsonValue>,
) -> JsonValue {
    let Some(datatype) = datatype else {
        return constraints.clone();
    };
    let Some(JsonValue::Object(rule_constraints)) =
        datatype_rules.get(&datatype_base(datatype).to_lowercase())
    else {
        return constraints.clone();
    };
    let mut merged = rule_constraints.clone();
    if let JsonValue::Object(existing) = constraints {
        for (key, value) in existing {
            merged.insert(key.clone(), value.clone());
        }
    }
    JsonValue::Object(merged)
}

fn check_world_policy(
    schema: &Schema,
    aes: &[AesEvent],
    bound_paths: &BTreeSet<String>,
    _rule_index: &BTreeMap<String, JsonValue>,
    ctx: &mut DiagContext,
) {
    if schema.world != "closed" {
        return;
    }

    let allowed_rules = schema
        .rules
        .iter()
        .filter_map(|rule| {
            rule.path
                .as_ref()
                .filter(|path| !path.is_empty())
                .map(|path| ("path", path.as_str()))
                .or_else(|| {
                    rule.selector
                        .as_ref()
                        .filter(|selector| !selector.is_empty())
                        .map(|selector| ("selector", selector.as_str()))
                })
        })
        .collect::<Vec<_>>();
    for event in aes {
        if event.key.starts_with("aeon:") {
            continue;
        }
        let path = format_canonical_path(&event.path);
        if !bound_paths.contains(&path)
            || allowed_rules.iter().any(|(kind, allowed_path)| {
                if *kind == "selector" {
                    matches_selector_path(&path, allowed_path)
                } else {
                    matches_allowed_path(&path, allowed_path)
                }
            })
        {
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
                attributes: BTreeMap::new(),
                reference_path: element.path.clone(),
            });
    }
}

fn build_attribute_info_map(
    annotations: &BTreeMap<String, AttributeEntry>,
) -> BTreeMap<String, AttributeInfo> {
    let mut mapped = BTreeMap::new();
    for (key, entry) in annotations {
        mapped.insert(
            key.clone(),
            AttributeInfo {
                value_type: entry.value.value_type.clone(),
                datatype: entry.datatype.clone(),
                raw: entry.value.raw.clone().unwrap_or_default(),
                value: entry.value.value.clone(),
                span: None,
                attributes: build_attribute_info_map(&entry.annotations),
            },
        );
    }
    mapped
}

fn resolve_reference_form_events(
    rule_index: &BTreeMap<String, JsonValue>,
    events_by_path: &BTreeMap<String, EventInfo>,
) -> BTreeMap<String, EventInfo> {
    let mut resolved = events_by_path.clone();
    for (path, constraints) in rule_index {
        if constraints
            .get("resolve_reference_form")
            .and_then(JsonValue::as_bool)
            != Some(true)
        {
            continue;
        }
        let Some(event) = events_by_path.get(path) else {
            continue;
        };
        if !is_reference_type(&event.value_type) {
            continue;
        }
        let Some(terminal) =
            resolve_terminal_reference_event(event, events_by_path, &mut BTreeSet::new())
        else {
            resolved.remove(path);
            continue;
        };
        let mut effective = terminal.clone();
        effective.span = event.span;
        resolved.insert(path.clone(), effective);
    }
    resolved
}

fn expand_selector_rules(
    rule_index: &BTreeMap<String, JsonValue>,
    schema: &Schema,
    events_by_path: &BTreeMap<String, EventInfo>,
    ctx: &mut DiagContext,
) -> BTreeMap<String, JsonValue> {
    let mut expanded = rule_index.clone();
    for rule in &schema.rules {
        let Some(selector) = rule
            .selector
            .as_ref()
            .filter(|selector| !selector.is_empty())
        else {
            continue;
        };
        if rule.path.as_ref().is_some_and(|path| !path.is_empty()) {
            continue;
        }
        let mut matched = false;
        for actual_path in events_by_path.keys() {
            if !matches_selector_path(actual_path, selector) {
                continue;
            }
            matched = true;
            expanded
                .entry(actual_path.clone())
                .or_insert_with(|| rule.constraints.clone());
        }
        if !matched
            && rule
                .constraints
                .get("required")
                .and_then(JsonValue::as_bool)
                == Some(true)
        {
            emit_error(
                ctx,
                ValidationDiagnostic {
                    path: Some(selector.clone()),
                    code: String::from("missing_required_field"),
                    phase: String::from("schema_validation"),
                    span: None,
                },
            );
        }
    }
    expanded
}

fn expand_wildcard_rules(
    rule_index: &BTreeMap<String, JsonValue>,
    events_by_path: &BTreeMap<String, EventInfo>,
) -> BTreeMap<String, JsonValue> {
    let mut expanded = rule_index.clone();
    for (path, constraints) in rule_index {
        if !path.contains("[*]") {
            continue;
        }
        expanded.remove(path);
        for actual_path in events_by_path.keys() {
            if matches_allowed_path(actual_path, path) {
                expanded.insert(actual_path.clone(), constraints.clone());
            }
        }
    }
    expanded
}

fn select_any_of_rules(
    rule_index: &BTreeMap<String, JsonValue>,
    events_by_path: &BTreeMap<String, EventInfo>,
    ctx: &mut DiagContext,
) -> BTreeMap<String, JsonValue> {
    let mut selected = rule_index.clone();
    for (path, constraints) in rule_index {
        let Some(branches) = constraints.get("any_of").and_then(JsonValue::as_array) else {
            continue;
        };
        let Some(event) = events_by_path.get(path) else {
            continue;
        };
        let mut outer = constraints.clone();
        if let JsonValue::Object(map) = &mut outer {
            map.remove("any_of");
        }
        let Some(branch) = branches
            .iter()
            .find(|branch| constraint_branch_matches_event(branch, event))
        else {
            emit_error(
                ctx,
                ValidationDiagnostic {
                    path: Some(path.clone()),
                    code: String::from("type_mismatch"),
                    phase: String::from("schema_validation"),
                    span: event.span,
                },
            );
            selected.insert(path.clone(), outer);
            continue;
        };
        selected.insert(path.clone(), merge_constraints(&outer, branch));
    }
    selected
}

fn merge_constraints(outer: &JsonValue, branch: &JsonValue) -> JsonValue {
    let mut merged = outer.as_object().cloned().unwrap_or_default();
    if let Some(branch_map) = branch.as_object() {
        for (key, value) in branch_map {
            merged.insert(key.clone(), value.clone());
        }
    }
    JsonValue::Object(merged)
}

fn constraint_branch_matches_event(constraints: &JsonValue, event: &EventInfo) -> bool {
    if let Some(expected_container) = constraints.get("type_is").and_then(JsonValue::as_str) {
        let ok = match expected_container {
            "list" => matches!(event.value_type.as_str(), "ListLiteral" | "ListNode"),
            "tuple" => event.value_type == "TupleLiteral",
            _ => true,
        };
        if !ok {
            return false;
        }
    }
    if let Some(expected_type) = constraints.get("type").and_then(JsonValue::as_str)
        && !type_matches(expected_type, &event.value_type, constraints)
    {
        return false;
    }
    if let Some(expected_datatype) = constraints.get("datatype").and_then(JsonValue::as_str)
        && event.datatype.as_deref() != Some(expected_datatype)
    {
        return false;
    }
    if event.value_type == "NullLiteral"
        && !null_value_matches(
            event
                .value
                .as_ref()
                .and_then(JsonValue::as_str)
                .unwrap_or_default(),
            constraints,
        )
    {
        return false;
    }
    if event.value_type == "ToggleLiteral"
        && let Some(pair) = constraints.get("toggle_pair").and_then(JsonValue::as_str)
        && pair != "any"
    {
        let raw = event.raw.to_lowercase();
        let allowed = match pair {
            "yes_no" => matches!(raw.as_str(), "yes" | "no"),
            "on_off" => matches!(raw.as_str(), "on" | "off"),
            _ => true,
        };
        if !allowed {
            return false;
        }
    }
    if event.value_type == "StringLiteral" {
        let value = event
            .value
            .as_ref()
            .and_then(JsonValue::as_str)
            .unwrap_or_default();
        if let Some(min_length) = constraints.get("min_length").and_then(JsonValue::as_u64)
            && value.encode_utf16().count() < min_length as usize
        {
            return false;
        }
        if let Some(max_length) = constraints.get("max_length").and_then(JsonValue::as_u64)
            && value.encode_utf16().count() > max_length as usize
        {
            return false;
        }
        if let Some(pattern) = constraints.get("pattern").and_then(JsonValue::as_str)
            && Regex::new(pattern).map_or(false, |regex| !regex.is_match(value))
        {
            return false;
        }
    }
    if has_digit_form_constraints(constraints) && is_digit_form_literal(&event.value_type) {
        let digit_count = count_form_digits(&event.value_type, &event.raw);
        if constraints.get("sign").and_then(JsonValue::as_str) == Some("unsigned")
            && is_form_negative(&event.raw)
        {
            return false;
        }
        if let Some(min_digits) = constraints.get("min_digits").and_then(JsonValue::as_u64)
            && digit_count < min_digits as usize
        {
            return false;
        }
        if let Some(max_digits) = constraints.get("max_digits").and_then(JsonValue::as_u64)
            && digit_count > max_digits as usize
        {
            return false;
        }
        if event.value_type == "RadixLiteral"
            && let Some(radix) = constraints.get("radix").and_then(JsonValue::as_u64)
            && first_invalid_radix_digit(&event.raw, radix as usize).is_some()
        {
            return false;
        }
    }
    true
}

fn matches_allowed_path(actual_path: &str, allowed_path: &str) -> bool {
    if actual_path == allowed_path {
        return true;
    }
    if !allowed_path.contains("[*]") {
        return false;
    }
    let pattern = format!(
        "^{}$",
        allowed_path
            .split("[*]")
            .map(regex::escape)
            .collect::<Vec<_>>()
            .join(r"\[\d+\]")
    );
    Regex::new(&pattern)
        .map(|regex| regex.is_match(actual_path))
        .unwrap_or(false)
}

fn tokenize_canonical_like_path(path: &str) -> Option<Vec<String>> {
    if !path.starts_with('$') {
        return None;
    }
    let mut segments = Vec::new();
    let mut cursor = 1;
    while cursor < path.len() {
        let marker = path[cursor..].chars().next()?;
        if marker == '.' {
            cursor += marker.len_utf8();
            if cursor < path.len() && path[cursor..].starts_with('[') {
                let end = find_bracket_end(path, cursor)?;
                segments.push(path[cursor..=end].to_string());
                cursor = end + 1;
                continue;
            }
            let start = cursor;
            while cursor < path.len() {
                let ch = path[cursor..].chars().next()?;
                if matches!(ch, '.' | '[' | '@') {
                    break;
                }
                cursor += ch.len_utf8();
            }
            if start == cursor {
                return None;
            }
            segments.push(path[start..cursor].to_string());
            continue;
        }
        if marker == '[' {
            let end = find_bracket_end(path, cursor)?;
            segments.push(path[cursor..=end].to_string());
            cursor = end + 1;
            continue;
        }
        if marker == '@' {
            cursor += marker.len_utf8();
            if cursor < path.len() && path[cursor..].starts_with('[') {
                let end = find_bracket_end(path, cursor)?;
                segments.push(format!("@{}", &path[cursor..=end]));
                cursor = end + 1;
                continue;
            }
            let start = cursor;
            while cursor < path.len() {
                let ch = path[cursor..].chars().next()?;
                if matches!(ch, '.' | '[' | '@') {
                    break;
                }
                cursor += ch.len_utf8();
            }
            if start == cursor {
                return None;
            }
            segments.push(format!("@{}", &path[start..cursor]));
            continue;
        }
        return None;
    }
    Some(segments)
}

fn find_bracket_end(path: &str, start: usize) -> Option<usize> {
    let mut quote: Option<char> = None;
    let mut escaped = false;
    for (offset, ch) in path[start + 1..].char_indices() {
        let index = start + 1 + offset;
        if escaped {
            escaped = false;
            continue;
        }
        if let Some(active_quote) = quote {
            if ch == '\\' {
                escaped = true;
            } else if ch == active_quote {
                quote = None;
            }
            continue;
        }
        if ch == '"' || ch == '\'' {
            quote = Some(ch);
            continue;
        }
        if ch == ']' {
            return Some(index);
        }
    }
    None
}

fn matches_selector_path(actual_path: &str, selector: &str) -> bool {
    if actual_path == selector {
        return true;
    }
    let Some(actual_segments) = tokenize_canonical_like_path(actual_path) else {
        return false;
    };
    let Some(selector_segments) = tokenize_canonical_like_path(selector) else {
        return false;
    };

    fn match_from(
        actual: &[String],
        selector: &[String],
        actual_index: usize,
        selector_index: usize,
    ) -> bool {
        if selector_index == selector.len() {
            return actual_index == actual.len();
        }
        let selector_segment = selector[selector_index].as_str();
        if selector_segment == "**" {
            if selector_index == selector.len() - 1 {
                return true;
            }
            for next_actual in actual_index..=actual.len() {
                if match_from(actual, selector, next_actual, selector_index + 1) {
                    return true;
                }
            }
            return false;
        }
        if actual_index >= actual.len() {
            return false;
        }
        if selector_segment == "*" {
            return match_from(actual, selector, actual_index + 1, selector_index + 1);
        }
        if selector_segment == "[*]" {
            return Regex::new(r"^\[\d+\]$")
                .map(|regex| regex.is_match(&actual[actual_index]))
                .unwrap_or(false)
                && match_from(actual, selector, actual_index + 1, selector_index + 1);
        }
        selector_segment == actual[actual_index]
            && match_from(actual, selector, actual_index + 1, selector_index + 1)
    }

    match_from(&actual_segments, &selector_segments, 0, 0)
}

fn resolve_terminal_reference_event(
    event: &EventInfo,
    events_by_path: &BTreeMap<String, EventInfo>,
    active_paths: &mut BTreeSet<String>,
) -> Option<EventInfo> {
    if !is_reference_type(&event.value_type) {
        return Some(event.clone());
    }
    let target_path = format_reference_target_path(event.reference_path.as_ref()?);
    if !active_paths.insert(target_path.clone()) {
        return None;
    }
    let resolved = events_by_path.get(&target_path).and_then(|target| {
        if is_reference_type(&target.value_type) {
            resolve_terminal_reference_event(target, events_by_path, active_paths)
        } else {
            Some(target.clone())
        }
    });
    active_paths.remove(&target_path);
    resolved
}

fn emit_error(ctx: &mut DiagContext, diag: ValidationDiagnostic) {
    ctx.errors.push(diag);
}

fn emit_warning(ctx: &mut DiagContext, diag: ValidationDiagnostic) {
    ctx.warnings.push(diag);
}

fn type_matches(expected: &str, actual: &str, constraints: &JsonValue) -> bool {
    if constraints
        .get("nullable")
        .and_then(JsonValue::as_bool)
        .unwrap_or(false)
        && actual == "NullLiteral"
    {
        return true;
    }
    if constraints
        .get("allow_infinity")
        .and_then(JsonValue::as_bool)
        .unwrap_or(false)
        && actual == "InfinityLiteral"
        && is_numeric_expected_type(expected)
    {
        return true;
    }
    if constraints
        .get("allow_nan")
        .and_then(JsonValue::as_bool)
        .unwrap_or(false)
        && actual == "NaNLiteral"
        && is_numeric_expected_type(expected)
    {
        return true;
    }
    match actual {
        "NumberLiteral" => matches!(
            expected,
            "NumberLiteral" | "IntegerLiteral" | "FloatLiteral"
        ),
        "ListLiteral" | "ListNode" => matches!(expected, "ListLiteral" | "ListNode"),
        _ => expected == actual,
    }
}

fn is_numeric_expected_type(expected: &str) -> bool {
    matches!(
        expected,
        "NumberLiteral" | "IntegerLiteral" | "FloatLiteral"
    )
}

fn check_attribute_lexical_constraints(
    path: &str,
    entry: &AttributeInfo,
    constraints: &JsonValue,
    ctx: &mut DiagContext,
) {
    if entry.value_type == "NullLiteral"
        && !null_value_matches(
            string_value(entry.value.as_ref())
                .as_deref()
                .unwrap_or_default(),
            constraints,
        )
    {
        emit_error(
            ctx,
            ValidationDiagnostic {
                path: Some(String::from(path)),
                code: String::from("null_value_mismatch"),
                phase: String::from("schema_validation"),
                span: entry.span,
            },
        );
    }

    if entry.value_type == "ToggleLiteral"
        && let Some(pair) = constraints.get("toggle_pair").and_then(JsonValue::as_str)
        && pair != "any"
    {
        let value = entry.raw.to_lowercase();
        let allowed = match pair {
            "yes_no" => matches!(value.as_str(), "yes" | "no"),
            "on_off" => matches!(value.as_str(), "on" | "off"),
            _ => true,
        };
        if !allowed {
            emit_error(
                ctx,
                ValidationDiagnostic {
                    path: Some(String::from(path)),
                    code: String::from("toggle_pair_mismatch"),
                    phase: String::from("schema_validation"),
                    span: entry.span,
                },
            );
        }
    }
}

fn is_reference_type(value_type: &str) -> bool {
    matches!(value_type, "CloneReference" | "PointerReference")
}

fn is_tuple_element_path(path: &str, events_by_path: &BTreeMap<String, EventInfo>) -> bool {
    let Some(index_start) = path.rfind('[') else {
        return false;
    };
    if !path.ends_with(']') {
        return false;
    }
    if path[index_start + 1..path.len() - 1]
        .parse::<usize>()
        .is_err()
    {
        return false;
    }
    let parent_path = &path[..index_start];
    events_by_path
        .get(parent_path)
        .is_some_and(|event| event.value_type == "TupleLiteral")
}

fn count_integer_digits(raw: &str) -> usize {
    raw.chars()
        .skip_while(|ch| *ch == '-' || *ch == '+')
        .take_while(|ch| *ch != '.')
        .filter(|ch| ch.is_ascii_digit())
        .count()
}

fn is_digit_form_literal(value_type: &str) -> bool {
    matches!(
        value_type,
        "NumberLiteral"
            | "IntegerLiteral"
            | "FloatLiteral"
            | "HexLiteral"
            | "RadixLiteral"
            | "SeparatorLiteral"
    )
}

fn has_digit_form_constraints(constraints: &JsonValue) -> bool {
    constraints.get("sign").is_some()
        || constraints.get("min_digits").is_some()
        || constraints.get("max_digits").is_some()
        || constraints.get("radix").is_some()
}

fn count_form_digits(value_type: &str, raw: &str) -> usize {
    if matches!(
        value_type,
        "NumberLiteral" | "IntegerLiteral" | "FloatLiteral"
    ) {
        return count_integer_digits(raw);
    }
    let body = raw
        .trim_start_matches(|ch| matches!(ch, '#' | '%' | '^'))
        .trim_start_matches(|ch| matches!(ch, '+' | '-'))
        .replace('_', "");
    body.chars()
        .filter(|ch| {
            ch.is_ascii_digit()
                || (value_type != "SeparatorLiteral"
                    && (ch.is_ascii_alphabetic() || *ch == '&' || *ch == '!'))
        })
        .count()
}

fn is_form_negative(raw: &str) -> bool {
    if raw.starts_with('-') {
        return true;
    }
    raw.chars()
        .next()
        .is_some_and(|ch| matches!(ch, '$' | '#' | '%' | '^'))
        && raw.chars().nth(1) == Some('-')
}

fn first_invalid_radix_digit(raw: &str, radix: usize) -> Option<char> {
    let body = raw
        .strip_prefix('%')
        .unwrap_or(raw)
        .trim_start_matches(|ch| matches!(ch, '+' | '-'))
        .replace('_', "");
    body.chars()
        .find(|ch| radix_digit_value(*ch).is_some_and(|digit| digit >= radix))
}

fn radix_digit_value(ch: char) -> Option<usize> {
    match ch {
        '0'..='9' => Some((ch as u8 - b'0') as usize),
        'a'..='z' => Some((ch as u8 - b'a') as usize + 10),
        'A'..='Z' => Some((ch as u8 - b'A') as usize + 10),
        '&' => Some(36),
        '!' => Some(37),
        _ => None,
    }
}

fn null_value_matches(value: &str, constraints: &JsonValue) -> bool {
    let values = expected_null_values(constraints);
    values.is_empty() || values.iter().any(|expected| expected == value)
}

fn expected_null_values(constraints: &JsonValue) -> Vec<String> {
    let mut values = Vec::new();
    if let Some(value) = constraints.get("null_value").and_then(JsonValue::as_str) {
        values.push(String::from(value));
    }
    if let Some(list) = constraints.get("null_values").and_then(JsonValue::as_array) {
        values.extend(list.iter().filter_map(JsonValue::as_str).map(String::from));
    }
    values
}

fn normalize_integer_literal(raw: &str) -> Option<String> {
    if raw.is_empty() {
        return None;
    }
    let valid = raw.chars().enumerate().all(|(idx, ch)| match ch {
        '+' | '-' => idx == 0,
        '_' => true,
        _ => ch.is_ascii_digit(),
    });
    if !valid || !raw.chars().any(|ch| ch.is_ascii_digit()) || raw.contains('.') {
        return None;
    }
    Some(raw.replace('_', ""))
}

fn datatype_base(datatype: &str) -> &str {
    let generic_idx = datatype.find('<');
    let separator_idx = datatype.find('[');
    let end_idx = [generic_idx, separator_idx]
        .into_iter()
        .flatten()
        .min()
        .unwrap_or(datatype.len());
    &datatype[..end_idx]
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

fn format_reference_target_path(segments: &[ReferencePathSegment]) -> String {
    let mut rendered = String::from("$");
    for segment in segments {
        match segment {
            ReferencePathSegment::Member(key) => {
                if is_identifier(key) {
                    rendered.push('.');
                    rendered.push_str(key);
                } else {
                    rendered.push_str(".[\"");
                    rendered.push_str(&escape_quoted_key(key));
                    rendered.push_str("\"]");
                }
            }
            ReferencePathSegment::Index(index) => {
                rendered.push('[');
                rendered.push_str(&index.to_string());
                rendered.push(']');
            }
            ReferencePathSegment::Attribute { segment_type, key } if segment_type == "attr" => {
                if is_identifier(key) {
                    rendered.push('@');
                    rendered.push_str(key);
                } else {
                    rendered.push_str("@[\"");
                    rendered.push_str(&escape_quoted_key(key));
                    rendered.push_str("\"]");
                }
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
    fn validates_radix_constraint_for_radix_literals() {
        let payload = r#"{
          "aes": [
            {
              "path": { "segments": [ { "type": "root" }, { "type": "member", "key": "bits" } ] },
              "key": "bits",
              "value": { "type": "RadixLiteral", "raw": "%1050", "value": "1050" },
              "span": [28, 33]
            }
          ],
          "schema": {
            "rules": [
              {
                "path": "$.bits",
                "constraints": { "type": "RadixLiteral", "radix": 2 }
              }
            ]
          },
          "options": {}
        }"#;
        let parsed = validate_cts_payload(payload).expect("payload should validate");
        let envelope: ResultEnvelope = serde_json::from_str(&parsed).expect("result JSON");
        assert!(!envelope.ok);
        assert!(envelope.errors.iter().any(|error| {
            error.path.as_deref() == Some("$.bits") && error.code == "numeric_form_violation"
        }));
    }

    #[test]
    fn validates_multiple_null_values() {
        let payload = r#"{
          "aes": [
            {
              "path": { "segments": [ { "type": "root" }, { "type": "member", "key": "reason" } ] },
              "key": "reason",
              "value": { "type": "NullLiteral", "raw": "!notApplicable", "value": "notApplicable" },
              "span": [0, 14]
            }
          ],
          "schema": {
            "rules": [
              {
                "path": "$.reason",
                "constraints": { "type": "StringLiteral", "nullable": true, "null_values": ["none", "notApplicable"] }
              }
            ]
          },
          "options": {}
        }"#;
        let parsed = validate_cts_payload(payload).expect("payload should validate");
        let envelope: ResultEnvelope = serde_json::from_str(&parsed).expect("result JSON");
        assert!(envelope.ok);
    }

    #[test]
    fn wildcard_rules_apply_to_indexed_children_without_requiring_placeholder() {
        let payload = r#"{
          "aes": [
            {
              "path": { "segments": [ { "type": "root" }, { "type": "member", "key": "contact" }, { "type": "member", "key": "measurements" } ] },
              "key": "measurements",
              "value": { "type": "ListNode", "elements": [] },
              "span": [1, 8]
            },
            {
              "path": { "segments": [ { "type": "root" }, { "type": "member", "key": "contact" }, { "type": "member", "key": "measurements" }, { "type": "index", "index": 0 } ] },
              "key": "0",
              "value": { "type": "NumberLiteral", "raw": "3", "value": "3" },
              "span": [2, 3]
            }
          ],
          "schema": {
            "rules": [
              {
                "path": "$.contact.measurements[*]",
                "constraints": { "required": true, "type": "NumberLiteral" }
              }
            ]
          },
          "options": {}
        }"#;
        let parsed = validate_cts_payload(payload).expect("payload should validate");
        let envelope: ResultEnvelope = serde_json::from_str(&parsed).expect("result JSON");
        assert!(envelope.ok);
        assert!(envelope.errors.is_empty());

        let failing_payload = payload.replace(
            "\"constraints\": { \"required\": true, \"type\": \"NumberLiteral\" }",
            "\"constraints\": { \"required\": true, \"type\": \"StringLiteral\" }",
        );
        let failing_parsed =
            validate_cts_payload(&failing_payload).expect("failing payload should validate");
        let failing: ResultEnvelope =
            serde_json::from_str(&failing_parsed).expect("failing result JSON");
        assert!(failing.errors.iter().any(|error| {
            error.code == "type_mismatch"
                && error.path.as_deref() == Some("$.contact.measurements[0]")
        }));
        assert!(!failing.errors.iter().any(|error| {
            error.code == "missing_required_field"
                && error.path.as_deref() == Some("$.contact.measurements[*]")
        }));
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
                annotations: BTreeMap::new(),
                value: EventValue {
                    value_type: String::from("CloneReference"),
                    raw: None,
                    value: None,
                    path: None,
                    elements: Vec::new(),
                    bindings: Vec::new(),
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
                annotations: BTreeMap::new(),
                value: EventValue {
                    value_type: String::from("PointerReference"),
                    raw: None,
                    value: None,
                    path: None,
                    elements: Vec::new(),
                    bindings: Vec::new(),
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

    #[test]
    fn reference_target_pattern_matches_canonicalized_target() {
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
                            key: Some(String::from("postcode")),
                            index: None,
                        },
                    ],
                },
                key: String::from("postcode"),
                datatype: None,
                annotations: BTreeMap::new(),
                value: EventValue {
                    value_type: String::from("CloneReference"),
                    raw: None,
                    value: None,
                    path: Some(vec![
                        ReferencePathSegment::Member(String::from("safe keys")),
                        ReferencePathSegment::Member(String::from("postcode")),
                    ]),
                    elements: Vec::new(),
                    bindings: Vec::new(),
                },
                span: Some(SpanInput::Pair([0, 12])),
            }],
            schema: Some(Schema {
                rules: vec![SchemaRule {
                    path: Some(String::from("$.postcode")),
                    constraints: json!({ "reference_target_pattern": "^\\$\\.\\[\"safe keys\"\\]\\.postcode$" }),
                }],
                datatype_rules: BTreeMap::new(),
                datatype_allowlist: Vec::new(),
                world: String::from("open"),
                reference_policy: None,
            }),
            options: ValidationOptions::default(),
        };

        let result = validate(&envelope);
        assert!(result.ok);
    }

    #[test]
    fn resolve_reference_form_checks_terminal_literal() {
        let envelope = ValidationEnvelope {
            aes: vec![
                AesEvent {
                    path: EventPath {
                        segments: vec![
                            PathSegmentInput {
                                segment_type: String::from("root"),
                                key: None,
                                index: None,
                            },
                            PathSegmentInput {
                                segment_type: String::from("member"),
                                key: Some(String::from("source")),
                                index: None,
                            },
                        ],
                    },
                    key: String::from("source"),
                    datatype: None,
                    annotations: BTreeMap::new(),
                    value: EventValue {
                        value_type: String::from("NumberLiteral"),
                        raw: Some(String::from("2000")),
                        value: Some(JsonValue::String(String::from("2000"))),
                        path: None,
                        elements: Vec::new(),
                        bindings: Vec::new(),
                    },
                    span: Some(SpanInput::Pair([0, 4])),
                },
                AesEvent {
                    path: EventPath {
                        segments: vec![
                            PathSegmentInput {
                                segment_type: String::from("root"),
                                key: None,
                                index: None,
                            },
                            PathSegmentInput {
                                segment_type: String::from("member"),
                                key: Some(String::from("postcode")),
                                index: None,
                            },
                        ],
                    },
                    key: String::from("postcode"),
                    datatype: None,
                    annotations: BTreeMap::new(),
                    value: EventValue {
                        value_type: String::from("CloneReference"),
                        raw: None,
                        value: None,
                        path: Some(vec![ReferencePathSegment::Member(String::from("source"))]),
                        elements: Vec::new(),
                        bindings: Vec::new(),
                    },
                    span: Some(SpanInput::Pair([5, 13])),
                },
            ],
            schema: Some(Schema {
                rules: vec![SchemaRule {
                    path: Some(String::from("$.postcode")),
                    constraints: json!({ "type": "IntegerLiteral", "min_value": "1000", "max_value": "9999", "resolve_reference_form": true }),
                }],
                datatype_rules: BTreeMap::new(),
                datatype_allowlist: Vec::new(),
                world: String::from("open"),
                reference_policy: None,
            }),
            options: ValidationOptions::default(),
        };

        let result = validate(&envelope);
        assert!(result.ok);
    }

    #[test]
    fn resolve_reference_form_keeps_missing_targets_core_owned() {
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
                            key: Some(String::from("postcode")),
                            index: None,
                        },
                    ],
                },
                key: String::from("postcode"),
                datatype: None,
                annotations: BTreeMap::new(),
                value: EventValue {
                    value_type: String::from("CloneReference"),
                    raw: None,
                    value: None,
                    path: Some(vec![ReferencePathSegment::Member(String::from("missing"))]),
                    elements: Vec::new(),
                    bindings: Vec::new(),
                },
                span: Some(SpanInput::Pair([0, 9])),
            }],
            schema: Some(Schema {
                rules: vec![SchemaRule {
                    path: Some(String::from("$.postcode")),
                    constraints: json!({ "type": "IntegerLiteral", "min_value": "1000", "max_value": "9999", "resolve_reference_form": true }),
                }],
                datatype_rules: BTreeMap::new(),
                datatype_allowlist: Vec::new(),
                world: String::from("open"),
                reference_policy: None,
            }),
            options: ValidationOptions::default(),
        };

        let result = validate(&envelope);
        assert!(result.ok);
    }

    #[test]
    fn accepts_indexed_node_child_paths() {
        let envelope = ValidationEnvelope {
            aes: vec![
                AesEvent {
                    path: EventPath {
                        segments: vec![
                            PathSegmentInput {
                                segment_type: String::from("root"),
                                key: None,
                                index: None,
                            },
                            PathSegmentInput {
                                segment_type: String::from("member"),
                                key: Some(String::from("page")),
                                index: None,
                            },
                        ],
                    },
                    key: String::from("page"),
                    datatype: None,
                    annotations: BTreeMap::new(),
                    value: EventValue {
                        value_type: String::from("NodeLiteral"),
                        raw: None,
                        value: None,
                        path: None,
                        elements: Vec::new(),
                        bindings: Vec::new(),
                    },
                    span: Some(SpanInput::Pair([0, 1])),
                },
                AesEvent {
                    path: EventPath {
                        segments: vec![
                            PathSegmentInput {
                                segment_type: String::from("root"),
                                key: None,
                                index: None,
                            },
                            PathSegmentInput {
                                segment_type: String::from("member"),
                                key: Some(String::from("page")),
                                index: None,
                            },
                            PathSegmentInput {
                                segment_type: String::from("index"),
                                key: None,
                                index: Some(JsonValue::from(0)),
                            },
                        ],
                    },
                    key: String::from("0"),
                    datatype: Some(String::from("int32")),
                    annotations: BTreeMap::new(),
                    value: EventValue {
                        value_type: String::from("NumberLiteral"),
                        raw: Some(String::from("3")),
                        value: Some(JsonValue::String(String::from("3"))),
                        path: None,
                        elements: Vec::new(),
                        bindings: Vec::new(),
                    },
                    span: Some(SpanInput::Pair([2, 3])),
                },
            ],
            schema: Some(Schema {
                rules: vec![
                    SchemaRule {
                        path: Some(String::from("$.page")),
                        constraints: json!({ "type": "NodeLiteral" }),
                    },
                    SchemaRule {
                        path: Some(String::from("$.page[0]")),
                        constraints: json!({ "type": "NumberLiteral" }),
                    },
                ],
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
    fn rejects_indexed_node_child_type_mismatch() {
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
                            key: Some(String::from("page")),
                            index: None,
                        },
                        PathSegmentInput {
                            segment_type: String::from("index"),
                            key: None,
                            index: Some(JsonValue::from(0)),
                        },
                    ],
                },
                key: String::from("0"),
                datatype: Some(String::from("int32")),
                annotations: BTreeMap::new(),
                value: EventValue {
                    value_type: String::from("NumberLiteral"),
                    raw: Some(String::from("3")),
                    value: Some(JsonValue::String(String::from("3"))),
                    path: None,
                    elements: Vec::new(),
                    bindings: Vec::new(),
                },
                span: Some(SpanInput::Pair([2, 3])),
            }],
            schema: Some(Schema {
                rules: vec![SchemaRule {
                    path: Some(String::from("$.page[0]")),
                    constraints: json!({ "type": "StringLiteral" }),
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
        assert_eq!(result.errors[0].code, "type_mismatch");
        assert_eq!(result.errors[0].path, Some(String::from("$.page[0]")));
    }

    #[test]
    fn requires_attribute_entries_when_declared_in_schema() {
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
                            key: Some(String::from("value")),
                            index: None,
                        },
                    ],
                },
                key: String::from("value"),
                datatype: Some(String::from("number")),
                annotations: BTreeMap::new(),
                value: EventValue {
                    value_type: String::from("NumberLiteral"),
                    raw: Some(String::from("3")),
                    value: Some(JsonValue::String(String::from("3"))),
                    path: None,
                    elements: Vec::new(),
                    bindings: Vec::new(),
                },
                span: Some(SpanInput::Pair([0, 1])),
            }],
            schema: Some(Schema {
                rules: vec![SchemaRule {
                    path: Some(String::from("$.value")),
                    constraints: json!({
                        "type": "NumberLiteral",
                        "attributes": {
                            "unit": { "required": true, "type": "StringLiteral", "datatype": "string" }
                        }
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
        assert_eq!(result.errors[0].code, "missing_required_field");
        assert_eq!(result.errors[0].path, Some(String::from("$.value@unit")));
    }

    #[test]
    fn rejects_unexpected_attribute_entries_when_closed_attributes_is_true() {
        let mut annotations = BTreeMap::new();
        annotations.insert(
            String::from("unit"),
            AttributeEntry {
                value: EventValue {
                    value_type: String::from("StringLiteral"),
                    raw: Some(String::from("\"cm\"")),
                    value: Some(JsonValue::String(String::from("cm"))),
                    path: None,
                    elements: Vec::new(),
                    bindings: Vec::new(),
                },
                datatype: Some(String::from("string")),
                annotations: BTreeMap::new(),
            },
        );
        annotations.insert(
            String::from("extra"),
            AttributeEntry {
                value: EventValue {
                    value_type: String::from("StringLiteral"),
                    raw: Some(String::from("\"x\"")),
                    value: Some(JsonValue::String(String::from("x"))),
                    path: None,
                    elements: Vec::new(),
                    bindings: Vec::new(),
                },
                datatype: Some(String::from("string")),
                annotations: BTreeMap::new(),
            },
        );

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
                            key: Some(String::from("value")),
                            index: None,
                        },
                    ],
                },
                key: String::from("value"),
                datatype: Some(String::from("number")),
                annotations,
                value: EventValue {
                    value_type: String::from("NumberLiteral"),
                    raw: Some(String::from("3")),
                    value: Some(JsonValue::String(String::from("3"))),
                    path: None,
                    elements: Vec::new(),
                    bindings: Vec::new(),
                },
                span: Some(SpanInput::Pair([0, 1])),
            }],
            schema: Some(Schema {
                rules: vec![SchemaRule {
                    path: Some(String::from("$.value")),
                    constraints: json!({
                        "attributes": {
                            "unit": { "type": "StringLiteral" }
                        },
                        "closed_attributes": true
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
        assert!(
            result
                .errors
                .iter()
                .any(|error| error.code == "unexpected_attribute_entry"
                    && error.path.as_deref() == Some("$.value@extra"))
        );
    }

    #[test]
    fn applies_datatype_rules_to_attribute_entries_automatically() {
        let mut annotations = BTreeMap::new();
        annotations.insert(
            String::from("unit"),
            AttributeEntry {
                value: EventValue {
                    value_type: String::from("NumberLiteral"),
                    raw: Some(String::from("-7")),
                    value: Some(JsonValue::String(String::from("-7"))),
                    path: None,
                    elements: Vec::new(),
                    bindings: Vec::new(),
                },
                datatype: Some(String::from("uint")),
                annotations: BTreeMap::new(),
            },
        );

        let mut datatype_rules = BTreeMap::new();
        datatype_rules.insert(
            String::from("uint"),
            json!({ "type": "NumberLiteral", "sign": "unsigned" }),
        );

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
                            key: Some(String::from("value")),
                            index: None,
                        },
                    ],
                },
                key: String::from("value"),
                datatype: Some(String::from("number")),
                annotations,
                value: EventValue {
                    value_type: String::from("NumberLiteral"),
                    raw: Some(String::from("3")),
                    value: Some(JsonValue::String(String::from("3"))),
                    path: None,
                    elements: Vec::new(),
                    bindings: Vec::new(),
                },
                span: Some(SpanInput::Pair([0, 1])),
            }],
            schema: Some(Schema {
                rules: vec![SchemaRule {
                    path: Some(String::from("$.value")),
                    constraints: json!({
                        "attributes": {
                            "unit": {}
                        }
                    }),
                }],
                datatype_rules,
                datatype_allowlist: Vec::new(),
                world: String::from("open"),
                reference_policy: None,
            }),
            options: ValidationOptions::default(),
        };

        let result = validate(&envelope);
        assert!(!result.ok);
        assert!(
            result
                .errors
                .iter()
                .any(|error| error.code == "numeric_form_violation"
                    && error.path.as_deref() == Some("$.value@unit"))
        );
    }

    #[test]
    fn validates_literal_widening_and_cardinality_constraints() {
        let payload = r#"{
          "aes": [
            {
              "path": { "segments": [ { "type": "root" }, { "type": "member", "key": "app" } ] },
              "key": "app",
              "value": {
                "type": "ObjectNode",
                "bindings": [
                  { "type": "Binding", "key": "a", "value": { "type": "StringLiteral", "raw": "\"a\"", "value": "a" } },
                  { "type": "Binding", "key": "b", "value": { "type": "StringLiteral", "raw": "\"b\"", "value": "b" } }
                ]
              },
              "span": [0, 13]
            },
            {
              "path": { "segments": [ { "type": "root" }, { "type": "member", "key": "name" } ] },
              "key": "name",
              "value": { "type": "NullLiteral", "raw": "!notApplicable", "value": "notApplicable" },
              "span": [14, 28]
            },
            {
              "path": { "segments": [ { "type": "root" }, { "type": "member", "key": "visible" } ] },
              "key": "visible",
              "value": { "type": "ToggleLiteral", "raw": "on", "value": "on" },
              "span": [29, 31]
            },
            {
              "path": { "segments": [ { "type": "root" }, { "type": "member", "key": "score" } ] },
              "key": "score",
              "value": { "type": "InfinityLiteral", "raw": "Infinity", "value": "Infinity" },
              "span": [32, 40]
            }
          ],
          "schema": {
            "rules": [
              { "path": "$.app", "constraints": { "type": "ObjectNode", "max_children": 1 } },
              { "path": "$.name", "constraints": { "type": "StringLiteral", "nullable": true, "null_value": "none" } },
              { "path": "$.visible", "constraints": { "type": "ToggleLiteral", "toggle_pair": "yes_no" } },
              { "path": "$.score", "constraints": { "type": "NumberLiteral", "allow_infinity": true } }
            ]
          },
          "options": {}
        }"#;

        let parsed = validate_cts_payload(payload).expect("payload should validate");
        let result: ResultEnvelope = serde_json::from_str(&parsed).expect("result JSON");
        assert!(!result.ok);
        let codes = result
            .errors
            .iter()
            .map(|error| error.code.as_str())
            .collect::<Vec<_>>();
        assert_eq!(
            codes,
            vec![
                "container_cardinality_mismatch",
                "null_value_mismatch",
                "toggle_pair_mismatch",
            ]
        );
    }
}
