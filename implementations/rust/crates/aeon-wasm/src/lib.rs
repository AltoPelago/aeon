use aeon_annotations::{AnnotationRecord, AnnotationTarget, extract_annotations, sort_annotations};
use aeon_canonical::canonicalize;
use aeon_core::{
    AssignmentEvent, AttributeValue, CompileOptions, DatatypePolicy, Diagnostic, HeaderFields,
    LexerOptions, NullLiteralMode, ReferenceSegment, Span, TokenKind, Value, compile, format_path,
    normalize_number_literal, tokenize,
};
use aeon_finalize::{FinalizeMode, FinalizeOptions, FinalizeScope, Materialization, finalize_json};
use serde::Deserialize;
use serde_json::{Value as JsonValue, json};
use wasm_bindgen::prelude::*;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProcessOptions {
    #[serde(default = "default_validation_mode")]
    validation_mode: String,
    #[serde(default = "default_max_input_bytes")]
    max_input_bytes: usize,
    #[serde(default = "default_depth")]
    max_separator_depth: usize,
    #[serde(default = "default_depth")]
    max_attribute_depth: usize,
    #[serde(default = "default_depth")]
    max_generic_depth: usize,
    #[serde(default)]
    materialization_mode: String,
    #[serde(default = "default_finalize_scope")]
    finalize_scope: String,
    #[serde(default)]
    include_paths: Vec<String>,
}

fn default_validation_mode() -> String {
    String::from("strict")
}

fn default_finalize_scope() -> String {
    String::from("payload")
}

const fn default_depth() -> usize {
    1
}

const fn default_max_input_bytes() -> usize {
    1 << 20
}

#[wasm_bindgen]
pub fn process_aeon(source: &str, options_json: &str) -> Result<String, JsValue> {
    process_aeon_json(source, options_json).map_err(|error| JsValue::from_str(&error))
}

pub fn process_aeon_json(source: &str, options_json: &str) -> Result<String, String> {
    let options: ProcessOptions = if options_json.trim().is_empty() {
        ProcessOptions {
            validation_mode: default_validation_mode(),
            max_input_bytes: default_max_input_bytes(),
            max_separator_depth: default_depth(),
            max_attribute_depth: default_depth(),
            max_generic_depth: default_depth(),
            materialization_mode: String::from("all"),
            finalize_scope: default_finalize_scope(),
            include_paths: Vec::new(),
        }
    } else {
        serde_json::from_str(options_json)
            .map_err(|error| format!("invalid options JSON: {error}"))?
    };

    let result = process(source, &options);
    serde_json::to_string(&result).map_err(|error| format!("failed to serialize response: {error}"))
}

fn process(source: &str, options: &ProcessOptions) -> JsonValue {
    if source.len() > options.max_input_bytes {
        return json!({
            "canonical": "",
            "finalized": null,
            "annotations": [],
            "events": [],
            "warnings": [],
            "errors": [{
                "code": "INPUT_SIZE_EXCEEDED",
                "path": "$",
                "span": {
                    "start": { "line": 1, "column": 1, "offset": 0 },
                    "end": { "line": 1, "column": 1, "offset": 0 },
                },
                "phase": 0,
                "message": format!(
                    "Input size {} bytes exceeds configured limit of {} bytes",
                    source.len(),
                    options.max_input_bytes
                ),
            }],
        });
    }

    let canonical = canonicalize(source);
    let annotations = annotations_json(source);

    if !canonical.errors.is_empty() {
        return json!({
            "canonical": "",
            "finalized": null,
            "annotations": annotations,
            "events": [],
            "warnings": [],
            "errors": diagnostics_json(&canonical.errors),
        });
    }

    if options.validation_mode == "none" {
        return json!({
            "canonical": canonical.text,
            "finalized": null,
            "annotations": annotations,
            "events": [],
            "warnings": [],
            "errors": [],
        });
    }

    let compile_result = compile(
        &apply_validation_mode(source, &options.validation_mode),
        compile_options(options),
    );

    let events = events_json(
        &compile_result.events,
        compile_result.header.as_ref(),
        &options.finalize_scope,
    );

    if !compile_result.errors.is_empty() {
        return json!({
            "canonical": canonical.text,
            "finalized": null,
            "annotations": annotations,
            "events": events,
            "warnings": [],
            "errors": diagnostics_json(&compile_result.errors),
        });
    }

    let finalized = finalize_json(
        &compile_result.events,
        finalize_options(options, compile_result.header),
    );

    json!({
        "canonical": canonical.text,
        "finalized": finalized.document,
        "annotations": annotations,
        "events": events,
        "warnings": diagnostics_json(&finalized.meta.warnings),
        "errors": diagnostics_json(&finalized.meta.errors),
    })
}

