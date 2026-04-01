use std::collections::BTreeMap;

use crate::header::apply_trimticks;
use crate::temporal::classify_temporal_literal;
use crate::{
    tokenize, AttributeValue, Binding, Diagnostic, LexerOptions, ReferenceSegment, Span, Token,
    TokenKind, Value,
};

pub(crate) fn parse_document_from_tokens(input: &str) -> Result<Vec<Binding>, Diagnostic> {
    let lexed = tokenize(
        input,
        LexerOptions {
            include_newlines: true,
            ..LexerOptions::default()
        },
    );
    if let Some(error) = lexed.errors.first() {
        return Err(Diagnostic {
            code: error.code.clone(),
            path: Some(String::from("$")),
            span: Some(error.span),
            phase: None,
            message: error.message.clone(),
        });
    }
    TokenParser::new(&lexed.tokens).parse_document()
}

struct TokenParser<'a> {
    tokens: &'a [Token],
    current: usize,
}

impl<'a> TokenParser<'a> {
    fn new(tokens: &'a [Token]) -> Self {
        Self { tokens, current: 0 }
    }

    fn parse_document(&mut self) -> Result<Vec<Binding>, Diagnostic> {
        let mut bindings = Vec::new();
        self.skip_newlines();
        while !self.is_at_end() {
            bindings.push(self.parse_binding()?);
            self.consume_separator()?;
            self.skip_newlines();
        }
        Ok(bindings)
    }

    fn parse_binding(&mut self) -> Result<Binding, Diagnostic> {
        let start = self.peek().span.start;
        let key = self.parse_key()?;
        self.skip_newlines();
        let mut attributes = BTreeMap::new();
        while self.check(TokenKind::At) {
            attributes.extend(self.parse_attribute_block()?);
            self.skip_newlines();
        }
        let mut datatype = None;
        if self.match_kind(TokenKind::Colon) {
            self.skip_newlines();
            datatype = Some(self.parse_simple_datatype()?);
        }
        self.skip_newlines();
        let equals_message = format!("Expected '=' after key '{key}'");
        self.consume(TokenKind::Equals, &equals_message)?;
        self.skip_newlines();
        let value = self.parse_value()?;
        let end = self.previous().span.end;
        Ok(Binding {
            key,
            datatype,
            attributes,
            value,
            span: Span { start, end },
        })
    }

    fn parse_key(&mut self) -> Result<String, Diagnostic> {
        let token = self.peek();
        match token.kind {
            TokenKind::Identifier => {
                if token.text == "aeon" && self.peek_next().kind == TokenKind::Colon {
                    self.advance();
                    self.advance();
                    let field = self.consume(TokenKind::Identifier, "Expected header field after `aeon:`")?;
                    Ok(format!("aeon:{}", field.text))
                } else {
                    Ok(self.advance().text.clone())
                }
            }
            TokenKind::String => {
                if token.quote == Some('`') {
                    return Err(self.error_at_current("Backtick strings are not valid keys"));
                }
                Ok(unescape_quoted(&self.advance().text))
            }
            _ => Err(self.error_at_current("Expected key")),
        }
    }

    fn parse_simple_datatype(&mut self) -> Result<String, Diagnostic> {
        self.parse_datatype_annotation(0)
    }

