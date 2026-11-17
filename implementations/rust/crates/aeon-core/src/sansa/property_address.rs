//! Reuse the pinned SANSA engine for property-bearing Addressing. Structural
//! reference spelling and property-free Core parsing retain their existing path.
use super::*;
use sansa_runtime::address as shared;

pub(super) fn has_syntax(input: &str) -> bool {
    let (mut quoted, mut escaped) = (false, false);
    for byte in input.bytes() {
        if quoted {
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == b'"' {
                quoted = false;
            }
        } else if byte == b'"' {
            quoted = true;
        } else if byte == b'&' {
            return true;
        }
    }
    false
}

pub(super) fn has_selector(address: &SansaAddress) -> bool {
    address
        .selectors
        .iter()
        .any(|s| matches!(s, SansaSelector::PropertyFilter { .. }))
}

pub(super) fn parse(input: &str) -> Result<SansaAddress, SansaParseError> {
    let address = shared::parse_address(input).map_err(|error| {
        let mut output = SansaParseError::new(error.message, error.index, error.code);
        output.limit_kind = error.limit_kind;
        output.limit = error.limit;
        output.observed = error.observed;
        output
    })?;
    Ok(SansaAddress {
        root: match address.root {
            shared::Root::Absolute => SansaRoot::Absolute,
            shared::Root::Contextual => SansaRoot::Contextual,
        },
        selectors: address
            .selectors
            .iter()
            .map(|s| match s {
                shared::Selector::PropertyFilter { property, value } => {
                    SansaSelector::PropertyFilter {
                        property: *property,
                        value: value.clone(),
                    }
                }
                shared::Selector::ChildIdentity { identity } => SansaSelector::ChildIdentity {
                    identity: identity.clone(),
                },
                shared::Selector::Member { name, quoted } => SansaSelector::Member {
                    name: name.clone(),
                    quoted: *quoted,
                },
                shared::Selector::Position { index } => SansaSelector::Position { index: *index },
                shared::Selector::PositionRange { start, end } => SansaSelector::PositionRange {
                    start: *start,
                    end: *end,
                },
                shared::Selector::Parent => SansaSelector::Parent,
                shared::Selector::AttributeSpace => SansaSelector::AttributeSpace,
                shared::Selector::LocalSpace { name } => {
                    SansaSelector::LocalSpace { name: name.clone() }
                }
                shared::Selector::DirectExpansion => SansaSelector::DirectExpansion,
                shared::Selector::DescendantExpansion => SansaSelector::DescendantExpansion,
                shared::Selector::NamePattern { pattern } => SansaSelector::NamePattern {
                    pattern: pattern.clone(),
                },
                shared::Selector::SemanticTypeFilter { name } => {
                    SansaSelector::SemanticTypeFilter { name: name.clone() }
                }
                shared::Selector::RepresentationKindFilter { name } => {
                    SansaSelector::RepresentationKindFilter { name: name.clone() }
                }
            })
            .collect(),
        qualifier_expression: address
            .qualifier_expression
            .as_ref()
            .map(|q| QualifierExpression {
                terms: q.terms.iter().map(term).collect(),
            }),
        is_exact: address.is_exact,
        canonical: address.canonical,
    })
}

fn term(root: &shared::QualifierTerm) -> QualifierTerm {
    // No recursive cloning of shared QualifierTerm (which implements Drop), and
    // no duplicate legacy parameter tree. parameter_groups owns these new ASTs.
    let mut nodes = vec![(root, Vec::<Vec<usize>>::new())];
    let mut next = 0;
    while next < nodes.len() {
        let source = nodes[next].0;
        let mut groups = Vec::new();
        for group in &source.parameter_groups {
            let mut children = Vec::new();
            for child in group {
                children.push(nodes.len());
                nodes.push((child, Vec::new()));
            }
            groups.push(children);
        }
        nodes[next].1 = groups;
        next += 1;
    }
    let mut built: Vec<Option<QualifierTerm>> = (0..nodes.len()).map(|_| None).collect();
    for (index, (source, groups)) in nodes.into_iter().enumerate().rev() {
        built[index] = Some(QualifierTerm {
            name: source.name.clone(),
            parameters: Vec::new(),
            parameter_groups: groups
                .into_iter()
                .map(|group| {
                    group
                        .into_iter()
                        .map(|id| built[id].take().expect("converted child"))
                        .collect()
                })
                .collect(),
            arguments: source
                .arguments
                .iter()
                .map(|a| match a {
                    shared::QualifierArgument::Number(value) => {
                        QualifierArgument::Number(value.clone())
                    }
                    shared::QualifierArgument::Quoted(value) => {
                        QualifierArgument::Quoted(value.clone())
                    }
                })
                .collect(),
        });
    }
    built[0].take().expect("converted root")
}

