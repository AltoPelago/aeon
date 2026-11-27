use std::borrow::Cow;
use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet};
use std::str::FromStr;

use aeon_core::{
    Diagnostic, RadixBaseResolution, radix_digit_value, resolve_radix_base_from_components,
};
use aes_telex::{
    AEON_DOCUMENT_PROJECTION, COMPLETE_AES_PROFILE, TelexLimits, TelexRecord,
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
    materialized_weight_cache: BTreeMap<(String, bool), usize>,
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
        object.insert(key.clone(), materialize_record(&child, ctx, &child.address));
        if let Some(metadata) = record_metadata(&child, ctx, &child.address) {
            attributes.insert(key, metadata);
        }
    }
    if !attributes.is_empty() {
        object.insert("@".to_owned(), JsonValue::Object(attributes));
    }
    JsonValue::Object(object)
}

fn materialize_record(
    indexed: &IndexedRecord,
    ctx: &mut Context<'_>,
    output_path: &str,
) -> JsonValue {
    materialize_record_with_receiver(indexed, ctx, output_path, indexed.record)
}

fn materialize_record_with_receiver(
    indexed: &IndexedRecord,
    ctx: &mut Context<'_>,
    output_path: &str,
    receiver: usize,
) -> JsonValue {
    let record = &ctx.records[indexed.record];
    let kind = record.get("kind").unwrap_or("");
    let value = record.get("value").unwrap_or("");
    match kind {
        "StringLiteral" => JsonValue::String(value.to_owned()),
        "NumberLiteral" => number_value(value, output_path, ctx),
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
                output_path,
                false,
            );
            JsonValue::String(value.to_owned())
        }
        "NullLiteral" => null_value(value, output_path, ctx),
        "BooleanLiteral" => JsonValue::Bool(value == "true"),
        "ToggleLiteral" => JsonValue::Bool(value == "yes" || value == "on"),
        "SymbolicLiteral" => {
            report(
                ctx,
                format!(
                    "Symbol literal is not losslessly representable in the strict JSON profile: {value}"
                ),
                "FINALIZE_JSON_PROFILE_SYMBOL",
                output_path,
                false,
            );
            JsonValue::String(value.to_owned())
        }
        "HexLiteral"
        | "EncodingLiteral"
        | "SeparatorLiteral"
        | "SansaAddressLiteral"
        | "DateLiteral"
        | "TimeLiteral"
        | "DateTimeLiteral"
        | "WTCDateTimeLiteral" => JsonValue::String(value.to_owned()),
        "RadixLiteral" => radix_value(&ctx.records[receiver], value, output_path, ctx),
        "ObjectNode" => materialize_object(indexed, ctx, output_path),
        "ListNode" | "TupleLiteral" => materialize_indexed(indexed, ctx, output_path),
        "NodeLiteral" => materialize_node(indexed, ctx, output_path),
        "CloneReference" => materialize_clone(indexed, ctx, output_path, receiver),
        "PointerReference" => {
            report(
                ctx,
                format!(
                    "Pointer reference remains symbolic during JSON materialization: {}",
                    reference_token("~>", value)
                ),
                "FINALIZE_UNRESOLVED_REFERENCE",
                output_path,
                false,
            );
            JsonValue::String(reference_token("~>", value))
        }
        _ => {
            report(
                ctx,
                format!("Unsupported portable AES kind '{kind}'"),
                "FINALIZE_UNSUPPORTED_AES_KIND",
                output_path,
                true,
            );
            JsonValue::Null
        }
    }
}

