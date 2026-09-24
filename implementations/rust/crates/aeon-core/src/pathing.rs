use crate::{CanonicalPath, PathSegment, ReferenceSegment};

#[must_use]
pub fn format_path(path: &CanonicalPath) -> String {
    let mut rendered = String::from("$");
    for segment in &path.segments {
        match segment {
            PathSegment::Root => {}
            PathSegment::Member(key) => push_member_segment(&mut rendered, key),
            PathSegment::Index(index) => {
                rendered.push('[');
                push_usize_decimal(&mut rendered, *index);
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
            ReferenceSegment::Key(key) => push_member_segment(&mut output, key),
            ReferenceSegment::Index(index) => {
                output.push('[');
                push_usize_decimal(&mut output, *index);
                output.push(']');
            }
            ReferenceSegment::Attr(key) => {
                output.push_str(".@");
                push_member_segment(&mut output, key);
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
            ReferenceSegment::Key(key) => push_member_segment(&mut output, key),
            ReferenceSegment::Index(index) => {
                output.push('[');
                push_usize_decimal(&mut output, *index);
                output.push(']');
            }
            ReferenceSegment::Attr(_) => break,
        }
    }
    output
}

#[must_use]
pub fn render_child_member_path(parent_path: &str, key: &str) -> String {
    let mut output = String::with_capacity(parent_path.len() + key.len() + 5);
    output.push_str(parent_path);
    push_member_segment(&mut output, key);
    output
}

#[must_use]
pub fn render_child_index_path(parent_path: &str, index: usize) -> String {
    let mut output = String::with_capacity(parent_path.len() + decimal_width(index) + 2);
    output.push_str(parent_path);
    output.push('[');
    push_usize_decimal(&mut output, index);
    output.push(']');
    output
}

fn decimal_width(value: usize) -> usize {
    if value == 0 {
        1
    } else {
        value.ilog10() as usize + 1
    }
}

#[must_use]
pub fn render_member_segment(key: &str) -> String {
    let mut output = String::with_capacity(key.len() + 5);
    push_member_segment(&mut output, key);
    output
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

fn push_member_segment(output: &mut String, key: &str) {
    if is_identifier(key) {
        output.push('.');
        output.push_str(key);
    } else {
        output.push_str(".[\"");
        for ch in key.chars() {
            match ch {
                '\\' => output.push_str("\\\\"),
                '"' => output.push_str("\\\""),
                _ => output.push(ch),
            }
        }
        output.push_str("\"]");
    }
}

fn push_usize_decimal(output: &mut String, mut value: usize) {
    let mut digits = [0_u8; 20];
    let mut cursor = digits.len();
    loop {
        cursor -= 1;
        digits[cursor] = b'0' + (value % 10) as u8;
        value /= 10;
        if value == 0 {
            break;
        }
    }
    output.push_str(
        std::str::from_utf8(&digits[cursor..]).expect("decimal digits are always valid UTF-8"),
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_members_indexes_and_escaped_keys_without_intermediate_strings() {
        assert_eq!(render_member_segment("plain_name"), ".plain_name");
        assert_eq!(render_member_segment("quoted key"), ".[\"quoted key\"]");
        assert_eq!(render_member_segment("a\\b\"c"), ".[\"a\\\\b\\\"c\"]");
        assert_eq!(render_child_member_path("$.root", "child"), "$.root.child");
        assert_eq!(render_child_index_path("$.root", 42), "$.root[42]");
        assert_eq!(
            render_child_index_path("$", usize::MAX),
            format!("$[{}]", usize::MAX)
        );
    }

    #[test]
    fn direct_reference_rendering_preserves_key_index_and_attribute_syntax() {
        let segments = vec![
            ReferenceSegment::Key(String::from("root")),
            ReferenceSegment::Index(12),
            ReferenceSegment::Attr(String::from("quoted key")),
        ];
        assert_eq!(
            format_reference_target(&segments),
            "$.root[12].@.[\"quoted key\"]"
        );
        assert_eq!(format_reference_base(&segments), "$.root[12]");
    }
}
