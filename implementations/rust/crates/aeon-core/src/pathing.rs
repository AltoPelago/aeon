use crate::{CanonicalPath, PathSegment, ReferenceSegment};

#[must_use]
pub fn format_path(path: &CanonicalPath) -> String {
    let mut rendered = String::from("$");
    for segment in &path.segments {
        match segment {
            PathSegment::Root => {}
            PathSegment::Member(key) => rendered.push_str(&render_member_segment(key)),
            PathSegment::Index(index) => {
                rendered.push('[');
                rendered.push_str(&index.to_string());
                rendered.push(']');
            }
        }
    }
    rendered
}

#[must_use]
pub fn format_reference_target(segments: &[ReferenceSegment]) -> String {
    let mut output = String::from("$");
    for segment in segments {
        match segment {
            ReferenceSegment::Key(key) => output.push_str(&render_member_segment(key)),
            ReferenceSegment::Index(index) => {
                output.push('[');
                output.push_str(&index.to_string());
                output.push(']');
            }
            ReferenceSegment::Attr(key) => {
                output.push('@');
                output.push_str(key);
            }
        }
    }
    output
}

#[must_use]
pub fn format_reference_base(segments: &[ReferenceSegment]) -> String {
    let mut output = String::from("$");
    for segment in segments {
        match segment {
            ReferenceSegment::Key(key) => output.push_str(&render_member_segment(key)),
            ReferenceSegment::Index(index) => {
                output.push('[');
                output.push_str(&index.to_string());
                output.push(']');
            }
            ReferenceSegment::Attr(_) => break,
        }
    }
    output
}

#[must_use]
pub fn render_child_member_path(parent_path: &str, key: &str) -> String {
    format!("{parent_path}{}", render_member_segment(key))
}

#[must_use]
pub fn render_child_index_path(parent_path: &str, index: usize) -> String {
    format!("{parent_path}[{index}]")
}

#[must_use]
pub fn render_member_segment(key: &str) -> String {
    if is_identifier(key) {
        format!(".{key}")
    } else {
        format!(".[\"{}\"]", escape_quoted_key(key))
    }
}

#[must_use]
pub fn is_identifier(value: &str) -> bool {
    let mut chars = value.chars();
    match chars.next() {
        Some(first) if first == '_' || first.is_ascii_alphabetic() => {}
        _ => return false,
    }
    chars.all(|ch| ch == '_' || ch.is_ascii_alphanumeric())
}

#[must_use]
pub fn escape_quoted_key(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}