    fn parse_datatype_annotation(&mut self, generic_depth: usize) -> Result<String, Diagnostic> {
        if generic_depth > 1 {
            return Err(Diagnostic {
                code: String::from("GENERIC_DEPTH_EXCEEDED"),
                path: Some(String::from("$")),
                span: Some(self.peek().span),
                phase: None,
                message: String::from("Generic depth 2 exceeds max_generic_depth 1"),
            });
        }

        let start = self.current;
        if self.peek().kind == TokenKind::String {
            return Err(Diagnostic {
                code: String::from("SYNTAX_ERROR"),
                path: Some(String::from("$")),
                span: Some(self.peek().span),
                phase: None,
                message: String::from("Quoted type names are not supported"),
            });
        }
        let datatype_name = self.consume(TokenKind::Identifier, "Expected datatype annotation")?.text.clone();
        self.skip_newlines();

        if self.match_kind(TokenKind::LeftAngle) {
            if datatype_name == "radix" {
                return Err(Diagnostic {
                    code: String::from("SYNTAX_ERROR"),
                    path: Some(String::from("$")),
                    span: Some(self.previous().span),
                    phase: None,
                    message: String::from("Radix datatype bases must use bracket syntax like `radix[10]`"),
                });
            }
            self.skip_newlines();
            loop {
                match self.peek().kind {
                    TokenKind::Identifier => {
                        self.parse_datatype_annotation(generic_depth + 1)?;
                    }
                    TokenKind::Number => {
                        self.advance();
                    }
                    _ => {
                        return Err(self.error_at_current("Expected generic argument"));
                    }
                }

                self.skip_newlines();
                if self.match_kind(TokenKind::RightAngle) {
                    self.skip_newlines();
                    break;
                }
                self.consume(TokenKind::Comma, "Expected ',' between generic arguments")?;
                self.skip_newlines();
            }
        }

        let mut saw_radix_base = false;
        while self.match_kind(TokenKind::LeftBracket) {
            self.skip_newlines();
            if datatype_name == "radix" && !saw_radix_base {
                let token = self.peek().clone();
                if token.kind == TokenKind::RightBracket {
                    return Err(Diagnostic {
                        code: String::from("SYNTAX_ERROR"),
                        path: Some(String::from("$")),
                        span: Some(token.span),
                        phase: None,
                        message: String::from("Radix base must be an integer from 2 to 64"),
                    });
                }

                let token = self.advance();
                self.skip_newlines();
                if self.peek().kind != TokenKind::RightBracket
                    || token.kind != TokenKind::Number
                    || !is_valid_radix_base_token(&token.text)
                {
                    return Err(Diagnostic {
                        code: String::from("SYNTAX_ERROR"),
                        path: Some(String::from("$")),
                        span: Some(token.span),
                        phase: None,
                        message: String::from("Radix base must be an integer from 2 to 64"),
                    });
                }

                saw_radix_base = true;
                self.consume(TokenKind::RightBracket, "Expected ']' to close radix base spec")?;
                self.skip_newlines();
                continue;
            }
            match self.peek().kind {
                TokenKind::Identifier
                | TokenKind::Number
                | TokenKind::String
                | TokenKind::Symbol
                | TokenKind::Semicolon
                | TokenKind::Dot
                | TokenKind::Comma => {
                    let token = self.advance();
                    if token.kind != TokenKind::Number
                        && (token.text.len() != 1 || token.text == "," || token.text == "[" || token.text == "]")
                    {
                        return Err(Diagnostic {
                            code: String::from("INVALID_SEPARATOR_CHAR"),
                            path: Some(String::from("$")),
                            span: Some(token.span),
                            phase: None,
                            message: format!("Invalid separator character `{}`", token.text),
                        });
                    }
                }
                _ => {
                    return Err(self.error_at_current("Expected separator character"));
                }
            }
            self.skip_newlines();
            self.consume(TokenKind::RightBracket, "Expected ']' to close separator spec")?;
            self.skip_newlines();
        }

        Ok(self.tokens[start..self.current]
            .iter()
            .map(|token| token.text.as_str())
            .collect::<String>()
            .chars()
            .filter(|ch| !matches!(ch, ' ' | '\t' | '\n' | '\r'))
            .collect())
    }

    fn parse_value(&mut self) -> Result<Value, Diagnostic> {
        let token = self.peek();
        match token.kind {
            TokenKind::String => {
                let text = self.advance().text.clone();
                Ok(Value::StringLiteral {
                    value: unescape_quoted(&text),
                    is_trimtick: false,
                })
            }
            TokenKind::Number => {
                let raw = self.advance().text.clone();
                Ok(classify_temporal_literal(&raw).unwrap_or(Value::NumberLiteral { raw }))
            }
            TokenKind::Identifier if token.text == "Infinity" => Ok(Value::InfinityLiteral {
                raw: self.advance().text.clone(),
            }),
            TokenKind::Symbol
                if token.text == "-"
                    && self.peek_next().kind == TokenKind::Identifier
                    && self.peek_next().text == "Infinity" =>
            {
                self.advance();
                self.advance();
                Ok(Value::InfinityLiteral {
                    raw: String::from("-Infinity"),
                })
            }
            TokenKind::True | TokenKind::False => Ok(Value::BooleanLiteral {
                raw: self.advance().text.clone(),
            }),
            TokenKind::Yes | TokenKind::No | TokenKind::On | TokenKind::Off => Ok(Value::SwitchLiteral {
                raw: self.advance().text.clone(),
            }),
            TokenKind::HexLiteral => Ok(Value::HexLiteral {
                raw: self.advance().text.clone(),
            }),
            TokenKind::RadixLiteral => Ok(Value::RadixLiteral {
                raw: self.advance().text.clone(),
            }),
            TokenKind::EncodingLiteral => Ok(Value::EncodingLiteral {
                raw: self.advance().text.clone(),
            }),
            TokenKind::SeparatorLiteral => Ok(Value::SeparatorLiteral {
                raw: self.advance().text.clone(),
            }),
            TokenKind::LeftBracket => self.parse_list(),
            TokenKind::LeftParen => self.parse_tuple(),
            TokenKind::LeftBrace => self.parse_object(),
            TokenKind::LeftAngle => self.parse_node_literal(),
            TokenKind::RightAngle => self.parse_trimtick(),
            TokenKind::Tilde | TokenKind::TildeArrow => self.parse_reference(),
            _ => Err(self.error_at_current(&format!("Unexpected token '{}'", token.text))),
        }
    }

