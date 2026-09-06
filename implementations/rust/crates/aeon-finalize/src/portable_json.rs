use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet};
use std::str::FromStr;

use aeon_core::Diagnostic;
use aes_telex::{
    AEON_DOCUMENT_PROJECTION, COMPLETE_AES_PROFILE, ClarifierKind, TelexLimits, TelexRecord,
    validate_telex_records_with_projection_and_limits,
};
use serde_json::{Map, Number, Value as JsonValue};

use crate::{FinalizeJsonResult, FinalizeMeta, FinalizeMode, FinalizeScope};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FinalizePortableJsonOptions {
    pub mode: FinalizeMode,
    pub scope: FinalizeScope,
    pub profile: String,
    pub projection: Option<String>,
    pub registered_fields: Vec<String>,
    pub limits: TelexLimits,
    pub max_materialized_weight: Option<usize>,
    pub max_reference_depth: Option<usize>,
}

impl Default for FinalizePortableJsonOptions {
    fn default() -> Self {
        Self {
            mode: FinalizeMode::Strict,
            scope: FinalizeScope::Payload,
            profile: COMPLETE_AES_PROFILE.to_owned(),
            projection: None,
            registered_fields: Vec::new(),
            limits: TelexLimits::default(),
            max_materialized_weight: None,
            max_reference_depth: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Segment {
    Member(String),
    Attribute(String),
    Index(String),
}

#[derive(Debug, Clone)]
struct IndexedRecord {
    record: usize,
    address: String,
    segment: Segment,
}

#[derive(Debug, Clone, Default)]
struct PlaneIndex {
    by_address: BTreeMap<String, IndexedRecord>,
    by_parent: BTreeMap<String, Vec<IndexedRecord>>,
}

struct Context<'a> {
    records: &'a [TelexRecord],
    strict: bool,
    body: PlaneIndex,
    header: PlaneIndex,
    errors: Vec<Diagnostic>,
    warnings: Vec<Diagnostic>,
    max_materialized_weight: Option<usize>,
    max_reference_depth: Option<usize>,
    active_clone_paths: Vec<String>,
    materialized_weight_cache: BTreeMap<String, usize>,
    materialized_weight: usize,
}

const RESERVED_OBJECT_KEYS: &[&str] = &[
    "@",
    "$",
    "$node",
    "$children",
    "__proto__",
    "constructor",
    "prototype",
];

/// Materialize a complete flat AES stream directly into the JSON output
/// profile, without reconstructing a parser AST or legacy assignment events.
#[must_use]
pub fn finalize_portable_json(
    records: &[TelexRecord],
    options: FinalizePortableJsonOptions,
) -> FinalizeJsonResult {
    let registered = options
        .registered_fields
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>();
    let validation = validate_telex_records_with_projection_and_limits(
        records,
        &options.profile,
        options.projection.as_deref(),
        &registered,
        &options.limits,
    );
    let mut errors = validation
        .diagnostics
        .into_iter()
        .map(|diagnostic| {
            let value = Diagnostic::new(diagnostic.code, diagnostic.message);
            diagnostic
                .path
                .map_or(value.clone(), |path| value.at_path(path))
        })
        .collect::<Vec<_>>();

    if options.profile != COMPLETE_AES_PROFILE {
        errors.push(Diagnostic::new(
            "FINALIZE_PARTIAL_AES_UNSUPPORTED",
            format!(
                "Portable JSON materialization requires '{COMPLETE_AES_PROFILE}', received '{}'",
                options.profile
            ),
        ));
    }
    if !errors.is_empty() {
        return FinalizeJsonResult {
            document: empty_document(options.scope),
            meta: FinalizeMeta {
                errors,
                warnings: Vec::new(),
            },
        };
    }

    let mut ctx = Context {
        records,
        strict: options.mode == FinalizeMode::Strict,
        body: index_plane(records, "path"),
        header: index_plane(records, "header"),
        errors: Vec::new(),
        warnings: Vec::new(),
        max_materialized_weight: options.max_materialized_weight,
        max_reference_depth: options.max_reference_depth,
        active_clone_paths: Vec::new(),
        materialized_weight_cache: BTreeMap::new(),
        materialized_weight: 0,
    };

    let payload = if options.scope == FinalizeScope::Header {
        JsonValue::Object(Map::new())
    } else {
        materialize_root(false, &mut ctx)
    };
    let header = if options.scope == FinalizeScope::Payload
        || options.projection.as_deref() != Some(AEON_DOCUMENT_PROJECTION)
    {
        JsonValue::Object(Map::new())
    } else {
        materialize_root(true, &mut ctx)
    };
    let document = match options.scope {
        FinalizeScope::Payload => payload,
        FinalizeScope::Header => header,
        FinalizeScope::Full => JsonValue::Object(Map::from_iter([
            ("header".to_owned(), header),
            ("payload".to_owned(), payload),
        ])),
    };
    FinalizeJsonResult {
        document,
        meta: FinalizeMeta {
            errors: ctx.errors,
            warnings: ctx.warnings,
        },
    }
}

fn empty_document(scope: FinalizeScope) -> JsonValue {
    if scope == FinalizeScope::Full {
        JsonValue::Object(Map::from_iter([
            ("header".to_owned(), JsonValue::Object(Map::new())),
            ("payload".to_owned(), JsonValue::Object(Map::new())),
        ]))
    } else {
        JsonValue::Object(Map::new())
    }
}

fn index_plane(records: &[TelexRecord], field: &str) -> PlaneIndex {
    let mut index = PlaneIndex::default();
    for (record_index, record) in records.iter().enumerate() {
        let Some(address) = record.get(field) else {
            continue;
        };
        let Ok((parent, segment)) = parse_path(address) else {
            continue;
        };
        let indexed = IndexedRecord {
            record: record_index,
            address: address.to_owned(),
            segment,
        };
        index.by_address.insert(address.to_owned(), indexed.clone());
        index.by_parent.entry(parent).or_default().push(indexed);
    }
    index
}

fn materialize_root(header: bool, ctx: &mut Context<'_>) -> JsonValue {
    let children = structural_children(if header { &ctx.header } else { &ctx.body }, "$");
    let mut object = Map::new();
    let mut attributes = Map::new();
    for child in children {
        let Segment::Member(mut key) = child.segment.clone() else {
            continue;
        };
        if header {
            key = key.strip_prefix("aeon:").unwrap_or(&key).to_owned();
        }
        if !safe_member(&key, &child.address, ctx) {
            continue;
        }
        object.insert(key.clone(), materialize_record(&child, ctx));
        if let Some(metadata) = record_metadata(&child, ctx) {
            attributes.insert(key, metadata);
        }
    }
    if !attributes.is_empty() {
        object.insert("@".to_owned(), JsonValue::Object(attributes));
    }
    JsonValue::Object(object)
}

fn materialize_record(indexed: &IndexedRecord, ctx: &mut Context<'_>) -> JsonValue {
    let record = &ctx.records[indexed.record];
    let kind = record.get("kind").unwrap_or("");
    let value = record.get("value").unwrap_or("");
    match kind {
        "StringLiteral" => JsonValue::String(value.to_owned()),
        "NumberLiteral" => number_value(value, &indexed.address, ctx),
        "InfinityLiteral" | "NaNLiteral" => {
            let code = if kind == "NaNLiteral" {
                "FINALIZE_JSON_PROFILE_NAN"
            } else {
                "FINALIZE_JSON_PROFILE_INFINITY"
            };
            report(
                ctx,
                format!("The {kind} value '{value}' is not representable in strict JSON"),
                code,
                &indexed.address,
                false,
            );
            JsonValue::String(value.to_owned())
        }
        "NullLiteral" => null_value(value, &indexed.address, ctx),
        "BooleanLiteral" => JsonValue::Bool(value == "true"),
        "ToggleLiteral" => JsonValue::Bool(value == "yes" || value == "on"),
        "HexLiteral"
        | "EncodingLiteral"
        | "SeparatorLiteral"
        | "SansaAddressLiteral"
        | "DateLiteral"
        | "TimeLiteral"
        | "DateTimeLiteral"
        | "WTCDateTimeLiteral" => JsonValue::String(value.to_owned()),
        "RadixLiteral" => radix_value(record, value, &indexed.address, ctx),
        "ObjectNode" => materialize_object(indexed, ctx),
        "ListNode" | "TupleLiteral" => materialize_indexed(indexed, ctx),
        "NodeLiteral" => materialize_node(indexed, ctx),
        "CloneReference" => materialize_clone(indexed, ctx),
        "PointerReference" => {
            report(
                ctx,
                format!(
                    "Pointer reference remains symbolic during JSON materialization: {}",
                    reference_token("~>", value)
                ),
                "FINALIZE_UNRESOLVED_REFERENCE",
                &indexed.address,
                false,
            );
            JsonValue::String(reference_token("~>", value))
        }
        "NodeHead" => {
            report(
                ctx,
                "NodeHead can only be materialized through its owning NodeLiteral".to_owned(),
                "FINALIZE_ORPHAN_NODE_HEAD",
                &indexed.address,
                true,
            );
            JsonValue::String(value.to_owned())
        }
        _ => {
            report(
                ctx,
                format!("Unsupported portable AES kind '{kind}'"),
                "FINALIZE_UNSUPPORTED_AES_KIND",
                &indexed.address,
                true,
            );
            JsonValue::Null
        }
    }
}

fn materialize_object(indexed: &IndexedRecord, ctx: &mut Context<'_>) -> JsonValue {
    let children = structural_children(plane_for(indexed, ctx), &indexed.address);
    let mut object = Map::new();
    let mut attributes = Map::new();
    for child in children {
        let Segment::Member(key) = child.segment.clone() else {
            continue;
        };
        if !safe_member(&key, &child.address, ctx) {
            continue;
        }
        object.insert(key.clone(), materialize_record(&child, ctx));
        if let Some(metadata) = record_metadata(&child, ctx) {
            attributes.insert(key, metadata);
        }
    }
    if !attributes.is_empty() {
        object.insert("@".to_owned(), JsonValue::Object(attributes));
    }
    JsonValue::Object(object)
}

fn materialize_indexed(indexed: &IndexedRecord, ctx: &mut Context<'_>) -> JsonValue {
    let mut children = structural_children(plane_for(indexed, ctx), &indexed.address)
        .into_iter()
        .filter(|child| matches!(child.segment, Segment::Index(_)))
        .collect::<Vec<_>>();
    children.sort_by(|left, right| index_cmp(&left.segment, &right.segment));
    let mut values = Vec::new();
    for child in children {
        let Segment::Index(index) = &child.segment else {
            continue;
        };
        if index != &values.len().to_string() {
            report(
                ctx,
                format!("Indexed AES container cannot materialize non-contiguous index {index}"),
                "FINALIZE_NON_CONTIGUOUS_INDEX",
                &indexed.address,
                true,
            );
            continue;
        }
        values.push(materialize_record(&child, ctx));
    }
    JsonValue::Array(values)
}

fn materialize_node(indexed: &IndexedRecord, ctx: &mut Context<'_>) -> JsonValue {
    let mut heads = structural_children(plane_for(indexed, ctx), &indexed.address)
        .into_iter()
        .filter(|child| matches!(child.segment, Segment::Index(_)))
        .collect::<Vec<_>>();
    heads.sort_by(|left, right| index_cmp(&left.segment, &right.segment));
    let valid = heads.len() == 1
        && matches!(&heads[0].segment, Segment::Index(index) if index == "0")
        && ctx.records[heads[0].record].get("kind") == Some("NodeHead");
    if !valid {
        report(
            ctx,
            "The JSON output profile requires exactly one NodeHead at index 0".to_owned(),
            "FINALIZE_UNREPRESENTABLE_NODE_HEADS",
            &indexed.address,
            true,
        );
        return JsonValue::Null;
    }
    let head = &heads[0];
    let mut object = Map::new();
    object.insert(
        "$node".to_owned(),
        JsonValue::String(
            ctx.records[head.record]
                .get("value")
                .unwrap_or("")
                .to_owned(),
        ),
    );
    if let Some(attributes) = attributes_to_json(head, ctx) {
        object.insert("@".to_owned(), attributes);
    }
    object.insert("$children".to_owned(), materialize_indexed(head, ctx));
    JsonValue::Object(object)
}

fn materialize_clone(indexed: &IndexedRecord, ctx: &mut Context<'_>) -> JsonValue {
    let target_path = ctx.records[indexed.record]
        .get("value")
        .unwrap_or("")
        .to_owned();
    let Some(target) = ctx.body.by_address.get(&target_path).cloned() else {
        report(
            ctx,
            format!(
                "Clone reference target is unavailable: {}",
                reference_token("~", &target_path)
            ),
            "FINALIZE_UNRESOLVED_REFERENCE",
            &indexed.address,
            false,
        );
        return JsonValue::String(reference_token("~", &target_path));
    };
    if ctx.active_clone_paths.contains(&target_path) {
        report(
            ctx,
            format!("Reference cycle detected during JSON materialization: '{target_path}'"),
            "REFERENCE_CYCLE",
            &indexed.address,
            true,
        );
        return JsonValue::String(reference_token("~", &target_path));
    }
    let observed_depth = ctx.active_clone_paths.len() + 1;
    if ctx
        .max_reference_depth
        .is_some_and(|limit| observed_depth > limit)
    {
        report(
            ctx,
            format!(
                "Reference materialization depth {observed_depth} exceeds maxReferenceDepth {}",
                ctx.max_reference_depth.unwrap_or_default()
            ),
            "FINALIZE_REFERENCE_DEPTH_EXCEEDED",
            &indexed.address,
            true,
        );
        return JsonValue::String(reference_token("~", &target_path));
    }
    if let Some(limit) = ctx.max_materialized_weight {
        let weight = measure_weight(&target, ctx, &mut BTreeSet::new());
        let observed = ctx.materialized_weight.saturating_add(weight);
        if observed > limit {
            report(
                ctx,
                format!(
                    "Reference materialization budget exceeded for '{target_path}' (budget=maxMaterializedWeight, observed={observed}, limit={limit})"
                ),
                "FINALIZE_REFERENCE_BUDGET_EXCEEDED",
                &indexed.address,
                true,
            );
            return JsonValue::String(reference_token("~", &target_path));
        }
        ctx.materialized_weight = observed;
    }
    ctx.active_clone_paths.push(target_path);
    let value = materialize_record(&target, ctx);
    ctx.active_clone_paths.pop();
    value
}

fn measure_weight(
    indexed: &IndexedRecord,
    ctx: &mut Context<'_>,
    stack: &mut BTreeSet<String>,
) -> usize {
    if let Some(weight) = ctx.materialized_weight_cache.get(&indexed.address) {
        return *weight;
    }
    if !stack.insert(indexed.address.clone()) {
        return 1;
    }
    let kind = ctx.records[indexed.record].get("kind").unwrap_or("");
    let weight = match kind {
        "ObjectNode" | "ListNode" | "TupleLiteral" => plane_children(indexed, ctx)
            .into_iter()
            .map(|child| measure_weight(&child, ctx, stack))
            .sum(),
        "NodeLiteral" => plane_children(indexed, ctx)
            .into_iter()
            .map(|head| {
                1 + plane_children(&head, ctx)
                    .into_iter()
                    .map(|child| measure_weight(&child, ctx, stack))
                    .sum::<usize>()
            })
            .sum(),
        "CloneReference" => {
            let target_path = ctx.records[indexed.record].get("value").unwrap_or("");
            ctx.body
                .by_address
                .get(target_path)
                .cloned()
                .map_or(1, |target| measure_weight(&target, ctx, stack))
        }
        _ => 1,
    };
    stack.remove(&indexed.address);
    ctx.materialized_weight_cache
        .insert(indexed.address.clone(), weight);
    weight
}

fn record_metadata(indexed: &IndexedRecord, ctx: &mut Context<'_>) -> Option<JsonValue> {
    let own = attributes_to_json(indexed, ctx);
    let items = indexed_item_attributes(indexed, ctx);
    match (own, items) {
        (None, None) => None,
        (Some(JsonValue::Object(mut own)), Some(items)) => {
            own.insert("@items".to_owned(), items);
            Some(JsonValue::Object(own))
        }
        (Some(own), None) => Some(own),
        (None, Some(items)) => Some(JsonValue::Object(Map::from_iter([(
            "@items".to_owned(),
            items,
        )]))),
        _ => None,
    }
}

fn attributes_to_json(indexed: &IndexedRecord, ctx: &mut Context<'_>) -> Option<JsonValue> {
    let children = attribute_children(plane_for(indexed, ctx), &indexed.address);
    let mut object = Map::new();
    let mut nested = Map::new();
    for child in children {
        let Segment::Attribute(key) = child.segment.clone() else {
            continue;
        };
        if !safe_member(&key, &child.address, ctx) {
            continue;
        }
        object.insert(key.clone(), materialize_record(&child, ctx));
        if let Some(metadata) = record_metadata(&child, ctx) {
            nested.insert(key, metadata);
        }
    }
    if !nested.is_empty() {
        object.insert("@".to_owned(), JsonValue::Object(nested));
    }
    (!object.is_empty()).then(|| JsonValue::Object(object))
}

fn indexed_item_attributes(indexed: &IndexedRecord, ctx: &mut Context<'_>) -> Option<JsonValue> {
    let kind = ctx.records[indexed.record].get("kind").unwrap_or("");
    let owners = if kind == "NodeLiteral" {
        structural_children(plane_for(indexed, ctx), &indexed.address)
            .into_iter()
            .flat_map(|head| structural_children(plane_for(&head, ctx), &head.address))
            .collect::<Vec<_>>()
    } else if kind == "ListNode" || kind == "TupleLiteral" {
        structural_children(plane_for(indexed, ctx), &indexed.address)
    } else {
        Vec::new()
    };
    let mut object = Map::new();
    for owner in owners {
        let Segment::Index(index) = &owner.segment else {
            continue;
        };
        if let Some(attributes) = attributes_to_json(&owner, ctx) {
            object.insert(index.clone(), attributes);
        }
    }
    (!object.is_empty()).then(|| JsonValue::Object(object))
}

fn structural_children(index: &PlaneIndex, parent: &str) -> Vec<IndexedRecord> {
    index
        .by_parent
        .get(parent)
        .into_iter()
        .flatten()
        .filter(|child| !matches!(child.segment, Segment::Attribute(_)))
        .cloned()
        .collect()
}

fn attribute_children(index: &PlaneIndex, parent: &str) -> Vec<IndexedRecord> {
    index
        .by_parent
        .get(parent)
        .into_iter()
        .flatten()
        .filter(|child| matches!(child.segment, Segment::Attribute(_)))
        .cloned()
        .collect()
}

fn plane_children(indexed: &IndexedRecord, ctx: &Context<'_>) -> Vec<IndexedRecord> {
    plane_for(indexed, ctx)
        .by_parent
        .get(&indexed.address)
        .cloned()
        .unwrap_or_default()
}

fn plane_for<'a>(indexed: &IndexedRecord, ctx: &'a Context<'_>) -> &'a PlaneIndex {
    if ctx.records[indexed.record].contains("header") {
        &ctx.header
    } else {
        &ctx.body
    }
}

fn number_value(value: &str, path: &str, ctx: &mut Context<'_>) -> JsonValue {
    let normalized = value.replace('_', "");
    let exceeds_safe_range = normalized
        .parse::<i128>()
        .map(|number| number.unsigned_abs() > 9_007_199_254_740_991)
        .unwrap_or_else(|_| {
            normalized.parse::<f64>().map_or(true, |number| {
                !number.is_finite() || number.abs() > 9_007_199_254_740_991.0
            })
        });
    if exceeds_safe_range {
        report(
            ctx,
            format!("Numeric literal is not safely representable in JSON: {value}"),
            "FINALIZE_UNSAFE_NUMBER",
            path,
            false,
        );
        return JsonValue::String(value.to_owned());
    }
    if let Ok(number) = Number::from_str(&normalized) {
        return JsonValue::Number(number);
    }
    report(
        ctx,
        format!("Numeric literal is not safely representable in JSON: {value}"),
        "FINALIZE_UNSAFE_NUMBER",
        path,
        false,
    );
    JsonValue::String(value.to_owned())
}

fn null_value(value: &str, path: &str, ctx: &mut Context<'_>) -> JsonValue {
    if value == "none" {
        return JsonValue::Null;
    }
    report(
        ctx,
        format!("Null literal is not losslessly representable in strict JSON: {value}"),
        "FINALIZE_JSON_PROFILE_NULL",
        path,
        false,
    );
    let token = match value {
        "notSet" | "notApplicable" | "tombstone" => format!("!{value}"),
        _ => format!(
            "!{}",
            serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_owned())
        ),
    };
    JsonValue::String(token)
}

fn radix_value(record: &TelexRecord, value: &str, path: &str, ctx: &mut Context<'_>) -> JsonValue {
    let normalized = value.replace('_', "");
    if let Some(base) = declared_radix_base(record)
        && normalized.chars().any(|character| {
            !matches!(character, '+' | '-' | '.')
                && radix_digit_value(character).is_none_or(|digit| digit >= base)
        })
    {
        report(
            ctx,
            format!("Radix literal exceeds declared radix {base}: %{normalized}"),
            "FINALIZE_INVALID_RADIX_BASE",
            path,
            false,
        );
    }
    JsonValue::String(normalized)
}

fn declared_radix_base(record: &TelexRecord) -> Option<u32> {
    match record.get("datatype")? {
        "decimal" => Some(10),
        "radix2" => Some(2),
        "radix6" => Some(6),
        "radix8" => Some(8),
        "radix12" => Some(12),
        "radix" => record.datatype()?.clarifiers.first().and_then(|clarifier| {
            (clarifier.kind == ClarifierKind::NumberLiteral)
                .then(|| clarifier.value.parse::<u32>().ok())
                .flatten()
                .filter(|base| (2..=64).contains(base))
        }),
        _ => None,
    }
}

fn radix_digit_value(character: char) -> Option<u32> {
    match character {
        '0'..='9' => Some(character as u32 - '0' as u32),
        'A'..='Z' => Some(character as u32 - 'A' as u32 + 10),
        'a'..='z' => Some(character as u32 - 'a' as u32 + 36),
        '&' => Some(62),
        '!' => Some(63),
        _ => None,
    }
}

fn report(ctx: &mut Context<'_>, message: String, code: &str, path: &str, always_error: bool) {
    let diagnostic = Diagnostic::new(code, message).at_path(path);
    if always_error || ctx.strict {
        ctx.errors.push(diagnostic);
    } else {
        ctx.warnings.push(diagnostic);
    }
}

fn safe_member(key: &str, path: &str, ctx: &mut Context<'_>) -> bool {
    if !RESERVED_OBJECT_KEYS.contains(&key) {
        return true;
    }
    report(
        ctx,
        format!("Reserved key: {key}"),
        "FINALIZE_RESERVED_KEY",
        path,
        true,
    );
    false
}

fn reference_token(prefix: &str, target: &str) -> String {
    format!("{prefix}{}", target.strip_prefix("$.").unwrap_or(target))
}

fn index_cmp(left: &Segment, right: &Segment) -> Ordering {
    let (Segment::Index(left), Segment::Index(right)) = (left, right) else {
        return Ordering::Equal;
    };
    left.len().cmp(&right.len()).then_with(|| left.cmp(right))
}

fn parse_path(path: &str) -> Result<(String, Segment), ()> {
    let bytes = path.as_bytes();
    if bytes.first() != Some(&b'$') || bytes.len() == 1 {
        return Err(());
    }
    let mut cursor = 1;
    let mut parent = "$".to_owned();
    let mut segment = None;
    while cursor < bytes.len() {
        parent = path[..cursor].to_owned();
        if path[cursor..].starts_with(".@.") {
            let (key, end) = read_member(path, cursor + 3)?;
            segment = Some(Segment::Attribute(key));
            cursor = end;
        } else if bytes[cursor] == b'.' {
            let (key, end) = read_member(path, cursor + 1)?;
            segment = Some(Segment::Member(key));
            cursor = end;
        } else if bytes[cursor] == b'[' {
            let end = path[cursor + 1..].find(']').ok_or(())? + cursor + 1;
            let index = &path[cursor + 1..end];
            if index.is_empty()
                || !index.bytes().all(|byte| byte.is_ascii_digit())
                || (index.len() > 1 && index.starts_with('0'))
            {
                return Err(());
            }
            segment = Some(Segment::Index(index.to_owned()));
            cursor = end + 1;
        } else {
            return Err(());
        }
    }
    segment.map(|segment| (parent, segment)).ok_or(())
}

fn read_member(path: &str, cursor: usize) -> Result<(String, usize), ()> {
    let bytes = path.as_bytes();
    if bytes.get(cursor) == Some(&b'[') {
        let mut end = cursor + 2;
        let mut escaped = false;
        while end < bytes.len() {
            if escaped {
                escaped = false;
            } else if bytes[end] == b'\\' {
                escaped = true;
            } else if bytes[end] == b'"' {
                break;
            }
            end += 1;
        }
        if bytes.get(end + 1) != Some(&b']') {
            return Err(());
        }
        let key = serde_json::from_str::<String>(&path[cursor + 1..=end]).map_err(|_| ())?;
        return Ok((key, end + 2));
    }
    let mut end = cursor;
    while bytes
        .get(end)
        .is_some_and(|byte| byte.is_ascii_alphanumeric() || *byte == b'_')
    {
        end += 1;
    }
    if end == cursor || !bytes[cursor].is_ascii_alphabetic() && bytes[cursor] != b'_' {
        return Err(());
    }
    Ok((path[cursor..end].to_owned(), end))
}

#[cfg(test)]
mod tests {
    use super::*;
    use aeon_core::{CompileOptions, ExportTelexOptions, compile, project_telex_records};

