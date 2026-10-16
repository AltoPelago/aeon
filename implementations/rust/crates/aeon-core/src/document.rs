//! The authored native document boundary, without compiler semantic approval.

use std::collections::HashSet;

use crate::flatten::flatten_document;
use crate::header::lower_header;
use crate::resource_limits::{validate_event_path_limits, validate_source_resource_limits};
use crate::token_parser::{
    ParserImplementation, ParserLimits, parse_document_from_tokens_recovery_with_implementation,
};
use crate::validation::validate_duplicate_object_member_keys;
use crate::{AeonCompileLimits, Binding, CanonicalPath, Diagnostic, format_path};

/// Parse an authored document, checking syntax, header layout, duplicate keys,
/// and the supplied structural/resource limits. On failure, no partial AST is
/// returned, even when the internal parser can recover.
///
/// Bindings, object members, sequence positions, and metadata order vectors
/// retain authored order. Structured headers are **not** lowered or defaulted;
/// `Binding::is_header` distinguishes header syntax from quoted body keys.
/// Spans refer to the original UTF-8 input, including a BOM or preamble.
///
/// This is **not** compilation or reference validation: missing, forward, and
/// self-references remain in the AST. Datatype compatibility, behavior modes,
/// profiles, schemas, and reference evaluation are not checked. Consumers must
/// validate reference legality before transforming this document. Use
/// [`crate::compile`] when compiler semantic approval is required.
///
/// `max_events` and payload-path limits use the existing compiler event
/// projection (header field roots are not body assignment events).
///
/// ```
/// use aeon_core::{AeonCompileLimits, parse_document};
///
/// let authored = parse_document("z = 1\na = ~z", &AeonCompileLimits::default())?;
/// assert_eq!(authored[0].key, "z");
/// assert_eq!(authored[1].key, "a");
/// # Ok::<(), Vec<aeon_core::Diagnostic>>(())
/// ```
pub fn parse_document(
    input: &str,
    limits: &AeonCompileLimits,
) -> Result<Vec<Binding>, Vec<Diagnostic>> {
    parse_with_implementation(input, limits, ParserImplementation::Sofia)
}