    fn parse_trimtick(&mut self) -> Result<Value, Diagnostic> {
        let mut marker_width = 0usize;
        let mut previous_end = None;
        while self.check(TokenKind::RightAngle) {
            let token = self.peek();
            if let Some(end) = previous_end {
                if end != token.span.start.offset {
                    return Err(self.error_at_current("Trimtick marker must be contiguous"));
                }
            }
            marker_width += 1;
            if marker_width > 4 {
                return Err(self.error_at_current("Trimtick marker may contain at most four \">\" characters"));
            }
            previous_end = Some(token.span.end.offset);
            self.advance();
        }
        if !self.check(TokenKind::String) || self.peek().quote != Some('`') {
            return Err(self.error_at_current("Trimtick marker must be followed by a backtick string"));
        }
        let text = self.advance().text.clone();
        let raw = unescape_quoted(&text);
        let value = apply_trimticks(&raw, marker_width);
        Ok(Value::StringLiteral {
            value,
            is_trimtick: true,
        })
    }

    fn parse_list(&mut self) -> Result<Value, Diagnostic> {
        self.consume(TokenKind::LeftBracket, "Expected `[`")?;
        let items = self.parse_delimited_values(TokenKind::RightBracket, "Expected list delimiter")?;
        self.consume(TokenKind::RightBracket, "Expected `]` after list")?;
        Ok(Value::ListNode { items })
    }

    fn parse_tuple(&mut self) -> Result<Value, Diagnostic> {
        self.consume(TokenKind::LeftParen, "Expected `(`")?;
        let mut items = Vec::new();
        self.skip_newlines();
        while !self.check(TokenKind::RightParen) {
            items.push(self.parse_value()?);
            if self.match_kind(TokenKind::Comma) {
                self.skip_newlines();
                if self.check(TokenKind::RightParen) {
                    break;
                }
                if self.check(TokenKind::Comma) {
                    return Err(self.error_at_current("Expected tuple delimiter"));
                }
                continue;
            }
            if self.check(TokenKind::RightParen) {
                break;
            }
            if self.peek().kind == TokenKind::Newline {
                self.skip_newlines();
                continue;
            }
            return Err(self.error_at_current("Expected tuple delimiter"));
        }
        self.consume(TokenKind::RightParen, "Expected `)` after tuple")?;
        Ok(Value::TupleLiteral { items })
    }

    fn parse_object(&mut self) -> Result<Value, Diagnostic> {
        self.consume(TokenKind::LeftBrace, "Expected `{`")?;
        let bindings = self.parse_delimited_bindings(TokenKind::RightBrace, "Expected object member delimiter")?;
        self.consume(TokenKind::RightBrace, "Expected `}` after object")?;
        Ok(Value::ObjectNode { bindings })
    }