fn compile_options(options: &ProcessOptions) -> CompileOptions {
    CompileOptions {
        recovery: true,
        max_input_bytes: Some(options.max_input_bytes),
        max_separator_depth: options.max_separator_depth,
        max_attribute_depth: options.max_attribute_depth,
        max_generic_depth: options.max_generic_depth,
        datatype_policy: match options.validation_mode.as_str() {
            "strict" => Some(DatatypePolicy::ReservedOnly),
            "custom" => Some(DatatypePolicy::AllowCustom),
            _ => None,
        },
        ..CompileOptions::default()
    }
}

fn finalize_options(options: &ProcessOptions, header: Option<HeaderFields>) -> FinalizeOptions {
    FinalizeOptions {
        mode: if options.validation_mode == "loose" {
            FinalizeMode::Loose
        } else {
            FinalizeMode::Strict
        },
        materialization: if options.materialization_mode == "projected" {
            Materialization::Projected
        } else {
            Materialization::All
        },
        include_paths: options.include_paths.clone(),
        scope: match options.finalize_scope.as_str() {
            "full" => FinalizeScope::Full,
            "header" => FinalizeScope::Header,
            _ => FinalizeScope::Payload,
        },
        header,
        ..FinalizeOptions::default()
    }
}

fn apply_validation_mode(source: &str, mode: &str) -> String {
    if mode == "none" {
        return source.to_owned();
    }

    let compile_mode = if mode == "loose" { "transport" } else { mode };
    if let Some(updated) = replace_structured_header_mode(source, compile_mode) {
        return updated;
    }
    if let Some((_, close_index)) = find_structured_header_bounds(source) {
        let mut updated = String::with_capacity(source.len() + compile_mode.len() + 14);
        updated.push_str(&source[..close_index]);
        updated.push_str(&format!("\n  mode = \"{compile_mode}\""));
        updated.push_str(&source[close_index..]);
        return updated;
    }
    if let Some(updated) = replace_shorthand_mode(source, compile_mode) {
        return updated;
    }

    format!("aeon:mode = \"{compile_mode}\"\n{source}")
}

fn replace_structured_header_mode(source: &str, compile_mode: &str) -> Option<String> {
    let (open_index, close_index) = find_structured_header_bounds(source)?;
    let mut index = open_index + 1;
    let mut depth = 1usize;
    while index < close_index {
        index = consume_source_trivia(source, index);
        if depth == 1 {
            if let Some(mode_end) = consume_keyword(source, index, "mode") {
                if let Some((value_start, value_end)) =
                    find_mode_value_range(source, mode_end, close_index)
                {
                    let mut updated = String::with_capacity(source.len() + compile_mode.len() + 2);
                    updated.push_str(&source[..value_start]);
                    updated.push_str(compile_mode);
                    updated.push_str(&source[value_end..]);
                    return Some(updated);
                }
            }
        }
        let Some(ch) = source[index..].chars().next() else {
            break;
        };
        match ch {
            '"' | '\'' | '`' => index = consume_quoted_source(source, index),
            '{' => {
                depth += 1;
                index += 1;
            }
            '}' => {
                depth = depth.saturating_sub(1);
                index += 1;
            }
            _ => index += ch.len_utf8(),
        }
    }
    None
}

