use std::collections::{BTreeMap, BTreeSet};

use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;

use aeon_core::{
    SansaResolveBinding, SansaResolveNamespace, SansaResolveOptions, SansaSelector,
    parse_sansa_address, resolve_sansa_address,
};

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
    #[serde(default)]
    pub resource_policy: Option<JsonValue>,
}

fn default_mode() -> String {
    String::from("v1")
}

fn default_trailing_separator_policy() -> String {
    String::from("off")
}

const MAX_SCHEMA_REGEX_LENGTH: usize = 512;
const PORTABLE_REGEX_ESCAPES: &[char] = &[
    '0', 'b', 'B', 'd', 'D', 'f', 'n', 'r', 's', 'S', 't', 'v', 'w', 'W', '\\', '^', '$', '.', '|',
    '?', '*', '+', '(', ')', '[', ']', '{', '}', '-',
];

fn is_regex_quantifier_start(chars: &[char], index: usize) -> bool {
    matches!(chars.get(index), Some('*' | '+' | '{'))
}

fn has_nested_quantified_group(pattern: &str) -> bool {
    let chars: Vec<char> = pattern.chars().collect();
    let mut stack: Vec<bool> = Vec::new();
    let mut escaped = false;
    let mut in_class = false;

    for (index, char) in chars.iter().enumerate() {
        if escaped {
            escaped = false;
            continue;
        }
        if *char == '\\' {
            escaped = true;
            continue;
        }
        if *char == '[' {
            in_class = true;
            continue;
        }
        if *char == ']' && in_class {
            in_class = false;
            continue;
        }
        if in_class {
            continue;
        }
        if *char == '(' {
            stack.push(false);
            continue;
        }
        if *char == ')' {
            let Some(has_inner_quantifier) = stack.pop() else {
                continue;
            };
            if has_inner_quantifier && is_regex_quantifier_start(&chars, index + 1) {
                return true;
            }
            if is_regex_quantifier_start(&chars, index + 1)
                && let Some(parent) = stack.last_mut()
            {
                *parent = true;
            }
            continue;
        }
        if is_regex_quantifier_start(&chars, index)
            && let Some(current) = stack.last_mut()
        {
            *current = true;
        }
    }

    false
}

fn portable_pattern_problem(pattern: &str) -> Option<&'static str> {
    if pattern.len() > MAX_SCHEMA_REGEX_LENGTH {
        return Some("regex exceeds maximum length");
    }

    let chars: Vec<char> = pattern.chars().collect();
    let mut stack: Vec<char> = Vec::new();
    let mut escaped = false;
    let mut in_class = false;
    for (index, char) in chars.iter().enumerate() {
        if escaped {
            if char.is_ascii_digit() && *char != '0' {
                return Some("backreferences are not part of the AEOS portable pattern profile");
            }
            if matches!(*char, 'p' | 'P') && matches!(chars.get(index + 1), Some('{')) {
                return Some(
                    "Unicode property escapes are not part of the AEOS portable pattern profile",
                );
            }
            if *char == 'k' && matches!(chars.get(index + 1), Some('<')) {
                return Some(
                    "named backreferences are not part of the AEOS portable pattern profile",
                );
            }
            if char.is_ascii_alphanumeric() && !PORTABLE_REGEX_ESCAPES.contains(char) {
                return Some("unsupported escape sequence");
            }
            escaped = false;
            continue;
        }
        if *char == '\\' {
            escaped = true;
            continue;
        }
        if in_class {
            if *char == ']' {
                in_class = false;
            }
            continue;
        }
        if *char == '[' {
            in_class = true;
            continue;
        }
        if *char == '(' {
            if matches!(chars.get(index + 1), Some('?')) {
                if !matches!(chars.get(index + 2), Some(':')) {
                    return Some(
                        "lookaround, named groups, and inline regex flags are not part of the AEOS portable pattern profile",
                    );
                }
            }
            stack.push('(');
            continue;
        }
        if *char == ')' && stack.pop().is_none() {
            return Some("unmatched closing group");
        }
    }

    if escaped {
        return Some("trailing escape");
    }
    if in_class {
        return Some("unterminated character class");
    }
    if !stack.is_empty() {
        return Some("unterminated group");
    }
    if has_nested_quantified_group(pattern) {
        return Some("regex contains a nested quantified group");
    }
    if Regex::new(pattern).is_err() {
        return Some("regex is not valid portable syntax");
    }
    None
}

fn matches_portable_pattern(pattern: &str, value: &str) -> bool {
    if portable_pattern_problem(pattern).is_some() {
        return false;
    }
    let anchored = format!(
        "{}{}{}",
        if pattern.starts_with('^') { "" } else { "^" },
        pattern,
        if pattern.ends_with('$') { "" } else { "$" },
    );
    Regex::new(&anchored).is_ok_and(|regex| regex.is_match(value))
}

#[derive(Debug, Clone)]
struct ResourcePolicy {
    max_events: usize,
    max_rules: usize,
    max_any_of_cases: usize,
    max_schema_depth: usize,
    max_path_length: usize,
    max_reference_resolution_steps: usize,
    max_selector_expansions: usize,
    max_string_length_default: usize,
    max_container_children_default: usize,
}

impl Default for ResourcePolicy {
    fn default() -> Self {
        Self {
            max_events: 100_000,
            max_rules: 10_000,
            max_any_of_cases: 64,
            max_schema_depth: 64,
            max_path_length: 4_096,
            max_reference_resolution_steps: 64,
            max_selector_expansions: 100_000,
            max_string_length_default: 10_000_000,
            max_container_children_default: 1_000_000,
        }
    }
}