    fn parse_reference(&mut self) -> Result<Value, Diagnostic> {
        let start = self.peek().span.start;
        let is_pointer = if self.match_kind(TokenKind::TildeArrow) {
            true
        } else {
            self.consume(TokenKind::Tilde, "Expected `~`")?;
            false
        };

        let mut segments = Vec::new();
        if self.match_kind(TokenKind::Dollar) {
            self.consume(TokenKind::Dot, "Expected `.` after `$`")?;
            segments.push(ReferenceSegment::Key(self.parse_reference_key()?));
        } else if self.match_kind(TokenKind::LeftBracket) {
            let key_token = self.consume(TokenKind::String, "Expected quoted reference key")?;
            let key = unescape_quoted(&key_token.text);
            if key.is_empty() {
                return Err(self.error_at_current("Empty quoted path segments are not valid"));
            }
            self.consume(TokenKind::RightBracket, "Expected `]` after quoted reference key")?;
            segments.push(ReferenceSegment::Key(key));
        } else {
            segments.push(ReferenceSegment::Key(self.parse_reference_key()?));
        }

        loop {
            if self.match_kind(TokenKind::At) {
                if self.match_kind(TokenKind::LeftBracket) {
                    let key_token = self.consume(TokenKind::String, "Expected quoted attribute key")?;
                    let key = unescape_quoted(&key_token.text);
                    if key.is_empty() {
                        return Err(self.error_at_current("Empty quoted path segments are not valid"));
                    }
                    self.consume(TokenKind::RightBracket, "Expected `]` after quoted attribute key")?;
                    segments.push(ReferenceSegment::Attr(key));
                } else {
                    segments.push(ReferenceSegment::Attr(self.parse_reference_key()?));
                }
                continue;
            }
            if self.match_kind(TokenKind::Dot) {
                if self.match_kind(TokenKind::LeftBracket) {
                    let key_token = self.consume(TokenKind::String, "Expected quoted member key")?;
                    let key = unescape_quoted(&key_token.text);
                    if key.is_empty() {
                        return Err(self.error_at_current("Empty quoted path segments are not valid"));
                    }
                    self.consume(TokenKind::RightBracket, "Expected `]` after quoted member key")?;
                    segments.push(ReferenceSegment::Key(key));
                } else {
                    segments.push(ReferenceSegment::Key(self.parse_reference_key()?));
                }
                continue;
            }
            if self.match_kind(TokenKind::LeftBracket) {
                if self.check(TokenKind::String) {
                    let key_token = self.advance();
                    let key = unescape_quoted(&key_token.text);
                    if key.is_empty() {
                        return Err(self.error_at_current("Empty quoted path segments are not valid"));
                    }
                    self.consume(TokenKind::RightBracket, "Expected `]` after quoted key")?;
                    segments.push(ReferenceSegment::Key(key));
                } else {
                    let index_token = self.consume(TokenKind::Number, "Expected index segment")?;
                    let index = index_token
                        .text
                        .parse::<usize>()
                        .map_err(|_| self.error_at_current("Invalid index segment"))?;
                    self.consume(TokenKind::RightBracket, "Expected `]` after index segment")?;
                    segments.push(ReferenceSegment::Index(index));
                }
                continue;
            }
            break;
        }

        let end = self.previous().span.end;
        let span = Span { start, end };

        Ok(if is_pointer {
            Value::PointerReference { segments, span }
        } else {
            Value::CloneReference { segments, span }
        })
    }

    fn parse_reference_key(&mut self) -> Result<String, Diagnostic> {
        match self.peek().kind {
            TokenKind::Identifier => Ok(self.advance().text.clone()),
            TokenKind::String => {
                let text = self.advance().text.clone();
                let key = unescape_quoted(&text);
                if key.is_empty() {
                    return Err(self.error_at_current("Empty quoted path segments are not valid"));
                }
                Ok(key)
            }
            _ => Err(self.error_at_current("Expected reference path segment")),
        }
    }

    fn parse_node_tag(&mut self) -> Result<String, Diagnostic> {
        match self.peek().kind {
            TokenKind::Identifier => Ok(self.advance().text.clone()),
            TokenKind::String => {
                let token = self.peek();
                if token.quote == Some('`') {
                    return Err(self.error_at_current("Backtick strings are not valid node tags"));
                }
                let text = self.advance().text.clone();
                let tag = unescape_quoted(&text);
                if tag.is_empty() {
                    return Err(self.error_at_current("Empty quoted node tags are not valid"));
                }
                Ok(tag)
            }
            _ => Err(self.error_at_current("Expected node tag")),
        }
    }