fn replace_shorthand_mode(source: &str, compile_mode: &str) -> Option<String> {
    let mut index = 0;
    while index < source.len() {
        index = consume_source_trivia(source, index);
        let Some(next) = consume_keyword(source, index, "aeon") else {
            let Some(ch) = source[index..].chars().next() else {
                break;
            };
            index += ch.len_utf8();
            continue;
        };
        index = consume_source_trivia(source, next);
        let Some(next) = consume_literal(source, index, ":") else {
            continue;
        };
        index = consume_source_trivia(source, next);
        let Some(mode_end) = consume_keyword(source, index, "mode") else {
            continue;
        };
        if let Some((value_start, value_end)) =
            find_mode_value_range(source, mode_end, source.len())
        {
            let mut updated = String::with_capacity(source.len() + compile_mode.len() + 2);
            updated.push_str(&source[..value_start]);
            updated.push_str(compile_mode);
            updated.push_str(&source[value_end..]);
            return Some(updated);
        }
    }
    None
}

fn find_mode_value_range(source: &str, mut index: usize, limit: usize) -> Option<(usize, usize)> {
    index = consume_source_trivia(source, index);
    if let Some(next) = consume_literal(source, index, ":") {
        index = next;
        while index < limit && !source[index..].starts_with('=') {
            let ch = source[index..].chars().next()?;
            index += ch.len_utf8();
        }
    }
    index = consume_source_trivia(source, index);
    let next = consume_literal(source, index, "=")?;
    index = consume_source_trivia(source, next);
    let value_start_quote = consume_literal(source, index, "\"")?;
    let value_end = find_closing_quote(source, value_start_quote, '"')?;
    Some((value_start_quote, value_end))
}

fn find_structured_header_bounds(source: &str) -> Option<(usize, usize)> {
    let mut index = 0;
    while index < source.len() {
        index = consume_source_trivia(source, index);
        let Some(next) = consume_keyword(source, index, "aeon") else {
            let Some(ch) = source[index..].chars().next() else {
                break;
            };
            index += ch.len_utf8();
            continue;
        };
        let mut cursor = consume_source_trivia(source, next);
        cursor = consume_literal(source, cursor, ":")?;
        cursor = consume_source_trivia(source, cursor);
        cursor = consume_keyword(source, cursor, "header")?;
        cursor = consume_source_trivia(source, cursor);
        cursor = consume_literal(source, cursor, "=")?;
        cursor = consume_source_trivia(source, cursor);
        if source[cursor..].starts_with('{') {
            let close_index = find_matching_brace(source, cursor)?;
            return Some((cursor, close_index));
        }
        index = cursor;
    }
    None
}

fn find_matching_brace(source: &str, open_index: usize) -> Option<usize> {
    let mut index = open_index;
    let mut depth = 0usize;
    while index < source.len() {
        index = consume_source_trivia(source, index);
        let ch = source[index..].chars().next()?;
        match ch {
            '"' | '\'' | '`' => index = consume_quoted_source(source, index),
            '{' => {
                depth += 1;
                index += 1;
            }
            '}' => {
                depth = depth.checked_sub(1)?;
                if depth == 0 {
                    return Some(index);
                }
                index += 1;
            }
            _ => index += ch.len_utf8(),
        }
    }
    None
}

fn consume_source_trivia(source: &str, mut index: usize) -> usize {
    loop {
        let before = index;
        while let Some(ch) = source[index..].chars().next() {
            if ch.is_whitespace() {
                index += ch.len_utf8();
            } else {
                break;
            }
        }
        if source[index..].starts_with("/#") {
            if let Some(end) = source[index + 2..].find("#/") {
                index += 2 + end + 2;
                continue;
            }
        }
        if source[index..].starts_with("/*") {
            if let Some(end) = source[index + 2..].find("*/") {
                index += 2 + end + 2;
                continue;
            }
        }
        if index == before {
            return index;
        }
    }
}

fn consume_keyword(source: &str, index: usize, literal: &str) -> Option<usize> {
    let next = consume_literal(source, index, literal)?;
    let after = source[next..].chars().next();
    (!after.is_some_and(is_identifier_char)).then_some(next)
}

fn is_identifier_char(ch: char) -> bool {
    ch.is_ascii_alphanumeric() || ch == '_' || ch == '-'
}

fn consume_quoted_source(source: &str, index: usize) -> usize {
    let Some(quote) = source[index..].chars().next() else {
        return index;
    };
    find_closing_quote(source, index + quote.len_utf8(), quote)
        .map_or(source.len(), |end| end + quote.len_utf8())
}

