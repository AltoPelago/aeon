#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SansaAddress {
    pub root: SansaRoot,
    pub selectors: Vec<SansaSelector>,
    pub qualifier_expression: Option<QualifierExpression>,
    pub is_exact: bool,
    pub canonical: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SansaRoot {
    Absolute,
    Contextual,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SansaSelector {
    Member { name: String, quoted: bool },
    Position { index: usize },
    AttributeSpace,
    LocalSpace { name: String },
    DirectExpansion,
    DescendantExpansion,
    NamePattern { pattern: String },
    SemanticTypeFilter { name: String },
    RepresentationKindFilter { name: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QualifierExpression {
    pub terms: Vec<QualifierTerm>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QualifierTerm {
    pub name: String,
    pub parameters: Vec<QualifierTerm>,
    pub parameter_groups: Vec<Vec<QualifierTerm>>,
    pub arguments: Vec<QualifierArgument>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum QualifierArgument {
    Token(String),
    Quoted(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SansaParseError {
    pub code: String,
    pub message: String,
    pub index: usize,
}

impl SansaParseError {
    fn new(message: impl Into<String>, index: usize, code: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            index,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct SansaResolveBinding {
    pub address: Option<String>,
    pub name: Option<String>,
    pub key: Option<String>,
    pub index: Option<usize>,
    pub semantic_type: Option<String>,
    pub datatype: Option<String>,
    pub representation_kind: Option<String>,
    pub kind: Option<String>,
    pub value_type: Option<String>,
    pub children: Vec<SansaResolveBinding>,
    pub attribute_space: Option<Box<SansaResolveBinding>>,
    pub attributes: Option<Box<SansaResolveBinding>>,
    pub local_spaces: Vec<(String, SansaResolveBinding)>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SansaResolveNamespace {
    pub root: SansaResolveBinding,
    pub contextual_root: Option<SansaResolveBinding>,
    pub supports_attribute_space: bool,
    pub supports_local_space: bool,
}

impl SansaResolveNamespace {
    #[must_use]
    pub fn new(root: SansaResolveBinding) -> Self {
        Self {
            root,
            contextual_root: None,
            supports_attribute_space: true,
            supports_local_space: false,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct SansaResolveOptions {
    pub contextual_root: Option<SansaResolveBinding>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SansaResolveDiagnostic {
    pub code: String,
    pub message: String,
    pub index: Option<usize>,
    pub selector_index: Option<usize>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct SansaResolveOutput {
    pub ok: bool,
    pub bindings: Vec<SansaResolveBinding>,
    pub errors: Vec<SansaResolveDiagnostic>,
    pub diagnostics: Vec<SansaResolveDiagnostic>,
}

#[must_use]
pub fn render_address(address: &SansaAddress) -> String {
    let mut output = match address.root {
        SansaRoot::Absolute => String::from("$"),
        SansaRoot::Contextual => String::from("?"),
    };

    for selector in &address.selectors {
        match selector {
            SansaSelector::Member { name, .. } if is_identifier(name) => {
                output.push('.');
                output.push_str(name);
            }
            SansaSelector::Member { name, .. } => {
                output.push_str(".[");
                output.push_str(&quote_payload(name));
                output.push(']');
            }
            SansaSelector::Position { index } => {
                output.push('[');
                output.push_str(&index.to_string());
                output.push(']');
            }
            SansaSelector::AttributeSpace => output.push_str(".@"),
            SansaSelector::LocalSpace { name } => {
                output.push_str(".<");
                output.push_str(&quote_payload(name));
                output.push('>');
            }
            SansaSelector::DirectExpansion => output.push_str(".*"),
            SansaSelector::DescendantExpansion => output.push_str(".**"),
            SansaSelector::NamePattern { pattern } => {
                output.push_str(".(");
                output.push_str(&quote_payload(pattern));
                output.push(')');
            }
            SansaSelector::SemanticTypeFilter { name } => {
                output.push('#');
                output.push_str(name);
            }
            SansaSelector::RepresentationKindFilter { name } => {
                output.push('%');
                output.push_str(name);
            }
        }
    }

    if let Some(expression) = &address.qualifier_expression {
        output.push(':');
        output.push_str(&render_qualifier_expression(expression));
    }

    output
}

#[must_use]
pub fn render_qualifier_expression(expression: &QualifierExpression) -> String {
    expression
        .terms
        .iter()
        .map(render_qualifier_term)
        .collect::<Vec<_>>()
        .join("|")
}

#[must_use]
pub fn render_qualifier_term(term: &QualifierTerm) -> String {
    let mut output = term.name.clone();
    for group in &term.parameter_groups {
        output.push('<');
        output.push_str(
            &group
                .iter()
                .map(render_qualifier_term)
                .collect::<Vec<_>>()
                .join(","),
        );
        output.push('>');
    }
    for argument in &term.arguments {
        output.push('[');
        output.push_str(&render_qualifier_argument(argument));
        output.push(']');
    }
    output
}

#[must_use]
pub fn render_qualifier_argument(argument: &QualifierArgument) -> String {
    match argument {
        QualifierArgument::Token(value) => value.clone(),
        QualifierArgument::Quoted(value) => quote_payload(value),
    }
}

pub fn parse_address(input: &str) -> Result<SansaAddress, SansaParseError> {
    AddressParser::new(input).parse()
}

#[must_use]
pub fn resolve_address(
    input: &str,
    namespace: &SansaResolveNamespace,
    options: &SansaResolveOptions,
) -> SansaResolveOutput {
    match parse_address(input) {
        Ok(address) => resolve_parsed_address(&address, namespace, options),
        Err(error) => SansaResolveOutput {
            ok: false,
            bindings: Vec::new(),
            errors: vec![SansaResolveDiagnostic {
                code: error.code,
                message: error.message,
                index: Some(error.index),
                selector_index: None,
            }],
            diagnostics: Vec::new(),
        },
    }
}

#[must_use]
pub fn resolve_parsed_address(
    address: &SansaAddress,
    namespace: &SansaResolveNamespace,
    options: &SansaResolveOptions,
) -> SansaResolveOutput {
    let Some(root) = resolve_root(&address.root, namespace, options) else {
        return SansaResolveOutput {
            ok: false,
            bindings: Vec::new(),
            errors: vec![resolve_error(
                "SANSA_RESOLVE_UNSUPPORTED_CONTEXTUAL_ROOT",
                "Contextual root requires a contextualRoot binding",
                None,
            )],
            diagnostics: Vec::new(),
        };
    };

    let mut current = vec![root];
    for (selector_index, selector) in address.selectors.iter().enumerate() {
        match apply_resolve_selector(selector, &current, namespace, selector_index) {
            Ok(selected) => {
                current = selected;
                if current.is_empty() {
                    break;
                }
            }
            Err(error) => {
                return SansaResolveOutput {
                    ok: false,
                    bindings: Vec::new(),
                    errors: vec![error],
                    diagnostics: Vec::new(),
                };
            }
        }
    }

    SansaResolveOutput {
        ok: true,
        bindings: current,
        errors: Vec::new(),
        diagnostics: Vec::new(),
    }
}

fn resolve_root(
    root: &SansaRoot,
    namespace: &SansaResolveNamespace,
    options: &SansaResolveOptions,
) -> Option<SansaResolveBinding> {
    match root {
        SansaRoot::Absolute => Some(namespace.root.clone()),
        SansaRoot::Contextual => options
            .contextual_root
            .clone()
            .or_else(|| namespace.contextual_root.clone()),
    }
}

fn apply_resolve_selector(
    selector: &SansaSelector,
    bindings: &[SansaResolveBinding],
    namespace: &SansaResolveNamespace,
    selector_index: usize,
) -> Result<Vec<SansaResolveBinding>, SansaResolveDiagnostic> {
    match selector {
        SansaSelector::Member { name, .. } => Ok(bindings
            .iter()
            .flat_map(|binding| select_member(binding, name))
            .collect()),
        SansaSelector::Position { index } => Ok(bindings
            .iter()
            .flat_map(|binding| select_position(binding, *index))
            .collect()),
        SansaSelector::DirectExpansion => Ok(bindings
            .iter()
            .flat_map(|binding| binding.children.clone())
            .collect()),
        SansaSelector::DescendantExpansion => {
            Ok(bindings.iter().flat_map(get_descendants).collect())
        }
        SansaSelector::NamePattern { pattern } => Ok(bindings
            .iter()
            .flat_map(|binding| {
                binding
                    .children
                    .iter()
                    .filter(|child| {
                        child
                            .name
                            .as_deref()
                            .or(child.key.as_deref())
                            .is_some_and(|name| glob_matches(pattern, name))
                    })
                    .cloned()
                    .collect::<Vec<_>>()
            })
            .collect()),
        SansaSelector::SemanticTypeFilter { name } => Ok(bindings
            .iter()
            .filter(|binding| matches_semantic_type(binding, name))
            .cloned()
            .collect()),
        SansaSelector::RepresentationKindFilter { name } => Ok(bindings
            .iter()
            .filter(|binding| matches_representation_kind(binding, name))
            .cloned()
            .collect()),
        SansaSelector::AttributeSpace => {
            select_attribute_spaces(bindings, namespace, selector_index)
        }
        SansaSelector::LocalSpace { name } => {
            select_local_spaces(bindings, namespace, name, selector_index)
        }
    }
}

fn select_member(binding: &SansaResolveBinding, name: &str) -> Vec<SansaResolveBinding> {
    binding
        .children
        .iter()
        .filter(|child| child.name.as_deref().or(child.key.as_deref()) == Some(name))
        .cloned()
        .collect()
}

fn select_position(binding: &SansaResolveBinding, index: usize) -> Vec<SansaResolveBinding> {
    if let Some(indexed) = binding
        .children
        .iter()
        .find(|child| child.index == Some(index))
        .cloned()
    {
        return vec![indexed];
    }
    binding.children.get(index).cloned().into_iter().collect()
}

fn get_descendants(binding: &SansaResolveBinding) -> Vec<SansaResolveBinding> {
    let mut output = Vec::new();
    for child in &binding.children {
        output.push(child.clone());
        output.extend(get_descendants(child));
    }
    output
}

fn select_attribute_spaces(
    bindings: &[SansaResolveBinding],
    namespace: &SansaResolveNamespace,
    selector_index: usize,
) -> Result<Vec<SansaResolveBinding>, SansaResolveDiagnostic> {
    if !namespace.supports_attribute_space && !bindings.is_empty() {
        return Err(resolve_error(
            "SANSA_RESOLVE_UNSUPPORTED_ATTRIBUTE_SPACE",
            "The namespace does not expose attribute address-space traversal",
            Some(selector_index),
        ));
    }
    Ok(bindings
        .iter()
        .filter_map(|binding| {
            binding
                .attribute_space
                .as_deref()
                .or(binding.attributes.as_deref())
                .cloned()
        })
        .collect())
}

fn select_local_spaces(
    bindings: &[SansaResolveBinding],
    namespace: &SansaResolveNamespace,
    name: &str,
    selector_index: usize,
) -> Result<Vec<SansaResolveBinding>, SansaResolveDiagnostic> {
    if !namespace.supports_local_space {
        return Err(resolve_error(
            "SANSA_RESOLVE_UNSUPPORTED_LOCAL_SPACE",
            format!("The namespace does not expose local address space '{name}'"),
            Some(selector_index),
        ));
    }
    Ok(bindings
        .iter()
        .filter_map(|binding| {
            binding
                .local_spaces
                .iter()
                .find(|(local_name, _)| local_name == name)
                .map(|(_, local_space)| local_space.clone())
        })
        .collect())
}

fn matches_semantic_type(binding: &SansaResolveBinding, expected: &str) -> bool {
    let actual = binding
        .semantic_type
        .as_deref()
        .or(binding.datatype.as_deref());
    actual.is_some_and(|actual| actual == expected || datatype_base_name(actual) == expected)
}

fn matches_representation_kind(binding: &SansaResolveBinding, expected: &str) -> bool {
    let actual = binding
        .representation_kind
        .as_deref()
        .or(binding.kind.as_deref())
        .or(binding.value_type.as_deref());
    actual.is_some_and(|actual| lower_first(actual) == expected)
}

fn resolve_error(
    code: impl Into<String>,
    message: impl Into<String>,
    selector_index: Option<usize>,
) -> SansaResolveDiagnostic {
    SansaResolveDiagnostic {
        code: code.into(),
        message: message.into(),
        index: None,
        selector_index,
    }
}

fn datatype_base_name(datatype: &str) -> &str {
    let cut = [datatype.find('<'), datatype.find('[')]
        .into_iter()
        .flatten()
        .min()
        .unwrap_or(datatype.len());
    datatype[..cut].trim()
}

fn lower_first(value: &str) -> String {
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return String::new();
    };
    first.to_lowercase().chain(chars).collect()
}

fn glob_matches(pattern: &str, name: &str) -> bool {
    let pattern_chars: Vec<char> = pattern.chars().collect();
    let name_chars: Vec<char> = name.chars().collect();
    let mut dp = vec![vec![false; name_chars.len() + 1]; pattern_chars.len() + 1];
    dp[0][0] = true;

    for p in 1..=pattern_chars.len() {
        if pattern_chars[p - 1] == '*' {
            dp[p][0] = dp[p - 1][0];
        }
    }

    for p in 1..=pattern_chars.len() {
        for n in 1..=name_chars.len() {
            dp[p][n] = match pattern_chars[p - 1] {
                '*' => dp[p - 1][n] || dp[p][n - 1],
                '?' => dp[p - 1][n - 1],
                char => dp[p - 1][n - 1] && char == name_chars[n - 1],
            };
        }
    }

    dp[pattern_chars.len()][name_chars.len()]
}

struct AddressParser<'a> {
    input: &'a str,
    index: usize,
}

impl<'a> AddressParser<'a> {
    fn new(input: &'a str) -> Self {
        Self { input, index: 0 }
    }

    fn parse(&mut self) -> Result<SansaAddress, SansaParseError> {
        if self.input.is_empty() {
            self.fail("Expected SANSA address root", "SANSA_EMPTY_ADDRESS")?;
        }
        let root_char = self.peek();
        if root_char != Some('$') && root_char != Some('?') {
            self.fail(
                "Expected SANSA address root '$' or '?'",
                "SANSA_EXPECTED_ROOT",
            )?;
        }
        self.advance();

        let root = if root_char == Some('$') {
            SansaRoot::Absolute
        } else {
            SansaRoot::Contextual
        };
        let mut selectors = Vec::new();
        let mut qualifier_expression = None;

        while !self.at_end() {
            match self.peek() {
                Some(':') => {
                    self.advance();
                    if self.at_end() {
                        self.fail("Expected qualifier expression", "SANSA_EXPECTED_QUALIFIER")?;
                    }
                    qualifier_expression = Some(self.parse_qualifier_expression(None)?);
                    break;
                }
                Some('.') => selectors.push(self.parse_dot_selector()?),
                Some('[') => selectors.push(self.parse_position_selector()?),
                Some('#') => {
                    self.advance();
                    selectors.push(SansaSelector::SemanticTypeFilter {
                        name: self.parse_identifier("semantic type filter")?,
                    });
                }
                Some('%') => {
                    self.advance();
                    selectors.push(SansaSelector::RepresentationKindFilter {
                        name: self.parse_identifier("representation kind filter")?,
                    });
                }
                Some(ch) if is_layout(ch) => {
                    self.fail(
                        "Whitespace is not allowed inside a SANSA address",
                        "SANSA_UNEXPECTED_WHITESPACE",
                    )?;
                }
                Some(ch) => {
                    self.fail(
                        format!("Unexpected character '{ch}'"),
                        "SANSA_UNEXPECTED_CHARACTER",
                    )?;
                }
                None => break,
            }
        }

        self.expect_end()?;
        let is_exact = selectors.iter().all(is_exact_selector);
        let mut address = SansaAddress {
            root,
            selectors,
            qualifier_expression,
            is_exact,
            canonical: String::new(),
        };
        address.canonical = render_address(&address);
        Ok(address)
    }

    fn parse_dot_selector(&mut self) -> Result<SansaSelector, SansaParseError> {
        self.consume('.')?;
        if self.match_char('@') {
            return Ok(SansaSelector::AttributeSpace);
        }
        if self.match_char('*') {
            if self.match_char('*') {
                return Ok(SansaSelector::DescendantExpansion);
            }
            return Ok(SansaSelector::DirectExpansion);
        }
        if self.match_char('[') {
            let name = self.parse_quoted_payload()?;
            if name.is_empty() {
                self.fail(
                    "Quoted member names must not be empty",
                    "SANSA_EMPTY_MEMBER_NAME",
                )?;
            }
            self.consume(']')?;
            return Ok(SansaSelector::Member { name, quoted: true });
        }
        if self.match_char('<') {
            let name = self.parse_quoted_payload()?;
            if name.is_empty() {
                self.fail(
                    "Local address-space names must not be empty",
                    "SANSA_EMPTY_LOCAL_SPACE_NAME",
                )?;
            }
            self.consume('>')?;
            return Ok(SansaSelector::LocalSpace { name });
        }
        if self.match_char('(') {
            let pattern = self.parse_quoted_payload()?;
            self.consume(')')?;
            return Ok(SansaSelector::NamePattern { pattern });
        }
        Ok(SansaSelector::Member {
            name: self.parse_identifier("member selector")?,
            quoted: false,
        })
    }

    fn parse_position_selector(&mut self) -> Result<SansaSelector, SansaParseError> {
        self.consume('[')?;
        let start = self.index;
        while self.peek().is_some_and(|ch| ch.is_ascii_digit()) {
            self.advance();
        }
        if self.index == start {
            self.fail("Expected positional index", "SANSA_EXPECTED_INDEX")?;
        }
        let raw = &self.input[start..self.index];
        if raw.len() > 1 && raw.starts_with('0') {
            return Err(SansaParseError::new(
                "Positional indexes must not contain leading zeroes",
                start,
                "SANSA_LEADING_ZERO_INDEX",
            ));
        }
        self.consume(']')?;
        Ok(SansaSelector::Position {
            index: raw.parse::<usize>().unwrap_or(0),
        })
    }

    fn parse_qualifier_expression(
        &mut self,
        stop_char: Option<char>,
    ) -> Result<QualifierExpression, SansaParseError> {
        let mut terms = vec![self.parse_qualifier_term(stop_char)?];
        while !self.at_end() && self.peek() == Some('|') {
            self.advance();
            terms.push(self.parse_qualifier_term(stop_char)?);
        }
        Ok(QualifierExpression { terms })
    }

    fn parse_qualifier_term(
        &mut self,
        stop_char: Option<char>,
    ) -> Result<QualifierTerm, SansaParseError> {
        let name = self.parse_identifier("qualifier type name")?;
        let mut parameters = Vec::new();
        let mut parameter_groups = Vec::new();
        let mut arguments = Vec::new();

        while self.match_char('<') {
            let mut group = Vec::new();
            group.push(self.parse_qualifier_term(Some('>'))?);
            if self.peek() == Some('|') {
                self.fail(
                    "Nested qualifier unions are not supported",
                    "SANSA_INVALID_QUALIFIER",
                )?;
            }
            while self.match_char(',') {
                group.push(self.parse_qualifier_term(Some('>'))?);
                if self.peek() == Some('|') {
                    self.fail(
                        "Nested qualifier unions are not supported",
                        "SANSA_INVALID_QUALIFIER",
                    )?;
                }
            }
            self.consume('>')?;
            parameters.extend(group.iter().cloned());
            parameter_groups.push(group);
        }

        while self.match_char('[') {
            arguments.push(self.parse_qualifier_argument()?);
            self.consume(']')?;
        }

        if let Some(next) = self.peek()
            && !matches!(next, '|' | ',' | '>')
            && Some(next) != stop_char
        {
            self.fail(
                format!("Unexpected character '{next}' in qualifier expression"),
                "SANSA_INVALID_QUALIFIER",
            )?;
        }

        Ok(QualifierTerm {
            name,
            parameters,
            parameter_groups,
            arguments,
        })
    }

    fn parse_qualifier_argument(&mut self) -> Result<QualifierArgument, SansaParseError> {
        if self.peek() == Some('"') {
            return Ok(QualifierArgument::Quoted(self.parse_quoted_payload()?));
        }

        let start = self.index;
        while !self.at_end() && self.peek() != Some(']') {
            let char = self.peek().unwrap_or_default();
            if !is_qualifier_argument_char(char) {
                self.fail(
                    format!("Invalid unquoted qualifier argument character '{char}'"),
                    "SANSA_INVALID_QUALIFIER_ARGUMENT_CHAR",
                )?;
            }
            self.advance();
        }
        if self.index == start {
            self.fail(
                "Expected qualifier argument",
                "SANSA_EXPECTED_QUALIFIER_ARGUMENT",
            )?;
        }
        Ok(QualifierArgument::Token(
            self.input[start..self.index].to_owned(),
        ))
    }

    fn parse_identifier(&mut self, context: &str) -> Result<String, SansaParseError> {
        let start = self.index;
        let Some(first) = self.peek() else {
            self.fail(format!("Expected {context}"), "SANSA_EXPECTED_IDENTIFIER")?;
            unreachable!();
        };
        if !is_identifier_start(first) {
            self.fail(format!("Expected {context}"), "SANSA_EXPECTED_IDENTIFIER")?;
        }
        self.advance();
        while self.peek().is_some_and(is_identifier_continue) {
            self.advance();
        }
        Ok(self.input[start..self.index].to_owned())
    }

    fn parse_quoted_payload(&mut self) -> Result<String, SansaParseError> {
        self.consume('"')?;
        let mut output = String::new();
        while !self.at_end() {
            let char = self.peek().unwrap_or_default();
            if char == '"' {
                self.advance();
                return Ok(output);
            }
            if matches!(char, '\n' | '\r') {
                self.fail(
                    "Quoted payloads must not contain raw newlines",
                    "SANSA_RAW_NEWLINE_IN_QUOTED_PAYLOAD",
                )?;
            }
            if char == '\\' {
                output.push(self.parse_escape()?);
                continue;
            }
            output.push(char);
            self.advance();
        }
        self.fail(
            "Unterminated quoted payload",
            "SANSA_UNTERMINATED_QUOTED_PAYLOAD",
        )
    }

    fn parse_escape(&mut self) -> Result<char, SansaParseError> {
        self.consume('\\')?;
        let Some(escape) = self.peek() else {
            self.fail("Unterminated escape sequence", "SANSA_UNTERMINATED_ESCAPE")?;
            unreachable!();
        };
        let escape_start = self.index;
        self.advance();
        match escape {
            '\\' => Ok('\\'),
            '"' => Ok('"'),
            '\'' => Ok('\''),
            '`' => Ok('`'),
            'n' => Ok('\n'),
            'r' => Ok('\r'),
            't' => Ok('\t'),
            'b' => Ok('\u{0008}'),
            'f' => Ok('\u{000c}'),
            'u' => self.parse_unicode_escape(escape_start),
            _ => Err(SansaParseError::new(
                format!("Invalid escape sequence \\{escape}"),
                escape_start.saturating_sub(1),
                "SANSA_INVALID_ESCAPE",
            )),
        }
    }

    fn parse_unicode_escape(&mut self, escape_start: usize) -> Result<char, SansaParseError> {
        if self.match_char('{') {
            let start = self.index;
            while !self.at_end() && self.peek() != Some('}') {
                self.advance();
            }
            if self.at_end() {
                self.fail(
                    "Unterminated Unicode escape",
                    "SANSA_UNTERMINATED_UNICODE_ESCAPE",
                )?;
            }
            let raw = &self.input[start..self.index];
            self.consume('}')?;
            if raw.is_empty() || raw.len() > 6 || !raw.chars().all(|ch| ch.is_ascii_hexdigit()) {
                return Err(SansaParseError::new(
                    "Invalid Unicode escape",
                    start,
                    "SANSA_INVALID_UNICODE_ESCAPE",
                ));
            }
            return code_point_to_char(u32::from_str_radix(raw, 16).unwrap_or(0x11_0000), start);
        }

        let start = self.index;
        let mut raw = String::new();
        for _ in 0..4 {
            let Some(ch) = self.peek() else {
                return Err(SansaParseError::new(
                    "Invalid Unicode escape",
                    start,
                    "SANSA_INVALID_UNICODE_ESCAPE",
                ));
            };
            raw.push(ch);
            self.advance();
        }
        if !raw.chars().all(|ch| ch.is_ascii_hexdigit()) {
            return Err(SansaParseError::new(
                "Invalid Unicode escape",
                start,
                "SANSA_INVALID_UNICODE_ESCAPE",
            ));
        }
        code_point_to_char(
            u32::from_str_radix(&raw, 16).unwrap_or(0x11_0000),
            escape_start,
        )
    }

    fn expect_end(&self) -> Result<(), SansaParseError> {
        if let Some(ch) = self.peek() {
            return Err(SansaParseError::new(
                format!("Unexpected trailing character '{ch}'"),
                self.index,
                "SANSA_TRAILING_INPUT",
            ));
        }
        Ok(())
    }

    fn consume(&mut self, char: char) -> Result<(), SansaParseError> {
        if self.peek() != Some(char) {
            self.fail(format!("Expected '{char}'"), "SANSA_EXPECTED_TOKEN")?;
        }
        self.advance();
        Ok(())
    }

    fn match_char(&mut self, char: char) -> bool {
        if self.peek() != Some(char) {
            return false;
        }
        self.advance();
        true
    }

    fn peek(&self) -> Option<char> {
        self.input[self.index..].chars().next()
    }

    fn advance(&mut self) -> Option<char> {
        let ch = self.peek()?;
        self.index += ch.len_utf8();
        Some(ch)
    }

    fn at_end(&self) -> bool {
        self.index >= self.input.len()
    }

    fn fail<T>(
        &self,
        message: impl Into<String>,
        code: impl Into<String>,
    ) -> Result<T, SansaParseError> {
        Err(SansaParseError::new(message, self.index, code))
    }
}

fn is_exact_selector(selector: &SansaSelector) -> bool {
    matches!(
        selector,
        SansaSelector::Member { .. }
            | SansaSelector::Position { .. }
            | SansaSelector::AttributeSpace
            | SansaSelector::LocalSpace { .. }
    )
}

fn is_identifier(value: &str) -> bool {
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    is_identifier_start(first) && chars.all(is_identifier_continue)
}

fn is_identifier_start(char: char) -> bool {
    char.is_ascii_alphabetic() || char == '_'
}

fn is_identifier_continue(char: char) -> bool {
    char.is_ascii_alphanumeric() || char == '_'
}

fn is_layout(char: char) -> bool {
    matches!(char, ' ' | '\t' | '\n' | '\r')
}

fn is_qualifier_argument_char(char: char) -> bool {
    char.is_ascii_alphanumeric()
        || matches!(
            char,
            '!' | '#'
                | '$'
                | '%'
                | '&'
                | '*'
                | '+'
                | '-'
                | '.'
                | ':'
                | ';'
                | '='
                | '?'
                | '@'
                | '^'
                | '_'
                | '|'
                | '~'
                | '<'
                | '>'
        )
}

fn code_point_to_char(code_point: u32, index: usize) -> Result<char, SansaParseError> {
    char::from_u32(code_point).ok_or_else(|| {
        SansaParseError::new(
            "Unicode escape must decode to a scalar value",
            index,
            "SANSA_INVALID_UNICODE_SCALAR",
        )
    })
}

fn quote_payload(value: &str) -> String {
    let mut output = String::from("\"");
    for char in value.chars() {
        match char {
            '\\' => output.push_str("\\\\"),
            '"' => output.push_str("\\\""),
            '\n' => output.push_str("\\n"),
            '\r' => output.push_str("\\r"),
            '\t' => output.push_str("\\t"),
            '\u{0008}' => output.push_str("\\b"),
            '\u{000c}' => output.push_str("\\f"),
            _ => output.push(char),
        }
    }
    output.push('"');
    output
}

#[cfg(test)]
mod tests {
    use super::{
        SansaResolveBinding, SansaResolveNamespace, SansaResolveOptions, parse_address,
        resolve_address,
    };

    #[test]
    fn parses_absolute_and_contextual_addresses() {
        assert_eq!(
            parse_address("$.inventory.items[2].sku")
                .expect("parse")
                .canonical,
            "$.inventory.items[2].sku"
        );
        assert_eq!(parse_address("?.name").expect("parse").canonical, "?.name");
    }

    #[test]
    fn parses_quoted_comma_qualifier_argument() {
        assert_eq!(
            parse_address("$.inventory:csv[\",\"]")
                .expect("parse")
                .canonical,
            "$.inventory:csv[\",\"]"
        );
    }

    #[test]
    fn rejects_raw_comma_qualifier_argument() {
        assert!(parse_address("$.inventory:csv[,]").is_err());
    }

    #[test]
    fn supports_chained_parameter_groups() {
        assert_eq!(
            parse_address("$.path:tuple<x><y>")
                .expect("parse")
                .canonical,
            "$.path:tuple<x><y>"
        );
    }

    #[test]
    fn resolves_exact_paths_and_no_match_cases() {
        let namespace = fixture_namespace();
        assert_eq!(
            resolved_addresses(&resolve_address(
                "$.inventory.items[1].sku",
                &namespace,
                &SansaResolveOptions::default()
            )),
            vec!["$.inventory.items[1].sku"]
        );
        assert_eq!(
            resolved_addresses(&resolve_address(
                "$.inventory.items[2].sku",
                &namespace,
                &SansaResolveOptions::default()
            )),
            Vec::<String>::new()
        );
    }

    #[test]
    fn resolves_expansions_name_patterns_and_filters() {
        let namespace = fixture_namespace();
        assert_eq!(
            resolved_addresses(&resolve_address(
                "$.inventory.items.*",
                &namespace,
                &SansaResolveOptions::default()
            )),
            vec!["$.inventory.items[0]", "$.inventory.items[1]"]
        );
        assert_eq!(
            resolved_addresses(&resolve_address(
                "$.inventory.**.sku",
                &namespace,
                &SansaResolveOptions::default()
            )),
            vec!["$.inventory.items[0].sku", "$.inventory.items[1].sku"]
        );
        assert_eq!(
            resolved_addresses(&resolve_address(
                "$.inventory.(\"item??\")",
                &namespace,
                &SansaResolveOptions::default()
            )),
            vec!["$.inventory.itemA1", "$.inventory.itemB2"]
        );
        assert_eq!(
            resolved_addresses(&resolve_address(
                "$.reading#measurement",
                &namespace,
                &SansaResolveOptions::default()
            )),
            vec!["$.reading"]
        );
        assert_eq!(
            resolved_addresses(&resolve_address(
                "$.inventory.items.*.sku%string",
                &namespace,
                &SansaResolveOptions::default()
            )),
            vec!["$.inventory.items[0].sku", "$.inventory.items[1].sku"]
        );
        assert_eq!(
            resolved_addresses(&resolve_address(
                "$.inventory.items.*.qty#string",
                &namespace,
                &SansaResolveOptions::default()
            )),
            Vec::<String>::new()
        );
    }

    #[test]
    fn resolves_attribute_space_and_contextual_roots() {
        let namespace = fixture_namespace();
        assert_eq!(
            resolved_addresses(&resolve_address(
                "$.contact.status.@.role",
                &namespace,
                &SansaResolveOptions::default()
            )),
            vec!["$.contact.status.@.role"]
        );

        let item0 = namespace.root.children[0].children[0].children[0].clone();
        assert_eq!(
            resolved_addresses(&resolve_address(
                "?.sku",
                &namespace,
                &SansaResolveOptions {
                    contextual_root: Some(item0)
                }
            )),
            vec!["$.inventory.items[0].sku"]
        );
    }

    #[test]
    fn reports_contextual_local_and_parse_errors() {
        let namespace = fixture_namespace();
        let missing_context = resolve_address("?.sku", &namespace, &SansaResolveOptions::default());
        assert!(!missing_context.ok);
        assert_eq!(
            missing_context.errors[0].code,
            "SANSA_RESOLVE_UNSUPPORTED_CONTEXTUAL_ROOT"
        );

        let local = resolve_address(
            "$.inventory.<\"catalog\">",
            &namespace,
            &SansaResolveOptions::default(),
        );
        assert!(!local.ok);
        assert_eq!(
            local.errors[0].code,
            "SANSA_RESOLVE_UNSUPPORTED_LOCAL_SPACE"
        );
        assert_eq!(local.errors[0].selector_index, Some(1));

        let parse = resolve_address(
            "$.inventory.items[01]",
            &namespace,
            &SansaResolveOptions::default(),
        );
        assert!(!parse.ok);
        assert_eq!(parse.errors[0].code, "SANSA_LEADING_ZERO_INDEX");
    }

    fn resolved_addresses(output: &super::SansaResolveOutput) -> Vec<String> {
        assert!(output.ok, "{:?}", output.errors);
        output
            .bindings
            .iter()
            .filter_map(|binding| binding.address.clone())
            .collect()
    }

    fn fixture_namespace() -> SansaResolveNamespace {
        SansaResolveNamespace::new(binding(
            "$",
            None,
            None,
            None,
            Some("object"),
            vec![
                binding(
                    "$.inventory",
                    Some("inventory"),
                    None,
                    None,
                    Some("object"),
                    vec![
                        binding(
                            "$.inventory.items",
                            Some("items"),
                            None,
                            None,
                            Some("list"),
                            vec![
                                binding(
                                    "$.inventory.items[0]",
                                    None,
                                    Some(0),
                                    None,
                                    Some("object"),
                                    vec![
                                        binding(
                                            "$.inventory.items[0].sku",
                                            Some("sku"),
                                            None,
                                            Some("string"),
                                            Some("string"),
                                            vec![],
                                        ),
                                        binding(
                                            "$.inventory.items[0].qty",
                                            Some("qty"),
                                            None,
                                            Some("number"),
                                            Some("number"),
                                            vec![],
                                        ),
                                    ],
                                ),
                                binding(
                                    "$.inventory.items[1]",
                                    None,
                                    Some(1),
                                    None,
                                    Some("object"),
                                    vec![
                                        binding(
                                            "$.inventory.items[1].sku",
                                            Some("sku"),
                                            None,
                                            Some("string"),
                                            Some("string"),
                                            vec![],
                                        ),
                                        binding(
                                            "$.inventory.items[1].qty",
                                            Some("qty"),
                                            None,
                                            Some("number"),
                                            Some("number"),
                                            vec![],
                                        ),
                                        binding(
                                            "$.inventory.items[1].status",
                                            Some("status"),
                                            None,
                                            Some("boolean"),
                                            Some("boolean"),
                                            vec![],
                                        ),
                                    ],
                                ),
                            ],
                        ),
                        binding(
                            "$.inventory.itemA1",
                            Some("itemA1"),
                            None,
                            Some("string"),
                            Some("string"),
                            vec![],
                        ),
                        binding(
                            "$.inventory.itemB2",
                            Some("itemB2"),
                            None,
                            Some("string"),
                            Some("string"),
                            vec![],
                        ),
                        binding(
                            "$.inventory.archive",
                            Some("archive"),
                            None,
                            None,
                            Some("object"),
                            vec![],
                        ),
                    ],
                ),
                with_attribute_space(
                    binding(
                        "$.contact",
                        Some("contact"),
                        None,
                        None,
                        Some("object"),
                        vec![with_attribute_space(
                            binding(
                                "$.contact.status",
                                Some("status"),
                                None,
                                Some("boolean"),
                                Some("boolean"),
                                vec![],
                            ),
                            binding(
                                "$.contact.status.@",
                                None,
                                None,
                                None,
                                Some("object"),
                                vec![binding(
                                    "$.contact.status.@.role",
                                    Some("role"),
                                    None,
                                    Some("string"),
                                    Some("string"),
                                    vec![],
                                )],
                            ),
                        )],
                    ),
                    binding("$.contact.@", None, None, None, Some("object"), vec![]),
                ),
                with_attribute_space(
                    binding(
                        "$.reading",
                        Some("reading"),
                        None,
                        Some("measurement<number>"),
                        Some("number"),
                        vec![],
                    ),
                    binding(
                        "$.reading.@",
                        None,
                        None,
                        None,
                        Some("object"),
                        vec![binding(
                            "$.reading.@.unit",
                            Some("unit"),
                            None,
                            Some("string"),
                            Some("string"),
                            vec![],
                        )],
                    ),
                ),
            ],
        ))
    }

    fn binding(
        address: &str,
        name: Option<&str>,
        index: Option<usize>,
        semantic_type: Option<&str>,
        representation_kind: Option<&str>,
        children: Vec<SansaResolveBinding>,
    ) -> SansaResolveBinding {
        SansaResolveBinding {
            address: Some(address.to_owned()),
            name: name.map(str::to_owned),
            index,
            semantic_type: semantic_type.map(str::to_owned),
            representation_kind: representation_kind.map(str::to_owned),
            children,
            ..SansaResolveBinding::default()
        }
    }

    fn with_attribute_space(
        mut binding: SansaResolveBinding,
        attribute_space: SansaResolveBinding,
    ) -> SansaResolveBinding {
        binding.attribute_space = Some(Box::new(attribute_space));
        binding
    }
}