    fn parse_node_literal(&mut self) -> Result<Value, Diagnostic> {
        let start_index = self.current;
        self.consume(TokenKind::LeftAngle, "Expected `<`")?;
        self.skip_newlines();
        let tag = self.parse_node_tag()?;

        let mut attributes = Vec::new();
        self.skip_newlines();
        while self.check(TokenKind::At) {
            attributes.push(self.parse_attribute_block()?);
            self.skip_newlines();
        }

        let mut datatype = None;
        if self.match_kind(TokenKind::Colon) {
            let parsed = self.parse_simple_datatype()?;
            if parsed.contains('<') || parsed.contains('[') {
                return Err(self.error_at_current(
                    "Node head datatypes must be simple labels without generics or separator specs",
                ));
            }
            datatype = Some(parsed);
        }

        self.skip_newlines();
        let mut children = Vec::new();
        if self.match_kind(TokenKind::RightAngle) {
            let raw = self.tokens_text(start_index, self.current);
            return Ok(Value::NodeLiteral {
                raw,
                tag,
                attributes,
                datatype,
                children,
            });
        }

        self.consume(TokenKind::LeftParen, "Expected `(` or `>` in node literal")?;
        children = self.parse_delimited_values(TokenKind::RightParen, "Expected node child delimiter")?;
        self.consume(TokenKind::RightParen, "Expected `)` after node children")?;
        self.skip_newlines();
        self.consume(TokenKind::RightAngle, "Expected `>` after node children")?;

        let raw = self.tokens_text(start_index, self.current);
        Ok(Value::NodeLiteral {
            raw,
            tag,
            attributes,
            datatype,
            children,
        })
    }

    fn parse_attribute_block(&mut self) -> Result<BTreeMap<String, AttributeValue>, Diagnostic> {
        self.consume(TokenKind::At, "Expected `@` before attribute block")?;
        self.skip_newlines();
        self.consume(TokenKind::LeftBrace, "Expected `{` after `@`")?;
        let map = self.parse_attribute_members(TokenKind::RightBrace, "Expected attribute delimiter", "Expected `=` after attribute key")?;
        self.consume(TokenKind::RightBrace, "Expected `}` after attribute block")?;
        Ok(map)
    }

    fn parse_attribute_value_shape(&mut self) -> Result<AttributeValue, Diagnostic> {
        if self.check(TokenKind::LeftBrace) {
            let members = self.parse_attribute_object_members()?;
            return Ok(AttributeValue::with_parts(None, None, BTreeMap::new(), members));
        }
        let value = self.parse_value()?;
        Ok(AttributeValue::with_parts(
            None,
            Some(value),
            BTreeMap::new(),
            BTreeMap::new(),
        ))
    }

    fn parse_attribute_object_members(&mut self) -> Result<BTreeMap<String, AttributeValue>, Diagnostic> {
        self.consume(TokenKind::LeftBrace, "Expected `{` in attribute object")?;
        let members = self.parse_attribute_members(
            TokenKind::RightBrace,
            "Expected object member delimiter",
            "Expected `=` after object member key",
        )?;
        self.consume(TokenKind::RightBrace, "Expected `}` after attribute object")?;
        Ok(members)
    }

    fn parse_delimited_values(
        &mut self,
        terminator: TokenKind,
        delimiter_message: &str,
    ) -> Result<Vec<Value>, Diagnostic> {
        let mut items = Vec::new();
        self.skip_newlines();
        while !self.check(terminator) {
            items.push(self.parse_value()?);
            self.consume_member_delimiter(terminator, delimiter_message)?;
        }
        Ok(items)
    }

    fn parse_delimited_bindings(
        &mut self,
        terminator: TokenKind,
        delimiter_message: &str,
    ) -> Result<Vec<Binding>, Diagnostic> {
        let mut bindings = Vec::new();
        self.skip_newlines();
        while !self.check(terminator) {
            bindings.push(self.parse_binding()?);
            self.consume_member_delimiter(terminator, delimiter_message)?;
        }
        Ok(bindings)
    }