fn find_closing_quote(source: &str, mut index: usize, quote: char) -> Option<usize> {
    while index < source.len() {
        let ch = source[index..].chars().next()?;
        if ch == '\\' {
            index += ch.len_utf8();
            if let Some(escaped) = source[index..].chars().next() {
                index += escaped.len_utf8();
            }
            continue;
        }
        if ch == quote {
            return Some(index);
        }
        index += ch.len_utf8();
    }
    None
}

#[allow(dead_code)]
fn apply_validation_mode_by_line(source: &str, mode: &str) -> String {
    let compile_mode = if mode == "loose" { "transport" } else { mode };
    let lines: Vec<&str> = source.lines().collect();
    let Some(header_start) = lines
        .iter()
        .position(|line| line_has_structured_header_start(line))
    else {
        if has_flexible_header_mode(source) {
            return source.to_owned();
        }
        return format!("aeon:mode = \"{compile_mode}\"\n{source}");
    };

    let mut output = Vec::with_capacity(lines.len() + 1);
    let mut in_header = false;
    let mut mode_written = false;

    for (index, line) in lines.iter().enumerate() {
        if index == header_start {
            in_header = true;
        }

        if in_header && line_starts_with_mode_binding(line) {
            let indent = line
                .chars()
                .take_while(|ch| ch.is_whitespace())
                .collect::<String>();
            let datatype = line
                .split_once('=')
                .and_then(|(left, _)| left.split_once(':').map(|(_, datatype)| datatype.trim()))
                .map_or(String::new(), |datatype| format!(":{datatype}"));
            output.push(format!("{indent}mode{datatype} = \"{compile_mode}\""));
            mode_written = true;
        } else if in_header && line.trim() == "}" && !mode_written {
            output.push(format!("  mode = \"{compile_mode}\""));
            output.push((*line).to_owned());
            mode_written = true;
            in_header = false;
            continue;
        } else {
            output.push((*line).to_owned());
        }

        if in_header && line.trim() == "}" {
            in_header = false;
        }
    }

    output.join("\n")
}

fn line_has_structured_header_start(line: &str) -> bool {
    let mut index = consume_inline_trivia(line, 0);
    let Some(next) = consume_literal(line, index, "aeon") else {
        return false;
    };
    index = consume_inline_trivia(line, next);
    let Some(next) = consume_literal(line, index, ":") else {
        return false;
    };
    index = consume_inline_trivia(line, next);
    let Some(next) = consume_literal(line, index, "header") else {
        return false;
    };
    index = consume_inline_trivia(line, next);
    let Some(next) = consume_literal(line, index, "=") else {
        return false;
    };
    index = consume_inline_trivia(line, next);
    line[index..].starts_with('{')
}

fn line_starts_with_mode_binding(line: &str) -> bool {
    let mut index = consume_inline_trivia(line, 0);
    let Some(next) = consume_literal(line, index, "mode") else {
        return false;
    };
    index = consume_inline_trivia(line, next);
    if let Some(next) = consume_literal(line, index, ":") {
        index = next;
        while index < line.len() {
            index = consume_inline_trivia(line, index);
            if line[index..].starts_with('=') {
                return true;
            }
            let Some(ch) = line[index..].chars().next() else {
                return false;
            };
            index += ch.len_utf8();
        }
        return false;
    }
    index = consume_inline_trivia(line, index);
    line[index..].starts_with('=')
}

fn consume_literal(line: &str, index: usize, literal: &str) -> Option<usize> {
    line[index..]
        .starts_with(literal)
        .then_some(index + literal.len())
}

fn consume_inline_trivia(line: &str, mut index: usize) -> usize {
    loop {
        let before = index;
        while let Some(ch) = line[index..].chars().next() {
            if ch.is_whitespace() {
                index += ch.len_utf8();
            } else {
                break;
            }
        }
        if line[index..].starts_with("/#") {
            if let Some(end) = line[index + 2..].find("#/") {
                index += 2 + end + 2;
                continue;
            }
        }
        if line[index..].starts_with("/*") {
            if let Some(end) = line[index + 2..].find("*/") {
                index += 2 + end + 2;
                continue;
            }
        }
        if index == before {
            return index;
        }
    }
}

