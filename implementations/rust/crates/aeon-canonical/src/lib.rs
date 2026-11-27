#![allow(clippy::result_large_err)]

use std::collections::BTreeMap;

use aeon_core::{Diagnostic, Span, normalize_number_literal};

pub use aes_telex::{canonicalize_telex, canonicalize_telex_with_limits};

mod reference_safe;
pub use reference_safe::{CanonicalOrdering, CanonicalizeOptions, canonicalize_with_options};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CanonicalResult {
    pub text: String,
    pub errors: Vec<Diagnostic>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Binding {
    rank: Option<usize>,
    canonical_key: bool,
    key: String,
    structural_id: Option<String>,
    datatype: Option<String>,
    attributes: BTreeMap<String, AttributeEntry>,
    value: Value,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct AttributeEntry {
    rank: Option<usize>,
    structural_id: Option<String>,
    datatype: Option<String>,
    attributes: BTreeMap<String, AttributeEntry>,
    value: Value,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct NodeValue {
    canonical_key: bool,
    tag: String,
    structural_id: Option<String>,
    datatype: Option<String>,
    attributes: BTreeMap<String, AttributeEntry>,
    children: Vec<Value>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Value {
    Attributed {
        canonical_head: bool,
        structural_id: Option<String>,
        attributes: BTreeMap<String, AttributeEntry>,
        datatype: Option<String>,
        value: Box<Value>,
    },
    String {
        value: String,
        trimticks: bool,
    },
    Symbol(String),
    Separator(String),
    Number(String),
    Null {
        mode: NullMode,
        value: String,
    },
    Object(Vec<Binding>),
    List(Vec<Value>),
    Tuple(Vec<Value>),
    Node(NodeValue),
    Raw(String),
    Reference {
        segments: Vec<reference_safe::Segment>,
        pointer: bool,
        span: Span,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum NullMode {
    Reserved,
    Reason,
}

#[must_use]
pub fn canonicalize(source: &str) -> CanonicalResult {
    canonicalize_with_options(source, &CanonicalizeOptions::default())
}

fn default_header() -> Vec<Binding> {
    vec![
        Binding::scalar(
            "encoding",
            Value::String {
                value: String::from("utf-8"),
                trimticks: false,
            },
        ),
        Binding::scalar(
            "mode",
            Value::String {
                value: String::from("transport"),
                trimticks: false,
            },
        ),
        Binding::scalar(
            "profile",
            Value::String {
                value: String::from("core"),
                trimticks: false,
            },
        ),
        Binding::scalar(
            "version",
            Value::String {
                value: String::from("1.0"),
                trimticks: false,
            },
        ),
    ]
}

fn render_document(mut header: Vec<Binding>, mut body: Vec<Binding>) -> String {
    header.sort_by(compare_bindings);
    body.sort_by(compare_bindings);

    let mut lines = Vec::new();
    lines.push(String::from("aeon:header = {"));
    for binding in header {
        lines.extend(render_binding(&binding, 2));
    }
    lines.push(String::from("}"));
    for binding in body {
        lines.extend(render_binding(&binding, 0));
    }
    let mut text = lines.join("\n");
    if !text.is_empty() {
        text.push('\n');
    }
    text
}

fn render_binding(binding: &Binding, indent: usize) -> Vec<String> {
    if binding.canonical_key
        && let Value::Node(node) = &binding.value
    {
        return render_node(node, indent, false);
    }
    let prefix = " ".repeat(indent);
    let left = format!(
        "{}{}{}{}{}",
        prefix,
        render_binding_key(binding),
        render_structural_identity(binding.structural_id.as_deref()),
        render_attributes(&binding.attributes),
        render_canonical_datatype(binding.datatype.as_deref(), binding.canonical_key)
    );

    match &binding.value {
        Value::Object(bindings) => {
            let mut nested = bindings.clone();
            nested.sort_by(compare_bindings);
            let mut lines = vec![format!("{left} = {{")];
            for binding in nested {
                lines.extend(render_binding(&binding, indent + 2));
            }
            lines.push(format!("{prefix}}}"));
            lines
        }
        Value::List(items) => render_sequence(&left, items, indent, '[', ']'),
        Value::Tuple(items) => render_sequence(&left, items, indent, '(', ')'),
        Value::Node(node) => {
            let rendered = render_node(node, indent, false);
            if rendered.len() == 1 {
                vec![format!("{left} = {}", rendered[0].trim_start())]
            } else {
                let mut lines = vec![format!("{left} = {}", rendered[0].trim_start())];
                lines.extend(rendered.into_iter().skip(1));
                lines
            }
        }
        Value::String {
            value,
            trimticks: true,
        } if value.contains('\n') => {
            let rendered = render_trimtick_lines(value, indent);
            let mut lines = vec![format!("{left} = {}", rendered[0])];
            lines.extend(rendered.into_iter().skip(1));
            lines
        }
        other => vec![format!("{left} = {}", render_value_inline(other))],
    }
}

fn render_sequence(
    left: &str,
    items: &[Value],
    indent: usize,
    open: char,
    close: char,
) -> Vec<String> {
    if items.iter().all(is_simple_scalar) {
        let rendered = items
            .iter()
            .map(render_value_inline)
            .collect::<Vec<_>>()
            .join(", ");
        return vec![format!("{left} = {open}{rendered}{close}")];
    }

    let prefix = " ".repeat(indent);
    let mut lines = vec![format!("{left} = {open}")];
    for (index, item) in items.iter().enumerate() {
        let mut item_lines = render_value_multiline(item, indent + 2);
        if index + 1 < items.len()
            && let Some(last) = item_lines.last_mut()
        {
            last.push(',');
        }
        lines.append(&mut item_lines);
    }
    lines.push(format!("{prefix}{close}"));
    lines
}

fn render_value_multiline(value: &Value, indent: usize) -> Vec<String> {
    let prefix = " ".repeat(indent);
    match value {
        Value::Attributed {
            canonical_head,
            structural_id,
            attributes,
            datatype,
            value,
        } => {
            let rendered = render_value_multiline(value, indent);
            let head = format!(
                "{}{}{}",
                render_structural_identity(structural_id.as_deref()),
                render_attributes(attributes),
                render_canonical_datatype(datatype.as_deref(), *canonical_head)
            );
            if let Some((first, rest)) = rendered.split_first() {
                let first = first.strip_prefix(&prefix).unwrap_or(first);
                let mut lines = vec![format!("{prefix}{head} = {first}")];
                lines.extend(rest.iter().cloned());
                lines
            } else {
                vec![format!("{prefix}{head} = ")]
            }
        }
        Value::String {
            value,
            trimticks: true,
        } if value.contains('\n') => {
            let mut lines = render_trimtick_lines(value, indent);
            if let Some(first) = lines.first_mut() {
                *first = format!("{prefix}{first}");
            }
            lines
        }
        Value::Object(bindings) => {
            let mut nested = bindings.clone();
            nested.sort_by(compare_bindings);
            let mut lines = vec![format!("{prefix}{{")];
            for binding in nested {
                lines.extend(render_binding(&binding, indent + 2));
            }
            lines.push(format!("{prefix}}}"));
            lines
        }
        Value::List(items) => {
            let mut lines = vec![format!("{prefix}[")];
            for (index, item) in items.iter().enumerate() {
                let mut item_lines = render_value_multiline(item, indent + 2);
                if index + 1 < items.len()
                    && let Some(last) = item_lines.last_mut()
                {
                    last.push(',');
                }
                lines.append(&mut item_lines);
            }
            lines.push(format!("{prefix}]"));
            lines
        }
        Value::Tuple(items) => {
            let mut lines = vec![format!("{prefix}(")];
            for (index, item) in items.iter().enumerate() {
                let mut item_lines = render_value_multiline(item, indent + 2);
                if index + 1 < items.len()
                    && let Some(last) = item_lines.last_mut()
                {
                    last.push(',');
                }
                lines.append(&mut item_lines);
            }
            lines.push(format!("{prefix})"));
            lines
        }
        Value::Node(node) => render_node(node, indent, false),
        other => vec![format!("{prefix}{}", render_value_inline(other))],
    }
}

fn render_node(node: &NodeValue, indent: usize, inline_only: bool) -> Vec<String> {
    let prefix = " ".repeat(indent);
    let head = format!(
        "<{}{}{}{}",
        render_head_key(
            &node.tag,
            node.canonical_key,
            node.structural_id.as_deref(),
            &node.attributes,
            node.datatype.as_deref()
        ),
        render_structural_identity(node.structural_id.as_deref()),
        render_attributes(&node.attributes),
        render_canonical_datatype(node.datatype.as_deref(), node.canonical_key)
    );

    if node.children.is_empty() {
        return vec![format!("{prefix}{head}>")];
    }

    if inline_only {
        let children = node
            .children
            .iter()
            .map(render_value_inline)
            .collect::<Vec<_>>()
            .join(", ");
        return vec![format!("{prefix}{head}({children})>")];
    }

    let mut lines = vec![format!("{prefix}{head}(")];
    for (index, child) in node.children.iter().enumerate() {
        let mut child_lines = render_node_child(child, indent + 2);
        if index + 1 < node.children.len()
            && let Some(last) = child_lines.last_mut()
        {
            last.push(',');
        }
        lines.append(&mut child_lines);
    }
    lines.push(format!("{prefix})>"));
    lines
}

fn render_node_child(value: &Value, indent: usize) -> Vec<String> {
    match value {
        Value::Attributed {
            canonical_head: true,
            structural_id,
            attributes,
            datatype,
            value,
        } => {
            let mut rendered = render_node_child(value, indent);
            if let Some(first) = rendered.first_mut() {
                *first = format!(
                    "{}{}{}{} = {}",
                    " ".repeat(indent),
                    render_structural_identity(structural_id.as_deref()),
                    render_attributes(attributes),
                    render_canonical_datatype(datatype.as_deref(), true),
                    first.trim_start()
                );
            }
            rendered
        }
        Value::List(items) if items.iter().all(is_simple_value) => {
            vec![format!(
                "{}{}",
                " ".repeat(indent),
                render_value_inline(value)
            )]
        }
        Value::Tuple(items) if items.iter().all(is_simple_value) => {
            vec![format!(
                "{}{}",
                " ".repeat(indent),
                render_value_inline(value)
            )]
        }
        Value::Node(node) if node.children.iter().all(is_simple_value) => {
            vec![format!(
                "{}{}",
                " ".repeat(indent),
                render_value_inline(value)
            )]
        }
        _ => render_value_multiline(value, indent),
    }
}

fn render_attributes(attributes: &BTreeMap<String, AttributeEntry>) -> String {
    if attributes.is_empty() {
        return String::new();
    }

    let mut entries: Vec<_> = attributes.iter().collect();
    entries.sort_by(|(a, left), (b, right)| match (left.rank, right.rank) {
        (Some(a), Some(b)) => a.cmp(&b),
        _ => a.cmp(b),
    });
    let rendered = entries
        .into_iter()
        .map(|(key, entry)| {
            if entry.rank.is_some() && matches!(entry.value, Value::Node(_)) {
                return render_value_inline_with_contract(&entry.value, true);
            }
            format!(
                "{}{}{}{} = {}",
                render_head_key(
                    key,
                    entry.rank.is_some(),
                    entry.structural_id.as_deref(),
                    &entry.attributes,
                    entry.datatype.as_deref()
                ),
                render_structural_identity(entry.structural_id.as_deref()),
                render_attributes(&entry.attributes),
                render_canonical_datatype(entry.datatype.as_deref(), entry.rank.is_some()),
                render_value_inline_with_contract(&entry.value, entry.rank.is_some())
            )
        })
        .collect::<Vec<_>>()
        .join(", ");

    format!("@{{{rendered}}}")
}

fn render_value_inline(value: &Value) -> String {
    render_value_inline_with_contract(value, false)
}

// Attribute values use compact rendering recursively. Preserve historical
// empty-object bytes unless the ordering planner supplied the explicit contract.
fn render_value_inline_with_contract(value: &Value, reference_safe: bool) -> String {
    match value {
        Value::Attributed {
            canonical_head,
            structural_id,
            attributes,
            datatype,
            value,
        } => {
            format!(
                "{}{}{} = {}",
                render_structural_identity(structural_id.as_deref()),
                render_attributes(attributes),
                render_canonical_datatype(datatype.as_deref(), *canonical_head),
                render_value_inline_with_contract(value, reference_safe || *canonical_head)
            )
        }
        Value::String { value, trimticks } => {
            if *trimticks {
                format_compact_trimtick(value)
            } else {
                format!("\"{}\"", escape_string(value))
            }
        }
        Value::Symbol(value) => format_symbol(value),
        // Native separators are literal data, not legacy raw/reference text.
        Value::Separator(raw) => raw.clone(),
        Value::Number(value) => normalize_number(value),
        Value::Null { mode, value } => match mode {
            NullMode::Reserved => format!("!{value}"),
            NullMode::Reason => format!("!\"{}\"", escape_string(value)),
        },
        Value::Object(bindings) => {
            if bindings.is_empty() {
                return String::from(if reference_safe { "{  }" } else { "{}" });
            }
            let mut nested = bindings.clone();
            nested.sort_by(compare_bindings);
            format!(
                "{{ {} }}",
                nested
                    .iter()
                    .map(|binding| {
                        if binding.canonical_key && matches!(binding.value, Value::Node(_)) {
                            return render_value_inline_with_contract(&binding.value, true);
                        }
                        format!(
                            "{}{}{}{} = {}",
                            render_binding_key(binding),
                            render_structural_identity(binding.structural_id.as_deref()),
                            render_attributes(&binding.attributes),
                            render_canonical_datatype(
                                binding.datatype.as_deref(),
                                binding.canonical_key
                            ),
                            render_value_inline_with_contract(
                                &binding.value,
                                reference_safe || binding.canonical_key,
                            )
                        )
                    })
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        }
        Value::List(items) => format!(
            "[{}]",
            items
                .iter()
                .map(|item| render_value_inline_with_contract(item, reference_safe))
                .collect::<Vec<_>>()
                .join(", ")
        ),
        Value::Tuple(items) => format!(
            "({})",
            items
                .iter()
                .map(|item| render_value_inline_with_contract(item, reference_safe))
                .collect::<Vec<_>>()
                .join(", ")
        ),
        Value::Node(node) => {
            let head = format!(
                "<{}{}{}{}",
                render_head_key(
                    &node.tag,
                    node.canonical_key,
                    node.structural_id.as_deref(),
                    &node.attributes,
                    node.datatype.as_deref()
                ),
                if node.canonical_key {
                    render_structural_identity(node.structural_id.as_deref())
                } else {
                    String::new()
                },
                render_attributes(&node.attributes),
                render_canonical_datatype(node.datatype.as_deref(), node.canonical_key)
            );
            if node.children.is_empty() {
                format!("{head}>")
            } else {
                format!(
                    "{head}({})>",
                    node.children
                        .iter()
                        .map(|child| {
                            render_value_inline_with_contract(
                                child,
                                reference_safe || node.canonical_key,
                            )
                        })
                        .collect::<Vec<_>>()
                        .join(", ")
                )
            }
        }
        Value::Raw(value) => normalize_raw(value),
        Value::Reference {
            segments, pointer, ..
        } => format!(
            "{}{}",
            if *pointer { "~>" } else { "~" },
            reference_safe::render_path(segments)
        ),
    }
}

fn render_key(key: &str) -> String {
    if is_identifier(key) || key.starts_with("aeon:") {
        key.to_owned()
    } else {
        format!("\"{}\"", escape_string(key))
    }
}

fn render_canonical_key(key: &str, canonical: bool) -> String {
    if canonical && !is_identifier(key) {
        format!("\"{}\"", escape_string(key))
    } else {
        render_key(key)
    }
}

fn render_binding_key(binding: &Binding) -> String {
    render_head_key(
        &binding.key,
        binding.canonical_key,
        binding.structural_id.as_deref(),
        &binding.attributes,
        binding.datatype.as_deref(),
    )
}

fn render_head_key(
    key: &str,
    canonical: bool,
    structural_id: Option<&str>,
    attributes: &BTreeMap<String, AttributeEntry>,
    datatype: Option<&str>,
) -> String {
    // Bare `aeon:` is one namespace token even inside metadata and node heads.
    // An emitted identity or nonempty attribute head separates the key from
    // the colon; otherwise preserve quoting when a datatype follows directly.
    if canonical
        && key == "aeon"
        && structural_id.is_none()
        && attributes.is_empty()
        && datatype.is_some()
    {
        return String::from("\"aeon\"");
    }
    render_canonical_key(key, canonical)
}

fn compare_bindings(left: &Binding, right: &Binding) -> std::cmp::Ordering {
    match (left.rank, right.rank) {
        (Some(a), Some(b)) => a.cmp(&b),
        _ => left.key.cmp(&right.key),
    }
}

fn render_datatype(datatype: Option<&str>) -> String {
    datatype
        .map(|datatype| format!(":{}", normalize_datatype(datatype)))
        .unwrap_or_default()
}

fn render_canonical_datatype(datatype: Option<&str>, canonical: bool) -> String {
    if canonical {
        datatype
            .map(|value| format!(":{value}"))
            .unwrap_or_default()
    } else {
        render_datatype(datatype)
    }
}

fn render_structural_identity(structural_id: Option<&str>) -> String {
    structural_id
        .map(|value| format!("\\{value}\\"))
        .unwrap_or_default()
}

fn is_simple_scalar(value: &Value) -> bool {
    match value {
        Value::Attributed { value, .. } => is_simple_scalar(value),
        Value::String { value, trimticks } => !*trimticks || !value.contains('\n'),
        Value::Symbol(_)
        | Value::Separator(_)
        | Value::Number(_)
        | Value::Null { .. }
        | Value::Raw(_)
        | Value::Reference { .. } => true,
        _ => false,
    }
}

fn is_simple_value(value: &Value) -> bool {
    match value {
        Value::Attributed { value, .. } => is_simple_value(value),
        Value::String { value, trimticks } => !*trimticks || !value.contains('\n'),
        Value::Symbol(_)
        | Value::Separator(_)
        | Value::Number(_)
        | Value::Null { .. }
        | Value::Raw(_)
        | Value::Reference { .. } => true,
        _ => false,
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

fn escape_string(value: &str) -> String {
    let mut out = String::new();
    for ch in value.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            ch if (ch as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", ch as u32)),
            _ => out.push(ch),
        }
    }
    out
}

fn format_symbol(value: &str) -> String {
    let mut out = String::from("|");
    for ch in value.chars() {
        match ch {
            '|' => out.push_str("\\|"),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            ch if (ch as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", ch as u32)),
            _ => out.push(ch),
        }
    }
    out.push('|');
    out
}

fn render_trimtick_lines(value: &str, indent: usize) -> Vec<String> {
    if !value.contains('\n') {
        return vec![format_compact_trimtick(value)];
    }
    let nonblank = value.split('\n').filter(|line| !line.is_empty());
    if nonblank.clone().next().is_some() && nonblank.clone().all(|line| line.starts_with(' ')) {
        return vec![format_compact_trimtick(value)];
    }
    let prefix = " ".repeat(indent);
    let body_prefix = " ".repeat(indent + 2);
    let mut lines = vec![String::from(">`")];
    lines.extend(
        value
            .split('\n')
            .map(|line| format!("{body_prefix}{}", escape_trimtick_line(line))),
    );
    lines.push(format!("{prefix}`"));
    lines
}

fn format_compact_trimtick(value: &str) -> String {
    if !value.contains('\n') {
        return format!(">`{}`", escape_trimtick_line(value));
    }
    let first_nonblank = value
        .split('\n')
        .find(|line| !line.is_empty())
        .unwrap_or("");
    let gutter = if first_nonblank.starts_with(' ') {
        '\t'
    } else {
        ' '
    };
    let mut protected_value = value
        .split('\n')
        .map(|line| {
            if line.is_empty() {
                String::new()
            } else {
                format!("{gutter}{line}")
            }
        })
        .collect::<Vec<_>>()
        .join("\n");
    if value.starts_with('\n') {
        protected_value.insert(0, '\n');
    }
    format!(">`{}`", escape_trimtick_line(&protected_value))
}

fn escape_trimtick_line(value: &str) -> String {
    let mut out = String::new();
    for ch in value.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            '`' => out.push_str("\\`"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            ch if (ch as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", ch as u32)),
            _ => out.push(ch),
        }
    }
    out
}

fn normalize_number(raw: &str) -> String {
    normalize_number_literal(raw)
}

fn normalize_datatype(raw: &str) -> String {
    // Preserve quoted payloads while applying value-number normalization to
    // numeric clarifier tokens. Do not parse them through host floats.
    let lexed = aeon_core::tokenize(raw, aeon_core::LexerOptions::default());
    let mut result = String::new();
    let mut bracket_depth = 0usize;
    for token in lexed.tokens {
        match token.kind {
            aeon_core::TokenKind::Eof => {}
            aeon_core::TokenKind::LeftBracket => {
                bracket_depth += 1;
                result.push_str(&token.text);
            }
            aeon_core::TokenKind::RightBracket => {
                bracket_depth = bracket_depth.saturating_sub(1);
                result.push_str(&token.text);
            }
            aeon_core::TokenKind::Number if bracket_depth > 0 => {
                result.push_str(&normalize_number(&token.text));
            }
            aeon_core::TokenKind::Comma => result.push_str(", "),
            _ => result.push_str(&token.text),
        }
    }
    result
}

fn normalize_raw(raw: &str) -> String {
    if let Some(hex) = raw.strip_prefix('#') {
        return format!("#{}", hex.replace('_', "").to_ascii_lowercase());
    }
    if let Some(radix) = raw.strip_prefix('%') {
        return format!("%{}", radix.replace('_', ""));
    }
    if let Some(encoding) = raw.strip_prefix('&') {
        return format!("&{}", normalize_encoding(encoding));
    }

    let mut value = raw
        .strip_prefix("~>$.")
        .map(|rest| format!("~>{rest}"))
        .or_else(|| raw.strip_prefix("~$.").map(|rest| format!("~{rest}")))
        .unwrap_or_else(|| raw.to_owned());

    if looks_like_hex_literal(&value) {
        value.make_ascii_lowercase();
    }
    value = normalize_quoted_reference_segments(&value, ".[\"", ".");
    value = normalize_quoted_reference_segments(&value, ".@.[\"", ".@.");
    value
}

fn normalize_encoding(raw: &str) -> String {
    raw.to_owned()
}

fn looks_like_hex_literal(raw: &str) -> bool {
    raw.starts_with('#') && raw.len() > 1 && raw[1..].chars().all(|ch| ch.is_ascii_hexdigit())
}

fn normalize_quoted_reference_segments(raw: &str, needle: &str, replacement: &str) -> String {
    let mut output = String::new();
    let mut rest = raw;
    while let Some(index) = rest.find(needle) {
        output.push_str(&rest[..index]);
        let after = &rest[index + needle.len()..];
        if let Some(end) = after.find("\"]") {
            let segment = &after[..end];
            if is_identifier(segment) {
                output.push_str(replacement);
                output.push_str(segment);
                rest = &after[end + 2..];
                continue;
            }
        }
        output.push_str(&rest[index..index + needle.len()]);
        rest = after;
    }
    output.push_str(rest);
    output
}

impl Binding {
    fn scalar(key: &str, value: Value) -> Self {
        Self {
            rank: None,
            canonical_key: false,
            key: String::from(key),
            structural_id: None,
            datatype: None,
            attributes: BTreeMap::new(),
            value,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preserves_structural_identity_in_canonical_head_position() {
        let result = canonicalize(
            "items = [\\B2\\@{source = \"user\"}:string = \"green\"]\nage\\A1\\:int32 = 42",
        );
        assert!(result.errors.is_empty(), "{:?}", result.errors);
        assert!(result.text.contains("age\\A1\\:int32 = 42"));
        assert!(
            result
                .text
                .contains("\\B2\\@{source = \"user\"}:string = \"green\"")
        );
    }

    #[test]
    fn preserves_attribute_entry_and_node_head_structural_identity() {
        let result = canonicalize("<value\\NODE\\@{source\\META\\:string = \"user\"}>");
        assert!(result.errors.is_empty(), "{:?}", result.errors);
        assert!(result.text.contains("source\\META\\:string = \"user\""));
        assert!(
            result
                .text
                .contains("<value\\NODE\\@{source\\META\\:string = \"user\"}>")
        );
    }

    #[test]
    fn rejects_duplicate_structural_identity_during_canonicalization() {
        let result = canonicalize("a\\A1\\ = 1\nb = [\\A1\\ = 2]");
        assert_eq!(result.errors[0].code, "DUPLICATE_STRUCTURAL_IDENTITY");
    }

    #[test]
    fn normalizes_line_endings_and_trailing_newline() {
        let result = canonicalize("a = [1, 2]");
        assert!(result.errors.is_empty());
        assert!(result.text.contains("aeon:header = {"));
    }

    #[test]
    fn folds_shorthand_mode_into_structured_header_without_extra_defaults() {
        let result = canonicalize("aeon:mode = \"strict\"\na = {}\n");
        assert!(result.errors.is_empty(), "{:?}", result.errors);
        assert_eq!(
            result.text,
            "aeon:header = {\n  mode = \"strict\"\n}\na = {\n}\n"
        );
    }

    #[test]
    fn treats_trivia_inside_aeon_header_key_as_separator_trivia() {
        for source in [
            "aeon :header = {\n  mode:string = \"strict\"\n}\n",
            "aeon: header = {\n  mode:string = \"strict\"\n}\n",
            "aeon : header = {\n  mode:string = \"strict\"\n}\n",
            "aeon: /# #/header = {\n  mode:string = \"strict\"\n}\n",
        ] {
            let result = canonicalize(source);
            assert!(result.errors.is_empty(), "{source}: {:?}", result.errors);
            assert_eq!(
                result.text,
                "aeon:header = {\n  mode:string = \"strict\"\n}\n"
            );
        }
    }

    #[test]
    fn canonicalizes_flexible_structured_header_as_header() {
        let result = canonicalize(
            "aeon\n:\nheader /# #/= /# #/{\n  mode:\nstring = \"strict\"\n  encoding:string = \"utf-8\"\n}\n",
        );

        assert!(result.errors.is_empty(), "{:?}", result.errors);
        assert_eq!(
            result.text,
            "aeon:header = {\n  encoding:string = \"utf-8\"\n  mode:string = \"strict\"\n}\n"
        );
    }

    #[test]
    fn preserves_empty_trimtick_literal_family() {
        let result =
            canonicalize("aeon:mode = \"transport\"\nc:trimtick = > ``\nb:string = \"\"\n");
        assert!(result.errors.is_empty(), "{:?}", result.errors);
        assert_eq!(
            result.text,
            "aeon:header = {\n  mode = \"transport\"\n}\nb:string = \"\"\nc:trimtick = >``\n"
        );
    }

    #[test]
    fn decodes_the_complete_escape_vocabulary_in_trimticks() {
        let source = r#"value = >`\"\'\`\\\n\r\t\b\f\u0041\u{1F600}\uD83D\uDE00`"#;
        let bindings = aeon_core::parse_document(source, &Default::default()).expect("parse");
        assert!(matches!(
            &bindings[0].value,
            aeon_core::Value::StringLiteral { value, trimticks: Some(_), .. }
                if value == "\"'`\\\n\r\t\u{0008}\u{000c}A😀😀"
        ));
    }

    #[test]
    fn rejects_invalid_escapes_in_every_string_delimiter() {
        for source in [
            r#"value = "\q""#,
            r#"value = '\q'"#,
            r#"value = `\q`"#,
            r#"value = >`\q`"#,
            r#"value = "\u{D800}\uDC00""#,
        ] {
            let result = canonicalize(source);
            assert_eq!(result.text, "", "{source}");
            assert_eq!(result.errors.len(), 1, "{source}");
            assert_eq!(result.errors[0].code, "INVALID_ESCAPE", "{source}");
        }
    }

    #[test]
    fn rejects_literal_newlines_in_ordinary_quoted_strings() {
        for source in [
            "value = \"line one\nline two\"",
            "value = 'line one\nline two'",
        ] {
            let result = canonicalize(source);
            assert_eq!(result.text, "", "{source}");
            assert_eq!(result.errors.len(), 1, "{source}");
            assert_eq!(result.errors[0].code, "UNTERMINATED_STRING", "{source}");
        }
    }

    #[test]
    fn canonicalizes_datatype_spacing_clarifiers_and_number_forms() {
        let result = canonicalize(
            "aeon:mode = \"strict\"\n\
             a:tuple<int32,int32> = (1, 2)\n\
             sep3 : sep [\"x\"] = ^1920x1080\n\
             n:number = 1_1_1.2_2e3_3\n",
        );
        assert!(result.errors.is_empty(), "{:?}", result.errors);
        assert_eq!(
            result.text,
            "aeon:header = {\n  mode = \"strict\"\n}\na:tuple<int32, int32> = (1, 2)\nn:number = 111.22e33\nsep3:sep[\"x\"] = ^1920x1080\n"
        );
    }

    #[test]
    fn strips_binding_head_annotations_without_changing_keys_or_datatypes() {
        let result = canonicalize(
            "aname/#A#/ :string = \"alignment playground\"\n\
             bname:/#B#/ string = \"alignment playground\"\n\
             cname: string /#C#/ = \"alignment playground\"\n\
             dname: string = /#D#/ \"alignment playground\"\n",
        );
        assert!(result.errors.is_empty(), "{:?}", result.errors);
        assert_eq!(
            result.text,
            "aeon:header = {\n  encoding = \"utf-8\"\n  mode = \"transport\"\n  profile = \"core\"\n  version = \"1.0\"\n}\naname:string = \"alignment playground\"\nbname:string = \"alignment playground\"\ncname:string = \"alignment playground\"\ndname:string = \"alignment playground\"\n"
        );
    }

    #[test]
    fn canonicalizes_number_families_without_collapsing_radix_representation() {
        let result = canonicalize(
            "plain:number = +10\n\
             fraction:number = 10.00\n\
             half:number = +.5\n\
             scientific:number = 1.0E+03\n\
             zero_int:number = +0\n\
             zero_dec:number = -.0\n\
             zero_exp:number = -0.0E-0\n\
             zero_exp_positive:number = 0e+01\n\
             zero_exp_negative:number = 0e-01\n\
             negative_zero_exp_positive:number = -0e+01\n\
             negative_zero_exp_negative:number = -0e-01\n\
             mask:radix[10] = %10.00\n\
             width:radix[10] = %0010.00\n",
        );
        assert!(result.errors.is_empty(), "{:?}", result.errors);
        assert_eq!(
            result.text,
            "aeon:header = {\n  encoding = \"utf-8\"\n  mode = \"transport\"\n  profile = \"core\"\n  version = \"1.0\"\n}\nfraction:number = 10.0\nhalf:number = 0.5\nmask:radix[10] = %10.00\nnegative_zero_exp_negative:number = -0e0\nnegative_zero_exp_positive:number = -0e0\nplain:number = 10\nscientific:number = 1e3\nwidth:radix[10] = %0010.00\nzero_dec:number = -0.0\nzero_exp:number = -0e0\nzero_exp_negative:number = 0e0\nzero_exp_positive:number = 0e0\nzero_int:number = 0\n"
        );
    }

    #[test]
    fn canonicalizes_infinity_literals() {
        let result = canonicalize("top:infinity = Infinity\nbottom:infinity = -Infinity\n");
        assert!(result.errors.is_empty(), "{:?}", result.errors);
        assert_eq!(
            result.text,
            "aeon:header = {\n  encoding = \"utf-8\"\n  mode = \"transport\"\n  profile = \"core\"\n  version = \"1.0\"\n}\nbottom:infinity = -Infinity\ntop:infinity = Infinity\n"
        );
    }

    #[test]
    fn canonicalizes_nan_literals() {
        let result = canonicalize("top:nan = NaN\nbottom:nan = -NaN\n");
        assert!(result.errors.is_empty(), "{:?}", result.errors);
        assert_eq!(
            result.text,
            "aeon:header = {\n  encoding = \"utf-8\"\n  mode = \"transport\"\n  profile = \"core\"\n  version = \"1.0\"\n}\nbottom:nan = -NaN\ntop:nan = NaN\n"
        );
    }

    #[test]
    fn canonicalizes_null_literals() {
        let result = canonicalize("top:null = !none\nbottom:null = !'postponed'\n");
        assert!(result.errors.is_empty(), "{:?}", result.errors);
        assert_eq!(
            result.text,
            "aeon:header = {\n  encoding = \"utf-8\"\n  mode = \"transport\"\n  profile = \"core\"\n  version = \"1.0\"\n}\nbottom:null = !\"postponed\"\ntop:null = !none\n"
        );
    }

    #[test]
    fn rejects_invalid_infinity_spellings_in_canonicalization() {
        for source in ["a = +Infinity\n", "a = +NaN\n"] {
            let result = canonicalize(source);
            assert!(!result.errors.is_empty(), "{source}");
            assert!(
                result
                    .errors
                    .iter()
                    .any(|error| error.code == "SYNTAX_ERROR"),
                "{:?}",
                result.errors
            );
        }
    }

    #[test]
    fn preserves_wtc_zone_casing_in_canonicalization() {
        let result = canonicalize(
            "aeon:mode = \"strict\"\nz5:wtc = 2025-01-01T00:00:00Z&Europe/Belgium/Brussels\n",
        );
        assert!(result.errors.is_empty(), "{:?}", result.errors);
        assert_eq!(
            result.text,
            "aeon:header = {\n  mode = \"strict\"\n}\nz5:wtc = 2025-01-01T00:00:00Z&Europe/Belgium/Brussels\n"
        );
    }

    #[test]
    fn strips_trailing_comments_from_raw_literals_in_canonicalization() {
        let result = canonicalize("aeon:mode = \"strict\"\nfile4:sep[\"|\"] = ^aaa // comment\n");
        assert!(result.errors.is_empty(), "{:?}", result.errors);
        assert_eq!(
            result.text,
            "aeon:header = {\n  mode = \"strict\"\n}\nfile4:sep[\"|\"] = ^aaa\n"
        );
    }

    #[test]
    fn strips_trailing_line_comments_from_reserved_null_literals_in_canonicalization() {
        let result = canonicalize("aeon:mode = \"strict\"\nn10:null = !none//Null\n");
        assert!(result.errors.is_empty(), "{:?}", result.errors);
        assert_eq!(
            result.text,
            "aeon:header = {\n  mode = \"strict\"\n}\nn10:null = !none\n"
        );
    }

    #[test]
    fn canonicalizes_sansa_address_literals_before_comments_and_inside_containers() {
        let result = canonicalize(
            "aeon:mode = \"strict\"\n\
             a:sansa = $.name/* block */\n\
             b:sansa = $.name// line\n\
             c:list = [$.name]\n\
             <d($.name)>\n\
             e:tuple = ($.name)\n\
             f:sansa = $.items.*#text%stringLiteral.(\"item?*\")\n",
        );
        assert!(result.errors.is_empty(), "{:?}", result.errors);
        assert_eq!(
            result.text,
            "aeon:header = {\n  mode = \"strict\"\n}\n\
             a:sansa = $.name\n\
             b:sansa = $.name\n\
             c:list = [$.name]\n\
             <d(\n  $.name\n)>\n\
             e:tuple = ($.name)\n\
             f:sansa = $.items.*#text%stringLiteral.(\"item?*\")\n"
        );
    }

    #[test]
    fn canonicalizes_braced_unicode_escapes_in_all_string_delimiters() {
        let result = canonicalize(
            "string014:string = '\\u2B62 \\u{10908} \\u{2B95} \\u{2B91}'\nstring015:string = \"\\u2B62 \\u{10908} \\u{2B95} \\u{2B91}\"\nstring016:string = `\\u2B62 \\u{10908} \\u{2B95} \\u{2B91}`\n",
        );
        assert!(result.errors.is_empty(), "{:?}", result.errors);
        assert_eq!(
            result.text,
            "aeon:header = {\n  encoding = \"utf-8\"\n  mode = \"transport\"\n  profile = \"core\"\n  version = \"1.0\"\n}\nstring014:string = \"⭢ 𐤈 ⮕ ⮑\"\nstring015:string = \"⭢ 𐤈 ⮕ ⮑\"\nstring016:string = \"⭢ 𐤈 ⮕ ⮑\"\n"
        );
    }

    #[test]
    fn canonicalizes_references_with_whitespace_after_clone_sigil() {
        let result = canonicalize("order:o = {\n  total:n = 2\n}\nmixed:n = ~ order.total\n");
        assert!(result.errors.is_empty(), "{:?}", result.errors);
        assert_eq!(
            result.text,
            "aeon:header = {\n  encoding = \"utf-8\"\n  mode = \"transport\"\n  profile = \"core\"\n  version = \"1.0\"\n}\norder:o = {\n  total:n = 2\n}\nmixed:n = ~order.total\n"
        );
    }

    #[test]
    fn canonicalizes_references_with_whitespace_after_pointer_sigil() {
        let result = canonicalize("order:o = {\n  total:n = 2\n}\nmixed:n = ~> order.total\n");
        assert!(result.errors.is_empty(), "{:?}", result.errors);
        assert_eq!(
            result.text,
            "aeon:header = {\n  encoding = \"utf-8\"\n  mode = \"transport\"\n  profile = \"core\"\n  version = \"1.0\"\n}\norder:o = {\n  total:n = 2\n}\nmixed:n = ~>order.total\n"
        );
    }

    #[test]
    fn canonicalizes_hex_literals_to_lowercase_without_underscores() {
        let result = canonicalize("aeon:mode = \"transport\"\na = #F_Ff\n");
        assert!(result.errors.is_empty(), "{:?}", result.errors);
        assert_eq!(
            result.text,
            "aeon:header = {\n  mode = \"transport\"\n}\na = #fff\n"
        );
    }

    #[test]
    fn canonicalizes_radix_literals_without_underscores() {
        let result = canonicalize("aeon:mode = \"transport\"\nb:radix = %101_0101\n");
        assert!(result.errors.is_empty(), "{:?}", result.errors);
        assert_eq!(
            result.text,
            "aeon:header = {\n  mode = \"transport\"\n}\nb:radix = %1010101\n"
        );
    }

    #[test]
    fn preserves_padded_base64url_encoding_literals() {
        let result = canonicalize("aeon:mode = \"transport\"\npayload:base64 = &YWJjLQ==\n");
        assert!(result.errors.is_empty(), "{:?}", result.errors);
        assert_eq!(
            result.text,
            "aeon:header = {\n  mode = \"transport\"\n}\npayload:base64 = &YWJjLQ==\n"
        );
    }

    #[test]
    fn reports_missing_equals_after_key_with_key_name() {
        let result = canonicalize("a hello\n");
        assert_eq!(result.errors.len(), 1);
        assert_eq!(result.errors[0].code, "SYNTAX_ERROR");
        assert_eq!(result.errors[0].message, "Expected '=' after key 'a'");
        let span = result.errors[0].span.expect("span");
        assert_eq!(span.start.line, 1);
        assert_eq!(span.start.column, 3);
        assert_eq!(span.end.line, 1);
        assert_eq!(span.end.column, 8);
    }

    #[test]
    fn rejects_unexpected_identifier_token_in_value_position() {
        let result = canonicalize("a = hello\n");
        assert_eq!(result.errors.len(), 1);
        assert_eq!(result.errors[0].code, "SYNTAX_ERROR");
        assert_eq!(result.errors[0].message, "Unexpected token 'hello'");
        let span = result.errors[0].span.expect("span");
        assert_eq!(span.start.line, 1);
        assert_eq!(span.start.column, 5);
        assert_eq!(span.end.line, 1);
        assert_eq!(span.end.column, 10);
    }

    #[test]
    fn renders_child_bearing_nodes_multiline_in_bindings() {
        let result = canonicalize("aeon:mode = \"strict\"\n<widget:node(\"x\")>\n");
        assert!(result.errors.is_empty(), "{:?}", result.errors);
        assert_eq!(
            result.text,
            "aeon:header = {\n  mode = \"strict\"\n}\n<widget:node(\n  \"x\"\n)>\n"
        );
    }

    #[test]
    fn canonicalizes_nested_node_list_and_tuple_children_inside_nodes() {
        let result = canonicalize(
            "aeon:mode = \"transport\"\n\
             <b(<a(1,2,3)>)>\n\
             <c([1,2])>\n\
             <d((1,2))>\n",
        );
        assert!(result.errors.is_empty(), "{:?}", result.errors);
        assert_eq!(
            result.text,
            "aeon:header = {\n  mode = \"transport\"\n}\n<b(\n  <a(1, 2, 3)>\n)>\n<c(\n  [1, 2]\n)>\n<d(\n  (1, 2)\n)>\n"
        );
    }

    #[test]
    fn canonicalizes_bracketed_reference_paths_and_root_prefixes() {
        let result = canonicalize(
            "aeon:mode = \"transport\"\n\
             a@{meta={deep=2}} = { \"b.c\" = 1 }\n\
             v = ~$.a.[\"b.c\"]\n\
             p = ~>$.a\n\
             q = ~a.@.[\"meta\"].deep\n",
        );
        assert!(result.errors.is_empty(), "{:?}", result.errors);
        assert_eq!(
            result.text,
            "aeon:header = {\n  mode = \"transport\"\n}\na@{meta = { deep = 2 }} = {\n  \"b.c\" = 1\n}\np = ~>a\nq = ~a.@.meta.deep\nv = ~a.[\"b.c\"]\n"
        );
    }

    #[test]
    fn renders_inline_object_attribute_values_with_canonical_spacing() {
        let result = canonicalize("aeon:mode = \"transport\"\na@{ meta = { deep = 1 } } = 3\n");
        assert!(result.errors.is_empty(), "{:?}", result.errors);
        assert_eq!(
            result.text,
            "aeon:header = {\n  mode = \"transport\"\n}\na@{meta = { deep = 1 }} = 3\n"
        );
    }

    #[test]
    fn canonicalizes_whitespace_around_empty_node_children_in_strict_mode() {
        let result = canonicalize(
            "aeon:mode = \"strict\"\n\
             <\n\
             a\n\
             >\n\
             < b (   ) >\n\
             <c(  ) >\n\
             <d (  )>\n",
        );
        assert!(result.errors.is_empty(), "{:?}", result.errors);
        assert_eq!(
            result.text,
            "aeon:header = {\n  mode = \"strict\"\n}\n<a>\n<b>\n<c>\n<d>\n"
        );
    }

    #[test]
    fn canonicalizes_whitespace_between_attribute_sigil_and_block_in_strict_mode() {
        let result = canonicalize(
            "aeon:mode = \"strict\"\n\
             a@ { n:n=2} : n = 3\n\
             b @ { n:n=2} : n = 3\n\
             c @ { n : n = 2 } : n = 3\n",
        );
        assert!(result.errors.is_empty(), "{:?}", result.errors);
        assert_eq!(
            result.text,
            "aeon:header = {\n  mode = \"strict\"\n}\na@{n:n = 2}:n = 3\nb@{n:n = 2}:n = 3\nc@{n:n = 2}:n = 3\n"
        );
    }

    #[test]
    fn canonicalizes_extremely_multiline_binding_attributes_in_strict_mode() {
        let result = canonicalize(
            "aeon:mode = \"strict\"\n\
             a\n\
             @ \n\
             {\n\
             n\n\
             :\n\
             n \n\
             =\n\
             1\n\
             }\n\
             :\n\
             n \n\
             = \n\
             2\n",
        );
        assert!(result.errors.is_empty(), "{:?}", result.errors);
        assert_eq!(
            result.text,
            "aeon:header = {\n  mode = \"strict\"\n}\na@{n:n = 1}:n = 2\n"
        );
    }

    #[test]
    fn canonicalizes_multiline_clarifiers_and_generic_boundaries_in_strict_mode() {
        let result = canonicalize(
            "aeon:mode = \"strict\"\n\
             size\n\
             :\n\
             sep\n\
             [\n\
             \"x\"\n\
             ]\n\
             = ^300x250\n\
             items\n\
             :\n\
             list\n\
             <\n\
             n\n\
             >\n\
             =\n\
             [\n\
             2\n\
             ,\n\
             3\n\
             ]\n",
        );
        assert!(result.errors.is_empty(), "{:?}", result.errors);
        assert_eq!(
            result.text,
            "aeon:header = {\n  mode = \"strict\"\n}\nitems:list<n> = [2, 3]\nsize:sep[\"x\"] = ^300x250\n"
        );
    }

    #[test]
    fn canonicalizes_parameterized_object_and_node_claims() {
        let result = canonicalize(
            "aeon:mode = \"strict\"\nscores:object<number> = { alice:number = 10 }\n<doc:node<html>>\n<child:node<node>>\nmissing:null<number> = !none\nbad:nan<number> = NaN\nfast:infinity<speedofmass> = Infinity\n<title:node<string>(\"Hello\")>\n",
        );
        assert!(result.errors.is_empty(), "{:?}", result.errors);
        assert_eq!(
            result.text,
            "aeon:header = {\n  mode = \"strict\"\n}\nbad:nan<number> = NaN\n<child:node<node>>\n<doc:node<html>>\nfast:infinity<speedofmass> = Infinity\nmissing:null<number> = !none\nscores:object<number> = {\n  alice:number = 10\n}\n<title:node<string>(\n  \"Hello\"\n)>\n"
        );
    }

    #[test]
    fn preserves_binding_node_claims_with_reserved_child_value_datatypes() {
        let result = canonicalize("<tag:node<string>>\n");
        assert!(result.errors.is_empty(), "{:?}", result.errors);
        assert!(result.text.contains("<tag:node<string>>"));
    }

    #[test]
    fn canonicalizes_root_prefixed_quoted_attribute_traversal() {
        let result = canonicalize(
            "aeon:mode = \"transport\"\na@{ meta = { deep = 1 } } = 3\nv = ~$.a.@.[\"meta\"].[\"deep\"]\n",
        );
        assert!(result.errors.is_empty(), "{:?}", result.errors);
        assert_eq!(
            result.text,
            "aeon:header = {\n  mode = \"transport\"\n}\na@{meta = { deep = 1 }} = 3\nv = ~a.@.meta.deep\n"
        );
    }

    #[test]
    fn canonicalizes_multiline_strings_as_trimticks() {
        let result = canonicalize("aeon:mode = \"transport\"\ntext = > `\n  alpha\n\n  beta\n`\n");
        assert!(result.errors.is_empty(), "{:?}", result.errors);
        assert_eq!(
            result.text,
            "aeon:header = {\n  mode = \"transport\"\n}\ntext = >`\n  alpha\n  \n  beta\n`\n"
        );
    }

    #[test]
    fn escapes_controls_without_changing_string_literal_family() {
        let result = canonicalize("value = \"line1\\ntick:\\` slash:\\\\ tab:\\t backspace:\\b\"");
        assert!(result.errors.is_empty(), "{:?}", result.errors);
        assert!(
            result
                .text
                .contains("value = \"line1\\ntick:` slash:\\\\ tab:\\t backspace:\\u0008\"")
        );
        let repeated = canonicalize(&result.text);
        assert!(repeated.errors.is_empty(), "{:?}", repeated.errors);
        assert_eq!(repeated.text, result.text);
    }

    #[test]
    fn preserves_one_line_trimticks_in_lists() {
        let result = canonicalize(
            "aeon:mode = \"custom\"\nnotes:list<trimtick> = [\n  > `\n    one\n  `,\n  > `\n    two\n  `\n]\n",
        );
        assert!(result.errors.is_empty(), "{:?}", result.errors);
        assert_eq!(
            result.text,
            "aeon:header = {\n  mode = \"custom\"\n}\nnotes:list<trimtick> = [>`one`, >`two`]\n"
        );
        let repeated = canonicalize(&result.text);
        assert!(repeated.errors.is_empty(), "{:?}", repeated.errors);
        assert_eq!(repeated.text, result.text);
    }

    #[test]
    fn preserves_multiline_trimticks_inside_inline_attribute_objects() {
        let result = canonicalize(
            "aeon:mode = \"custom\"\n<a@{ nested:object = { note:trimtick = > `\n    hello\n\n    world\n  ` } }:node>\n",
        );
        assert!(result.errors.is_empty(), "{:?}", result.errors);
        assert_eq!(
            result.text,
            "aeon:header = {\n  mode = \"custom\"\n}\n<a@{nested:object = { note:trimtick = >` hello\\n\\n world` }}:node>\n"
        );
        let repeated = canonicalize(&result.text);
        assert!(repeated.errors.is_empty(), "{:?}", repeated.errors);
        assert_eq!(repeated.text, result.text);
    }

    #[test]
    fn compact_multiline_trimticks_preserve_payload_indentation() {
        let result = canonicalize("a@{note:trimtick = >`\n\t first\n\t  second\n`}:number = 1\n");
        assert!(result.errors.is_empty(), "{:?}", result.errors);
        assert!(
            result
                .text
                .contains("note:trimtick = >`\\t first\\n\\t  second`")
        );
        let reparsed = aeon_core::parse_document(&result.text, &Default::default())
            .expect("canonical output should parse");
        let note = reparsed
            .iter()
            .find(|binding| binding.key == "a")
            .expect("a binding")
            .attributes
            .get("note")
            .expect("note attribute");
        assert!(matches!(
            note.value.as_ref(),
            Some(aeon_core::Value::StringLiteral { value, trimticks: Some(_), .. })
                if value == " first\n  second"
        ));
        let repeated = canonicalize(&result.text);
        assert!(repeated.errors.is_empty(), "{:?}", repeated.errors);
        assert_eq!(repeated.text, result.text);
    }

    #[test]
    fn compact_trimticks_preserve_semantic_leading_blank_lines() {
        let sources = [
            "value:trimtick = >`\n\n\t alpha\n\tbeta\n`",
            "value:trimtick = >`\n\n\n\t alpha\n\tbeta\n`",
            "value@{note:trimtick = >`\n\n  alpha\n  beta\n`}:number = 1",
        ];
        for source in sources {
            let result = canonicalize(source);
            assert!(result.errors.is_empty(), "{source}: {:?}", result.errors);
            let repeated = canonicalize(&result.text);
            assert!(
                repeated.errors.is_empty(),
                "{source}: {:?}",
                repeated.errors
            );
            assert_eq!(repeated.text, result.text, "{source}");
        }
    }

    #[test]
    fn ordinary_multiline_backticks_do_not_canonicalize_as_trimticks() {
        let result = canonicalize("value = `\nhello\n`");
        assert!(result.errors.is_empty(), "{:?}", result.errors);
        assert!(result.text.contains("value = \"\\nhello\\n\""));
        assert!(!result.text.contains("value = >`"));
        let repeated = canonicalize(&result.text);
        assert!(repeated.errors.is_empty(), "{:?}", repeated.errors);
        assert_eq!(repeated.text, result.text);
    }

    #[test]
    fn block_trimticks_use_canonical_space_indentation() {
        let result = canonicalize("c=>`\n  hello\n world\n hello\n`");
        assert!(result.errors.is_empty(), "{:?}", result.errors);
        assert!(
            result
                .text
                .contains("c = >`\n   hello\n  world\n  hello\n`")
        );
        assert!(!result.text.contains("\\t"));
        let repeated = canonicalize(&result.text);
        assert!(repeated.errors.is_empty(), "{:?}", repeated.errors);
        assert_eq!(repeated.text, result.text);
    }

    #[test]
    fn preserves_strict_string_and_prose_literal_families() {
        let result = canonicalize(
            "aeon:mode = \"strict\"\ndescription:prose = >`approved`\nmessage:string = \"first\\nsecond\"\n",
        );
        assert!(result.errors.is_empty(), "{:?}", result.errors);
        assert!(result.text.contains("description:prose = >`approved`"));
        assert!(result.text.contains("message:string = \"first\\nsecond\""));
        let compiled = aeon_core::compile(&result.text, aeon_core::CompileOptions::default());
        assert!(compiled.errors.is_empty(), "{:?}", compiled.errors);

        let reparsed = aeon_core::parse_document(&result.text, &Default::default())
            .expect("canonical output should parse");
        let description = reparsed
            .iter()
            .find(|binding| binding.key == "description")
            .expect("description binding");
        assert!(matches!(
            description.value,
            aeon_core::Value::StringLiteral {
                trimticks: Some(_),
                ..
            }
        ));
        let message = reparsed
            .iter()
            .find(|binding| binding.key == "message")
            .expect("message binding");
        assert!(matches!(
            message.value,
            aeon_core::Value::StringLiteral {
                trimticks: None,
                ..
            }
        ));

        let repeated = canonicalize(&result.text);
        assert!(repeated.errors.is_empty(), "{:?}", repeated.errors);
        assert_eq!(repeated.text, result.text);
    }

    #[test]
    fn canonicalizes_backtick_strings_to_double_quoted_strings() {
        let result = canonicalize("aeon:mode = \"custom\"\nwidth:unit = `3cm`\n");
        assert!(result.errors.is_empty(), "{:?}", result.errors);
        assert_eq!(
            result.text,
            "aeon:header = {\n  mode = \"custom\"\n}\nwidth:unit = \"3cm\"\n"
        );
    }

    #[test]
    fn sorts_escaped_quoted_keys_by_decoded_codepoint_order() {
        let result = canonicalize(
            "aeon:mode = \"transport\"\n\"e\" = 0\n\"\\n\" = 0\n\" \" = 1\n\"º\" = 0\n",
        );
        assert!(result.errors.is_empty(), "{:?}", result.errors);
        assert_eq!(
            result.text,
            "aeon:header = {\n  mode = \"transport\"\n}\n\"\\n\" = 0\n\" \" = 1\ne = 0\n\"º\" = 0\n"
        );
    }

    #[test]
    fn keeps_underscore_prefixed_keys_bare_canonically() {
        let result = canonicalize("aeon:mode = \"transport\"\n\"_\" = 0\n\"_hello\" = 0\n");
        assert!(result.errors.is_empty(), "{:?}", result.errors);
        assert_eq!(
            result.text,
            "aeon:header = {\n  mode = \"transport\"\n}\n_ = 0\n_hello = 0\n"
        );
    }

    #[test]
    fn quotes_non_identifier_node_heads_canonically() {
        let result =
            canonicalize("aeon:mode = \"transport\"\n<\"a\">\n<\"\\n\">\n<\" \">\n<\"º\">\n");
        assert!(result.errors.is_empty(), "{:?}", result.errors);
        assert_eq!(
            result.text,
            "aeon:header = {\n  mode = \"transport\"\n}\n<\"\\n\">\n<\" \">\n<a>\n<\"º\">\n"
        );
    }

    #[test]
    fn canonicalizes_hex_literals_to_lowercase() {
        let result = canonicalize("aeon:mode = \"custom\"\nshade:unit = #FF32\n");
        assert!(result.errors.is_empty(), "{:?}", result.errors);
        assert_eq!(
            result.text,
            "aeon:header = {\n  mode = \"custom\"\n}\nshade:unit = #ff32\n"
        );
    }

    #[test]
    fn parses_node_heads_with_attributes_before_datatype() {
        let result = canonicalize(
            "aeon:mode = \"custom\"\ntarget=1\n<scene(\n  <button@{ action:lookup = ~$.target }:node(\n    > `\n      Click\n      Here\n    `\n  )>\n)>\n",
        );
        assert!(result.errors.is_empty(), "{:?}", result.errors);
        assert!(
            result
                .text
                .contains("<button@{action:lookup = ~target}:node(")
        );
    }

    #[test]
    fn canonicalizes_anonymous_attributed_children() {
        let result =
            canonicalize("aeon:mode = \"strict\"\nwidth:list = [@{unit:string = \"cm\"} = 3]\n");
        assert!(result.errors.is_empty(), "{:?}", result.errors);
        assert!(
            result.text.contains("@{unit:string = \"cm\"} = 3"),
            "{}",
            result.text
        );
    }

    #[test]
    fn canonicalizes_node_head_references_inside_attributes() {
        let result = canonicalize(
            "aeon:mode = \"custom\"\ntarget:number = 1\n<scene@{ \"z.k\":lookup = ~$.target, alpha:number = 1 }:node(\n  <button@{ action:lookup = ~>$.target }:node>\n)>\n",
        );
        assert!(result.errors.is_empty(), "{:?}", result.errors);
        assert!(result.text.contains("target:number = 1"));
        assert!(result.text.contains("~target"));
        assert!(result.text.contains("~>target"));
        assert!(result.text.contains("<scene@{"));
        assert!(
            result
                .text
                .contains("<button@{action:lookup = ~>target}:node>")
        );
    }

    #[test]
    fn sorts_nested_object_keys_and_list_item_objects_canonically() {
        let result = canonicalize(
            "aeon:mode = \"custom\"\nconfig:object = {\n  zebra:number = 2,\n  alpha:object = { \"z.k\":number = 9, a:number = 1 },\n  items:list<object> = [\n    { y:number = 2, \"a.b\":number = 1 },\n    { beta:number = 2, alpha:number = 1 }\n  ]\n}\n",
        );
        assert!(result.errors.is_empty(), "{:?}", result.errors);
        assert_eq!(
            result.text,
            "aeon:header = {\n  mode = \"custom\"\n}\nconfig:object = {\n  alpha:object = {\n    a:number = 1\n    \"z.k\":number = 9\n  }\n  items:list<object> = [\n    {\n      \"a.b\":number = 1\n      y:number = 2\n    },\n    {\n      alpha:number = 1\n      beta:number = 2\n    }\n  ]\n  zebra:number = 2\n}\n"
        );
    }

    #[test]
    fn strips_surrounding_comments_from_multiline_node_layouts() {
        let result = canonicalize(
            "aeon:mode = \"custom\"\n/* header note */\ntarget:number = 1\n<scene@{ meta:object = { deep:number = 1 } }:node(\n  <button@{ action:lookup = ~>$.target }:node> // trailing child comment\n)> // trailing node comment\n",
        );
        assert!(result.errors.is_empty(), "{:?}", result.errors);
        assert_eq!(
            result.text,
            "aeon:header = {\n  mode = \"custom\"\n}\ntarget:number = 1\n<scene@{meta:object = { deep:number = 1 }}:node(\n  <button@{action:lookup = ~>target}:node>\n)>\n"
        );
    }

    #[test]
    fn canonicalizes_mixed_clone_and_pointer_references_in_nested_containers() {
        let result = canonicalize(
            "aeon:mode = \"custom\"\ntarget:number = 1\nbundle:object = {\n  refs:list<object> = [\n    { \"z.k\":lookup = ~$.target, ptr:lookup = ~>$.target },\n    { beta:lookup = ~$.target, \"a.b\":lookup = ~>$.target }\n  ],\n  meta:object = { \"z.k\":lookup = ~$.target, alpha:lookup = ~>$.target }\n}\n",
        );
        assert!(result.errors.is_empty(), "{:?}", result.errors);
        assert_eq!(
            result.text,
            "aeon:header = {\n  mode = \"custom\"\n}\ntarget:number = 1\nbundle:object = {\n  meta:object = {\n    alpha:lookup = ~>target\n    \"z.k\":lookup = ~target\n  }\n  refs:list<object> = [\n    {\n      ptr:lookup = ~>target\n      \"z.k\":lookup = ~target\n    },\n    {\n      \"a.b\":lookup = ~>target\n      beta:lookup = ~target\n    }\n  ]\n}\n"
        );
    }

    #[test]
    fn rejects_invalid_radix_literals_during_canonicalization() {
        let result = canonicalize("a = 3e-3\nb = %3e-3\n");
        assert_eq!(result.text, "");
        assert_eq!(result.errors.len(), 1);
        assert_eq!(result.errors[0].code, "INVALID_NUMBER");
        assert!(
            result.errors[0]
                .message
                .contains("Invalid radix literal `%3e-3`")
        );
    }

    #[test]
    fn rejects_missing_datatype_after_binding_colon_during_canonicalization() {
        let result = canonicalize("a::n = 0\n");
        assert_eq!(result.text, "");
        assert_eq!(result.errors.len(), 1);
        assert_eq!(result.errors[0].code, "SYNTAX_ERROR");
        assert_eq!(result.errors[0].message, "Expected datatype annotation");
    }

    #[test]
    fn rejects_invalid_lowercase_t_temporal_literals_during_canonicalization() {
        for source in [
            "dt:datetime = 2007-01-02t10:10:25\n",
            "z:wtc = 2007-01-02t10:10:25Z&Australia/Melbourne\n",
        ] {
            let result = canonicalize(source);
            assert_eq!(result.text, "", "{source}");
            assert_eq!(result.errors.len(), 1, "{source}");
            assert_eq!(result.errors[0].code, "SYNTAX_ERROR");
            assert!(
                result.errors[0]
                    .message
                    .starts_with("Invalid datetime literal"),
                "{:?}",
                result.errors
            );
        }
    }

    #[test]
    fn rejects_non_zero_padded_date_candidates_during_canonicalization() {
        for source in [
            "aeon:mode = \"transport\"\na = 0000-1-20\n",
            "aeon:mode = \"transport\"\na = 0000-02-1\n",
        ] {
            let result = canonicalize(source);
            assert_eq!(result.text, "", "{source}");
            assert_eq!(result.errors.len(), 1, "{source}");
            assert_eq!(result.errors[0].code, "INVALID_DATE");
            assert!(
                result.errors[0].message.starts_with("Invalid date literal"),
                "{:?}",
                result.errors
            );
        }
    }

    #[test]
    fn accepts_reduced_precision_dates_during_canonicalization() {
        for source in [
            "aeon:mode = \"strict\"\nyear:date = 2024-\n",
            "aeon:mode = \"strict\"\nmonth:date = 2024-12\n",
            "aeon:mode = \"strict\"\nyear_time:datetime = 2024-T10:10\n",
            "aeon:mode = \"strict\"\nmonth_time:datetime = 2024-12T10:10\n",
        ] {
            let result = canonicalize(source);
            assert!(result.errors.is_empty(), "{source}: {:?}", result.errors);
        }
    }

    #[test]
    fn preserves_leap_seconds_and_arbitrary_fraction_scale_during_canonicalization() {
        let source = "aeon:mode = \"strict\"\n\
                      datetime:datetime = 2016-12-31T23:59:60.340000\n\
                      time:time = 23:55:60.999999999999999999999999999999999999999999999999\n\
                      wtc:wtc = 2016-12-31T23:59:60.500000Z&UTC\n";
        let result = canonicalize(source);
        assert!(result.errors.is_empty(), "{:?}", result.errors);
        assert!(
            result
                .text
                .contains("datetime:datetime = 2016-12-31T23:59:60.340000")
        );
        assert!(
            result
                .text
                .contains("time:time = 23:55:60.999999999999999999999999999999999999999999999999")
        );
        assert!(
            result
                .text
                .contains("wtc:wtc = 2016-12-31T23:59:60.500000Z&UTC")
        );
        let repeated = canonicalize(&result.text);
        assert!(repeated.errors.is_empty(), "{:?}", repeated.errors);
        assert_eq!(repeated.text, result.text);
    }

    #[test]
    fn rejects_temporal_components_outside_core_structural_bounds() {
        for source in [
            "bad:time = 24:00\n",
            "bad:time = 23:60\n",
            "bad:time = 23:59:61\n",
            "bad:datetime = 2024-T24\n",
            "bad:datetime = 2024-12-21T10:10:00+02:60\n",
        ] {
            let result = canonicalize(source);
            assert_eq!(result.text, "", "{source}");
            assert_eq!(result.errors.len(), 1, "{source}: {:?}", result.errors);
        }
    }

    #[test]
    fn rejects_invalid_reduced_precision_date_candidates_during_canonicalization() {
        for source in [
            "aeon:mode = \"transport\"\na = 2024-13\n",
            "aeon:mode = \"transport\"\na = 0000-\n",
            "aeon:mode = \"transport\"\na = 0000-T10:10\n",
            "aeon:mode = \"transport\"\na = 2024-13T10:10\n",
            "aeon:mode = \"transport\"\na = 2024--02-01\n",
            "aeon:mode = \"transport\"\na = 2024-12-01-\n",
        ] {
            let result = canonicalize(source);
            assert_eq!(result.text, "", "{source}");
            assert_eq!(result.errors.len(), 1, "{source}");
            assert!(matches!(
                result.errors[0].code.as_str(),
                "INVALID_DATE" | "INVALID_DATETIME"
            ));
            assert!(
                result.errors[0].message.starts_with("Invalid date literal")
                    || result.errors[0]
                        .message
                        .starts_with("Invalid datetime literal"),
                "{:?}",
                result.errors
            );
        }
    }

    #[test]
    fn accepts_hour_precision_datetime_offsets_during_canonicalization() {
        for source in [
            "aeon:mode = \"strict\"\ndt5:datetime = 2025-01-01T09:+02:00\n",
            "aeon:mode = \"strict\"\nzdt7:wtc = 2025-01-01T09:+02:00&Europe/Belgium/Brussels\n",
        ] {
            let result = canonicalize(source);
            assert!(result.errors.is_empty(), "{:?}", result.errors);
        }
    }

    #[test]
    fn preserves_reserved_datatype_generics_during_canonicalization() {
        for source in ["a:n<string> = 3\n", "b:boolean<toggle> = true\n"] {
            let result = canonicalize(source);
            assert!(result.errors.is_empty(), "{:?}", result.errors);
            assert!(result.text.ends_with(source), "{}", result.text);
        }
    }

    #[test]
    fn preserves_reserved_datatype_clarifiers_during_canonicalization() {
        let result = canonicalize(
            "aeon:mode = \"strict\"\na:n[10] = 22\nb:string[333] = \"hello world\"\nr:radix2[4] = %111\n",
        );
        assert!(result.errors.is_empty(), "{:?}", result.errors);
        assert!(result.text.contains("a:n[10] = 22"));
        assert!(result.text.contains("b:string[333] = \"hello world\""));
        assert!(result.text.contains("r:radix2[4] = %111"));
    }

    #[test]
    fn canonicalizes_symbol_literals_and_escapes_pipes() {
        let result = canonicalize("stage:symbol = |say \\\"yes\\\" and \\|wait\\||\n");
        assert!(result.errors.is_empty(), "{:?}", result.errors);
        assert!(
            result
                .text
                .contains("stage:symbol = |say \"yes\" and \\|wait\\||")
        );
        let repeated = canonicalize(&result.text);
        assert!(repeated.errors.is_empty(), "{:?}", repeated.errors);
        assert_eq!(repeated.text, result.text);
    }

    #[test]
    fn rejects_empty_symbol_literals_during_canonicalization() {
        let result = canonicalize("stage:symbol = ||\n");
        assert_eq!(result.text, "");
        assert_eq!(result.errors.len(), 1);
        assert_eq!(result.errors[0].code, "INVALID_SYMBOLIC_LITERAL");
    }

    #[test]
    fn rejects_legacy_unquoted_and_repeated_clarifiers_during_canonicalization() {
        for source in ["a:sep[x] = ^300x250\n", "b:sep[\"x\"][\"y\"] = ^300x200\n"] {
            let result = canonicalize(source);
            assert_eq!(result.text, "", "{source}");
            assert_eq!(result.errors.len(), 1, "{source}");
            assert_eq!(result.errors[0].code, "SYNTAX_ERROR");
        }
    }

    #[test]
    fn canonicalizes_telex_through_the_canonicalization_crate() {
        let source =
            "telex.aes=1\r\n\r\nvalue=\\u{000041}\r\nkind=StringLiteral\r\npath=$.answer\r\n";
        let result = canonicalize_telex(source).expect("canonical Telex");
        assert_eq!(
            result,
            "telex.aes=1\n\npath=$.answer\nkind=StringLiteral\nvalue=A\n"
        );
    }
}

#[cfg(test)]
mod unicode_identity_regressions {
    use super::*;
    #[test]
    fn unicode_keys_references_and_canonical_fixed_points_remain_exact() {
        let fixtures: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../../test-fixtures/unicode-hardening-v1.json"
        ))
        .expect("unicode fixtures");
        for pair in fixtures["identity_pairs"].as_array().expect("pairs") {
            let left = pair["left"].to_string();
            let right = pair["right"].to_string();
            let source = format!(
                "{left}=\"left\"\n{right}=\"right\"\nleftCopy=~[{left}]\nrightPointer=~>[{right}]"
            );
            let result = canonicalize(&source);
            assert!(
                result.errors.is_empty(),
                "{}: {:?}",
                pair["id"],
                result.errors
            );
            let again = canonicalize(&result.text);
            assert!(again.errors.is_empty());
            assert_eq!(again.text, result.text);
            let compiled = aeon_core::compile(&result.text, aeon_core::CompileOptions::default());
            assert!(compiled.errors.is_empty(), "{:?}", compiled.errors);
            for (copy, target) in [
                ("leftCopy", pair["left"].as_str().expect("left")),
                ("rightPointer", pair["right"].as_str().expect("right")),
            ] {
                let event = compiled
                    .events
                    .iter()
                    .find(|e| e.key == copy)
                    .expect("reference event");
                match &event.value {
                    aeon_core::Value::CloneReference { segments, .. }
                    | aeon_core::Value::PointerReference { segments, .. } => assert_eq!(
                        segments,
                        &vec![aeon_core::ReferenceSegment::Key(target.to_owned())]
                    ),
                    _ => panic!("expected retained reference occurrence"),
                }
            }
            for key in [
                pair["left"].as_str().expect("left"),
                pair["right"].as_str().expect("right"),
            ] {
                assert!(compiled.events.iter().any(|e| e.key == key));
            }
            assert!(
                !aeon_core::compile(
                    &format!("{left}=1\n{left}=2"),
                    aeon_core::CompileOptions::default()
                )
                .errors
                .is_empty()
            );
        }
    }
}