    fn parse_attribute_members(
        &mut self,
        terminator: TokenKind,
        delimiter_message: &str,
        equals_message: &str,
    ) -> Result<BTreeMap<String, AttributeValue>, Diagnostic> {
        let mut members = BTreeMap::new();
        self.skip_newlines();
        while !self.check(terminator) {
            let key = self.parse_key()?;
            self.skip_newlines();
            let mut datatype = None;
            let mut nested_attrs = BTreeMap::new();
            while self.check(TokenKind::At) {
                nested_attrs.extend(self.parse_attribute_block()?);
                self.skip_newlines();
            }
            self.skip_newlines();
            if self.match_kind(TokenKind::Colon) {
                self.skip_newlines();
                datatype = Some(self.parse_simple_datatype()?);
            }
            self.skip_newlines();
            self.consume(TokenKind::Equals, equals_message)?;
            self.skip_newlines();
            let value = self.parse_attribute_value_shape()?;
            members.insert(
                key,
                AttributeValue::with_parts(
                    datatype,
                    value.value,
                    nested_attrs,
                    value.object_members,
                ),
            );
            self.consume_member_delimiter(terminator, delimiter_message)?;
        }
        Ok(members)
    }

    fn consume_member_delimiter(
        &mut self,
        terminator: TokenKind,
        delimiter_message: &str,
    ) -> Result<(), Diagnostic> {
        let mut saw_newline = false;
        while self.match_kind(TokenKind::Newline) {
            saw_newline = true;
        }
        if self.match_kind(TokenKind::Comma) {
            self.skip_newlines();
            return Ok(());
        }
        if self.check(terminator) {
            return Ok(());
        }
        if saw_newline {
            return Ok(());
        }
        Err(self.error_at_current(delimiter_message))
    }

    fn consume_separator(&mut self) -> Result<(), Diagnostic> {
        if self.is_at_end() {
            return Ok(());
        }
        if self.match_kind(TokenKind::Comma) {
            self.skip_newlines();
            return Ok(());
        }
        if self.peek().kind == TokenKind::Newline {
            self.skip_newlines();
            return Ok(());
        }
        Err(self.error_at_current("Expected binding delimiter"))
    }

    fn skip_newlines(&mut self) {
        while self.match_kind(TokenKind::Newline) {}
    }

    fn consume(&mut self, kind: TokenKind, message: &str) -> Result<&'a Token, Diagnostic> {
        if self.peek().kind == kind {
            Ok(self.advance())
        } else {
            Err(self.error_at_current(message))
        }
    }

    fn match_kind(&mut self, kind: TokenKind) -> bool {
        if self.peek().kind == kind {
            self.advance();
            true
        } else {
            false
        }
    }

    fn advance(&mut self) -> &'a Token {
        let token = &self.tokens[self.current];
        self.current += 1;
        token
    }

    fn previous(&self) -> &'a Token {
        &self.tokens[self.current.saturating_sub(1)]
    }

    fn peek(&self) -> &'a Token {
        &self.tokens[self.current]
    }

    fn peek_next(&self) -> &'a Token {
        self.tokens
            .get(self.current + 1)
            .unwrap_or_else(|| self.tokens.last().expect("token stream has EOF"))
    }

    fn check(&self, kind: TokenKind) -> bool {
        self.peek().kind == kind
    }

    fn is_at_end(&self) -> bool {
        self.peek().kind == TokenKind::Eof
    }

    fn error_at_current(&self, message: &str) -> Diagnostic {
        Diagnostic {
            code: String::from("SYNTAX_ERROR"),
            path: Some(String::from("$")),
            span: Some(self.peek().span),
            phase: None,
            message: String::from(message),
        }
    }

    fn tokens_text(&self, start: usize, end: usize) -> String {
        self.tokens[start..end]
            .iter()
            .map(|token| token.text.as_str())
            .collect::<String>()
    }
}

fn is_valid_radix_base_token(raw: &str) -> bool {
    if raw.is_empty() || (raw.starts_with('0') && raw != "0") || !raw.chars().all(|ch| ch.is_ascii_digit()) {
        return false;
    }
    raw.parse::<usize>().ok().is_some_and(|base| (2..=64).contains(&base))
}

fn unescape_quoted(text: &str) -> String {
    if text.len() < 2 {
        return String::from(text);
    }
    let inner = &text[1..text.len() - 1];
    let mut output = String::with_capacity(inner.len());
    let mut chars = inner.chars();
    while let Some(ch) = chars.next() {
        if ch == '\\' {
            if let Some(escaped) = chars.next() {
                output.push(escaped);
            } else {
                output.push('\\');
            }
        } else {
            output.push(ch);
        }
    }
    output
}

#[cfg(test)]
mod tests {
    use super::parse_document_from_tokens;
    use crate::Value;