fn parse_with_implementation(
    input: &str,
    limits: &AeonCompileLimits,
    implementation: ParserImplementation,
) -> Result<Vec<Binding>, Vec<Diagnostic>> {
    let options = limits.compile_options();
    if let Some(error) = crate::input_size_diagnostic(input, &options) {
        return Err(vec![error]);
    }
    let parsed = parse_document_from_tokens_recovery_with_implementation(
        input,
        ParserLimits::new(
            limits.max_value_nesting_depth,
            limits.max_attribute_depth,
            limits.max_clarifier_values,
            limits.max_generic_depth,
            limits.max_generic_arguments,
            limits.max_datatype_components,
        ),
        implementation,
    );
    if !parsed.errors.is_empty() {
        return Err(parsed.errors);
    }
    let bindings = parsed.bindings;
    if let Some(error) = validate_source_resource_limits(input, &bindings, &options) {
        return Err(vec![error]);
    }
    // Validate the compiler's normalized header namespace without replacing
    // the authored header node or losing an explicitly empty header.
    let lowered = lower_header(bindings.clone()).map_err(|error| vec![error])?;
    let mut errors = Vec::new();
    validate_duplicate_object_member_keys(&bindings, &mut errors);
    let mut seen = HashSet::new();
    for binding in &lowered {
        if !seen.insert((binding.is_header, binding.key.as_str())) {
            errors.push(
                Diagnostic::new("DUPLICATE_KEY", format!("Duplicate key: '{}'", binding.key))
                    .at_path(format_path(&CanonicalPath::root().member(&binding.key)))
                    .with_span(binding.span),
            );
        }
    }
    if !errors.is_empty() {
        return Err(errors);
    }
    let flattened = flatten_document(&lowered, &CanonicalPath::root(), true, false, false);
    if let Some(error) =
        validate_event_path_limits(&flattened.events, &flattened.rendered_event_paths, &options)
    {
        return Err(vec![error]);
    }
    if let Some(max_events) = limits.max_events
        && flattened.events.len() > max_events
    {
        return Err(vec![crate::event_count_exceeded_error(
            flattened.events.len(),
            max_events,
        )]);
    }
    Ok(bindings)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{CompileOptions, ReferenceSegment, Value, compile};

    fn parse(source: &str) -> Vec<Binding> {
        parse_document(source, &AeonCompileLimits::default()).expect("valid authored document")
    }

    #[test]
    fn preserves_binding_object_and_metadata_orders() {
        let bindings = parse_document(
            r"z@{y = 1, a@{n = 2, b = 3} = {q = 4, c = 5}} = {m = 6, d = 7}
a = 8",
            &AeonCompileLimits {
                max_attribute_depth: 2,
                ..AeonCompileLimits::default()
            },
        )
        .expect("valid nested metadata at depth two");
        assert_eq!(
            bindings.iter().map(|b| b.key.as_str()).collect::<Vec<_>>(),
            ["z", "a"]
        );
        let binding = &bindings[0];
        assert_eq!(binding.attribute_order, ["y", "a"]);
        assert_eq!(binding.attributes["a"].nested_attr_order, ["n", "b"]);
        assert_eq!(binding.attributes["a"].object_member_order, ["q", "c"]);
        let Value::ObjectNode { bindings } = &binding.value else {
            panic!("object")
        };
        assert_eq!(
            bindings.iter().map(|b| b.key.as_str()).collect::<Vec<_>>(),
            ["m", "d"]
        );
    }

    #[test]
    fn preserves_identity_datatype_and_separate_node_head_metadata() {
        let source = r#"value\BIND\@{z\META\:string = "user", a = 1}:custom = <tag\HEAD\@{q = 2, b = 3}(\CHILD\:string = "child")>"#;
        let bindings = parse(source);
        let binding = &bindings[0];
        assert_eq!(binding.structural_id.as_deref(), Some("BIND"));
        assert_eq!(binding.datatype.as_deref(), Some("custom"));
        assert_eq!(binding.attribute_order, ["z", "a"]);
        assert_eq!(
            binding.attributes["z"].structural_id.as_deref(),
            Some("META")
        );
        assert_eq!(binding.attributes["z"].datatype.as_deref(), Some("string"));
        let Value::NodeLiteral {
            structural_id,
            attributes,
            attribute_order,
            children,
            ..
        } = &binding.value
        else {
            panic!("node")
        };
        assert_eq!(structural_id.as_deref(), Some("HEAD"));
        assert_eq!(attribute_order, &["q", "b"]);
        assert!(!attributes[0].contains_key("z"));
        let Value::TypedValue {
            structural_id,
            datatype,
            ..
        } = &children[0]
        else {
            panic!("typed child")
        };
        assert_eq!(structural_id.as_deref(), Some("CHILD"));
        assert_eq!(datatype.as_deref(), Some("string"));
    }

    #[test]
    fn preserves_header_syntax_and_colliding_body_keys() {
        assert!(parse("").is_empty());
        assert!(!parse("x = 1")[0].is_header);
        let empty = parse("aeon:header = {}\nx = 1");
        assert!(empty[0].is_header);
        assert!(matches!(&empty[0].value, Value::ObjectNode { bindings } if bindings.is_empty()));
        let structured = parse("aeon:header = {z = 1, a = 2}\n\"aeon:z\" = 3");
        assert_eq!(structured[0].key, "aeon:header");
        assert!(structured[0].is_header);
        assert_eq!(structured[1].key, "aeon:z");
        assert!(!structured[1].is_header);
        assert!(!parse("\"aeon:header\" = 1")[0].is_header);
        let shorthand = parse("aeon:mode = \"transport\"\nx = 1");
        assert!(shorthand[0].is_header);
        assert_eq!(shorthand[0].key, "aeon:mode");
    }

    #[test]
    fn preserves_reference_kind_and_decoded_structural_segments() {
        let bindings = parse(
            r#"a = ~$.items[1].@.["literal.@key"].leaf
b = ~>["line\nbreak"][0]"#,
        );
        let Value::CloneReference { segments, .. } = &bindings[0].value else {
            panic!("clone")
        };
        assert_eq!(
            segments,
            &[
                ReferenceSegment::Key("items".into()),
                ReferenceSegment::Index(1),
                ReferenceSegment::Attr("literal.@key".into()),
                ReferenceSegment::Key("leaf".into()),
            ]
        );
        let Value::PointerReference { segments, .. } = &bindings[1].value else {
            panic!("pointer")
        };
        assert_eq!(
            segments,
            &[
                ReferenceSegment::Key("line\nbreak".into()),
                ReferenceSegment::Index(0)
            ]
        );
    }

    #[test]
    fn syntax_acceptance_does_not_approve_reference_semantics() {
        for (source, code) in [
            ("a = ~missing", "MISSING_REFERENCE_TARGET"),
            ("a = ~a", "SELF_REFERENCE"),
            ("a = ~z\nz = 1", "FORWARD_REFERENCE"),
            ("a@{b = ~a.@.z, z = 1} = 0", "FORWARD_REFERENCE"),
        ] {
            assert!(!parse(source).is_empty());
            assert!(
                compile(source, CompileOptions::default())
                    .errors
                    .iter()
                    .any(|error| error.code == code)
            );
        }
    }

    #[test]
    fn syntax_acceptance_does_not_approve_datatypes_modes_or_profiles() {
        for source in [
            "aeon:mode = \"strict\"\na = 1",
            "aeon:mode = \"strict\"\na:int32 = \"wrong\"",
            "aeon:mode = \"strict\"\na:myCustom = 1",
            "aeon:profile = \"aeon.gp.profile.v1\"\na:n[3] = 3",
        ] {
            assert!(!parse(source).is_empty());
            assert!(
                !compile(source, CompileOptions::default()).errors.is_empty(),
                "{source}"
            );
        }
    }

    #[test]
    fn preserves_literal_families_and_sequence_positions() {
        let bindings = parse(
            "a = [|approved|, `raw`, >`trim`, 2024-02-29, 2024-02-29T10:20:30Z, 10:20:30]\nb = (3, 2, 1)",
        );
        let Value::ListNode { items } = &bindings[0].value else {
            panic!("list")
        };
        assert!(matches!(&items[0], Value::SymbolicLiteral { value, .. } if value == "approved"));
        assert!(
            matches!(&items[1], Value::StringLiteral { delimiter: '`', trimticks: None, value, .. } if value == "raw")
        );
        assert!(
            matches!(&items[2], Value::StringLiteral { delimiter: '`', trimticks: Some(_), value, .. } if value == "trim")
        );
        assert!(matches!(&items[3], Value::DateLiteral { .. }));
        assert!(matches!(&items[4], Value::DateTimeLiteral { .. }));
        assert!(matches!(&items[5], Value::TimeLiteral { .. }));
        let Value::TupleLiteral { items } = &bindings[1].value else {
            panic!("tuple")
        };
        assert_eq!(
            items
                .iter()
                .map(|v| match v {
                    Value::NumberLiteral { raw } => raw.as_str(),
                    _ => panic!("number"),
                })
                .collect::<Vec<_>>(),
            ["3", "2", "1"]
        );
    }

    #[test]
    fn rejects_syntax_header_and_duplicate_errors_without_partial_ast() {
        for source in [
            "a = 1\nb = [",
            "a = 1\n!",
            "a = 1\na = 2",
            "a = {z = 1, z = 2}",
            "a = [{z = 1, z = 2}]",
            "a@{z = 1, z = 2} = 0",
            "a@{m = {z = 1, z = 2}} = 0",
            "aeon:header = {mode = \"transport\", mode = \"strict\"}",
            "aeon:mode = \"transport\"\naeon:mode = \"strict\"",
            "aeon:header = 1",
            "a = 1\naeon:header = {}",
            "aeon:header = {}\naeon:mode = \"transport\"",
            "a\\same\\ = 1\nb\\same\\ = 2",
        ] {
            assert!(
                parse_document(source, &AeonCompileLimits::default()).is_err(),
                "{source}"
            );
        }
    }

    #[test]
    fn retains_exact_original_utf8_coordinates_and_counts_preamble_bytes() {
        let source = "\u{feff}#!/usr/bin/env aeon\r\n//! format:aeon.test.v1\r\n\"é\" = |😀|";
        let binding = &parse(source)[0];
        assert_eq!(
            binding.span.start.offset,
            source.find('"').expect("quoted key")
        );
        assert_eq!(binding.span.start.line, 3);
        assert_eq!(binding.span.start.column, 1);
        assert_eq!(binding.span.end.offset, source.len());
        let mut limits = AeonCompileLimits {
            max_input_bytes: Some(source.len()),
            ..AeonCompileLimits::default()
        };
        assert!(parse_document(source, &limits).is_ok());
        limits.max_input_bytes = Some(source.len() - 1);
        assert_eq!(
            parse_document(source, &limits).expect_err("full source exceeds byte budget")[0].code,
            "INPUT_SIZE_EXCEEDED"
        );
    }

    #[test]
    fn native_document_matches_baseline_parser_without_semantic_approval() {
        for source in [
            "",
            "aeon:header = {}",
            "aeon:header = {z = {leaf = 1}}\n\"aeon:z\" = 2\ncopy = ~[\"aeon:z\"].leaf",
            "a@{z = 1, b = ~a.@.z} = [@{q = 2} = |ok|, <tag@{p = 3}(1, 2)>]",
            "a = ~a",
            "a = ~z\nz = 1",
            "a = 1\nb = [",
            "a = {x = 1, x = 2}",
            "\u{feff}#!/usr/bin/env aeon\r\n//! aeon\r\na = 1",
        ] {
            let limits = AeonCompileLimits::default();
            assert_eq!(
                parse_document(source, &limits),
                parse_with_implementation(source, &limits, ParserImplementation::Baseline),
                "{source}"
            );
        }
    }

    #[test]
    fn event_budget_uses_the_existing_compiler_projection() {
        let limits = AeonCompileLimits {
            max_events: Some(0),
            ..AeonCompileLimits::default()
        };
        assert!(parse_document("aeon:header = {mode = \"transport\"}", &limits).is_ok());
        assert_eq!(
            parse_document("aeon:header = {}\nx = 1", &limits)
                .expect_err("body event exceeds zero budget")[0]
                .code,
            "EVENT_COUNT_EXCEEDED"
        );
        // Header object descendants are events even though their field root
        // is not. Do not accidentally exempt the entire header subtree.
        assert_eq!(
            parse_document("aeon:header = {x = {leaf = 1}}", &limits)
                .expect_err("header descendant event exceeds zero budget")[0]
                .code,
            "EVENT_COUNT_EXCEEDED"
        );
    }

    #[test]
    fn limit_conversion_preserves_every_field_and_legacy_alias_precedence() {
        let options = CompileOptions {
            max_attribute_depth: 2,
            max_clarifier_values: Some(3),
            max_separator_depth: 99,
            max_generic_depth: 4,
            max_generic_arguments: 5,
            max_datatype_components: 6,
            max_value_nesting_depth: Some(7),
            max_nesting_depth: 99,
            max_path_depth: 8,
            max_string_codepoints: 9,
            max_key_segment_codepoints: 10,
            max_list_items: 11,
            max_tuple_items: 12,
            max_path_characters: 13,
            max_numeric_literal_characters: 14,
            max_structured_comment_characters: 15,
            max_input_bytes: Some(16),
            max_events: Some(17),
            ..CompileOptions::default()
        };
        let limits = AeonCompileLimits::from(&options);
        assert_eq!(limits, AeonCompileLimits::from(&limits.compile_options()));
        assert_eq!(limits.max_clarifier_values, 3);
        assert_eq!(limits.max_value_nesting_depth, 7);
        let legacy = AeonCompileLimits::from(&CompileOptions {
            max_separator_depth: 4,
            max_nesting_depth: 5,
            ..CompileOptions::default()
        });
        assert_eq!(legacy.max_clarifier_values, 4);
        assert_eq!(legacy.max_value_nesting_depth, 5);
        assert_eq!(
            AeonCompileLimits::default(),
            AeonCompileLimits::from(&CompileOptions::default())
        );
    }
}