fn has_flexible_header_mode(source: &str) -> bool {
    let lexed = tokenize(
        source,
        LexerOptions {
            include_newlines: true,
            ..LexerOptions::default()
        },
    );
    if !lexed.errors.is_empty() {
        return false;
    }

    for index in 0..lexed.tokens.len() {
        let Some(token) = lexed.tokens.get(index) else {
            continue;
        };
        if token.kind != TokenKind::Identifier || token.text != "aeon" {
            continue;
        }

        let Some(colon_index) = next_non_newline_token_index(&lexed.tokens, index + 1) else {
            continue;
        };
        if lexed.tokens[colon_index].kind != TokenKind::Colon {
            continue;
        }

        let Some(field_index) = next_non_newline_token_index(&lexed.tokens, colon_index + 1) else {
            continue;
        };
        let field = &lexed.tokens[field_index];
        if field.kind == TokenKind::Identifier && matches!(field.text.as_str(), "header" | "mode") {
            return true;
        }
    }

    false
}

fn next_non_newline_token_index(tokens: &[aeon_core::Token], mut index: usize) -> Option<usize> {
    while let Some(token) = tokens.get(index) {
        if token.kind != TokenKind::Newline {
            return Some(index);
        }
        index += 1;
    }
    None
}

fn diagnostics_json(diagnostics: &[Diagnostic]) -> Vec<JsonValue> {
    diagnostics
        .iter()
        .map(|diagnostic| {
            json!({
                "code": diagnostic.code,
                "path": diagnostic.path,
                "span": diagnostic.span.as_ref().map(span_json),
                "phase": diagnostic.phase,
                "message": diagnostic.message,
            })
        })
        .collect()
}

fn span_json(span: &Span) -> JsonValue {
    json!({
        "start": {
            "line": span.start.line,
            "column": span.start.column,
            "offset": span.start.offset,
        },
        "end": {
            "line": span.end.line,
            "column": span.end.column,
            "offset": span.end.offset,
        },
    })
}

fn annotations_json(source: &str) -> Vec<JsonValue> {
    sort_annotations(extract_annotations(source))
        .iter()
        .map(annotation_json)
        .collect()
}

fn annotation_json(record: &AnnotationRecord) -> JsonValue {
    let mut payload = json!({
        "kind": record.kind,
        "form": record.form,
        "subtype": record.subtype,
        "raw": record.raw,
        "span": span_json(&record.span),
        "target": match &record.target {
            AnnotationTarget::Path { path } => json!({ "kind": "path", "path": path }),
            AnnotationTarget::Unbound { reason } => json!({ "kind": "unbound", "reason": reason }),
        },
    });
    if let Some(placement) = &record.placement {
        let mut placement_json = json!({});
        if let Some(after) = placement.after {
            placement_json["after"] = json!(after.as_str());
        }
        if let Some(before) = placement.before {
            placement_json["before"] = json!(before.as_str());
        }
        payload["placement"] = placement_json;
    }
    payload
}

fn events_json(
    events: &[AssignmentEvent],
    header: Option<&HeaderFields>,
    scope: &str,
) -> Vec<JsonValue> {
    let mut output = Vec::new();

    if matches!(scope, "header" | "full")
        && let Some(header) = header
    {
        for (key, value) in &header.fields {
            output.push(json!({
                "path": format!("$.[\"aeon:{key}\"]"),
                "key": format!("aeon:{key}"),
                "datatype": null,
                "valueType": value_type_name(value),
            }));
        }
    }

    if scope != "header" {
        output.extend(events.iter().map(|event| {
            json!({
                "path": format_path(&event.path),
                "key": event.key,
                "datatype": event.datatype,
                "valueType": value_type_name(&event.value),
            })
        }));
    }

    output
}

fn value_type_name(value: &Value) -> &'static str {
    match value {
        Value::TypedValue { value, .. } => value_type_name(value),
        _ => value.value_kind(),
    }
}

