use std::collections::BTreeMap;

use aeon_core::{Diagnostic, Position, Span, strip_leading_bom};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CanonicalResult {
    pub text: String,
    pub errors: Vec<Diagnostic>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Binding {
    key: String,
    datatype: Option<String>,
    attributes: BTreeMap<String, AttributeEntry>,
    value: Value,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct AttributeEntry {
    datatype: Option<String>,
    attributes: BTreeMap<String, AttributeEntry>,
    value: Value,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct NodeValue {
    tag: String,
    datatype: Option<String>,
    attributes: BTreeMap<String, AttributeEntry>,
    children: Vec<Value>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Value {
    String(String),
    Number(String),
    Infinity(String),
    Object(Vec<Binding>),
    List(Vec<Value>),
    Tuple(Vec<Value>),
    Node(NodeValue),
    Raw(String),
}

#[must_use]
pub fn canonicalize(source: &str) -> CanonicalResult {
    let source = strip_preamble(&strip_leading_bom(source));
    let mut parser = Parser::new(&source);
    let bindings = match parser.parse_document() {
        Ok(bindings) => bindings,
        Err(error) => return CanonicalResult { text: String::new(), errors: vec![error] },
    };

    let (header, body) = match split_header(bindings) {
        Ok(parts) => parts,
        Err(error) => return CanonicalResult { text: String::new(), errors: vec![error] },
    };

    CanonicalResult {
        text: render_document(header, body),
        errors: Vec::new(),
    }
}

fn split_header(bindings: Vec<Binding>) -> Result<(Vec<Binding>, Vec<Binding>), Diagnostic> {
    let mut header = None;
    let mut shorthand_header = Vec::new();
    let mut body = Vec::new();

    for binding in bindings {
        if binding.key == "aeon:header" {
            if !body.is_empty() || header.is_some() {
                return Err(Diagnostic::new(
                    "SYNTAX_ERROR",
                    "Structured headers must appear before body bindings",
                )
                .at_path("$"));
            }
            let Value::Object(bindings) = binding.value else {
                return Err(Diagnostic::new("SYNTAX_ERROR", "Structured header must be an object").at_path("$"));
            };
            header = Some(bindings);
        } else if let Some(key) = shorthand_header_key(&binding.key) {
            if !body.is_empty() {
                return Err(Diagnostic::new(
                    "SYNTAX_ERROR",
                    "Header bindings must appear before body bindings",
                )
                .at_path("$"));
            }
            shorthand_header.push(Binding {
                key: String::from(key),
                datatype: binding.datatype,
                attributes: binding.attributes,
                value: binding.value,
            });
        } else {
            body.push(binding);
        }
    }

    let header = match header {
        Some(mut structured) => {
            merge_header_bindings(&mut structured, shorthand_header);
            structured
        }
        None if !shorthand_header.is_empty() => shorthand_header,
        None => default_header(),
    };

    Ok((header, body))
}

fn shorthand_header_key(key: &str) -> Option<&'static str> {
    match key {
        "aeon:encoding" => Some("encoding"),
        "aeon:mode" => Some("mode"),
        "aeon:profile" => Some("profile"),
        "aeon:version" => Some("version"),
        "aeon:schema" => Some("schema"),
        _ => None,
    }
}

fn merge_header_bindings(structured: &mut Vec<Binding>, shorthand: Vec<Binding>) {
    for binding in shorthand {
        if let Some(existing) = structured.iter_mut().find(|entry| entry.key == binding.key) {
            *existing = binding;
        } else {
            structured.push(binding);
        }
    }
}

fn default_header() -> Vec<Binding> {
    vec![
        Binding::scalar("encoding", Value::String(String::from("utf-8"))),
        Binding::scalar("mode", Value::String(String::from("transport"))),
        Binding::scalar("profile", Value::String(String::from("core"))),
        Binding::scalar("version", Value::Number(String::from("1.0"))),
    ]
}

fn render_document(mut header: Vec<Binding>, mut body: Vec<Binding>) -> String {
    header.sort_by(|left, right| left.key.cmp(&right.key));
    body.sort_by(|left, right| left.key.cmp(&right.key));

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
    let prefix = " ".repeat(indent);
    let left = format!(
        "{}{}{}{}",
        prefix,
        render_key(&binding.key),
        render_attributes(&binding.attributes),
        render_datatype(binding.datatype.as_deref())
    );

    match &binding.value {
        Value::Object(bindings) => {
            let mut nested = bindings.clone();
            nested.sort_by(|left, right| left.key.cmp(&right.key));
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
        Value::String(value) if value.contains('\n') => {
            let rendered = render_string_lines(value, indent);
            let mut lines = vec![format!("{left} = {}", rendered[0])];
            lines.extend(rendered.into_iter().skip(1));
            lines
        }
        other => vec![format!("{left} = {}", render_value_inline(other))],
    }
}

fn render_sequence(left: &str, items: &[Value], indent: usize, open: char, close: char) -> Vec<String> {
    if items.iter().all(is_simple_scalar) {
        let rendered = items.iter().map(render_value_inline).collect::<Vec<_>>().join(", ");
        return vec![format!("{left} = {open}{rendered}{close}")];
    }

    let prefix = " ".repeat(indent);
    let mut lines = vec![format!("{left} = {open}")];
    for (index, item) in items.iter().enumerate() {
        let mut item_lines = render_value_multiline(item, indent + 2);
        if index + 1 < items.len() {
            if let Some(last) = item_lines.last_mut() {
                last.push(',');
            }
        }
        lines.append(&mut item_lines);
    }
    lines.push(format!("{prefix}{close}"));
    lines
}

fn render_value_multiline(value: &Value, indent: usize) -> Vec<String> {
    let prefix = " ".repeat(indent);
    match value {
        Value::String(value) if value.contains('\n') => {
            let mut lines = render_string_lines(value, indent);
            if let Some(first) = lines.first_mut() {
                *first = format!("{prefix}{first}");
            }
            lines
        }
        Value::Object(bindings) => {
            let mut nested = bindings.clone();
            nested.sort_by(|left, right| left.key.cmp(&right.key));
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
                if index + 1 < items.len() {
                    if let Some(last) = item_lines.last_mut() {
                        last.push(',');
                    }
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
                if index + 1 < items.len() {
                    if let Some(last) = item_lines.last_mut() {
                        last.push(',');
                    }
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
        "<{}{}{}",
        render_key(&node.tag),
        render_attributes(&node.attributes),
        render_datatype(node.datatype.as_deref())
    );

    if node.children.is_empty() {
        return vec![format!("{prefix}{head}>")];
    }

    if inline_only {
        let children = node.children.iter().map(render_value_inline).collect::<Vec<_>>().join(", ");
        return vec![format!("{prefix}{head}({children})>")];
    }

    let mut lines = vec![format!("{prefix}{head}(")];
    for (index, child) in node.children.iter().enumerate() {
        let mut child_lines = render_node_child(child, indent + 2);
        if index + 1 < node.children.len() {
            if let Some(last) = child_lines.last_mut() {
                last.push(',');
            }
        }
        lines.append(&mut child_lines);
    }
    lines.push(format!("{prefix})>"));
    lines
}

fn render_node_child(value: &Value, indent: usize) -> Vec<String> {
    match value {
        Value::List(items) if items.iter().all(is_simple_value) => {
            vec![format!("{}{}", " ".repeat(indent), render_value_inline(value))]
        }
        Value::Tuple(items) if items.iter().all(is_simple_value) => {
            vec![format!("{}{}", " ".repeat(indent), render_value_inline(value))]
        }
        Value::Node(node) if node.children.iter().all(is_simple_value) => {
            vec![format!("{}{}", " ".repeat(indent), render_value_inline(value))]
        }
        _ => render_value_multiline(value, indent),
    }
}

fn render_attributes(attributes: &BTreeMap<String, AttributeEntry>) -> String {
    if attributes.is_empty() {
        return String::new();
    }

    let rendered = attributes
        .iter()
        .map(|(key, entry)| {
            format!(
                "{}{}{} = {}",
                render_key(key),
                render_attributes(&entry.attributes),
                render_datatype(entry.datatype.as_deref()),
                render_value_inline(&entry.value)
            )
        })
        .collect::<Vec<_>>()
        .join(", ");

    format!("@{{{rendered}}}")
}

fn render_value_inline(value: &Value) -> String {
    match value {
        Value::String(value) => format!("\"{}\"", escape_string(value)),
        Value::Number(value) => normalize_number(value),
        Value::Infinity(value) => value.clone(),
        Value::Object(bindings) => {
            if bindings.is_empty() {
                return String::from("{}");
            }
            let mut nested = bindings.clone();
            nested.sort_by(|left, right| left.key.cmp(&right.key));
            format!(
                "{{ {} }}",
                nested
                    .iter()
                    .map(|binding| {
                        format!(
                            "{}{}{} = {}",
                            render_key(&binding.key),
                            render_attributes(&binding.attributes),
                            render_datatype(binding.datatype.as_deref()),
                            render_value_inline(&binding.value)
                        )
                    })
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        }
        Value::List(items) => format!("[{}]", items.iter().map(render_value_inline).collect::<Vec<_>>().join(", ")),
        Value::Tuple(items) => format!("({})", items.iter().map(render_value_inline).collect::<Vec<_>>().join(", ")),
        Value::Node(node) => {
            let head = format!(
                "<{}{}{}",
                render_key(&node.tag),
                render_attributes(&node.attributes),
                render_datatype(node.datatype.as_deref())
            );
            if node.children.is_empty() {
                format!("{head}>")
            } else {
                format!(
                    "{head}({})>",
                    node.children.iter().map(render_value_inline).collect::<Vec<_>>().join(", ")
                )
            }
        }
        Value::Raw(value) => normalize_raw(value),
    }
}

fn render_key(key: &str) -> String {
    if is_identifier(key) || key.starts_with("aeon:") {
        key.to_owned()
    } else {
        format!("\"{}\"", key.replace('\\', "\\\\").replace('"', "\\\""))
    }
}

fn render_datatype(datatype: Option<&str>) -> String {
    datatype
        .map(|datatype| format!(":{}", normalize_datatype(datatype)))
        .unwrap_or_default()
}

fn is_simple_scalar(value: &Value) -> bool {
    match value {
        Value::String(value) => !value.contains('\n'),
        Value::Number(_) | Value::Infinity(_) | Value::Raw(_) => true,
        _ => false,
    }
}

fn is_simple_value(value: &Value) -> bool {
    match value {
        Value::String(value) => !value.contains('\n'),
        Value::Number(_) | Value::Infinity(_) | Value::Raw(_) => true,
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
    value
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', "\\n")
        .replace('\r', "\\r")
}

fn render_string_lines(value: &str, indent: usize) -> Vec<String> {
    if !value.contains('\n') {
        return vec![format!("\"{}\"", escape_string(value))];
    }

    let prefix = " ".repeat(indent);
    let body_prefix = " ".repeat(indent + 2);
    let mut lines = vec![String::from(">`")];
    lines.extend(value.split('\n').map(|line| format!("{body_prefix}{line}")));
    lines.push(format!("{prefix}`"));
    lines
}

fn apply_trimticks(raw: &str, marker_width: usize) -> String {
    if !raw.contains('\n') {
        return raw.to_owned();
    }

    let mut lines: Vec<&str> = raw.split('\n').collect();
    if !lines.is_empty() && is_blank_trimtick_line(lines[0]) {
        lines.remove(0);
    }
    while !lines.is_empty() && is_blank_trimtick_line(lines[lines.len() - 1]) {
        lines.pop();
    }
    if lines.is_empty() {
        return String::new();
    }

    let normalized: Vec<String> = lines
        .into_iter()
        .map(|line| {
            if is_blank_trimtick_line(line) {
                String::new()
            } else if marker_width == 1 {
                String::from(line)
            } else {
                normalize_trimtick_indent(line, marker_width)
            }
        })
        .collect();

    let common_indent = normalized
        .iter()
        .filter(|line| !line.is_empty())
        .map(|line| count_leading_spaces(line))
        .min()
        .unwrap_or(0);

    normalized
        .into_iter()
        .map(|line| {
            if line.is_empty() {
                String::new()
            } else {
                line[common_indent..].to_owned()
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn is_blank_trimtick_line(line: &str) -> bool {
    line.chars().all(|ch| matches!(ch, ' ' | '\t'))
}

fn count_leading_spaces(line: &str) -> usize {
    line.chars().take_while(|ch| *ch == ' ').count()
}

fn normalize_trimtick_indent(line: &str, tab_width: usize) -> String {
    let mut prefix = String::new();
    let mut rest_start = line.len();
    for (idx, ch) in line.char_indices() {
        match ch {
            ' ' => prefix.push(' '),
            '\t' => prefix.push_str(&" ".repeat(tab_width)),
            _ => {
                rest_start = idx;
                break;
            }
        }
    }
    format!("{prefix}{}", &line[rest_start..])
}

fn normalize_number(raw: &str) -> String {
    let mut value = raw.replace('_', "").replace('E', "e");
    if value.starts_with('.') {
        value = format!("0{value}");
    }
    if value.starts_with("-.") {
        value = value.replacen("-.", "-0.", 1);
    }
    if value.starts_with("+.") {
        value = value.replacen("+.", "0.", 1);
    }
    if value.starts_with('+') && value.as_bytes().get(1).is_some_and(u8::is_ascii_digit) {
        value.remove(0);
    }

    let (mut mantissa, exponent) = match value.split_once('e') {
        Some((mantissa, exponent)) => (mantissa.to_owned(), Some(exponent.to_owned())),
        None => (value, None),
    };

    if let Some((int_part, frac_part_raw)) = mantissa.split_once('.') {
        let mut frac_part = frac_part_raw.trim_end_matches('0').to_owned();
        if frac_part.is_empty() {
            frac_part = String::from("0");
        }
        if exponent.is_some() && frac_part == "0" {
            mantissa = int_part.to_owned();
        } else {
            mantissa = format!("{int_part}.{frac_part}");
        }
    }

    if let Some(mut exponent) = exponent {
        if exponent.starts_with('+') {
            exponent.remove(0);
        }
        let negative = exponent.starts_with('-');
        let digits = if negative { &exponent[1..] } else { &exponent[..] };
        let trimmed = digits.trim_start_matches('0');
        let normalized = if trimmed.is_empty() { "0" } else { trimmed };
        if negative {
            format!("{mantissa}e-{normalized}")
        } else {
            format!("{mantissa}e{normalized}")
        }
    } else {
        mantissa
    }
}

fn is_rejected_nonfinite_literal(raw: &str) -> bool {
    matches!(raw, "+Infinity" | "NaN" | "-NaN" | "+NaN")
}

fn looks_like_number_literal(raw: &str) -> bool {
    if raw.is_empty() {
        return false;
    }

    let bytes = raw.as_bytes();
    let mut index = 0usize;
    if matches!(bytes.first(), Some(b'+') | Some(b'-')) {
        index += 1;
    }
    if index >= bytes.len() {
        return false;
    }

    let mut saw_digit = false;
    let mut saw_dot = false;
    let mut saw_exponent = false;
    let mut prev_was_underscore = false;

    if bytes[index] == b'.' {
        if index + 1 >= bytes.len() || !(bytes[index + 1] as char).is_ascii_digit() {
            return false;
        }
        saw_dot = true;
        index += 1;
    }

    while index < bytes.len() {
        match bytes[index] as char {
            '0'..='9' => {
                saw_digit = true;
                prev_was_underscore = false;
                index += 1;
            }
            '_' => {
                if !saw_digit || prev_was_underscore || index + 1 >= bytes.len() {
                    return false;
                }
                if !(bytes[index + 1] as char).is_ascii_digit() {
                    return false;
                }
                prev_was_underscore = true;
                index += 1;
            }
            '.' => {
                if saw_dot || saw_exponent || prev_was_underscore || index + 1 >= bytes.len() {
                    return false;
                }
                if !(bytes[index + 1] as char).is_ascii_digit() {
                    return false;
                }
                saw_dot = true;
                prev_was_underscore = false;
                index += 1;
            }
            'e' | 'E' => {
                if !saw_digit || saw_exponent || prev_was_underscore || index + 1 >= bytes.len() {
                    return false;
                }
                saw_exponent = true;
                prev_was_underscore = false;
                index += 1;
                if matches!(bytes.get(index), Some(b'+') | Some(b'-')) {
                    index += 1;
                }
                if index >= bytes.len() || !(bytes[index] as char).is_ascii_digit() {
                    return false;
                }
            }
            _ => return false,
        }
    }

    saw_digit && !prev_was_underscore
}

fn normalize_datatype(raw: &str) -> String {
    raw.replace(',', ", ")
}

fn normalize_raw(raw: &str) -> String {
    if let Some(hex) = raw.strip_prefix('#') {
        return format!("#{}", hex.replace('_', "").to_ascii_lowercase());
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
    value = normalize_quoted_reference_segments(&value, "@[\"", "@");
    value
}

fn is_identifier_literal(raw: &str) -> bool {
    matches!(raw, "true" | "false" | "yes" | "no" | "on" | "off")
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

fn strip_preamble(input: &str) -> String {
    let mut lines = input.lines();
    let mut output = Vec::new();

    if let Some(first) = lines.next() {
        if !first.starts_with("#!") {
            output.push(first);
        }
    }
    if let Some(second) = lines.next() {
        if !(output.is_empty() && second.starts_with("//! format:")) {
            output.push(second);
        }
    }
    output.extend(lines);
    output.join("\n")
}

impl Binding {
    fn scalar(key: &str, value: Value) -> Self {
        Self {
            key: String::from(key),
            datatype: None,
            attributes: BTreeMap::new(),
            value,
        }
    }
}

struct Parser<'a> {
    source: &'a [u8],
    index: usize,
}

impl<'a> Parser<'a> {
    fn new(source: &'a str) -> Self {
        Self {
            source: source.as_bytes(),
            index: 0,
        }
    }

    fn parse_document(&mut self) -> Result<Vec<Binding>, Diagnostic> {
        let mut bindings = Vec::new();
        self.skip_ws(true);
        while !self.is_eof() {
            bindings.push(self.parse_binding()?);
            self.skip_delimiters()?;
        }
        Ok(bindings)
    }

    fn parse_binding(&mut self) -> Result<Binding, Diagnostic> {
        let key = self.parse_key()?;
        self.skip_ws(true);
        let attributes = if self.peek() == Some('@') {
            self.parse_attribute_block()?
        } else {
            BTreeMap::new()
        };
        self.skip_ws(true);
        let datatype = if self.peek() == Some(':') {
            self.index += 1;
            Some(self.parse_datatype_like()?)
        } else {
            None
        };
        self.skip_ws(true);
        self.expect_char_message('=', &format!("Expected '=' after key '{key}'"))?;
        self.skip_ws(true);
        let value = self.parse_value()?;
        Ok(Binding {
            key,
            datatype,
            attributes,
            value,
        })
    }

    fn parse_key(&mut self) -> Result<String, Diagnostic> {
        self.skip_inline_ws();
        if matches!(self.peek(), Some('"') | Some('\'')) {
            return self.parse_quoted_string();
        }
        let key = self.parse_identifier_like(&[':', '@', '=', ' ', '\t', '\n', '\r', ',', '{', '}', '(', ')', '>', ']'])?;
        if key == "aeon" && self.peek() == Some(':') {
            self.index += 1;
            let suffix = self.parse_identifier_like(&['@', '=', ' ', '\t', '\n', '\r', ',', '}', ')', ']'])?;
            return Ok(format!("aeon:{suffix}"));
        }
        Ok(key)
    }

    fn parse_attribute_block(&mut self) -> Result<BTreeMap<String, AttributeEntry>, Diagnostic> {
        self.expect_char('@')?;
        self.skip_ws(true);
        self.expect_char('{')?;
        let mut entries = BTreeMap::new();
        self.skip_ws(true);
        while self.peek() != Some('}') {
            let key = self.parse_key()?;
            self.skip_ws(true);
            let nested = if self.peek() == Some('@') {
                self.parse_attribute_block()?
            } else {
                BTreeMap::new()
            };
            self.skip_ws(true);
            let datatype = if self.peek() == Some(':') {
                self.index += 1;
                Some(self.parse_datatype_like()?)
            } else {
                None
            };
            self.skip_ws(true);
            self.expect_char('=')?;
            self.skip_ws(true);
            let value = self.parse_value()?;
            entries.insert(
                key,
                AttributeEntry {
                    datatype,
                    attributes: nested,
                    value,
                },
            );
            self.skip_ws(true);
            if matches!(self.peek(), Some(',') | Some('\n')) {
                self.consume_delimiter();
                self.skip_ws(true);
            }
        }
        self.expect_char('}')?;
        Ok(entries)
    }

    fn parse_value(&mut self) -> Result<Value, Diagnostic> {
        match self.peek() {
            Some('"') | Some('\'') | Some('`') => Ok(Value::String(self.parse_quoted_string()?)),
            Some('>') => Ok(Value::String(self.parse_trimtick()?)),
            Some('{') => self.parse_object(),
            Some('[') => self.parse_list(),
            Some('(') => self.parse_tuple(),
            Some('<') => self.parse_node(),
            Some(ch) if ch.is_ascii_digit() || matches!(ch, '-' | '+') => {
                let raw = self.parse_bare_value()?;
                if matches!(raw.as_str(), "Infinity" | "-Infinity") {
                    return Ok(Value::Infinity(raw));
                }
                if looks_like_number_literal(&raw) {
                    return Ok(Value::Number(raw));
                }
                if is_rejected_nonfinite_literal(&raw) {
                    return Err(self.syntax_error("Invalid number literal"));
                }
                Ok(Value::Raw(raw))
            }
            Some(_) => {
                let start = self.index;
                let raw = self.parse_bare_value()?;
                if matches!(raw.as_str(), "Infinity" | "-Infinity") {
                    return Ok(Value::Infinity(raw));
                }
                if looks_like_number_literal(&raw) {
                    return Ok(Value::Number(raw));
                }
                if is_rejected_nonfinite_literal(&raw) {
                    return Err(self.syntax_error("Invalid number literal"));
                }
                if is_identifier(&raw) && !is_identifier_literal(&raw) {
                    return Err(self.syntax_error_range(start, self.index, &format!("Unexpected token '{raw}'")));
                }
                Ok(Value::Raw(raw))
            }
            None => Err(self.syntax_error("Missing value")),
        }
    }

    fn parse_object(&mut self) -> Result<Value, Diagnostic> {
        self.expect_char('{')?;
        let mut bindings = Vec::new();
        self.skip_ws(true);
        while self.peek() != Some('}') {
            bindings.push(self.parse_binding()?);
            self.skip_delimiters()?;
        }
        self.expect_char('}')?;
        Ok(Value::Object(bindings))
    }

    fn parse_list(&mut self) -> Result<Value, Diagnostic> {
        self.expect_char('[')?;
        let items = self.parse_sequence(']')?;
        Ok(Value::List(items))
    }

    fn parse_tuple(&mut self) -> Result<Value, Diagnostic> {
        self.expect_char('(')?;
        let items = self.parse_sequence(')')?;
        Ok(Value::Tuple(items))
    }

    fn parse_sequence(&mut self, terminator: char) -> Result<Vec<Value>, Diagnostic> {
        let mut items = Vec::new();
        self.skip_ws(true);
        while self.peek() != Some(terminator) {
            items.push(self.parse_value()?);
            self.skip_inline_ws();
            if self.peek() == Some(',') {
                self.consume_delimiter();
                self.skip_ws(true);
            } else if self.peek() == Some('\n') {
                self.consume_delimiter();
                self.skip_ws(true);
            } else if self.peek() != Some(terminator) {
                return Err(self.syntax_error("Expected list delimiter"));
            }
        }
        self.expect_char(terminator)?;
        Ok(items)
    }

    fn parse_node(&mut self) -> Result<Value, Diagnostic> {
        self.expect_char('<')?;
        self.skip_ws(true);
        let tag = self.parse_key()?;
        let mut datatype = None;
        let mut attributes = BTreeMap::new();
        loop {
            self.skip_ws(true);
            if self.peek() == Some('@') && attributes.is_empty() {
                attributes = self.parse_attribute_block()?;
                continue;
            }
            if self.peek() == Some(':') && datatype.is_none() {
                self.index += 1;
                self.skip_ws(true);
                datatype = Some(self.parse_identifier_like(&['@', '(', '>', ' ', '\t', '\n', '\r'])?);
                continue;
            }
            break;
        }
        self.skip_ws(true);
        let children = if self.peek() == Some('(') {
            self.expect_char('(')?;
            self.skip_ws(true);
            if self.peek() == Some(')') {
                self.expect_char(')')?;
                Vec::new()
            } else {
                let items = self.parse_sequence(')')?;
                items
            }
        } else {
            Vec::new()
        };
        self.skip_ws(true);
        self.expect_char('>')?;
        Ok(Value::Node(NodeValue {
            tag,
            datatype,
            attributes,
            children,
        }))
    }

    fn parse_quoted_string(&mut self) -> Result<String, Diagnostic> {
        let quote = self.peek().ok_or_else(|| self.syntax_error("Expected quoted string"))?;
        if !matches!(quote, '"' | '\'' | '`') {
            return Err(self.syntax_error("Expected quoted string"));
        }
        self.index += 1;
        let start = self.index;
        while let Some(ch) = self.peek() {
            if ch == quote {
                let value = std::str::from_utf8(&self.source[start..self.index])
                    .map_err(|_| self.syntax_error("Invalid UTF-8"))?
                    .to_owned();
                self.index += 1;
                return Ok(value);
            }
            self.index += 1;
        }
        Err(self.syntax_error("Unterminated string"))
    }

    fn parse_trimtick(&mut self) -> Result<String, Diagnostic> {
        let mut marker_width = 0usize;
        while self.peek() == Some('>') {
            self.index += 1;
            marker_width += 1;
        }
        while matches!(self.peek(), Some(' ' | '\t')) {
            self.index += 1;
        }
        if self.peek() != Some('`') {
            return Err(self.syntax_error("Expected trimtick opener"));
        }
        self.index += 1;
        let start = self.index;
        while let Some(ch) = self.peek() {
            if ch == '`' {
                let raw = std::str::from_utf8(&self.source[start..self.index])
                    .map_err(|_| self.syntax_error("Invalid UTF-8"))?
                    .to_owned();
                self.index += 1;
                return Ok(apply_trimticks(&raw, marker_width.max(1)));
            }
            self.index += 1;
        }
        Err(self.syntax_error("Unterminated trimtick"))
    }

    fn parse_bare_value(&mut self) -> Result<String, Diagnostic> {
        let start = self.index;
        let mut bracket_depth = 0usize;
        let mut in_quote = None;
        while let Some(ch) = self.peek() {
            if let Some(quote) = in_quote {
                self.index += 1;
                if ch == '\\' {
                    if !self.is_eof() {
                        self.index += 1;
                    }
                    continue;
                }
                if ch == quote {
                    in_quote = None;
                }
                continue;
            }

            match ch {
                '"' | '\'' => {
                    in_quote = Some(ch);
                    self.index += 1;
                }
                '[' => {
                    bracket_depth += 1;
                    self.index += 1;
                }
                ']' => {
                    if bracket_depth == 0 {
                        break;
                    }
                    bracket_depth -= 1;
                    self.index += 1;
                }
                ' ' | '\t' | ',' | '\n' | '\r' | '}' | ')' if bracket_depth == 0 => break,
                _ => self.index += 1,
            }
        }
        if self.index == start {
            return Err(self.syntax_error("Expected token"));
        }
        let value = std::str::from_utf8(&self.source[start..self.index])
            .map_err(|_| self.syntax_error("Invalid UTF-8"))?
            .trim()
            .to_owned();
        if value.is_empty() {
            return Err(self.syntax_error("Expected token"));
        }
        Ok(value)
    }

    fn parse_identifier_like(&mut self, stop: &[char]) -> Result<String, Diagnostic> {
        let start = self.index;
        while let Some(ch) = self.peek() {
            if stop.contains(&ch) {
                break;
            }
            self.index += 1;
        }
        if self.index == start {
            return Err(self.syntax_error("Expected token"));
        }
        let value = std::str::from_utf8(&self.source[start..self.index])
            .map_err(|_| self.syntax_error("Invalid UTF-8"))?
            .trim()
            .to_owned();
        if value.is_empty() {
            return Err(self.syntax_error("Expected token"));
        }
        Ok(value)
    }

    fn parse_datatype_like(&mut self) -> Result<String, Diagnostic> {
        self.skip_ws(true);
        let start = self.index;
        let mut angle_depth = 0usize;
        let mut bracket_depth = 0usize;
        while let Some(ch) = self.peek() {
            match ch {
                '<' => {
                    angle_depth += 1;
                    self.index += 1;
                }
                '>' => {
                    if angle_depth == 0 {
                        break;
                    }
                    angle_depth -= 1;
                    self.index += 1;
                }
                '[' => {
                    bracket_depth += 1;
                    self.index += 1;
                }
                ']' => {
                    if bracket_depth == 0 {
                        break;
                    }
                    bracket_depth -= 1;
                    self.index += 1;
                }
                '\n' | '\r' if angle_depth > 0 || bracket_depth > 0 => {
                    self.index += 1;
                }
                '\n' | '\r' if self.next_datatype_continuation().is_some() => {
                    self.index += 1;
                }
                '@' | '=' | ',' | '{' | '}' | '(' | ')' | '\n' | '\r'
                    if angle_depth == 0 && bracket_depth == 0 =>
                {
                    break;
                }
                _ => self.index += 1,
            }
        }
        if angle_depth != 0 || bracket_depth != 0 {
            return Err(self.syntax_error("Unterminated datatype annotation"));
        }
        let value = std::str::from_utf8(&self.source[start..self.index])
            .map_err(|_| self.syntax_error("Invalid UTF-8"))?
            .chars()
            .filter(|ch| !matches!(ch, ' ' | '\t' | '\n' | '\r'))
            .collect::<String>()
            .trim()
            .to_owned();
        if value.is_empty() {
            return Err(self.syntax_error("Expected token"));
        }
        Ok(value)
    }

    fn next_datatype_continuation(&self) -> Option<char> {
        let mut probe = self.index;
        while let Some(byte) = self.source.get(probe) {
            let ch = char::from(*byte);
            if matches!(ch, ' ' | '\t' | '\n' | '\r') {
                probe += 1;
                continue;
            }
            if ch == '/' {
                if matches!(self.source.get(probe + 1).map(|b| char::from(*b)), Some('/')) {
                    return None;
                }
                if self.source.get(probe + 1).is_some() {
                    return None;
                }
            }
            return Some(ch);
        }
        None
    }

    fn skip_delimiters(&mut self) -> Result<(), Diagnostic> {
        self.skip_ws(true);
        if self.is_eof() {
            return Ok(());
        }
        if matches!(self.peek(), Some(',') | Some('\n')) {
            self.consume_delimiter();
            self.skip_ws(true);
        }
        Ok(())
    }

    fn skip_ws(&mut self, include_newlines: bool) {
        loop {
            let mut consumed = false;
            while let Some(ch) = self.peek() {
                if matches!(ch, ' ' | '\t' | '\r') || (include_newlines && ch == '\n') {
                    self.index += 1;
                    consumed = true;
                } else {
                    break;
                }
            }

            if self.peek() == Some('/') && self.peek_next() == Some('/') {
                self.index += 2;
                while let Some(ch) = self.peek() {
                    if ch == '\n' {
                        if include_newlines {
                            self.index += 1;
                        }
                        break;
                    }
                    self.index += 1;
                }
                consumed = true;
            } else if let Some(close) = self.block_comment_close() {
                self.index += 2;
                while !self.is_eof() {
                    if self.peek() == Some(close) && self.peek_next() == Some('/') {
                        self.index += 2;
                        break;
                    }
                    self.index += 1;
                }
                consumed = true;
            }

            if !consumed {
                break;
            }
        }
    }

    fn skip_inline_ws(&mut self) {
        self.skip_ws(false);
    }

    fn consume_delimiter(&mut self) {
        let mut consumed_newline = false;
        while self.peek() == Some('\n') {
            self.index += 1;
            consumed_newline = true;
        }
        if self.peek() == Some(',') {
            self.index += 1;
            return;
        }
        if !consumed_newline && self.peek() == Some('\n') {
            self.index += 1;
        }
    }

    fn expect_char(&mut self, expected: char) -> Result<(), Diagnostic> {
        self.expect_char_message(expected, &format!("Expected `{expected}`"))
    }

    fn expect_char_message(&mut self, expected: char, message: &str) -> Result<(), Diagnostic> {
        if self.peek() == Some(expected) {
            self.index += 1;
            Ok(())
        } else {
            Err(self.syntax_error(message))
        }
    }

    fn peek(&self) -> Option<char> {
        self.source.get(self.index).map(|byte| char::from(*byte))
    }

    fn peek_next(&self) -> Option<char> {
        self.source.get(self.index + 1).map(|byte| char::from(*byte))
    }

    fn block_comment_close(&self) -> Option<char> {
        if self.peek() != Some('/') {
            return None;
        }
        match self.peek_next()? {
            '*' => Some('*'),
            '#' => Some('#'),
            '@' => Some('@'),
            '?' => Some('?'),
            '{' => Some('}'),
            '[' => Some(']'),
            '(' => Some(')'),
            _ => None,
        }
    }

    fn is_eof(&self) -> bool {
        self.index >= self.source.len()
    }

    fn syntax_error(&self, message: &str) -> Diagnostic {
        let mut diagnostic = Diagnostic::new("SYNTAX_ERROR", message).at_path("$");
        diagnostic.span = Some(self.current_span());
        diagnostic
    }

    fn syntax_error_range(&self, start: usize, end: usize, message: &str) -> Diagnostic {
        let mut diagnostic = Diagnostic::new("SYNTAX_ERROR", message).at_path("$");
        diagnostic.span = Some(Span {
            start: self.position_at(start),
            end: self.position_at(end),
        });
        diagnostic
    }

    fn current_span(&self) -> Span {
        let start = self.position_at(self.index);
        let end_index = self.error_end_index();
        Span {
            start,
            end: self.position_at(end_index),
        }
    }

    fn error_end_index(&self) -> usize {
        let mut index = self.index;
        while let Some(byte) = self.source.get(index) {
            let ch = char::from(*byte);
            if ch.is_whitespace() || matches!(ch, ',' | '=' | ':' | '@' | '{' | '}' | '[' | ']' | '(' | ')' | '<' | '>') {
                break;
            }
            index += 1;
        }
        if index == self.index {
            self.index
        } else {
            index
        }
    }

    fn position_at(&self, index: usize) -> Position {
        let mut line = 1usize;
        let mut column = 1usize;
        let limit = index.min(self.source.len());
        for byte in &self.source[..limit] {
            if *byte == b'\n' {
                line += 1;
                column = 1;
            } else {
                column += 1;
            }
        }
        Position {
            line,
            column,
            offset: limit,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn normalizes_trimtick_to_string_content() {
        let result = canonicalize("aeon:mode = \"transport\"\nc:trimtick = >> ``\nb:string = \"\"\n");
        assert!(result.errors.is_empty(), "{:?}", result.errors);
        assert_eq!(
            result.text,
            "aeon:header = {\n  mode = \"transport\"\n}\nb:string = \"\"\nc:trimtick = \"\"\n"
        );
    }

    #[test]
    fn canonicalizes_datatype_spacing_separator_specs_and_number_forms() {
        let result = canonicalize(
            "aeon:mode = \"strict\"\n\
             a:tuple<int32,int32> = (1, 2)\n\
             sep3 : sep [x] = ^1920x1080\n\
             n:number = 1_1_1.2_2e3_3\n",
        );
        assert!(result.errors.is_empty(), "{:?}", result.errors);
        assert_eq!(
            result.text,
            "aeon:header = {\n  mode = \"strict\"\n}\na:tuple<int32, int32> = (1, 2)\nn:number = 111.22e33\nsep3:sep[x] = ^1920x1080\n"
        );
    }

    #[test]
    fn canonicalizes_infinity_literals() {
        let result = canonicalize("top:infinity = Infinity\nbottom:infinity = -Infinity\n");
        assert!(result.errors.is_empty(), "{:?}", result.errors);
        assert_eq!(
            result.text,
            "aeon:header = {\n  encoding = \"utf-8\"\n  mode = \"transport\"\n  profile = \"core\"\n  version = 1.0\n}\nbottom:infinity = -Infinity\ntop:infinity = Infinity\n"
        );
    }

    #[test]
    fn rejects_invalid_infinity_spellings_in_canonicalization() {
        for source in ["a = +Infinity\n", "a = NaN\n"] {
            let result = canonicalize(source);
            assert!(!result.errors.is_empty(), "{source}");
            assert!(result.errors.iter().any(|error| error.code == "SYNTAX_ERROR"), "{:?}", result.errors);
        }
    }

    #[test]
    fn preserves_zrut_zone_casing_in_canonicalization() {
        let result = canonicalize("aeon:mode = \"strict\"\nz5:zrut = 2025-01-01T00:00:00Z&Europe/Belgium/Brussels\n");
        assert!(result.errors.is_empty(), "{:?}", result.errors);
        assert_eq!(
            result.text,
            "aeon:header = {\n  mode = \"strict\"\n}\nz5:zrut = 2025-01-01T00:00:00Z&Europe/Belgium/Brussels\n"
        );
    }

    #[test]
    fn strips_trailing_comments_from_raw_literals_in_canonicalization() {
        let result = canonicalize("aeon:mode = \"strict\"\nfile4:sep[/] = ^root/main/file.aeon // comment\n");
        assert!(result.errors.is_empty(), "{:?}", result.errors);
        assert_eq!(
            result.text,
            "aeon:header = {\n  mode = \"strict\"\n}\nfile4:sep[/] = ^root/main/file.aeon\n"
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
        let result = canonicalize("aeon:mode = \"strict\"\nwidget:node = <tag:node(\"x\")>\n");
        assert!(result.errors.is_empty(), "{:?}", result.errors);
        assert_eq!(
            result.text,
            "aeon:header = {\n  mode = \"strict\"\n}\nwidget:node = <tag:node(\n  \"x\"\n)>\n"
        );
    }

    #[test]
    fn canonicalizes_nested_node_list_and_tuple_children_inside_nodes() {
        let result = canonicalize(
            "aeon:mode = \"transport\"\n\
             b = <a(<a(1,2,3)>)>\n\
             c = <a([1,2])>\n\
             d = <a((1,2))>\n",
        );
        assert!(result.errors.is_empty(), "{:?}", result.errors);
        assert_eq!(
            result.text,
            "aeon:header = {\n  mode = \"transport\"\n}\nb = <a(\n  <a(1, 2, 3)>\n)>\nc = <a(\n  [1, 2]\n)>\nd = <a(\n  (1, 2)\n)>\n"
        );
    }

    #[test]
    fn canonicalizes_bracketed_reference_paths_and_root_prefixes() {
        let result = canonicalize(
            "aeon:mode = \"transport\"\n\
             a = { \"b.c\" = 1 }\n\
             v = ~$.a.[\"b.c\"]\n\
             p = ~>$.a\n\
             q = ~a@[\"meta\"].deep\n",
        );
        assert!(result.errors.is_empty(), "{:?}", result.errors);
        assert_eq!(
            result.text,
            "aeon:header = {\n  mode = \"transport\"\n}\na = {\n  \"b.c\" = 1\n}\np = ~>a\nq = ~a@meta.deep\nv = ~a.[\"b.c\"]\n"
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
             a:node = <\n\
             a\n\
             >\n\
             b:node =  < a (   ) >\n\
             c:node =  <a(  ) >\n\
             d:node =  <a (  )>\n",
        );
        assert!(result.errors.is_empty(), "{:?}", result.errors);
        assert_eq!(
            result.text,
            "aeon:header = {\n  mode = \"strict\"\n}\na:node = <a>\nb:node = <a>\nc:node = <a>\nd:node = <a>\n"
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
    fn canonicalizes_multiline_separator_specs_and_generic_boundaries_in_strict_mode() {
        let result = canonicalize(
            "aeon:mode = \"strict\"\n\
             size\n\
             :\n\
             sep\n\
             [\n\
             x\n\
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
            "aeon:header = {\n  mode = \"strict\"\n}\nitems:list<n> = [2, 3]\nsize:sep[x] = ^300x250\n"
        );
    }

    #[test]
    fn canonicalizes_root_prefixed_quoted_attribute_traversal() {
        let result = canonicalize(
            "aeon:mode = \"transport\"\na@{ meta = { deep = 1 } } = 3\nv = ~$.a@[\"meta\"].[\"deep\"]\n",
        );
        assert!(result.errors.is_empty(), "{:?}", result.errors);
        assert_eq!(
            result.text,
            "aeon:header = {\n  mode = \"transport\"\n}\na@{meta = { deep = 1 }} = 3\nv = ~a@meta.deep\n"
        );
    }

    #[test]
    fn canonicalizes_multiline_strings_as_trimticks() {
        let result = canonicalize("aeon:mode = \"transport\"\ntext = >> `\n  alpha\n\n  beta\n`\n");
        assert!(result.errors.is_empty(), "{:?}", result.errors);
        assert_eq!(
            result.text,
            "aeon:header = {\n  mode = \"transport\"\n}\ntext = >`\n  alpha\n  \n  beta\n`\n"
        );
    }

    #[test]
    fn canonicalizes_one_line_trimticks_in_lists_to_strings() {
        let result = canonicalize(
            "aeon:mode = \"custom\"\nnotes:list<trimtick> = [\n  >> `\n    one\n  `,\n  >> `\n    two\n  `\n]\n",
        );
        assert!(result.errors.is_empty(), "{:?}", result.errors);
        assert_eq!(
            result.text,
            "aeon:header = {\n  mode = \"custom\"\n}\nnotes:list<trimtick> = [\"one\", \"two\"]\n"
        );
    }

    #[test]
    fn canonicalizes_multiline_trimticks_inside_inline_attribute_objects_as_strings() {
        let result = canonicalize(
            "aeon:mode = \"custom\"\na@{ nested:object = { note:trimtick = >> `\n    hello\n\n    world\n  ` } }:node = <box>\n",
        );
        assert!(result.errors.is_empty(), "{:?}", result.errors);
        assert_eq!(
            result.text,
            "aeon:header = {\n  mode = \"custom\"\n}\na@{nested:object = { note:trimtick = \"hello\\n\\nworld\" }}:node = <box>\n"
        );
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
            "aeon:mode = \"custom\"\nscene:node = <panel(\n  <button@{ action:lookup = ~$.scene[1] }:node(\n    >> `\n      Click\n      Here\n    `\n  )>\n)>\n",
        );
        assert!(result.errors.is_empty(), "{:?}", result.errors);
        assert!(result.text.contains("<button@{action:lookup = ~scene[1]}:node("));
    }

    #[test]
    fn canonicalizes_node_head_references_inside_attributes() {
        let result = canonicalize(
            "aeon:mode = \"custom\"\ntarget:number = 1\nscene:node = <panel@{ \"z.k\":lookup = ~$.target, alpha:number = 1 }:node(\n  <button@{ action:lookup = ~>$.target }:node>\n)>\n",
        );
        assert!(result.errors.is_empty(), "{:?}", result.errors);
        assert!(result.text.contains("target:number = 1"));
        assert!(result.text.contains("~target"));
        assert!(result.text.contains("~>target"));
        assert!(result.text.contains("<panel@{"));
        assert!(result.text.contains("<button@{action:lookup = ~>target}:node>"));
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
            "aeon:mode = \"custom\"\n/* header note */\ntarget:number = 1\nscene:node = <panel@{ meta:object = { deep:number = 1 } }:node(\n  <button@{ action:lookup = ~>$.target }:node> // trailing child comment\n)> // trailing node comment\n",
        );
        assert!(result.errors.is_empty(), "{:?}", result.errors);
        assert_eq!(
            result.text,
            "aeon:header = {\n  mode = \"custom\"\n}\nscene:node = <panel@{meta:object = { deep:number = 1 }}:node(\n  <button@{action:lookup = ~>target}:node>\n)>\ntarget:number = 1\n"
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
            "aeon:header = {\n  mode = \"custom\"\n}\nbundle:object = {\n  meta:object = {\n    alpha:lookup = ~>target\n    \"z.k\":lookup = ~target\n  }\n  refs:list<object> = [\n    {\n      ptr:lookup = ~>target\n      \"z.k\":lookup = ~target\n    },\n    {\n      \"a.b\":lookup = ~>target\n      beta:lookup = ~target\n    }\n  ]\n}\ntarget:number = 1\n"
        );
    }
}