fn materialize_object(
    indexed: &IndexedRecord,
    ctx: &mut Context<'_>,
    output_path: &str,
) -> JsonValue {
    let children = structural_children(plane_for(indexed, ctx), &indexed.address);
    let mut object = Map::new();
    let mut attributes = Map::new();
    for child in children {
        let Segment::Member(key) = child.segment.clone() else {
            continue;
        };
        let child_path = descendant_path(indexed, &child, output_path);
        if !safe_member(&key, &child_path, ctx) {
            continue;
        }
        object.insert(key.clone(), materialize_record(&child, ctx, &child_path));
        if let Some(metadata) = record_metadata(&child, ctx, &child_path) {
            attributes.insert(key, metadata);
        }
    }
    if !attributes.is_empty() {
        object.insert("@".to_owned(), JsonValue::Object(attributes));
    }
    JsonValue::Object(object)
}

fn materialize_indexed(
    indexed: &IndexedRecord,
    ctx: &mut Context<'_>,
    output_path: &str,
) -> JsonValue {
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
                output_path,
                true,
            );
            continue;
        }
        let child_path = descendant_path(indexed, &child, output_path);
        values.push(materialize_record(&child, ctx, &child_path));
    }
    JsonValue::Array(values)
}

fn materialize_node(
    indexed: &IndexedRecord,
    ctx: &mut Context<'_>,
    output_path: &str,
) -> JsonValue {
    let mut object = Map::new();
    let Some(tag) = ctx.records[indexed.record]
        .get("tag")
        .filter(|tag| !tag.is_empty())
    else {
        report(
            ctx,
            "A node record requires an intrinsic tag".to_owned(),
            "FINALIZE_INVALID_NODE_TAG",
            output_path,
            true,
        );
        return JsonValue::Null;
    };
    object.insert("$node".to_owned(), JsonValue::String(tag.to_owned()));
    if let Some(attributes) = attributes_to_json(indexed, ctx, output_path) {
        object.insert("@".to_owned(), attributes);
    }
    object.insert(
        "$children".to_owned(),
        materialize_indexed(indexed, ctx, output_path),
    );
    JsonValue::Object(object)
}

fn materialize_clone(
    indexed: &IndexedRecord,
    ctx: &mut Context<'_>,
    output_path: &str,
    receiver: usize,
) -> JsonValue {
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
            output_path,
            false,
        );
        return JsonValue::String(reference_token("~", &target_path));
    };
    if ctx.active_clone_paths.contains(&target_path) {
        report(
            ctx,
            format!("Reference cycle detected during JSON materialization: '{target_path}'"),
            "REFERENCE_CYCLE",
            output_path,
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
            output_path,
            true,
        );
        return JsonValue::String(reference_token("~", &target_path));
    }
    if let Some(limit) = ctx.max_materialized_weight {
        let weight = measure_weight(&target, ctx, &mut BTreeSet::new(), false);
        let observed = ctx.materialized_weight.saturating_add(weight);
        if observed > limit {
            report(
                ctx,
                format!(
                    "Reference materialization budget exceeded for '{target_path}' (budget=maxMaterializedWeight, observed={observed}, limit={limit})"
                ),
                "FINALIZE_REFERENCE_BUDGET_EXCEEDED",
                output_path,
                true,
            );
            return JsonValue::String(reference_token("~", &target_path));
        }
        ctx.materialized_weight = observed;
    }
    ctx.active_clone_paths.push(target_path);
    let value = materialize_record_with_receiver(&target, ctx, output_path, receiver);
    ctx.active_clone_paths.pop();
    value
}

