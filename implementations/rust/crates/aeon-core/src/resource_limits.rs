use crate::pathing::format_reference_target;
use crate::{
    AssignmentEvent, AttributeValue, Binding, CompileOptions, Diagnostic, LexerOptions, Span,
    TokenKind, Value, format_path, tokenize,
};

pub(crate) fn validate_source_resource_limits(
    source: &str,
    bindings: &[Binding],
    options: &CompileOptions,
) -> Option<Diagnostic> {
    for binding in bindings {
        if let Some(error) = validate_binding(binding, options) {
            return Some(error);
        }
    }
    let lexed = tokenize(
        source,
        LexerOptions {
            include_comments: true,
            ..LexerOptions::default()
        },
    );
    for token in lexed.tokens {
        if !matches!(token.kind, TokenKind::LineComment | TokenKind::BlockComment) {
            continue;
        }
        let structured_line =
            token.kind == TokenKind::LineComment
                && token.text.chars().nth(2).is_some_and(|marker| {
                    matches!(marker, '#' | '@' | '?' | '!' | '{' | '[' | '(')
                });
        let structured_block =
            token.kind == TokenKind::BlockComment
                && token.text.chars().nth(1).is_some_and(|marker| {
                    matches!(marker, '#' | '@' | '?' | '!' | '{' | '[' | '(')
                });
        if !structured_line && !structured_block {
            continue;
        }
        let payload_chars =
            token
                .text
                .chars()
                .count()
                .saturating_sub(if token.kind == TokenKind::LineComment {
                    3
                } else {
                    4
                });
        if payload_chars > options.max_structured_comment_characters {
            return Some(exhausted(
                "max_structured_comment_characters",
                payload_chars,
                options.max_structured_comment_characters,
                token.span,
            ));
        }
    }
    None
}

pub(crate) fn validate_event_path_limits(
    events: &[AssignmentEvent],
    options: &CompileOptions,
) -> Option<Diagnostic> {
    for event in events {
        let depth = event.path.segments.len().saturating_sub(1);
        if depth > options.max_path_depth {
            return Some(exhausted(
                "max_path_depth",
                depth,
                options.max_path_depth,
                event.span,
            ));
        }
        let characters = format_path(&event.path).chars().count();
        if characters > options.max_path_characters {
            return Some(exhausted(
                "max_path_characters",
                characters,
                options.max_path_characters,
                event.span,
            ));
        }
    }
    None
}

fn validate_binding(binding: &Binding, options: &CompileOptions) -> Option<Diagnostic> {
    check_key(&binding.key, options, binding.span)
        .or_else(|| validate_attributes(&binding.attributes, options, binding.span))
        .or_else(|| validate_value(&binding.value, options, binding.span))
}

fn validate_attributes(
    attributes: &std::collections::BTreeMap<String, AttributeValue>,
    options: &CompileOptions,
    span: Span,
) -> Option<Diagnostic> {
    for (key, value) in attributes {
        if let Some(error) =
            check_key(key, options, span).or_else(|| validate_attribute_value(value, options, span))
        {
            return Some(error);
        }
    }
    None
}

fn validate_attribute_value(
    value: &AttributeValue,
    options: &CompileOptions,
    span: Span,
) -> Option<Diagnostic> {
    if let Some(value) = &value.value
        && let Some(error) = validate_value(value, options, span)
    {
        return Some(error);
    }
    validate_attributes(&value.nested_attrs, options, span)
        .or_else(|| validate_attributes(&value.object_members, options, span))
}

fn validate_value(value: &Value, options: &CompileOptions, span: Span) -> Option<Diagnostic> {
    match value {
        Value::TypedValue {
            attributes, value, ..
        } => validate_attributes(attributes, options, span)
            .or_else(|| validate_value(value, options, span)),
        Value::StringLiteral { value, .. } => {
            let observed = value.chars().count();
            (observed > options.max_string_codepoints).then(|| {
                exhausted(
                    "max_string_codepoints",
                    observed,
                    options.max_string_codepoints,
                    span,
                )
            })
        }
        Value::NumberLiteral { raw } => {
            let observed = raw.chars().count();
            (observed > options.max_numeric_literal_characters).then(|| {
                exhausted(
                    "max_numeric_literal_characters",
                    observed,
                    options.max_numeric_literal_characters,
                    span,
                )
            })
        }
        Value::ListNode { items } => {
            if items.len() > options.max_list_items {
                return Some(exhausted(
                    "max_list_items",
                    items.len(),
                    options.max_list_items,
                    span,
                ));
            }
            items
                .iter()
                .find_map(|item| validate_value(item, options, span))
        }
        Value::TupleLiteral { items } => {
            if items.len() > options.max_tuple_items {
                return Some(exhausted(
                    "max_tuple_items",
                    items.len(),
                    options.max_tuple_items,
                    span,
                ));
            }
            items
                .iter()
                .find_map(|item| validate_value(item, options, span))
        }
        Value::ObjectNode { bindings } => bindings
            .iter()
            .find_map(|binding| validate_binding(binding, options)),
        Value::NodeLiteral {
            tag,
            attributes,
            children,
            ..
        } => check_key(tag, options, span)
            .or_else(|| {
                attributes
                    .iter()
                    .find_map(|attribute| validate_attributes(attribute, options, span))
            })
            .or_else(|| {
                children
                    .iter()
                    .find_map(|child| validate_value(child, options, span))
            }),
        Value::CloneReference { segments, .. } | Value::PointerReference { segments, .. } => {
            if segments.len() > options.max_path_depth {
                return Some(exhausted(
                    "max_path_depth",
                    segments.len(),
                    options.max_path_depth,
                    span,
                ));
            }
            let characters = format_reference_target(segments).chars().count();
            (characters > options.max_path_characters).then(|| {
                exhausted(
                    "max_path_characters",
                    characters,
                    options.max_path_characters,
                    span,
                )
            })
        }
        _ => None,
    }
}

