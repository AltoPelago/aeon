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
    use super::parse_address;

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
}