#[allow(dead_code)]
fn value_json(value: &Value) -> JsonValue {
    match value {
        Value::TypedValue {
            datatype,
            attributes,
            value,
            ..
        } => json!({
            "type": "TypedValue",
            "datatype": datatype,
            "attributes": attributes_json(attributes),
            "value": value_json(value),
        }),
        Value::NumberLiteral { raw } => {
            json!({ "type": "NumberLiteral", "raw": raw, "value": normalize_number_literal(raw) })
        }
        Value::InfinityLiteral { raw, .. } => json!({ "type": "InfinityLiteral", "raw": raw }),
        Value::NaNLiteral { raw, .. } => json!({ "type": "NaNLiteral", "raw": raw }),
        Value::NullLiteral { mode, value, raw } => json!({
            "type": "NullLiteral",
            "mode": match mode {
                NullLiteralMode::Reserved => "reserved",
                NullLiteralMode::Reason => "reason",
            },
            "value": value,
            "raw": raw,
        }),
        Value::StringLiteral { value, raw, .. } => {
            json!({ "type": "StringLiteral", "value": value, "raw": raw })
        }
        Value::ToggleLiteral { raw } => json!({ "type": "ToggleLiteral", "raw": raw }),
        Value::BooleanLiteral { raw } => json!({ "type": "BooleanLiteral", "raw": raw }),
        Value::HexLiteral { raw } => json!({ "type": "HexLiteral", "raw": raw }),
        Value::SeparatorLiteral { raw } => json!({ "type": "SeparatorLiteral", "raw": raw }),
        Value::EncodingLiteral { raw } => json!({ "type": "EncodingLiteral", "raw": raw }),
        Value::RadixLiteral { raw } => json!({ "type": "RadixLiteral", "raw": raw }),
        Value::DateLiteral { raw } => json!({ "type": "DateLiteral", "raw": raw }),
        Value::DateTimeLiteral { raw } => json!({ "type": "DateTimeLiteral", "raw": raw }),
        Value::TimeLiteral { raw } => json!({ "type": "TimeLiteral", "raw": raw }),
        Value::NodeLiteral {
            raw,
            tag,
            datatype,
            children,
            ..
        } => json!({
            "type": "NodeLiteral",
            "raw": raw,
            "tag": tag,
            "datatype": datatype,
            "children": children.iter().map(value_json).collect::<Vec<_>>(),
        }),
        Value::ListNode { items } => {
            json!({ "type": "ListNode", "items": items.iter().map(value_json).collect::<Vec<_>>() })
        }
        Value::TupleLiteral { items } => {
            json!({ "type": "TupleLiteral", "items": items.iter().map(value_json).collect::<Vec<_>>() })
        }
        Value::ObjectNode { bindings } => json!({
            "type": "ObjectNode",
            "bindings": bindings.iter().map(binding_json).collect::<Vec<_>>(),
        }),
        Value::CloneReference { segments, .. } => {
            json!({ "type": "CloneReference", "segments": reference_segments_json(segments) })
        }
        Value::PointerReference { segments, .. } => {
            json!({ "type": "PointerReference", "segments": reference_segments_json(segments) })
        }
    }
}

#[allow(dead_code)]
fn binding_json(binding: &aeon_core::Binding) -> JsonValue {
    json!({
        "key": binding.key,
        "datatype": binding.datatype,
        "attributes": attributes_json(&binding.attributes),
        "value": value_json(&binding.value),
        "span": span_json(&binding.span),
    })
}

#[allow(dead_code)]
fn attributes_json(attributes: &std::collections::BTreeMap<String, AttributeValue>) -> JsonValue {
    JsonValue::Object(
        attributes
            .iter()
            .map(|(key, value)| (key.clone(), attribute_json(value)))
            .collect(),
    )
}

#[allow(dead_code)]
fn attribute_json(attribute: &AttributeValue) -> JsonValue {
    json!({
        "datatype": attribute.datatype,
        "value": attribute.value.as_ref().map(value_json),
        "nestedAttrs": attributes_json(&attribute.nested_attrs),
        "objectMembers": attributes_json(&attribute.object_members),
    })
}