fn measure_weight(
    indexed: &IndexedRecord,
    ctx: &mut Context<'_>,
    stack: &mut BTreeSet<String>,
    include_metadata: bool,
) -> usize {
    let cache_key = (indexed.address.clone(), include_metadata);
    if let Some(weight) = ctx.materialized_weight_cache.get(&cache_key) {
        return *weight;
    }
    if !stack.insert(indexed.address.clone()) {
        return 1;
    }
    let kind = ctx.records[indexed.record].get("kind").unwrap_or("");
    let mut weight = match kind {
        "ObjectNode" => structural_children(plane_for(indexed, ctx), &indexed.address)
            .iter()
            .fold(0usize, |sum, child| {
                sum.saturating_add(measure_weight(child, ctx, stack, true))
            }),
        "ListNode" | "TupleLiteral" | "NodeLiteral" => {
            let mut weight = usize::from(kind == "NodeLiteral");
            for child in structural_children(plane_for(indexed, ctx), &indexed.address) {
                weight = weight.saturating_add(measure_weight(&child, ctx, stack, false));
                if include_metadata
                    && matches!(child.segment, Segment::Index(_))
                    && ctx.records[child.record].get("kind") != Some("NodeLiteral")
                {
                    weight = weight.saturating_add(measure_attribute_weight(&child, ctx, stack));
                }
            }
            weight
        }
        "CloneReference" => {
            let target = ctx.records[indexed.record].get("value").unwrap_or("");
            ctx.body
                .by_address
                .get(target)
                .cloned()
                .map_or(1, |target| measure_weight(&target, ctx, stack, false))
        }
        _ => 1,
    };
    if include_metadata || kind == "NodeLiteral" {
        weight = weight.saturating_add(measure_attribute_weight(indexed, ctx, stack));
    }
    stack.remove(&indexed.address);
    ctx.materialized_weight_cache.insert(cache_key, weight);
    weight
}

fn measure_attribute_weight(
    indexed: &IndexedRecord,
    ctx: &mut Context<'_>,
    stack: &mut BTreeSet<String>,
) -> usize {
    attribute_children(plane_for(indexed, ctx), &indexed.address)
        .iter()
        .fold(0usize, |sum, child| {
            sum.saturating_add(measure_weight(child, ctx, stack, true))
        })
}