    #[test]
    fn parses_simple_top_level_bindings_from_tokens() {
        let bindings = parse_document_from_tokens("name = \"Pat\"\nage = 49").expect("token parse");
        assert_eq!(bindings.len(), 2);
        assert_eq!(bindings[0].key, "name");
        assert!(matches!(bindings[0].value, Value::StringLiteral { .. }));
        assert_eq!(bindings[1].key, "age");
        assert!(matches!(bindings[1].value, Value::NumberLiteral { .. }));
    }

    #[test]
    fn parses_shorthand_header_key_from_tokens() {
        let bindings = parse_document_from_tokens("aeon:mode = \"strict\"").expect("token parse");
        assert_eq!(bindings[0].key, "aeon:mode");
    }

    #[test]
    fn rejects_unsupported_complex_value_in_token_seam() {
        let bindings = parse_document_from_tokens("items = [1, 2]").expect("token parse");
        assert!(matches!(bindings[0].value, Value::ListNode { .. }));
    }

    #[test]
    fn parses_objects_tuples_and_references_from_tokens() {
        let bindings = parse_document_from_tokens(
            "obj = { a = 1, pair = (2, 3) }\nref = ~obj.pair[1]\nptr = ~>$.obj.a",
        )
        .expect("token parse");
        assert!(matches!(bindings[0].value, Value::ObjectNode { .. }));
        assert!(matches!(bindings[1].value, Value::CloneReference { .. }));
        assert!(matches!(bindings[2].value, Value::PointerReference { .. }));
    }

    #[test]
    fn parses_binding_attributes_from_tokens() {
        let bindings = parse_document_from_tokens("user@{ role = \"admin\"\n level = 5 } = 1")
            .expect("token parse");
        assert!(bindings[0].attributes.contains_key("role"));
        assert!(bindings[0].attributes.contains_key("level"));
    }

    #[test]
    fn parses_node_literals_from_tokens() {
        let bindings = parse_document_from_tokens(
            "content:node = <div(\n  <span@{id = \"text\"}:node(\"hello\")>,\n  <br()>\n)>",
        )
        .expect("token parse");
        assert!(matches!(bindings[0].value, Value::NodeLiteral { .. }));
    }

    #[test]
    fn rejects_node_literals_without_trailing_right_angle_after_children() {
        let err = parse_document_from_tokens("content:node = <span(\"hello\")\n")
            .expect_err("missing closing angle should fail");
        assert_eq!(err.code, "SYNTAX_ERROR");
    }

    #[test]
    fn parses_empty_node_shorthand_after_node_head_datatype() {
        let bindings = parse_document_from_tokens("v:node = <glyph:node>\n").expect("token parse");
        match &bindings[0].value {
            Value::NodeLiteral { tag, datatype, children, .. } => {
                assert_eq!(tag, "glyph");
                assert_eq!(datatype.as_deref(), Some("node"));
                assert!(children.is_empty());
            }
            other => panic!("expected node literal, got {other:?}"),
        }
    }

    #[test]
    fn parses_empty_node_shorthand_after_node_head_attributes_and_datatype() {
        let bindings = parse_document_from_tokens("v:node = <glyph@{id=\"x\"}:node>\n")
            .expect("token parse");
        match &bindings[0].value {
            Value::NodeLiteral { tag, datatype, children, attributes, .. } => {
                assert_eq!(tag, "glyph");
                assert_eq!(datatype.as_deref(), Some("node"));
                assert!(children.is_empty());
                assert_eq!(attributes.len(), 1);
            }
            other => panic!("expected node literal, got {other:?}"),
        }
    }

    #[test]
    fn rejects_generic_inline_node_head_datatypes() {
        let err = parse_document_from_tokens("v:node = <tag:pair<int32,string>(\"x\")>\n")
            .expect_err("generic node head datatype should fail");
        assert_eq!(err.code, "SYNTAX_ERROR");
    }

    #[test]
    fn rejects_separator_inline_node_head_datatypes() {
        let err = parse_document_from_tokens("v:node = <tag:contact[x](\"x\")>\n")
            .expect_err("separator node head datatype should fail");
        assert_eq!(err.code, "SYNTAX_ERROR");
    }