pub(super) fn bounded(address: &SansaAddress) -> bool {
    if address.selectors.len() > 256 {
        return false;
    }
    let mut bytes = 0usize;
    for selector in &address.selectors {
        let text = match selector {
            SansaSelector::PropertyFilter { value, .. } => {
                if value.chars().take(4097).count() > 4096 {
                    return false;
                }
                value
            }
            SansaSelector::SemanticTypeFilter { name }
            | SansaSelector::RepresentationKindFilter { name } => {
                if !is_identifier(name) {
                    return false;
                }
                name
            }
            SansaSelector::LocalSpace { name } => {
                if name.is_empty() {
                    return false;
                }
                name
            }
            SansaSelector::Member { name, .. } => name,
            SansaSelector::ChildIdentity { identity } => {
                if !valid_identity(identity) {
                    return false;
                }
                identity
            }
            SansaSelector::NamePattern { pattern } => pattern,
            _ => continue,
        };
        bytes = bytes.saturating_add(text.len());
        if bytes > 4 * 65536 {
            return false;
        }
    }
    let mut stack = Vec::new();
    if let Some(q) = &address.qualifier_expression {
        if q.terms.len() > 65536 {
            return false;
        }
        stack.extend(q.terms.iter());
    }
    let mut work = 0usize;
    while let Some(term) = stack.pop() {
        work = work
            .saturating_add(1)
            .saturating_add(term.arguments.len())
            .saturating_add(term.parameter_groups.len());
        if work > 65536 {
            return false;
        }
        if !is_identifier(&term.name) {
            return false;
        }
        bytes = bytes.saturating_add(term.name.len());
        for argument in &term.arguments {
            if matches!(argument, QualifierArgument::Number(s) | QualifierArgument::Token(s) if !is_number_literal(s))
            {
                return false;
            }
            bytes = bytes.saturating_add(match argument {
                QualifierArgument::Number(s)
                | QualifierArgument::Token(s)
                | QualifierArgument::Quoted(s) => s.len(),
            });
            if bytes > 4 * 65536 {
                return false;
            }
        }
        if bytes > 4 * 65536 {
            return false;
        }
        for group in &term.parameter_groups {
            if stack.len().saturating_add(group.len()) > 65536 {
                return false;
            }
            stack.extend(group.iter());
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn parser_fixture() -> Value {
        serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../../test-fixtures/sansa-properties/property-parser-candidate-v1.json"
        )))
        .expect("parser fixture")
    }

    #[test]
    fn portable_property_parser_mirrors_every_present_expected_field() {
        let mut count = 0;
        for case in parser_fixture()["tests"].as_array().expect("cases") {
            // Core's existing parse API has no per-call positional option. The
            // standalone Python/SDK Addressing API covers that one native case.
            if !case["input"]["options"].is_null() {
                continue;
            }
            count += 1;
            let input = &case["input"];
            let text = if let Some(source) = input["source"].as_str() {
                source.to_owned()
            } else {
                let generated = &input["generate"];
                let count = generated["count"].as_u64().expect("count") as usize;
                let scalar = generated["scalar"].as_str().unwrap_or("x");
                match generated["kind"].as_str().expect("kind") {
                    "selectors" => format!("${}", "&key(\"x\")".repeat(count)),
                    "payload" => {
                        let text = if generated["encoding"] == "escaped" {
                            format!("\\u{{{:x}}}", scalar.chars().next().expect("scalar") as u32)
                        } else {
                            scalar.to_owned()
                        };
                        format!("$&key(\"{}\")", text.repeat(count))
                    }
                    _ => format!("$.[\"@{}\"]&key(\"x\")", "x".repeat(count - 16)),
                }
            };
            let expected = &case["expected"];
            let result = parse_address(&text);
            assert_eq!(
                result.is_ok(),
                expected["ok"].as_bool().expect("ok"),
                "{}",
                case["id"]
            );
            match result {
                Ok(address) => {
                    assert_eq!(
                        address.is_exact,
                        expected["isExact"].as_bool().expect("exact")
                    );
                    if let Some(canonical) = expected["canonical"].as_str() {
                        assert_eq!(address.canonical, canonical);
                    }
                    assert_eq!(render_address(&address), address.canonical);
                    assert_eq!(
                        parse_address(&address.canonical)
                            .expect("canonical parse")
                            .canonical,
                        address.canonical
                    );
                }
                Err(error) => {
                    assert_eq!(error.code, expected["error"].as_str().expect("error"));
                    if let Some(kind) = expected["limitKind"].as_str() {
                        assert_eq!(error.limit_kind, Some(kind));
                    }
                    if let Some(limit) = expected["limit"].as_u64() {
                        assert_eq!(error.limit, Some(limit as usize));
                    }
                    if let Some(observed) = expected["observed"].as_u64() {
                        assert_eq!(error.observed, Some(observed as usize));
                    }
                }
            }
        }
        assert_eq!(count, 33);
    }

    #[test]
    fn legacy_namespace_denies_properties_even_after_an_empty_prefix() {
        let namespace = SansaResolveNamespace::new(SansaResolveBinding::default());
        for source in ["$&key(\"x\")", "$.missing&tag(\"x\")"] {
            let mut address = parse_address(source).expect("property address");
            address.canonical = "$.forged".into();
            address.is_exact = true;
            for result in [
                resolve_address(source, &namespace, &SansaResolveOptions::default()),
                resolve_parsed_address(&address, &namespace, &SansaResolveOptions::default()),
            ] {
                assert!(!result.ok);
                assert!(result.bindings.is_empty());
                assert_eq!(
                    result.errors[0].code,
                    "SANSA_RESOLVE_UNSUPPORTED_PROPERTY_SCOPE"
                );
            }
        }
        let mut malformed = parse_address("$&key(\"x\")").expect("address");
        malformed
            .selectors
            .insert(0, SansaSelector::SemanticTypeFilter { name: "T.*".into() });
        assert_eq!(
            resolve_parsed_address(&malformed, &namespace, &SansaResolveOptions::default()).errors
                [0]
            .code,
            "SANSA_RESOLVE_INVALID_ADDRESS"
        );
    }

    #[test]
    fn deep_property_qualifiers_convert_clone_render_and_drop_iteratively() {
        for depth in [32, 6000] {
            let source = format!("$&key(\"x\"):{}b{}", "a<".repeat(depth), ">".repeat(depth));
            let address = parse_address(&source).expect("deep property address");
            let cloned = address.clone();
            assert_eq!(render_address(&cloned), source);
            assert!(
                cloned
                    .qualifier_expression
                    .as_ref()
                    .expect("qualifier")
                    .terms[0]
                    .parameters
                    .is_empty()
            );
            drop(cloned);
            drop(address);
        }
    }

    #[test]
    fn literal_compilers_and_streaming_lexer_preserve_property_payloads() {
        use std::borrow::Cow;
        let fixture: Value = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../../test-fixtures/property-address-literals.json"
        )))
        .expect("literal fixture");
        for input in fixture["addresses"].as_array().expect("addresses") {
            let address = input.as_str().expect("address");
            let expected = parse_address(address).expect("address").canonical;
            for source in [
                format!("p:sansa={address}// outside\nx=1"),
                format!("p:sansa={address}/* outside */\nx=1"),
                format!("p=[{address},2]"),
                format!("p=<tag({address})>"),
            ] {
                let result = crate::compile(&source, crate::CompileOptions::default());
                assert!(result.errors.is_empty(), "{source}: {:?}", result.errors);
                #[cfg(feature = "sofia")]
                {
                    let sofia = crate::compile_sofia(&source, crate::CompileOptions::default());
                    assert!(sofia.errors.is_empty(), "{source}: {:?}", sofia.errors);
                }
                let mut pending: Vec<_> = result.events.iter().map(|event| &event.value).collect();
                let mut found = false;
                while let Some(value) = pending.pop() {
                    match value {
                        crate::Value::SansaAddressLiteral { canonical, .. } => {
                            if canonical == &expected {
                                found = true;
                            }
                        }
                        crate::Value::TypedValue { value, .. } => pending.push(value),
                        crate::Value::ListNode { items } | crate::Value::TupleLiteral { items } => {
                            pending.extend(items)
                        }
                        crate::Value::NodeLiteral { children, .. } => pending.extend(children),
                        crate::Value::ObjectNode { bindings } => {
                            pending.extend(bindings.iter().map(|binding| &binding.value))
                        }
                        _ => {}
                    }
                }
                assert!(found, "property literal missing: {source}");
                let baseline = crate::tokenize(&source, crate::LexerOptions::default());
                for split in source
                    .char_indices()
                    .map(|(i, _)| i)
                    .chain(std::iter::once(source.len()))
                {
                    let mut lexer = crate::lexer::LexerSession::new(crate::LexerOptions::default());
                    let mut actual = lexer.push(Cow::Borrowed(&source[..split]));
                    let next = lexer.push(Cow::Borrowed(&source[split..]));
                    actual.tokens.extend(next.tokens);
                    actual.errors.extend(next.errors);
                    let final_result = lexer.finish();
                    actual.tokens.extend(final_result.tokens);
                    actual.errors.extend(final_result.errors);
                    assert_eq!(actual.tokens, baseline.tokens, "split {split}: {source}");
                    assert_eq!(actual.errors, baseline.errors);
                }
            }
            for marker in ["~", "~>"] {
                let result = crate::compile(
                    &format!("copy={marker}{address}"),
                    crate::CompileOptions::default(),
                );
                assert!(!result.errors.is_empty());
                assert!(result.events.is_empty());
            }
        }
    }
}