fn resolve_resource_policy(
    schema_policy: Option<&JsonValue>,
    option_policy: Option<&JsonValue>,
    ctx: &mut DiagContext,
) -> ResourcePolicy {
    let mut policy = ResourcePolicy::default();
    normalize_resource_policy(&mut policy, schema_policy, "schema", ctx);
    normalize_resource_policy(&mut policy, option_policy, "option", ctx);
    policy
}

fn normalize_resource_policy(
    policy: &mut ResourcePolicy,
    input: Option<&JsonValue>,
    source: &str,
    ctx: &mut DiagContext,
) {
    let Some(input) = input else {
        return;
    };
    let Some(map) = input.as_object() else {
        emit_resource_error(
            ctx,
            "$",
            format!("{source} resource policy must be an object"),
            None,
        );
        return;
    };
    for (key, value) in map {
        let Some(number) = value.as_u64() else {
            emit_resource_error(
                ctx,
                "$",
                format!("{source} resource policy {key} must be a non-negative integer"),
                None,
            );
            continue;
        };
        let Ok(number) = usize::try_from(number) else {
            emit_resource_error(
                ctx,
                "$",
                format!("{source} resource policy {key} exceeds platform limits"),
                None,
            );
            continue;
        };
        match key.as_str() {
            "max_events" => policy.max_events = number,
            "max_rules" => policy.max_rules = number,
            "max_any_of_cases" => policy.max_any_of_cases = number,
            "max_schema_depth" => policy.max_schema_depth = number,
            "max_path_length" => policy.max_path_length = number,
            "max_reference_resolution_steps" => policy.max_reference_resolution_steps = number,
            "max_selector_expansions" => policy.max_selector_expansions = number,
            "max_string_length_default" => policy.max_string_length_default = number,
            "max_container_children_default" => policy.max_container_children_default = number,
            _ => emit_resource_error(
                ctx,
                "$",
                format!("Unknown {source} resource policy key: {key}"),
                None,
            ),
        }
    }
}

fn emit_resource_error(
    ctx: &mut DiagContext,
    path: &str,
    message: String,
    span: Option<[usize; 2]>,
) {
    emit_error(
        ctx,
        ValidationDiagnostic {
            path: Some(String::from(path)),
            code: String::from("invalid_schema_policy"),
            phase: String::from("schema_validation"),
            span,
        },
    );
    let _ = message;
}

fn is_string_like_value_type(value_type: &str) -> bool {
    matches!(
        value_type,
        "StringLiteral"
            | "TrimtickLiteral"
            | "SeparatorLiteral"
            | "HexLiteral"
            | "EncodingLiteral"
            | "NullLiteral"
            | "DateLiteral"
            | "TimeLiteral"
            | "DateTimeLiteral"
            | "WTCDateTimeLiteral"
    )
}

fn string_like_payload_len(
    value_type: &str,
    raw: &str,
    value: Option<&JsonValue>,
) -> Option<usize> {
    if !is_string_like_value_type(value_type) {
        return None;
    }
    string_value(value)
        .filter(|inner| !inner.is_empty())
        .map(|inner| inner.chars().count())
        .or_else(|| Some(raw.chars().count()))
}

fn enforce_string_length_resource_budget(
    info: &EventInfo,
    path: &str,
    policy: &ResourcePolicy,
    ctx: &mut DiagContext,
) {
    enforce_string_length_resource_budget_inner(
        &info.value_type,
        &info.raw,
        info.value.as_ref(),
        info.span,
        &info.attributes,
        path,
        policy,
        ctx,
    );
}

fn enforce_attribute_string_length_resource_budget(
    info: &AttributeInfo,
    path: &str,
    policy: &ResourcePolicy,
    ctx: &mut DiagContext,
) {
    enforce_string_length_resource_budget_inner(
        &info.value_type,
        &info.raw,
        info.value.as_ref(),
        info.span,
        &info.attributes,
        path,
        policy,
        ctx,
    );
}

fn enforce_string_length_resource_budget_inner(
    value_type: &str,
    raw: &str,
    value: Option<&JsonValue>,
    span: Option<[usize; 2]>,
    attributes: &BTreeMap<String, AttributeInfo>,
    path: &str,
    policy: &ResourcePolicy,
    ctx: &mut DiagContext,
) {
    if let Some(payload_len) = string_like_payload_len(value_type, raw, value) {
        if payload_len > policy.max_string_length_default {
            emit_resource_error(
                ctx,
                path,
                format!(
                    "String-like payload length {payload_len} exceeds max_string_length_default {}",
                    policy.max_string_length_default
                ),
                span,
            );
        }
    }
    for (key, attribute) in attributes {
        enforce_attribute_string_length_resource_budget(
            attribute,
            &format_attribute_path(path, key),
            policy,
            ctx,
        );
    }
}

fn inspect_schema_resource_shape(schema: &Schema, policy: &ResourcePolicy, ctx: &mut DiagContext) {
    for rule in &schema.rules {
        let rule_path = rule
            .path
            .as_ref()
            .filter(|path| !path.is_empty())
            .or_else(|| {
                rule.selector
                    .as_ref()
                    .filter(|selector| !selector.is_empty())
            })
            .map_or("$", String::as_str);
        if rule_path.len() > policy.max_path_length {
            emit_resource_error(
                ctx,
                rule_path,
                format!(
                    "Rule path length {} exceeds max_path_length {}",
                    rule_path.len(),
                    policy.max_path_length
                ),
                None,
            );
        }
        inspect_constraint_resource_shape(&rule.constraints, rule_path, 1, policy, ctx);
    }
    for (datatype, constraints) in &schema.datatype_rules {
        inspect_constraint_resource_shape(
            constraints,
            &format!("datatype_rules.{datatype}"),
            1,
            policy,
            ctx,
        );
    }
}

