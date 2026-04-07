#![allow(clippy::result_large_err)]

use std::collections::BTreeMap;

use crate::{Binding, Diagnostic, HeaderFields, Position, Span, Value};

fn combined_span(a: Span, b: Span) -> Span {
    Span {
        start: earlier_position(a.start, b.start),
        end: later_position(a.end, b.end),
    }
}

fn earlier_position(a: Position, b: Position) -> Position {
    if a.offset <= b.offset { a } else { b }
}

fn later_position(a: Position, b: Position) -> Position {
    if a.offset >= b.offset { a } else { b }
}

pub(crate) fn extract_header_fields(bindings: &[Binding]) -> HeaderFields {
    let mut fields = BTreeMap::new();
    for binding in bindings {
        if let Some(key) = binding.key.strip_prefix("aeon:") {
            let _ = fields.insert(String::from(key), binding.value.clone());
        }
    }
    HeaderFields { fields }
}

pub(crate) fn lower_header(bindings: Vec<Binding>) -> Result<Vec<Binding>, Diagnostic> {
    let structured_header = bindings.iter().find(|binding| binding.key == "aeon:header");
    let shorthand_header = bindings
        .iter()
        .find(|binding| binding.key.starts_with("aeon:") && binding.key != "aeon:header");
    if let (Some(structured_header), Some(shorthand_header)) = (structured_header, shorthand_header)
    {
        return Err(Diagnostic::new(
            "HEADER_CONFLICT",
            "Header conflict: cannot use both structured header (aeon:header) and shorthand header fields",
        )
        .at_path("$")
        .with_span(combined_span(structured_header.span, shorthand_header.span)));
    }
    let mut lowered = Vec::new();
    let mut seen_body = false;
    for binding in bindings {
        if binding.key == "aeon:header" {
            if seen_body {
                return Err(Diagnostic::new(
                    "SYNTAX_ERROR",
                    "Structured headers must appear before body bindings",
                )
                .at_path("$"));
            }
            let Value::ObjectNode {
                bindings: header_bindings,
            } = binding.value
            else {
                return Err(
                    Diagnostic::new("SYNTAX_ERROR", "Structured header must be an object")
                        .at_path("$"),
                );
            };
            for header in header_bindings {
                let mapped_key = if header.key == "mode" {
                    String::from("aeon:mode")
                } else {
                    format!("aeon:{}", header.key)
                };
                lowered.push(Binding {
                    key: mapped_key,
                    ..header
                });
            }
        } else {
            seen_body = true;
            lowered.push(binding);
        }
    }
    Ok(lowered)
}

#[must_use]
pub fn strip_leading_bom(input: &str) -> String {
    input.strip_prefix('\u{feff}').unwrap_or(input).to_owned()
}

pub(crate) fn strip_preamble(input: &str) -> String {
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

pub(crate) fn apply_trimticks(raw: &str, marker_width: usize) -> String {
    if !raw.contains('\n') {
        return String::from(raw);
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
                line
            } else {
                line.chars().skip(common_indent).collect::<String>()
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}