    fn record(fields: &[(&str, &str)]) -> TelexRecord {
        TelexRecord::new(
            fields
                .iter()
                .map(|(name, value)| ((*name).to_owned(), (*value).to_owned()))
                .collect(),
        )
    }

    #[test]
    fn materializes_flat_containers_and_clones() {
        let records = vec![
            record(&[("path", "$.base"), ("kind", "ObjectNode")]),
            record(&[
                ("path", "$.base.name"),
                ("kind", "StringLiteral"),
                ("value", "AEON"),
            ]),
            record(&[("path", "$.base.values"), ("kind", "ListNode")]),
            record(&[
                ("path", "$.base.values[0]"),
                ("kind", "NumberLiteral"),
                ("value", "2"),
            ]),
            record(&[
                ("path", "$.base.values[1]"),
                ("kind", "NumberLiteral"),
                ("value", "3"),
            ]),
            record(&[
                ("path", "$.copy"),
                ("kind", "CloneReference"),
                ("value", "$.base"),
            ]),
        ];
        let result = finalize_portable_json(&records, FinalizePortableJsonOptions::default());
        assert_eq!(
            result.document,
            serde_json::json!({
                "base": {"name": "AEON", "values": [2, 3]},
                "copy": {"name": "AEON", "values": [2, 3]},
            })
        );
        assert!(result.meta.errors.is_empty());
    }