#[allow(dead_code)]
fn reference_segments_json(segments: &[ReferenceSegment]) -> Vec<JsonValue> {
    segments
        .iter()
        .map(|segment| match segment {
            ReferenceSegment::Key(key) => json!({ "type": "key", "key": key }),
            ReferenceSegment::Index(index) => json!({ "type": "index", "index": index }),
            ReferenceSegment::Attr(key) => json!({ "type": "attr", "key": key }),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::process_aeon_json;
    use serde_json::Value as JsonValue;

    #[test]
    fn processes_basic_document() {
        let output = process_aeon_json(
            "a:string = \"ok\"\n",
            r#"{"validationMode":"strict","maxSeparatorDepth":8,"finalizeScope":"payload"}"#,
        )
        .expect("process aeon");
        let parsed: JsonValue = serde_json::from_str(&output).expect("valid json");

        assert_eq!(parsed["errors"].as_array().expect("errors").len(), 0);
        assert_eq!(parsed["finalized"]["a"], "ok");
        assert_eq!(parsed["events"][0]["path"], "$.a");
    }

    #[test]
    fn binds_block_annotation_between_equals_and_value_to_current_field() {
        let output = process_aeon_json(
            "app:object = {\n  name:string = \"alignment playground\"\n  enabled:boolean = /# h #/ true\n  port:number = 8080\n}\n",
            r#"{"validationMode":"strict","maxSeparatorDepth":8,"finalizeScope":"payload"}"#,
        )
        .expect("process aeon");
        let parsed: JsonValue = serde_json::from_str(&output).expect("valid json");

        assert_eq!(parsed["errors"].as_array().expect("errors").len(), 0);
        assert_eq!(parsed["annotations"][0]["target"]["path"], "$.app.enabled");
        assert_eq!(parsed["annotations"][0]["placement"]["after"], "equals");
        assert_eq!(parsed["annotations"][0]["placement"]["before"], "value");
    }

    #[test]
    fn omits_null_placement_sides() {
        let output = process_aeon_json(
            "/# top #/\nname:string = \"alignment playground\"\n",
            r#"{"validationMode":"strict","maxSeparatorDepth":8,"finalizeScope":"payload"}"#,
        )
        .expect("process aeon");
        let parsed: JsonValue = serde_json::from_str(&output).expect("valid json");
        let placement = parsed["annotations"][0]["placement"]
            .as_object()
            .expect("placement object");

        assert!(!placement.contains_key("after"));
        assert_eq!(placement.get("before").expect("before"), "key");
    }

    #[test]
    fn validation_mode_detects_tokenized_structured_header() {
        let output = process_aeon_json(
            "aeon\n:\nheader /# #/=   /# #/{\n  mode:\nstring = \"strict\"\n}\n",
            r#"{"validationMode":"strict","maxSeparatorDepth":8,"finalizeScope":"full"}"#,
        )
        .expect("process aeon");
        let parsed: JsonValue = serde_json::from_str(&output).expect("valid json");

        assert_eq!(parsed["errors"], serde_json::json!([]));
        assert_eq!(parsed["finalized"]["header"]["mode"], "strict");
    }

    #[test]
    fn processes_flexible_structured_header_without_injecting_shorthand_mode() {
        let output = process_aeon_json(
            "aeon\n:\nheader /# #/= /# #/{\n  mode:\nstring = \"strict\"\n  encoding:string = \"utf-8\"\n}\n",
            r#"{"validationMode":"strict","maxSeparatorDepth":8,"finalizeScope":"full"}"#,
        )
        .expect("process aeon");
        let parsed: JsonValue = serde_json::from_str(&output).expect("valid json");

        assert_eq!(parsed["errors"].as_array().expect("errors").len(), 0);
        assert_eq!(parsed["finalized"]["header"]["mode"], "strict");
        assert_eq!(parsed["finalized"]["header"]["encoding"], "utf-8");
        assert_eq!(parsed["events"][0]["path"], "$.[\"aeon:encoding\"]");
        assert_eq!(parsed["events"][1]["path"], "$.[\"aeon:mode\"]");
    }

    #[test]
    fn fails_closed_when_max_input_bytes_is_exceeded() {
        let output = process_aeon_json(
            "value:string = \"too large\"\n",
            r#"{"validationMode":"strict","maxInputBytes":8}"#,
        )
        .expect("process aeon");
        let parsed: JsonValue = serde_json::from_str(&output).expect("valid json");

        assert_eq!(parsed["canonical"], "");
        assert_eq!(parsed["annotations"], serde_json::json!([]));
        assert_eq!(parsed["errors"][0]["code"], "INPUT_SIZE_EXCEEDED");
        assert_eq!(parsed["errors"][0]["phase"], 0);
    }
}