fn record_metadata(
    indexed: &IndexedRecord,
    ctx: &mut Context<'_>,
    output_path: &str,
) -> Option<JsonValue> {
    let own = (ctx.records[indexed.record].get("kind") != Some("NodeLiteral"))
        .then(|| attributes_to_json(indexed, ctx, output_path))
        .flatten();
    let items = indexed_item_attributes(indexed, ctx, output_path);
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

fn attributes_to_json(
    indexed: &IndexedRecord,
    ctx: &mut Context<'_>,
    output_path: &str,
) -> Option<JsonValue> {
    let children = attribute_children(plane_for(indexed, ctx), &indexed.address);
    let mut object = Map::new();
    let mut nested = Map::new();
    for child in children {
        let Segment::Attribute(key) = child.segment.clone() else {
            continue;
        };
        let child_path = descendant_path(indexed, &child, output_path);
        if !safe_member(&key, &child_path, ctx) {
            continue;
        }
        object.insert(key.clone(), materialize_record(&child, ctx, &child_path));
        if let Some(metadata) = record_metadata(&child, ctx, &child_path) {
            nested.insert(key, metadata);
        }
    }
    if !nested.is_empty() {
        object.insert("@".to_owned(), JsonValue::Object(nested));
    }
    (!object.is_empty()).then(|| JsonValue::Object(object))
}

fn indexed_item_attributes(
    indexed: &IndexedRecord,
    ctx: &mut Context<'_>,
    output_path: &str,
) -> Option<JsonValue> {
    let kind = ctx.records[indexed.record].get("kind").unwrap_or("");
    let owners = if matches!(kind, "NodeLiteral" | "ListNode" | "TupleLiteral") {
        structural_children(plane_for(indexed, ctx), &indexed.address)
    } else {
        Vec::new()
    };
    let mut object = Map::new();
    for owner in owners {
        let Segment::Index(index) = &owner.segment else {
            continue;
        };
        if ctx.records[owner.record].get("kind") == Some("NodeLiteral") {
            continue;
        }
        let owner_path = descendant_path(indexed, &owner, output_path);
        if let Some(attributes) = attributes_to_json(&owner, ctx, &owner_path) {
            object.insert(index.clone(), attributes);
        }
    }
    (!object.is_empty()).then(|| JsonValue::Object(object))
}

// A cloned descendant keeps its suffix from the input stream.
fn descendant_path<'a>(
    parent: &IndexedRecord,
    child: &'a IndexedRecord,
    output_path: &str,
) -> Cow<'a, str> {
    if output_path == parent.address {
        Cow::Borrowed(&child.address)
    } else {
        Cow::Owned(format!(
            "{output_path}{}",
            &child.address[parent.address.len()..]
        ))
    }
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
    let resolved = resolve_radix_base_from_components(
        record.get("datatype"),
        record
            .datatype()
            .map_or(&[], |datatype| datatype.clarifiers.as_slice()),
    );
    let message = match resolved {
        RadixBaseResolution::Invalid => Some(
            "Invalid declared radix base: expected one integral number from 2 to 64".to_owned(),
        ),
        RadixBaseResolution::Base(base)
            if normalized.chars().any(|character| {
                !matches!(character, '+' | '-' | '.')
                    && radix_digit_value(character).is_none_or(|digit| digit >= base)
            }) =>
        {
            Some(format!(
                "Radix literal exceeds declared radix {base}: %{normalized}"
            ))
        }
        _ => None,
    };
    if let Some(message) = message {
        report(ctx, message, "FINALIZE_INVALID_RADIX_BASE", path, false);
    }
    JsonValue::String(normalized)
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
    fn portable_clone_chain_honors_the_receiving_radix_inside_an_attribute() {
        for (digit, invalid) in [("f", true), ("F", false)] {
            let telex = format!(
                "telex.aes=1

path=$.raw
kind=RadixLiteral
datatype=radix[64]
value={digit}

path=$.relay
kind=CloneReference
datatype=radix[64]
value=$.raw

path=$.box
kind=ObjectNode

path=$.box.x
kind=NumberLiteral
datatype=int
value=0

path=$.box.x.@.r
kind=ObjectNode
datatype=object

path=$.box.x.@.r.s
kind=CloneReference
datatype=radix16
value=$.relay

path=$.copy
kind=CloneReference
value=$.box
"
            );
            let parsed = aes_telex::parse_telex(&telex).expect("valid Telex");
            for mode in [FinalizeMode::Strict, FinalizeMode::Loose] {
                let result = finalize_portable_json(
                    &parsed.records,
                    FinalizePortableJsonOptions {
                        mode,
                        ..FinalizePortableJsonOptions::default()
                    },
                );
                assert_eq!(result.document["box"]["x"], 0);
                assert_eq!(result.document["copy"], result.document["box"]);
                assert_eq!(result.document["copy"]["@"]["x"]["r"]["s"], digit);
                let diagnostics = if mode == FinalizeMode::Strict {
                    assert!(result.meta.warnings.is_empty());
                    &result.meta.errors
                } else {
                    assert!(result.meta.errors.is_empty());
                    &result.meta.warnings
                };
                let paths: Vec<_> = diagnostics
                    .iter()
                    .map(|diagnostic| {
                        assert_eq!(diagnostic.code, "FINALIZE_INVALID_RADIX_BASE");
                        diagnostic.path.as_deref().expect("path")
                    })
                    .collect();
                let expected = if invalid {
                    vec!["$.box.x.@.r.s", "$.copy.x.@.r.s"]
                } else {
                    vec![]
                };
                assert_eq!(paths, expected);
            }
        }
    }

    #[test]
    fn rejects_retired_node_records_and_sparse_indexes() {
        let retired = vec![
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
        let nodes = finalize_portable_json(&retired, FinalizePortableJsonOptions::default());
        let indexes = finalize_portable_json(&sparse, FinalizePortableJsonOptions::default());
        assert!(
            nodes
                .meta
                .errors
                .iter()
                .any(|error| error.code == "AES_INVALID_TAG"),
            "{:?}",
            nodes.meta.errors
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
  <card\NODE\@{role = "button"}(\CHILD\@{lang = "en"}:string = "hello", true)>
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