fn inspect_constraint_resource_shape(
    constraints: &JsonValue,
    path: &str,
    depth: usize,
    policy: &ResourcePolicy,
    ctx: &mut DiagContext,
) {
    if depth > policy.max_schema_depth {
        emit_resource_error(
            ctx,
            path,
            format!(
                "Schema constraint depth exceeds max_schema_depth {}",
                policy.max_schema_depth
            ),
            None,
        );
        return;
    }
    let Some(map) = constraints.as_object() else {
        return;
    };
    if let Some(any_of) = map.get("any_of").and_then(JsonValue::as_array) {
        if any_of.len() > policy.max_any_of_cases {
            emit_resource_error(
                ctx,
                path,
                format!(
                    "any_of case count {} exceeds max_any_of_cases {}",
                    any_of.len(),
                    policy.max_any_of_cases
                ),
                None,
            );
        }
        for (index, branch) in any_of.iter().enumerate() {
            inspect_constraint_resource_shape(
                branch,
                &format!("{path}.any_of[{index}]"),
                depth + 1,
                policy,
                ctx,
            );
        }
    }
    if let Some(attributes) = map.get("attributes").and_then(JsonValue::as_object) {
        for (key, child) in attributes {
            inspect_constraint_resource_shape(
                child,
                &format_attribute_path(path, key),
                depth + 1,
                policy,
                ctx,
            );
        }
    }
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
    #[serde(default)]
    pub resource_policy: Option<JsonValue>,
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
    #[serde(default, rename = "structuralId")]
    pub structural_id: Option<String>,
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
    "allow_unspecified_radix",
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
    let resource_policy = resolve_resource_policy(
        schema.and_then(|schema| schema.resource_policy.as_ref()),
        options.resource_policy.as_ref(),
        &mut ctx,
    );
    if !ctx.errors.is_empty() {
        return finalize_result(ctx, &BTreeSet::new(), &BTreeMap::new());
    }
    if aes.len() > resource_policy.max_events {
        emit_resource_error(
            &mut ctx,
            "$",
            format!(
                "AES event count {} exceeds max_events {}",
                aes.len(),
                resource_policy.max_events
            ),
            None,
        );
    }
    if let Some(schema) = schema {
        if schema.rules.len() > resource_policy.max_rules {
            emit_resource_error(
                &mut ctx,
                "$",
                format!(
                    "Schema rule count {} exceeds max_rules {}",
                    schema.rules.len(),
                    resource_policy.max_rules
                ),
                None,
            );
        }
        inspect_schema_resource_shape(schema, &resource_policy, &mut ctx);
        if !ctx.errors.is_empty() {
            return finalize_result(ctx, &BTreeSet::new(), &BTreeMap::new());
        }
    }

    let mut seen = BTreeSet::new();
    let mut bound_paths = BTreeSet::new();
    let mut events_by_path = BTreeMap::<String, EventInfo>::new();
    let mut container_arity = BTreeMap::<String, usize>::new();

    for event in aes {
        let path = format_canonical_path(&event.path);
        if path.len() > resource_policy.max_path_length {
            emit_resource_error(
                &mut ctx,
                &path,
                format!(
                    "Path length {} exceeds max_path_length {}",
                    path.len(),
                    resource_policy.max_path_length
                ),
                event.span_pair(),
            );
        }
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
        let info = EventInfo {
            value_type: event.value.value_type.clone(),
            datatype: event.datatype.clone(),
            raw: event.value.raw.clone().unwrap_or_default(),
            value: event.value.value.clone(),
            span: event.span_pair(),
            attributes: build_attribute_info_map(&event.annotations),
            reference_path: event.value.path.clone(),
        };
        events_by_path.insert(path.clone(), info.clone());
        hydrate_attribute_info_events(&path, &info.attributes, &mut events_by_path);

        if matches!(
            event.value.value_type.as_str(),
            "TupleLiteral" | "ListLiteral" | "ListNode"
        ) {
            container_arity.insert(path.clone(), event.value.elements.len());
            if event.value.elements.len() > resource_policy.max_container_children_default {
                emit_resource_error(
                    &mut ctx,
                    &path,
                    format!(
                        "Container child count {} exceeds max_container_children_default {}",
                        event.value.elements.len(),
                        resource_policy.max_container_children_default
                    ),
                    event.span_pair(),
                );
            }
            hydrate_indexed_fallback(
                &path,
                &event.value.elements,
                event.span_pair(),
                &mut events_by_path,
            );
        } else if event.value.value_type == "ObjectNode" {
            container_arity.insert(path.clone(), event.value.bindings.len());
            if event.value.bindings.len() > resource_policy.max_container_children_default {
                emit_resource_error(
                    &mut ctx,
                    &path,
                    format!(
                        "Container child count {} exceeds max_container_children_default {}",
                        event.value.bindings.len(),
                        resource_policy.max_container_children_default
                    ),
                    event.span_pair(),
                );
            }
        } else if event.value.value_type == "NodeLiteral" {
            container_arity.insert(path.clone(), event.value.elements.len());
            if event.value.elements.len() > resource_policy.max_container_children_default {
                emit_resource_error(
                    &mut ctx,
                    &path,
                    format!(
                        "Container child count {} exceeds max_container_children_default {}",
                        event.value.elements.len(),
                        resource_policy.max_container_children_default
                    ),
                    event.span_pair(),
                );
            }
            hydrate_indexed_fallback(
                &path,
                &event.value.elements,
                event.span_pair(),
                &mut events_by_path,
            );
        }
    }
    bound_paths.extend(events_by_path.keys().cloned());
    for (path, info) in &events_by_path {
        enforce_string_length_resource_budget(info, path, &resource_policy, &mut ctx);
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
    let mut expansion_budget = 0usize;
    let expanded_rule_index = expand_selector_rules(
        &rule_index,
        schema,
        &events_by_path,
        &mut ctx,
        &resource_policy,
        &mut expansion_budget,
    );
    let effective_rule_index = merge_datatype_rules(
        &expanded_rule_index,
        &schema.datatype_rules,
        &events_by_path,
    );
    check_presence(&effective_rule_index, &bound_paths, &mut ctx);
    check_reference_forms(schema, &effective_rule_index, &events_by_path, &mut ctx);
    let effective_events_by_path = resolve_reference_form_events(
        &effective_rule_index,
        &events_by_path,
        &resource_policy,
        &mut ctx,
    );
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
    check_world_policy(schema, aes, &bound_paths, &events_by_path, &mut ctx);

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
        if let Some(path) = path
            && path.contains("[*]")
        {
            emit_error(
                ctx,
                ValidationDiagnostic {
                    path: Some(path.clone()),
                    code: String::from("invalid_schema_policy"),
                    phase: String::from("schema_validation"),
                    span: None,
                },
            );
            continue;
        }
        if let Some(selector) = selector
            && selector.contains("[*]")
        {
            emit_error(
                ctx,
                ValidationDiagnostic {
                    path: Some(selector.clone()),
                    code: String::from("invalid_schema_policy"),
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

    for key in [
        "required",
        "nullable",
        "allow_infinity",
        "allow_nan",
        "closed_attributes",
        "allow_unspecified_radix",
    ] {
        if constraints
            .get(key)
            .is_some_and(|value| !value.is_boolean())
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
    }

    for key in ["type", "null_value", "sign", "datatype"] {
        if constraints.get(key).is_some_and(|value| !value.is_string()) {
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
    }

    if let Some(sign) = constraints.get("sign").and_then(JsonValue::as_str)
        && !matches!(sign, "signed" | "unsigned")
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

    for key in [
        "min_children",
        "max_children",
        "length_exact",
        "radix",
        "min_digits",
        "max_digits",
        "min_length",
        "max_length",
    ] {
        if constraints
            .get(key)
            .is_some_and(|value| value.as_u64().is_none())
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
    }

    for key in ["min_value", "max_value"] {
        if constraints.get(key).is_some_and(|value| !value.is_string()) {
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
    }

    if !validate_reference_constraints(schema, path, constraints, ctx) {
        return false;
    }

    if let Some(pattern) = constraints.get("pattern") {
        let Some(pattern) = pattern.as_str() else {
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
        if portable_pattern_problem(pattern).is_some() {
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
    }

    if constraints
        .get("allow_unspecified_radix")
        .is_some_and(|value| !value.is_boolean())
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
                    path: Some(format_attribute_path(path, key)),
                    code: String::from("unknown_constraint_key"),
                    phase: String::from("schema_validation"),
                    span: None,
                },
            );
            return false;
        };
        if !validate_constraint_tree(
            schema,
            &format_attribute_path(path, key),
            child_constraints,
            ctx,
        ) {
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
        if portable_pattern_problem(pattern).is_some() || reference == Some("forbid") {
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
        let Some(JsonValue::Object(datatype_constraints)) =
            datatype_rules.get(&datatype_base(datatype).to_lowercase())
        else {
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

        if let Some(expected_datatype) = constraints.get("datatype").and_then(JsonValue::as_str)
            && event.datatype.as_deref() != Some(expected_datatype)
        {
            emit_error(
                ctx,
                ValidationDiagnostic {
                    path: Some(path.clone()),
                    code: String::from("type_mismatch"),
                    phase: String::from("schema_validation"),
                    span: event.span,
                },
            );
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
                !matches_portable_pattern(pattern, &format_reference_target_path(segments))
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
        {
            let declared_radix = declared_radix_from_datatype(event.datatype.as_deref());
            if (declared_radix.is_none()
                && constraints
                    .get("allow_unspecified_radix")
                    .and_then(JsonValue::as_bool)
                    != Some(true))
                || declared_radix.is_some_and(|declared| declared != radix as usize)
                || first_invalid_radix_digit(&event.raw, radix as usize).is_some()
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
        if !is_string_like_literal(&event.value_type) {
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
        if !is_string_like_literal(&event.value_type) {
            continue;
        }
        let Some(value) = string_value(event.value.as_ref()) else {
            continue;
        };
        if !matches_portable_pattern(pattern, &value) {
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
            let child_path = format_attribute_path(base_path, key);
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
                    path: Some(format_attribute_path(base_path, key)),
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
        {
            let declared_radix = declared_radix_from_datatype(entry.datatype.as_deref());
            if (declared_radix.is_none()
                && effective_constraints
                    .get("allow_unspecified_radix")
                    .and_then(JsonValue::as_bool)
                    != Some(true))
                || declared_radix.is_some_and(|declared| declared != radix as usize)
                || first_invalid_radix_digit(&entry.raw, radix as usize).is_some()
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

    if is_string_like_literal(&entry.value_type) {
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
            && !matches_portable_pattern(pattern, &value)
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
    events_by_path: &BTreeMap<String, EventInfo>,
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
    let mut selector_matches = BTreeMap::<String, Option<BTreeSet<String>>>::new();
    for (kind, selector) in &allowed_rules {
        if *kind == "selector" && !selector_matches.contains_key(*selector) {
            selector_matches.insert(
                (*selector).to_string(),
                resolve_sansa_selector_path_set(selector, events_by_path, ctx),
            );
        }
    }
    for event in aes {
        if event.key.starts_with("aeon:") {
            continue;
        }
        let path = format_canonical_path(&event.path);
        if !bound_paths.contains(&path)
            || allowed_rules.iter().any(|(kind, allowed_path)| {
                if *kind == "selector" {
                    selector_matches
                        .get(*allowed_path)
                        .and_then(Option::as_ref)
                        .is_some_and(|paths| paths.contains(&path))
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

fn hydrate_attribute_info_events(
    base_path: &str,
    attributes: &BTreeMap<String, AttributeInfo>,
    events_by_path: &mut BTreeMap<String, EventInfo>,
) {
    for (key, entry) in attributes {
        let attribute_path = format_attribute_path(base_path, key);
        events_by_path.insert(
            attribute_path.clone(),
            EventInfo {
                value_type: entry.value_type.clone(),
                datatype: entry.datatype.clone(),
                raw: entry.raw.clone(),
                value: entry.value.clone(),
                span: entry.span,
                attributes: entry.attributes.clone(),
                reference_path: None,
            },
        );
        hydrate_attribute_info_events(&attribute_path, &entry.attributes, events_by_path);
    }
}

fn resolve_reference_form_events(
    rule_index: &BTreeMap<String, JsonValue>,
    events_by_path: &BTreeMap<String, EventInfo>,
    resource_policy: &ResourcePolicy,
    ctx: &mut DiagContext,
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
        let mut exhausted = false;
        let Some(terminal) = resolve_terminal_reference_event(
            event,
            events_by_path,
            &mut BTreeSet::new(),
            resource_policy.max_reference_resolution_steps,
            &mut exhausted,
        ) else {
            if exhausted {
                emit_resource_error(
                    ctx,
                    path,
                    format!(
                        "Reference resolution exceeded max_reference_resolution_steps {}",
                        resource_policy.max_reference_resolution_steps
                    ),
                    event.span,
                );
            }
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
    resource_policy: &ResourcePolicy,
    expansion_budget: &mut usize,
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
        let Some(resolved_paths) = resolve_sansa_selector_path_set(selector, events_by_path, ctx)
        else {
            continue;
        };
        let mut matched = false;
        for actual_path in resolved_paths {
            matched = true;
            *expansion_budget += 1;
            if *expansion_budget > resource_policy.max_selector_expansions {
                emit_resource_error(
                    ctx,
                    selector,
                    format!(
                        "Selector expansion count exceeds max_selector_expansions {}",
                        resource_policy.max_selector_expansions
                    ),
                    None,
                );
                return expanded;
            }
            expanded
                .entry(actual_path)
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
    if is_string_like_literal(&event.value_type) {
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
            && !matches_portable_pattern(pattern, value)
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
        {
            let declared_radix = declared_radix_from_datatype(event.datatype.as_deref());
            if (declared_radix.is_none()
                && constraints
                    .get("allow_unspecified_radix")
                    .and_then(JsonValue::as_bool)
                    != Some(true))
                || declared_radix.is_some_and(|declared| declared != radix as usize)
                || first_invalid_radix_digit(&event.raw, radix as usize).is_some()
            {
                return false;
            }
        }
    }
    true
}

fn matches_allowed_path(actual_path: &str, allowed_path: &str) -> bool {
    actual_path == allowed_path
}

fn resolve_sansa_selector_path_set(
    selector: &str,
    events_by_path: &BTreeMap<String, EventInfo>,
    ctx: &mut DiagContext,
) -> Option<BTreeSet<String>> {
    let namespace = create_aeos_sansa_resolve_namespace(events_by_path);
    let result = resolve_sansa_address(selector, &namespace, &SansaResolveOptions::default());
    if !result.ok {
        emit_error(
            ctx,
            ValidationDiagnostic {
                path: Some(selector.to_string()),
                code: String::from("invalid_schema_policy"),
                phase: String::from("schema_validation"),
                span: None,
            },
        );
        return None;
    }
    Some(
        result
            .bindings
            .into_iter()
            .filter_map(|binding| binding.address)
            .filter(|path| events_by_path.contains_key(path))
            .collect(),
    )
}

fn create_aeos_sansa_resolve_namespace(
    events_by_path: &BTreeMap<String, EventInfo>,
) -> SansaResolveNamespace {
    let mut namespace = SansaResolveNamespace::new(build_aeos_sansa_resolve_tree(events_by_path));
    namespace.supports_attribute_space = true;
    namespace.supports_local_space = false;
    namespace
}

fn build_aeos_sansa_resolve_tree(
    events_by_path: &BTreeMap<String, EventInfo>,
) -> SansaResolveBinding {
    let mut root = SansaResolveBinding {
        address: Some(String::from("$")),
        children: Vec::new(),
        ..SansaResolveBinding::default()
    };
    let mut entries = events_by_path.iter().collect::<Vec<_>>();
    entries.sort_by_key(|(path, _)| path.len());
    for (path, info) in entries {
        insert_aeos_sansa_resolve_path(&mut root, path, info);
    }
    root
}

fn insert_aeos_sansa_resolve_path(root: &mut SansaResolveBinding, path: &str, info: &EventInfo) {
    let Ok(address) = parse_sansa_address(path) else {
        return;
    };
    let mut current = root;
    let mut current_path = String::from("$");
    for selector in address.selectors {
        match selector {
            SansaSelector::Member { name, .. } => {
                current_path.push_str(&format_member_selector(&name));
                current = get_or_create_sansa_child_binding(
                    current,
                    current_path.clone(),
                    Some(name),
                    None,
                );
            }
            SansaSelector::Position { index } => {
                current_path.push('[');
                current_path.push_str(&index.to_string());
                current_path.push(']');
                current = get_or_create_sansa_child_binding(
                    current,
                    current_path.clone(),
                    None,
                    Some(index),
                );
            }
            SansaSelector::AttributeSpace => {
                current_path.push_str(".@");
                current = get_or_create_sansa_attribute_space(current, current_path.clone());
            }
            _ => return,
        }
    }
    current.semantic_type = info.datatype.clone();
    current.datatype = info.datatype.clone();
    current.representation_kind = Some(info.value_type.clone());
    current.kind = Some(info.value_type.clone());
    current.value_type = Some(info.value_type.clone());
}

fn get_or_create_sansa_child_binding(
    parent: &mut SansaResolveBinding,
    path: String,
    name: Option<String>,
    index: Option<usize>,
) -> &mut SansaResolveBinding {
    if let Some(existing_index) = parent.children.iter().position(|child| {
        if let Some(name) = name.as_deref() {
            child.name.as_deref() == Some(name)
        } else {
            child.index == index
        }
    }) {
        return &mut parent.children[existing_index];
    }
    parent.children.push(SansaResolveBinding {
        address: Some(path),
        name,
        index,
        children: Vec::new(),
        ..SansaResolveBinding::default()
    });
    parent.children.last_mut().expect("inserted child")
}

fn get_or_create_sansa_attribute_space(
    parent: &mut SansaResolveBinding,
    path: String,
) -> &mut SansaResolveBinding {
    if parent.attribute_space.is_none() {
        parent.attribute_space = Some(Box::new(SansaResolveBinding {
            address: Some(path),
            children: Vec::new(),
            ..SansaResolveBinding::default()
        }));
    }
    parent
        .attribute_space
        .as_deref_mut()
        .expect("attribute space exists")
}

fn format_member_selector(name: &str) -> String {
    if is_identifier(name) {
        format!(".{name}")
    } else {
        format!(".[\"{}\"]", escape_quoted_key(name))
    }
}

fn resolve_terminal_reference_event(
    event: &EventInfo,
    events_by_path: &BTreeMap<String, EventInfo>,
    active_paths: &mut BTreeSet<String>,
    remaining_steps: usize,
    exhausted: &mut bool,
) -> Option<EventInfo> {
    if remaining_steps == 0 {
        *exhausted = true;
        return None;
    }
    if !is_reference_type(&event.value_type) {
        return Some(event.clone());
    }
    let target_path = format_reference_target_path(event.reference_path.as_ref()?);
    if !active_paths.insert(target_path.clone()) {
        return None;
    }
    let resolved = events_by_path.get(&target_path).and_then(|target| {
        if is_reference_type(&target.value_type) {
            resolve_terminal_reference_event(
                target,
                events_by_path,
                active_paths,
                remaining_steps - 1,
                exhausted,
            )
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
        "NumberLiteral" | "IntegerLiteral" | "FloatLiteral" | "HexLiteral" | "RadixLiteral"
    )
}

fn is_string_like_literal(value_type: &str) -> bool {
    matches!(
        value_type,
        "StringLiteral"
            | "TrimtickLiteral"
            | "TrimtickStringLiteral"
            | "SeparatorLiteral"
            | "NullLiteral"
            | "EncodingLiteral"
            | "DateLiteral"
            | "TimeLiteral"
            | "DateTimeLiteral"
            | "WTCDateTimeLiteral"
    )
}

fn declared_radix_from_datatype(datatype: Option<&str>) -> Option<usize> {
    let datatype = datatype?.trim().to_ascii_lowercase();
    if datatype == "decimal" {
        return Some(10);
    }
    if let Some(inner) = datatype
        .strip_prefix("radix[")
        .and_then(|rest| rest.strip_suffix(']'))
    {
        let base = inner.parse::<usize>().ok()?;
        return (2..=64).contains(&base).then_some(base);
    }
    match datatype.as_str() {
        "radix2" => Some(2),
        "radix6" => Some(6),
        "radix8" => Some(8),
        "radix12" => Some(12),
        _ => None,
    }
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
        .filter(|ch| ch.is_ascii_digit() || ch.is_ascii_alphabetic() || *ch == '&' || *ch == '!')
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
    if datatype_base(datatype) != "sep" {
        return Vec::new();
    }
    let Some(inner) = datatype
        .trim()
        .strip_prefix("sep[")
        .and_then(|rest| rest.strip_suffix(']'))
    else {
        return Vec::new();
    };
    let Ok(values) = serde_json::from_str::<Vec<JsonValue>>(&format!("[{inner}]")) else {
        return Vec::new();
    };
    values
        .iter()
        .filter_map(JsonValue::as_str)
        .filter(|value| value.chars().count() == 1)
        .flat_map(str::chars)
        .collect()
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
                    rendered.push_str(".@.");
                    rendered.push_str(key);
                } else {
                    rendered.push_str(".@.[\"");
                    rendered.push_str(&escape_quoted_key(key));
                    rendered.push_str("\"]");
                }
            }
            _ => {}
        }
    }
    rendered
}

fn format_attribute_path(owner_path: &str, key: &str) -> String {
    if is_identifier(key) {
        format!("{owner_path}.@.{key}")
    } else {
        format!("{owner_path}.@.[\"{}\"]", escape_quoted_key(key))
    }
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
                resource_policy: None,
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
    fn datatype_constraint_requires_exact_label() {
        let payload = r#"{
          "aes": [
            {
              "path": { "segments": [ { "type": "root" }, { "type": "member", "key": "id" } ] },
              "key": "id",
              "datatype": "user-id",
              "value": { "type": "StringLiteral", "raw": "\"U-1\"", "value": "U-1" },
              "span": [0, 1]
            }
          ],
          "schema": {
            "rules": [
              { "path": "$.id", "constraints": { "datatype": "product-id" } }
            ]
          },
          "options": {}
        }"#;
        let parsed = validate_cts_payload(payload).expect("payload should validate");
        let envelope: ResultEnvelope = serde_json::from_str(&parsed).expect("result JSON");
        assert!(!envelope.ok);
        assert!(envelope.errors.iter().any(|error| {
            error.path.as_deref() == Some("$.id") && error.code == "type_mismatch"
        }));
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
    fn datatype_helpers_decode_clarifier_lists() {
        assert_eq!(declared_radix_from_datatype(Some("decimal")), Some(10));
        assert_eq!(declared_radix_from_datatype(Some("radix[12]")), Some(12));
        assert_eq!(declared_radix_from_datatype(Some("radix[65]")), None);
        assert_eq!(declared_radix_from_datatype(Some("radix12")), Some(12));
        assert_eq!(declared_radix_from_datatype(Some("radix65")), None);
        assert_eq!(
            decode_separator_chars(Some("sep[\"|\", \".\"]")),
            vec!['|', '.']
        );
        assert_eq!(
            decode_separator_chars(Some("custom[\"|\"]")),
            Vec::<char>::new()
        );
    }

    #[test]
    fn datatype_rule_pattern_applies_to_separator_literals() {
        let payload = r#"{
          "aes": [
            {
              "path": { "segments": [ { "type": "root" }, { "type": "member", "key": "ip" } ] },
              "key": "ip",
              "datatype": "kadot",
              "value": { "type": "SeparatorLiteral", "raw": "^198.0.126.255", "value": "198.0.126.255" },
              "span": [0, 14]
            },
            {
              "path": { "segments": [ { "type": "root" }, { "type": "member", "key": "dimensions" } ] },
              "key": "dimensions",
              "datatype": "kadot",
              "value": { "type": "SeparatorLiteral", "raw": "^300x250", "value": "300x250" },
              "span": [15, 23]
            }
          ],
          "schema": {
            "rules": [
              { "path": "$.ip", "constraints": {} },
              { "path": "$.dimensions", "constraints": {} }
            ],
            "datatype_rules": {
              "kadot": {
                "type": "SeparatorLiteral",
                "pattern": "^[0-9.]+$"
              }
            }
          },
          "options": {}
        }"#;
        let parsed = validate_cts_payload(payload).expect("payload should validate");
        let envelope: ResultEnvelope = serde_json::from_str(&parsed).expect("result JSON");
        assert!(!envelope.ok);
        assert!(
            !envelope
                .errors
                .iter()
                .any(|error| error.path.as_deref() == Some("$.ip"))
        );
        assert!(envelope.errors.iter().any(|error| {
            error.path.as_deref() == Some("$.dimensions") && error.code == "pattern_mismatch"
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
    fn sansa_selector_rules_apply_to_indexed_children_without_requiring_placeholder() {
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
                "selector": "$.contact.measurements.*",
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
                && error.path.as_deref() == Some("$.contact.measurements.*")
        }));
    }

    #[test]
    fn legacy_bracket_wildcard_is_rejected_as_rule_address() {
        let payload = r#"{
          "aes": [
            {
              "path": { "segments": [ { "type": "root" }, { "type": "member", "key": "contact" }, { "type": "member", "key": "measurements" } ] },
              "key": "measurements",
              "value": { "type": "ListNode", "elements": [] },
              "span": [1, 8]
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
        assert!(!envelope.ok);
        assert!(
            envelope
                .errors
                .iter()
                .any(|error| error.code == "invalid_schema_policy")
        );
    }

    #[test]
    fn schema_expresses_generic_container_content_claims() {
        let payload = r#"{
          "aes": [
            {
              "path": { "segments": [ { "type": "root" }, { "type": "member", "key": "numbers" } ] },
              "key": "numbers",
              "datatype": "list<number>",
              "value": { "type": "ListNode", "elements": [] },
              "span": [1, 2]
            },
            {
              "path": { "segments": [ { "type": "root" }, { "type": "member", "key": "numbers" }, { "type": "index", "index": 0 } ] },
              "key": "0",
              "datatype": "string",
              "value": { "type": "StringLiteral", "raw": "\"bad\"", "value": "bad" },
              "span": [2, 3]
            },
            {
              "path": { "segments": [ { "type": "root" }, { "type": "member", "key": "point" } ] },
              "key": "point",
              "datatype": "tuple<number>",
              "value": { "type": "TupleLiteral", "elements": [] },
              "span": [4, 5]
            },
            {
              "path": { "segments": [ { "type": "root" }, { "type": "member", "key": "point" }, { "type": "index", "index": 1 } ] },
              "key": "1",
              "datatype": "string",
              "value": { "type": "StringLiteral", "raw": "\"bad\"", "value": "bad" },
              "span": [5, 6]
            },
            {
              "path": { "segments": [ { "type": "root" }, { "type": "member", "key": "scores" } ] },
              "key": "scores",
              "datatype": "object<number>",
              "value": { "type": "ObjectNode", "bindings": [] },
              "span": [7, 8]
            },
            {
              "path": { "segments": [ { "type": "root" }, { "type": "member", "key": "scores" }, { "type": "member", "key": "bob" } ] },
              "key": "bob",
              "datatype": "string",
              "value": { "type": "StringLiteral", "raw": "\"bad\"", "value": "bad" },
              "span": [8, 9]
            },
            {
              "path": { "segments": [ { "type": "root" }, { "type": "member", "key": "group" } ] },
              "key": "group",
              "datatype": "node",
              "value": { "type": "NodeLiteral", "tag": "group", "datatype": "node<node>", "children": [] },
              "span": [10, 11]
            },
            {
              "path": { "segments": [ { "type": "root" }, { "type": "member", "key": "group" }, { "type": "index", "index": 1 } ] },
              "key": "1",
              "value": { "type": "StringLiteral", "raw": "\"bad\"", "value": "bad" },
              "span": [11, 12]
            }
          ],
          "schema": {
            "rules": [
              { "path": "$.numbers", "constraints": { "type": "ListNode", "datatype": "list<number>" } },
              { "selector": "$.numbers.*", "constraints": { "type": "NumberLiteral" } },
              { "path": "$.point", "constraints": { "type": "TupleLiteral", "datatype": "tuple<number>" } },
              { "selector": "$.point.*", "constraints": { "type": "NumberLiteral" } },
              { "path": "$.scores", "constraints": { "type": "ObjectNode", "datatype": "object<number>" } },
              { "selector": "$.scores.*", "constraints": { "type": "NumberLiteral" } },
              { "path": "$.group", "constraints": { "type": "NodeLiteral" } },
              { "selector": "$.group.*", "constraints": { "type": "NodeLiteral" } }
            ]
          },
          "options": {}
        }"#;
        let parsed = validate_cts_payload(payload).expect("payload should validate");
        let envelope: ResultEnvelope = serde_json::from_str(&parsed).expect("result JSON");
        assert!(!envelope.ok);
        for (path, codes) in [
            ("$.numbers[0]", ["type_mismatch", "type_mismatch"]),
            (
                "$.point[1]",
                ["type_mismatch", "TUPLE_ELEMENT_TYPE_MISMATCH"],
            ),
            ("$.scores.bob", ["type_mismatch", "type_mismatch"]),
            ("$.group[1]", ["type_mismatch", "type_mismatch"]),
        ] {
            assert!(envelope.errors.iter().any(|error| {
                codes.contains(&error.code.as_str()) && error.path.as_deref() == Some(path)
            }));
        }
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
                structural_id: None,
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
                resource_policy: None,
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
                structural_id: None,
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
                    selector: None,
                    constraints: json!({
                        "reference": "require",
                        "reference_kind": "clone"
                    }),
                }],
                datatype_rules: BTreeMap::new(),
                datatype_allowlist: Vec::new(),
                world: String::from("open"),
                reference_policy: None,
                resource_policy: None,
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
                    selector: None,
                    constraints: json!({
                        "reference_kind": "clone"
                    }),
                }],
                datatype_rules: BTreeMap::new(),
                datatype_allowlist: Vec::new(),
                world: String::from("open"),
                reference_policy: None,
                resource_policy: None,
            }),
            options: ValidationOptions::default(),
        };

        let result = validate(&envelope);
        assert!(!result.ok);
        assert_eq!(result.errors[0].code, "invalid_reference_constraint");
    }

    #[test]
    fn non_portable_pattern_fails_schema_validation() {
        let envelope = ValidationEnvelope {
            aes: Vec::new(),
            schema: Some(Schema {
                rules: vec![SchemaRule {
                    path: Some(String::from("$.a")),
                    selector: None,
                    constraints: json!({ "pattern": "(?=test)test" }),
                }],
                datatype_rules: BTreeMap::new(),
                datatype_allowlist: Vec::new(),
                world: String::from("open"),
                reference_policy: None,
                resource_policy: None,
            }),
            options: ValidationOptions::default(),
        };

        let result = validate(&envelope);
        assert!(!result.ok);
        assert_eq!(result.errors[0].code, "unknown_constraint_key");
    }

    #[test]
    fn non_portable_reference_target_pattern_fails_schema_validation() {
        let envelope = ValidationEnvelope {
            aes: Vec::new(),
            schema: Some(Schema {
                rules: vec![SchemaRule {
                    path: Some(String::from("$.a")),
                    selector: None,
                    constraints: json!({ "reference_target_pattern": "^(a)\\1$" }),
                }],
                datatype_rules: BTreeMap::new(),
                datatype_allowlist: Vec::new(),
                world: String::from("open"),
                reference_policy: None,
                resource_policy: None,
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
                structural_id: None,
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
                    selector: None,
                    constraints: json!({ "reference_target_pattern": "^\\$\\.\\[\"safe keys\"\\]\\.postcode$" }),
                }],
                datatype_rules: BTreeMap::new(),
                datatype_allowlist: Vec::new(),
                world: String::from("open"),
                reference_policy: None,
                resource_policy: None,
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
                    structural_id: None,
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
                    structural_id: None,
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
                    selector: None,
                    constraints: json!({ "type": "IntegerLiteral", "min_value": "1000", "max_value": "9999", "resolve_reference_form": true }),
                }],
                datatype_rules: BTreeMap::new(),
                datatype_allowlist: Vec::new(),
                world: String::from("open"),
                reference_policy: None,
                resource_policy: None,
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
                structural_id: None,
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
                    selector: None,
                    constraints: json!({ "type": "IntegerLiteral", "min_value": "1000", "max_value": "9999", "resolve_reference_form": true }),
                }],
                datatype_rules: BTreeMap::new(),
                datatype_allowlist: Vec::new(),
                world: String::from("open"),
                reference_policy: None,
                resource_policy: None,
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
                    structural_id: None,
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
                    structural_id: None,
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
                        selector: None,
                        constraints: json!({ "type": "NodeLiteral" }),
                    },
                    SchemaRule {
                        path: Some(String::from("$.page[0]")),
                        selector: None,
                        constraints: json!({ "type": "NumberLiteral" }),
                    },
                ],
                datatype_rules: BTreeMap::new(),
                datatype_allowlist: Vec::new(),
                world: String::from("open"),
                reference_policy: None,
                resource_policy: None,
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
                structural_id: None,
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
                    selector: None,
                    constraints: json!({ "type": "StringLiteral" }),
                }],
                datatype_rules: BTreeMap::new(),
                datatype_allowlist: Vec::new(),
                world: String::from("open"),
                reference_policy: None,
                resource_policy: None,
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
                structural_id: None,
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
                    selector: None,
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
                resource_policy: None,
            }),
            options: ValidationOptions::default(),
        };

        let result = validate(&envelope);
        assert!(!result.ok);
        assert_eq!(result.errors[0].code, "missing_required_field");
        assert_eq!(result.errors[0].path, Some(String::from("$.value.@.unit")));
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
                structural_id: None,
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
                    selector: None,
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
                resource_policy: None,
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
                    && error.path.as_deref() == Some("$.value.@.extra"))
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
                structural_id: None,
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
                    selector: None,
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
                resource_policy: None,
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
                    && error.path.as_deref() == Some("$.value.@.unit"))
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