    #[test]
    fn parses_multiline_separator_specs_and_generic_boundaries_from_tokens() {
        let bindings = parse_document_from_tokens(
            "size:sep\n[\nx\n]\n= ^300x250\nitems:list\n<\nn\n>\n=\n[\n2,\n3\n]\n",
        )
        .expect("token parse");
        assert_eq!(bindings.len(), 2);
        assert_eq!(bindings[0].datatype.as_deref(), Some("sep[x]"));
        assert_eq!(bindings[1].datatype.as_deref(), Some("list<n>"));
        assert!(matches!(bindings[1].value, Value::ListNode { .. }));
    }

    #[test]
    fn parses_escaped_backticks_from_tokens() {
        let bindings =
            parse_document_from_tokens("value = `\\``\nquoted = \"a\\\"b\"\n").expect("token parse");
        assert_eq!(
            bindings[0].value,
            Value::StringLiteral {
                value: String::from("`"),
                is_trimtick: false,
            }
        );
        assert_eq!(
            bindings[1].value,
            Value::StringLiteral {
                value: String::from("a\"b"),
                is_trimtick: false,
            }
        );
    }

    #[test]
    fn parses_trimticks_from_tokens() {
        let bindings = parse_document_from_tokens("note:trimtick = >`\n  one\n  two\n`\n")
            .expect("token parse");
        assert_eq!(
            bindings[0].value,
            Value::StringLiteral {
                value: String::from("one\ntwo"),
                is_trimtick: true,
            }
        );
    }

    #[test]
    fn parses_multiline_node_attributes_from_tokens() {
        let bindings = parse_document_from_tokens(
            "s:node = <span\n  @\n  {class = \"line-4\"}\n  (\"world\")\n>\n",
        )
        .expect("token parse");
        assert!(matches!(bindings[0].value, Value::NodeLiteral { .. }));
    }

    #[test]
    fn parses_multiline_binding_layout_from_tokens() {
        let bindings = parse_document_from_tokens(
            "name\n:\nstring =\n\"playground\"\n",
        )
        .expect("token parse");
        assert_eq!(bindings.len(), 1);
        assert_eq!(bindings[0].datatype.as_deref(), Some("string"));
        assert!(matches!(bindings[0].value, Value::StringLiteral { .. }));
    }

    #[test]
    fn rejects_empty_quoted_reference_segments() {
        for source in [
            "a = { \"\" = 1 }\nv = ~a.[\"\"]\n",
            "a = 1\nv = ~a@[\"\"]\n",
            "a = 1\nv = ~a[\"\"]\n",
        ] {
            let error = parse_document_from_tokens(source).expect_err("expected syntax error");
            assert_eq!(error.code, "SYNTAX_ERROR");
            assert!(error.message.contains("Empty quoted path segments are not valid"));
        }
    }

    #[test]
    fn reports_missing_equals_after_key_with_key_name() {
        let error = parse_document_from_tokens("a hello\n").expect_err("expected syntax error");
        assert_eq!(error.code, "SYNTAX_ERROR");
        assert_eq!(error.message, "Expected '=' after key 'a'");
        let span = error.span.expect("span");
        assert_eq!(span.start.line, 1);
        assert_eq!(span.start.column, 3);
        assert_eq!(span.end.line, 1);
        assert_eq!(span.end.column, 8);
    }

    #[test]
    fn reports_unexpected_identifier_token_in_value_position() {
        let error = parse_document_from_tokens("a = hello\n").expect_err("expected syntax error");
        assert_eq!(error.code, "SYNTAX_ERROR");
        assert_eq!(error.message, "Unexpected token 'hello'");
        let span = error.span.expect("span");
        assert_eq!(span.start.line, 1);
        assert_eq!(span.start.column, 5);
        assert_eq!(span.end.line, 1);
        assert_eq!(span.end.column, 10);
    }

    #[test]
    fn parses_extremely_multiline_binding_attributes_from_tokens() {
        let bindings = parse_document_from_tokens(
            "a\n@ \n{\nn\n:\nn \n=\n1\n}\n:\nn \n= \n2\n",
        )
        .expect("token parse");
        assert_eq!(bindings.len(), 1);
        assert_eq!(bindings[0].key, "a");
        assert_eq!(bindings[0].datatype.as_deref(), Some("n"));
        assert!(bindings[0].attributes.contains_key("n"));
        assert!(matches!(bindings[0].value, Value::NumberLiteral { .. }));
    }
}