fn check_key(key: &str, options: &CompileOptions, span: Span) -> Option<Diagnostic> {
    let observed = key.chars().count();
    (observed > options.max_key_segment_codepoints).then(|| {
        exhausted(
            "max_key_segment_codepoints",
            observed,
            options.max_key_segment_codepoints,
            span,
        )
    })
}

fn exhausted(counter: &str, observed: usize, limit: usize, span: Span) -> Diagnostic {
    Diagnostic::new(
        format!("{}_EXCEEDED", counter.to_ascii_uppercase()),
        format!("{counter} observed value {observed} exceeds configured limit {limit}"),
    )
    .at_path("$")
    .with_span(span)
}

#[cfg(test)]
mod tests {
    use crate::{CompileOptions, compile};

    fn first_code(source: &str, options: CompileOptions) -> String {
        let result = compile(source, options);
        result
            .errors
            .first()
            .unwrap_or_else(|| panic!("expected resource error for {source:?}"))
            .code
            .clone()
    }

    #[test]
    fn independent_named_resource_limits_fail_closed() {
        assert_eq!(
            first_code(
                "a = \"xy\"",
                CompileOptions {
                    max_string_codepoints: 1,
                    ..CompileOptions::default()
                }
            ),
            "MAX_STRING_CODEPOINTS_EXCEEDED"
        );
        assert_eq!(
            first_code(
                "ab = 1",
                CompileOptions {
                    max_key_segment_codepoints: 1,
                    ..CompileOptions::default()
                }
            ),
            "MAX_KEY_SEGMENT_CODEPOINTS_EXCEEDED"
        );
        assert_eq!(
            first_code(
                "a = [1,2]",
                CompileOptions {
                    max_list_items: 1,
                    ..CompileOptions::default()
                }
            ),
            "MAX_LIST_ITEMS_EXCEEDED"
        );
        assert_eq!(
            first_code(
                "a = (1,2)",
                CompileOptions {
                    max_tuple_items: 1,
                    ..CompileOptions::default()
                }
            ),
            "MAX_TUPLE_ITEMS_EXCEEDED"
        );
        assert_eq!(
            first_code(
                "a = 1234",
                CompileOptions {
                    max_numeric_literal_characters: 3,
                    ..CompileOptions::default()
                }
            ),
            "MAX_NUMERIC_LITERAL_CHARACTERS_EXCEEDED"
        );
        assert_eq!(
            first_code(
                "a = { b = 1 }",
                CompileOptions {
                    max_path_depth: 1,
                    ..CompileOptions::default()
                }
            ),
            "MAX_PATH_DEPTH_EXCEEDED"
        );
        assert_eq!(
            first_code(
                "//@abc\na = 1",
                CompileOptions {
                    max_structured_comment_characters: 2,
                    ..CompileOptions::default()
                }
            ),
            "MAX_STRUCTURED_COMMENT_CHARACTERS_EXCEEDED"
        );
        assert_eq!(
            first_code(
                "//!abc\na = 1",
                CompileOptions {
                    max_structured_comment_characters: 2,
                    ..CompileOptions::default()
                }
            ),
            "MAX_STRUCTURED_COMMENT_CHARACTERS_EXCEEDED"
        );
    }

    #[test]
    fn datatype_breadth_and_total_components_are_independent() {
        assert_eq!(
            first_code(
                "a:tuple<n,n,n> = (1,2,3)",
                CompileOptions {
                    max_generic_arguments: 2,
                    ..CompileOptions::default()
                }
            ),
            "GENERIC_ARGUMENTS_EXCEEDED"
        );
        assert_eq!(
            first_code(
                "a:tuple<n,n> = (1,2)",
                CompileOptions {
                    max_datatype_components: 2,
                    ..CompileOptions::default()
                }
            ),
            "DATATYPE_COMPONENTS_EXCEEDED"
        );
    }
}