    #[test]
    fn rejects_multi_head_and_sparse_indexes() {
        let multi_head = vec![
            record(&[("path", "$.value"), ("kind", "NodeLiteral")]),
            record(&[
                ("path", "$.value[0]"),
                ("kind", "NodeHead"),
                ("value", "first"),
            ]),
            record(&[
                ("path", "$.value[1]"),
                ("kind", "NodeHead"),
                ("value", "second"),
            ]),
        ];
        let sparse = vec![
            record(&[("path", "$.values"), ("kind", "ListNode")]),
            record(&[
                ("path", "$.values[999999999999999999999999]"),
                ("kind", "StringLiteral"),
                ("value", "far away"),
            ]),
        ];
        let heads = finalize_portable_json(&multi_head, FinalizePortableJsonOptions::default());
        let indexes = finalize_portable_json(&sparse, FinalizePortableJsonOptions::default());
        assert!(
            heads
                .meta
                .errors
                .iter()
                .any(|error| error.code == "FINALIZE_UNREPRESENTABLE_NODE_HEADS")
        );
        assert!(
            indexes
                .meta
                .errors
                .iter()
                .any(|error| error.code == "FINALIZE_NON_CONTIGUOUS_INDEX")
        );
        assert_eq!(indexes.document, serde_json::json!({"values": []}));
    }

    #[test]
    fn rejects_numbers_outside_the_cross_runtime_json_safe_range() {
        let records = vec![record(&[
            ("path", "$.value"),
            ("kind", "NumberLiteral"),
            ("value", "9007199254740993"),
        ])];
        let result = finalize_portable_json(&records, FinalizePortableJsonOptions::default());
        assert_eq!(
            result.document,
            serde_json::json!({"value": "9007199254740993"})
        );
        assert!(
            result
                .meta
                .errors
                .iter()
                .any(|error| error.code == "FINALIZE_UNSAFE_NUMBER")
        );
    }

    #[test]
    fn matches_legacy_json_for_a_rich_aeon_origin_stream() {
        let source = r#"config\ROOT\@{scope\META\ = "test"} = {
  title:string = "Demo"
  values:list<int> = [2, 3, 4]
  card:node = <tag\HEAD\@{role = "button"}(\CHILD\@{lang = "en"}:string = "hello", true)>
}
copy = ~config.values
pointer = ~>config.title"#;
        let compiled = compile(
            source,
            CompileOptions {
                max_attribute_depth: 8,
                ..CompileOptions::default()
            },
        );
        assert!(compiled.errors.is_empty(), "{:?}", compiled.errors);
        let records = project_telex_records(&compiled.events, &ExportTelexOptions::default())
            .expect("portable records");
        let legacy = crate::finalize_json(
            &compiled.events,
            crate::FinalizeOptions {
                mode: FinalizeMode::Loose,
                ..crate::FinalizeOptions::default()
            },
        );
        let portable = finalize_portable_json(
            &records,
            FinalizePortableJsonOptions {
                mode: FinalizeMode::Loose,
                ..FinalizePortableJsonOptions::default()
            },
        );
        assert_eq!(portable.document, legacy.document);
        assert_eq!(
            portable
                .meta
                .warnings
                .iter()
                .map(|diagnostic| (&diagnostic.code, &diagnostic.path))
                .collect::<Vec<_>>(),
            legacy
                .meta
                .warnings
                .iter()
                .map(|diagnostic| (&diagnostic.code, &diagnostic.path))
                .collect::<Vec<_>>()
        );
    }
}
