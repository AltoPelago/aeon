#![allow(clippy::result_large_err)]

use std::collections::BTreeMap;

use crate::header::apply_trimticks;
use crate::temporal::{classify_temporal_literal, invalid_temporal_literal};
use crate::validation::datatype_has_generic_args;
use crate::{
    AttributeValue, Binding, Diagnostic, LexerOptions, ReferenceSegment, Span, Token, TokenKind,
    TrimtickMetadata, Value, tokenize,
};

pub(crate) fn parse_document_from_tokens(
    input: &str,
    max_nesting_depth: usize,
    max_attribute_depth: usize,
) -> Result<Vec<Binding>, Diagnostic> {
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
    TokenParser::new(&lexed.tokens, max_nesting_depth, max_attribute_depth).parse_document()
}

struct TokenParser<'a> {
    tokens: &'a [Token],
    current: usize,
    max_nesting_depth: usize,
    current_nesting_depth: usize,
    max_attribute_depth: usize,
}

impl<'a> TokenParser<'a> {
    fn new(tokens: &'a [Token], max_nesting_depth: usize, max_attribute_depth: usize) -> Self {
        Self {
            tokens,
            current: 0,
            max_nesting_depth,
            current_nesting_depth: 0,
            max_attribute_depth,
        }
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
        let mut attribute_order = Vec::new();
        while self.check(TokenKind::At) {
            let (parsed_attrs, parsed_order) = self.parse_attribute_block(1)?;
            for key in parsed_order {
                if !attributes.contains_key(&key) {
                    attribute_order.push(key.clone());
                }
            }
            attributes.extend(parsed_attrs);
            self.skip_newlines();
        }
        let mut datatype = None;
        if self.match_kind(TokenKind::Colon) {
            self.skip_newlines();
            if self.check(TokenKind::Colon) {
                return Err(self.error_at_current("Expected datatype annotation"));
            }
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
            attribute_order,
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
                    let field =
                        self.consume(TokenKind::Identifier, "Expected header field after `aeon:`")?;
                    Ok(format!("aeon:{}", field.text))
                } else {
                    Ok(self.advance().text.clone())
                }
            }
            TokenKind::String => {
                if token.quote == Some('`') {
                    return Err(self.error_at_current("Backtick strings are not valid keys"));
                }
                let token = self.advance();
                let key = decode_quoted_token(token)?;
                if key.is_empty() {
                    return Err(Diagnostic::new("SYNTAX_ERROR", "Keys must not be empty")
                        .at_path("$")
                        .with_span(token.span));
                }
                Ok(key)
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
        let datatype_name = self
            .consume(TokenKind::Identifier, "Expected datatype annotation")?
            .text
            .clone();
        self.skip_newlines();

        if self.match_kind(TokenKind::LeftAngle) {
            if datatype_name == "radix" {
                return Err(Diagnostic {
                    code: String::from("SYNTAX_ERROR"),
                    path: Some(String::from("$")),
                    span: Some(self.previous().span),
                    phase: None,
                    message: String::from(
                        "Radix datatype bases must use bracket syntax like `radix[10]`",
                    ),
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
            if is_reserved_v1_datatype(&datatype_name)
                && !matches!(datatype_name.as_str(), "sep" | "set" | "radix")
            {
                return Err(Diagnostic {
                    code: String::from("SYNTAX_ERROR"),
                    path: Some(String::from("$")),
                    span: Some(self.peek().span),
                    phase: None,
                    message: format!(
                        "Datatype `{datatype_name}` does not support bracket specifiers in v1"
                    ),
                });
            }
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
                self.consume(
                    TokenKind::RightBracket,
                    "Expected ']' to close radix base spec",
                )?;
                self.skip_newlines();
                continue;
            }
            if is_reserved_v1_datatype(&datatype_name) {
                match self.peek().kind {
                    TokenKind::Identifier
                    | TokenKind::Number
                    | TokenKind::String
                    | TokenKind::Symbol
                    | TokenKind::Semicolon
                    | TokenKind::Dot
                    | TokenKind::Comma
                    | TokenKind::Colon
                    | TokenKind::At
                    | TokenKind::Hash
                    | TokenKind::Dollar
                    | TokenKind::Percent
                    | TokenKind::Ampersand
                    | TokenKind::Caret
                    | TokenKind::Equals
                    | TokenKind::LeftAngle
                    | TokenKind::RightAngle
                    | TokenKind::Tilde => {
                        let token = self.advance();
                        if token.text.len() != 1
                            || !token.text.chars().all(is_allowed_separator_spec_char)
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
            } else {
                match self.peek().kind {
                    TokenKind::Identifier
                    | TokenKind::Number
                    | TokenKind::String
                    | TokenKind::Symbol
                    | TokenKind::Semicolon
                    | TokenKind::Dot
                    | TokenKind::Comma
                    | TokenKind::Colon
                    | TokenKind::At
                    | TokenKind::Hash
                    | TokenKind::Dollar
                    | TokenKind::Percent
                    | TokenKind::Ampersand
                    | TokenKind::Caret
                    | TokenKind::Equals
                    | TokenKind::LeftAngle
                    | TokenKind::RightAngle
                    | TokenKind::Tilde => {
                        self.advance();
                    }
                    _ => {
                        return Err(self.error_at_current("Expected separator character"));
                    }
                }
            }
            self.skip_newlines();
            self.consume(
                TokenKind::RightBracket,
                "Expected ']' to close separator spec",
            )?;
            self.skip_newlines();
        }

        let datatype = self.tokens[start..self.current]
            .iter()
            .map(|token| token.text.as_str())
            .collect::<String>()
            .chars()
            .filter(|ch| !matches!(ch, ' ' | '\t' | '\n' | '\r'))
            .collect::<String>();
        validate_reserved_datatype_adornments(&datatype, self.previous().span)?;
        Ok(datatype)
    }

    fn parse_value(&mut self) -> Result<Value, Diagnostic> {
        self.current_nesting_depth += 1;
        if self.current_nesting_depth > self.max_nesting_depth {
            let span = self.peek().span;
            self.current_nesting_depth -= 1;
            return Err(Diagnostic {
                code: String::from("NESTING_DEPTH_EXCEEDED"),
                path: Some(String::from("$")),
                span: Some(span),
                phase: None,
                message: format!(
                    "Value nesting depth {} exceeds max_nesting_depth {}",
                    self.max_nesting_depth + 1,
                    self.max_nesting_depth
                ),
            });
        }
        let result = self.do_parse_value();
        self.current_nesting_depth -= 1;
        result
    }

    fn do_parse_value(&mut self) -> Result<Value, Diagnostic> {
        let token = self.peek();
        match token.kind {
            TokenKind::String => {
                let token = self.advance();
                Ok(Value::StringLiteral {
                    value: decode_quoted_token(token)?,
                    raw: token.text[1..token.text.len() - 1].to_string(),
                    delimiter: token.quote.unwrap_or('"'),
                    trimticks: None,
                })
            }
            TokenKind::Number => {
                let raw = self.advance().text.clone();
                if let Some(value) = classify_temporal_literal(&raw) {
                    return Ok(value);
                }
                if let Some((code, message)) = invalid_temporal_literal(&raw) {
                    return Err(Diagnostic {
                        code: String::from(code),
                        path: Some(String::from("$")),
                        span: Some(self.previous().span),
                        phase: None,
                        message,
                    });
                }
                if !is_valid_number_literal(&raw) {
                    return Err(Diagnostic {
                        code: String::from("INVALID_NUMBER"),
                        path: Some(String::from("$")),
                        span: Some(self.previous().span),
                        phase: None,
                        message: format!("Number literal `{raw}` is not valid"),
                    });
                }
                Ok(Value::NumberLiteral { raw })
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
            TokenKind::Yes | TokenKind::No | TokenKind::On | TokenKind::Off => {
                Ok(Value::SwitchLiteral {
                    raw: self.advance().text.clone(),
                })
            }
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
            if let Some(end) = previous_end
                && end != token.span.start.offset
            {
                return Err(self.error_at_current("Trimtick marker must be contiguous"));
            }
            marker_width += 1;
            if marker_width > 4 {
                return Err(self.error_at_current(
                    "Trimtick marker may contain at most four \">\" characters",
                ));
            }
            previous_end = Some(token.span.end.offset);
            self.advance();
        }
        if !self.check(TokenKind::String) || self.peek().quote != Some('`') {
            return Err(
                self.error_at_current("Trimtick marker must be followed by a backtick string")
            );
        }
        let token = self.advance();
        let raw = decode_quoted_token(token)?;
        let value = apply_trimticks(&raw, marker_width);
        Ok(Value::StringLiteral {
            value,
            raw: raw.clone(),
            delimiter: '`',
            trimticks: Some(TrimtickMetadata {
                marker_width,
                raw_value: raw,
            }),
        })
    }

    fn parse_list(&mut self) -> Result<Value, Diagnostic> {
        self.consume(TokenKind::LeftBracket, "Expected `[`")?;
        let items =
            self.parse_delimited_values(TokenKind::RightBracket, "Expected list delimiter")?;
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
        let bindings = self
            .parse_delimited_bindings(TokenKind::RightBrace, "Expected object member delimiter")?;
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
            if self.match_kind(TokenKind::LeftBracket) {
                let key_token = self.consume(TokenKind::String, "Expected quoted member key")?;
                let key = decode_quoted_token(key_token)?;
                if key.is_empty() {
                    return Err(Diagnostic::new(
                        "SYNTAX_ERROR",
                        "Empty quoted path segments are not valid",
                    )
                    .at_path("$")
                    .with_span(key_token.span));
                }
                self.consume(
                    TokenKind::RightBracket,
                    "Expected `]` after quoted member key",
                )?;
                segments.push(ReferenceSegment::Key(key));
            } else {
                segments.push(ReferenceSegment::Key(self.parse_reference_key()?));
            }
        } else if self.match_kind(TokenKind::LeftBracket) {
            let key_token = self.consume(TokenKind::String, "Expected quoted reference key")?;
            let key = decode_quoted_token(key_token)?;
            if key.is_empty() {
                return Err(Diagnostic::new(
                    "SYNTAX_ERROR",
                    "Empty quoted path segments are not valid",
                )
                .at_path("$")
                .with_span(key_token.span));
            }
            self.consume(
                TokenKind::RightBracket,
                "Expected `]` after quoted reference key",
            )?;
            segments.push(ReferenceSegment::Key(key));
        } else {
            segments.push(ReferenceSegment::Key(self.parse_reference_key()?));
        }

        loop {
            if self.match_kind(TokenKind::At) {
                if self.match_kind(TokenKind::LeftBracket) {
                    let key_token =
                        self.consume(TokenKind::String, "Expected quoted attribute key")?;
                    let key = decode_quoted_token(key_token)?;
                    if key.is_empty() {
                        return Err(Diagnostic::new(
                            "SYNTAX_ERROR",
                            "Empty quoted path segments are not valid",
                        )
                        .at_path("$")
                        .with_span(key_token.span));
                    }
                    self.consume(
                        TokenKind::RightBracket,
                        "Expected `]` after quoted attribute key",
                    )?;
                    segments.push(ReferenceSegment::Attr(key));
                } else {
                    segments.push(ReferenceSegment::Attr(self.parse_reference_key()?));
                }
                continue;
            }
            if self.match_kind(TokenKind::Dot) {
                if self.match_kind(TokenKind::LeftBracket) {
                    let key_token =
                        self.consume(TokenKind::String, "Expected quoted member key")?;
                    let key = decode_quoted_token(key_token)?;
                    if key.is_empty() {
                        return Err(Diagnostic::new(
                            "SYNTAX_ERROR",
                            "Empty quoted path segments are not valid",
                        )
                        .at_path("$")
                        .with_span(key_token.span));
                    }
                    self.consume(
                        TokenKind::RightBracket,
                        "Expected `]` after quoted member key",
                    )?;
                    segments.push(ReferenceSegment::Key(key));
                } else {
                    segments.push(ReferenceSegment::Key(self.parse_reference_key()?));
                }
                continue;
            }
            if self.match_kind(TokenKind::LeftBracket) {
                if self.check(TokenKind::String) {
                    let key_token = self.advance();
                    let key = decode_quoted_token(key_token)?;
                    if key.is_empty() {
                        return Err(Diagnostic::new(
                            "SYNTAX_ERROR",
                            "Empty quoted path segments are not valid",
                        )
                        .at_path("$")
                        .with_span(key_token.span));
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
                let token = self.advance();
                let key = decode_quoted_token(token)?;
                if key.is_empty() {
                    return Err(Diagnostic::new(
                        "SYNTAX_ERROR",
                        "Empty quoted path segments are not valid",
                    )
                    .at_path("$")
                    .with_span(token.span));
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
                let token = self.advance();
                let tag = decode_quoted_token(token)?;
                if tag.is_empty() {
                    return Err(Diagnostic::new(
                        "SYNTAX_ERROR",
                        "Empty quoted node tags are not valid",
                    )
                    .at_path("$")
                    .with_span(token.span));
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
            let (attribute_map, _) = self.parse_attribute_block(1)?;
            attributes.push(attribute_map);
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
        children =
            self.parse_delimited_values(TokenKind::RightParen, "Expected node child delimiter")?;
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

    fn parse_attribute_block(
        &mut self,
        depth: usize,
    ) -> Result<(BTreeMap<String, AttributeValue>, Vec<String>), Diagnostic> {
        if depth > self.max_attribute_depth {
            return Err(Diagnostic::new(
                "ATTRIBUTE_DEPTH_EXCEEDED",
                format!(
                    "Attribute depth {depth} exceeds max_attribute_depth {}",
                    self.max_attribute_depth
                ),
            )
            .at_path("$")
            .with_span(self.peek().span));
        }
        self.consume(TokenKind::At, "Expected `@` before attribute block")?;
        self.skip_newlines();
        self.consume(TokenKind::LeftBrace, "Expected `{` after `@`")?;
        let map = self.parse_attribute_members(
            TokenKind::RightBrace,
            "Expected attribute delimiter",
            "Expected `=` after attribute key",
            depth,
        )?;
        self.consume(TokenKind::RightBrace, "Expected `}` after attribute block")?;
        Ok(map)
    }

    fn parse_attribute_value_shape(&mut self) -> Result<AttributeValue, Diagnostic> {
        if self.check(TokenKind::LeftBrace) {
            let (members, member_order) = self.parse_attribute_object_members()?;
            return Ok(AttributeValue::with_parts(
                None,
                None,
                BTreeMap::new(),
                Vec::new(),
                members,
                member_order,
            ));
        }
        let value = self.parse_value()?;
        Ok(AttributeValue::with_parts(
            None,
            Some(value),
            BTreeMap::new(),
            Vec::new(),
            BTreeMap::new(),
            Vec::new(),
        ))
    }

    fn parse_attribute_object_members(
        &mut self,
    ) -> Result<(BTreeMap<String, AttributeValue>, Vec<String>), Diagnostic> {
        self.consume(TokenKind::LeftBrace, "Expected `{` in attribute object")?;
        let members = self.parse_attribute_members(
            TokenKind::RightBrace,
            "Expected object member delimiter",
            "Expected `=` after object member key",
            0,
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
        depth: usize,
    ) -> Result<(BTreeMap<String, AttributeValue>, Vec<String>), Diagnostic> {
        let mut members = BTreeMap::new();
        let mut member_order = Vec::new();
        self.skip_newlines();
        while !self.check(terminator) {
            let key = self.parse_key()?;
            self.skip_newlines();
            let mut datatype = None;
            let mut nested_attrs = BTreeMap::new();
            let mut nested_attr_order = Vec::new();
            while self.check(TokenKind::At) {
                let (parsed_attrs, parsed_order) = self.parse_attribute_block(depth + 1)?;
                for nested_key in parsed_order {
                    if !nested_attrs.contains_key(&nested_key) {
                        nested_attr_order.push(nested_key.clone());
                    }
                }
                nested_attrs.extend(parsed_attrs);
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
                key.clone(),
                AttributeValue::with_parts(
                    datatype,
                    value.value,
                    nested_attrs,
                    nested_attr_order,
                    value.object_members,
                    value.object_member_order,
                ),
            );
            if !member_order.contains(&key) {
                member_order.push(key);
            }
            self.consume_member_delimiter(terminator, delimiter_message)?;
        }
        Ok((members, member_order))
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

fn is_allowed_separator_spec_char(ch: char) -> bool {
    matches!(
        ch,
        'A'..='Z'
            | 'a'..='z'
            | '0'..='9'
            | '!'
            | '#'
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

fn is_valid_radix_base_token(raw: &str) -> bool {
    if raw.is_empty()
        || (raw.starts_with('0') && raw != "0")
        || !raw.chars().all(|ch| ch.is_ascii_digit())
    {
        return false;
    }
    raw.parse::<usize>()
        .ok()
        .is_some_and(|base| (2..=64).contains(&base))
}

fn validate_reserved_datatype_adornments(datatype: &str, span: Span) -> Result<(), Diagnostic> {
    let base = datatype_base(datatype);
    if !is_reserved_v1_datatype(base) {
        return Ok(());
    }
    if datatype_has_generic_args(datatype) && !matches!(base, "list" | "tuple") {
        return Err(Diagnostic {
            code: String::from("SYNTAX_ERROR"),
            path: Some(String::from("$")),
            span: Some(span),
            phase: None,
            message: format!("Datatype `{base}` does not support generic arguments in v1"),
        });
    }
    if !datatype_bracket_specs(datatype).is_empty() && !matches!(base, "sep" | "set" | "radix") {
        return Err(Diagnostic {
            code: String::from("SYNTAX_ERROR"),
            path: Some(String::from("$")),
            span: Some(span),
            phase: None,
            message: format!("Datatype `{base}` does not support bracket specifiers in v1"),
        });
    }
    Ok(())
}

fn datatype_base(datatype: &str) -> &str {
    let generic_idx = datatype.find('<').unwrap_or(datatype.len());
    let bracket_idx = datatype.find('[').unwrap_or(datatype.len());
    &datatype[..generic_idx.min(bracket_idx)]
}

fn datatype_bracket_specs(datatype: &str) -> Vec<&str> {
    let mut specs = Vec::new();
    let mut angle_depth = 0usize;
    let mut bracket_depth = 0usize;
    let mut bracket_start = None;
    for (index, ch) in datatype.char_indices() {
        match ch {
            '[' if angle_depth == 0 => {
                bracket_depth += 1;
                if bracket_depth == 1 {
                    bracket_start = Some(index + ch.len_utf8());
                }
            }
            ']' if angle_depth == 0 && bracket_depth > 0 => {
                bracket_depth -= 1;
                if bracket_depth == 0
                    && let Some(start) = bracket_start.take()
                {
                    specs.push(&datatype[start..index]);
                }
            }
            '<' if bracket_depth == 0 => angle_depth += 1,
            '>' if bracket_depth == 0 => angle_depth = angle_depth.saturating_sub(1),
            _ if bracket_depth > 0 => {}
            _ => {}
        }
    }
    if datatype_base(datatype) == "radix" && !specs.is_empty() {
        specs.remove(0);
    }
    specs
}

fn is_reserved_v1_datatype(base: &str) -> bool {
    matches!(
        base,
        "n" | "number"
            | "int"
            | "int8"
            | "int16"
            | "int32"
            | "int64"
            | "uint"
            | "uint8"
            | "uint16"
            | "uint32"
            | "uint64"
            | "float"
            | "float32"
            | "float64"
            | "string"
            | "trimtick"
            | "boolean"
            | "bool"
            | "switch"
            | "infinity"
            | "hex"
            | "date"
            | "time"
            | "datetime"
            | "zrut"
            | "encoding"
            | "base64"
            | "embed"
            | "inline"
            | "radix"
            | "radix2"
            | "radix6"
            | "radix8"
            | "radix12"
            | "sep"
            | "set"
            | "tuple"
            | "list"
            | "object"
            | "obj"
            | "envelope"
            | "o"
            | "node"
            | "null"
    )
}

fn decode_quoted_token(token: &Token) -> Result<String, Diagnostic> {
    decode_quoted_text(&token.text).map_err(|message| {
        Diagnostic::new("SYNTAX_ERROR", message)
            .at_path("$")
            .with_span(token.span)
    })
}

fn decode_quoted_text(text: &str) -> Result<String, &'static str> {
    if text.len() < 2 {
        return Ok(String::from(text));
    }
    let inner = &text[1..text.len() - 1];
    let mut output = String::with_capacity(inner.len());
    let mut chars = inner.chars();
    while let Some(ch) = chars.next() {
        if ch == '\\' {
            let escaped = chars.next().ok_or("Invalid escape sequence")?;
            match escaped {
                '\\' => output.push('\\'),
                '"' => output.push('"'),
                '\'' => output.push('\''),
                '`' => output.push('`'),
                'n' => output.push('\n'),
                'r' => output.push('\r'),
                't' => output.push('\t'),
                'b' => output.push('\u{0008}'),
                'f' => output.push('\u{000C}'),
                'u' => {
                    let next = chars.next().ok_or("Invalid unicode escape")?;
                    if next == '{' {
                        let mut hex_digits = String::new();
                        loop {
                            let ch = chars.next().ok_or("Invalid unicode escape")?;
                            if ch == '}' {
                                break;
                            }
                            hex_digits.push(ch);
                        }
                        if !(1..=6).contains(&hex_digits.len())
                            || !hex_digits.chars().all(|digit| digit.is_ascii_hexdigit())
                        {
                            return Err("Invalid unicode escape");
                        }
                        let codepoint = u32::from_str_radix(&hex_digits, 16)
                            .map_err(|_| "Invalid unicode escape")?;
                        let decoded = char::from_u32(codepoint).ok_or("Invalid unicode escape")?;
                        output.push(decoded);
                    } else {
                        let mut hex_digits = String::with_capacity(4);
                        hex_digits.push(next);
                        for _ in 0..3 {
                            hex_digits.push(chars.next().ok_or("Invalid unicode escape")?);
                        }
                        if !hex_digits.chars().all(|digit| digit.is_ascii_hexdigit()) {
                            return Err("Invalid unicode escape");
                        }
                        let codepoint = u32::from_str_radix(&hex_digits, 16)
                            .map_err(|_| "Invalid unicode escape")?;
                        let decoded = char::from_u32(codepoint).ok_or("Invalid unicode escape")?;
                        output.push(decoded);
                    }
                }
                _ => return Err("Invalid escape sequence"),
            }
        } else {
            output.push(ch);
        }
    }
    Ok(output)
}

fn is_valid_number_literal(raw: &str) -> bool {
    if raw.is_empty() {
        return false;
    }

    let body = raw
        .strip_prefix('+')
        .or_else(|| raw.strip_prefix('-'))
        .unwrap_or(raw);
    if body.is_empty() {
        return false;
    }

    let (mantissa, exponent) = match body.split_once(['e', 'E']) {
        Some((mantissa, exponent)) => {
            if mantissa.is_empty() || exponent.is_empty() || exponent.contains(['e', 'E']) {
                return false;
            }
            (mantissa, Some(exponent))
        }
        None => (body, None),
    };

    if let Some(exponent) = exponent {
        let exponent_digits = exponent
            .strip_prefix('+')
            .or_else(|| exponent.strip_prefix('-'))
            .unwrap_or(exponent);
        if !is_valid_exponent_digits(exponent_digits) {
            return false;
        }
    }

    match mantissa.split_once('.') {
        Some((integer, fraction)) => {
            if fraction.is_empty() || fraction.contains('.') {
                return false;
            }
            if !integer.is_empty() && !is_valid_digit_group(integer) {
                return false;
            }
            if !is_valid_digit_group(fraction) {
                return false;
            }
            !has_invalid_leading_zero(integer)
        }
        None => is_valid_digit_group(mantissa) && !has_invalid_leading_zero(mantissa),
    }
}

fn is_valid_digit_group(raw: &str) -> bool {
    if raw.is_empty() {
        return false;
    }

    let mut chars = raw.chars().peekable();
    let mut saw_digit = false;
    while let Some(ch) = chars.next() {
        match ch {
            '0'..='9' => saw_digit = true,
            '_' => {
                if !saw_digit {
                    return false;
                }
                match chars.peek() {
                    Some('0'..='9') => {}
                    _ => return false,
                }
                saw_digit = false;
            }
            _ => return false,
        }
    }
    saw_digit
}

fn has_invalid_leading_zero(raw: &str) -> bool {
    raw.len() > 1 && raw.starts_with('0') && !raw.starts_with("0_")
}

fn is_valid_exponent_digits(raw: &str) -> bool {
    is_valid_digit_group(raw) && !has_invalid_leading_zero(raw)
}

#[cfg(test)]
mod tests {
    use super::parse_document_from_tokens;
    use crate::{TrimtickMetadata, Value};

    fn parse(input: &str) -> Result<Vec<crate::Binding>, crate::Diagnostic> {
        parse_document_from_tokens(input, 256, 1)
    }

    #[test]
    fn parses_simple_top_level_bindings_from_tokens() {
        let bindings = parse("name = \"Pat\"\nage = 49").expect("token parse");
        assert_eq!(bindings.len(), 2);
        assert_eq!(bindings[0].key, "name");
        assert!(matches!(bindings[0].value, Value::StringLiteral { .. }));
        assert_eq!(bindings[1].key, "age");
        assert!(matches!(bindings[1].value, Value::NumberLiteral { .. }));
    }

    #[test]
    fn parses_shorthand_header_key_from_tokens() {
        let bindings = parse("aeon:mode = \"strict\"").expect("token parse");
        assert_eq!(bindings[0].key, "aeon:mode");
    }

    #[test]
    fn rejects_malformed_bare_number_tokens() {
        let error = parse("a = 1-1\n").expect_err("expected invalid number");
        assert_eq!(error.code, "INVALID_NUMBER");
        assert_eq!(error.message, "Number literal `1-1` is not valid");
    }

    #[test]
    fn rejects_unsupported_complex_value_in_token_seam() {
        let bindings = parse("items = [1, 2]").expect("token parse");
        assert!(matches!(bindings[0].value, Value::ListNode { .. }));
    }

    #[test]
    fn parses_objects_tuples_and_references_from_tokens() {
        let bindings = parse("obj = { a = 1, pair = (2, 3) }\nref = ~obj.pair[1]\nptr = ~>$.obj.a")
            .expect("token parse");
        assert!(matches!(bindings[0].value, Value::ObjectNode { .. }));
        assert!(matches!(bindings[1].value, Value::CloneReference { .. }));
        assert!(matches!(bindings[2].value, Value::PointerReference { .. }));
    }

    #[test]
    fn parses_binding_attributes_from_tokens() {
        let bindings = parse("user@{ role = \"admin\"\n level = 5 } = 1").expect("token parse");
        assert!(bindings[0].attributes.contains_key("role"));
        assert!(bindings[0].attributes.contains_key("level"));
    }

    #[test]
    fn parses_node_literals_from_tokens() {
        let bindings =
            parse("content:node = <div(\n  <span@{id = \"text\"}:node(\"hello\")>,\n  <br()>\n)>")
                .expect("token parse");
        assert!(matches!(bindings[0].value, Value::NodeLiteral { .. }));
    }

    #[test]
    fn rejects_node_literals_without_trailing_right_angle_after_children() {
        let err = parse("content:node = <span(\"hello\")\n")
            .expect_err("missing closing angle should fail");
        assert_eq!(err.code, "SYNTAX_ERROR");
    }

    #[test]
    fn parses_empty_node_shorthand_after_node_head_datatype() {
        let bindings = parse("v:node = <glyph:node>\n").expect("token parse");
        match &bindings[0].value {
            Value::NodeLiteral {
                tag,
                datatype,
                children,
                ..
            } => {
                assert_eq!(tag, "glyph");
                assert_eq!(datatype.as_deref(), Some("node"));
                assert!(children.is_empty());
            }
            other => panic!("expected node literal, got {other:?}"),
        }
    }

    #[test]
    fn parses_empty_node_shorthand_after_node_head_attributes_and_datatype() {
        let bindings = parse("v:node = <glyph@{id=\"x\"}:node>\n").expect("token parse");
        match &bindings[0].value {
            Value::NodeLiteral {
                tag,
                datatype,
                children,
                attributes,
                ..
            } => {
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
        let err = parse("v:node = <tag:pair<int32,string>(\"x\")>\n")
            .expect_err("generic node head datatype should fail");
        assert_eq!(err.code, "SYNTAX_ERROR");
    }

    #[test]
    fn rejects_separator_inline_node_head_datatypes() {
        let err = parse("v:node = <tag:contact[x](\"x\")>\n")
            .expect_err("separator node head datatype should fail");
        assert_eq!(err.code, "SYNTAX_ERROR");
    }

    #[test]
    fn parses_multiline_separator_specs_and_generic_boundaries_from_tokens() {
        let bindings =
            parse("size:sep\n[\nx\n]\n= ^300x250\nitems:list\n<\nn\n>\n=\n[\n2,\n3\n]\n")
                .expect("token parse");
        assert_eq!(bindings.len(), 2);
        assert_eq!(bindings[0].datatype.as_deref(), Some("sep[x]"));
        assert_eq!(bindings[1].datatype.as_deref(), Some("list<n>"));
        assert!(matches!(bindings[1].value, Value::ListNode { .. }));
    }

    #[test]
    fn parses_escaped_backticks_from_tokens() {
        let bindings = parse("value = `\\``\nquoted = \"a\\\"b\"\n").expect("token parse");
        assert_eq!(
            bindings[0].value,
            Value::StringLiteral {
                value: String::from("`"),
                raw: String::from("\\`"),
                delimiter: '`',
                trimticks: None,
            }
        );
        assert_eq!(
            bindings[1].value,
            Value::StringLiteral {
                value: String::from("a\"b"),
                raw: String::from("a\\\"b"),
                delimiter: '"',
                trimticks: None,
            }
        );
    }

    #[test]
    fn decodes_standard_and_unicode_quoted_escapes() {
        let bindings = parse("\"a\\n\" = 1\nvalue = \"x\\u0041\"\ntag:node = <\"a\\u{41}\">\n")
            .expect("token parse");
        assert_eq!(bindings[0].key, "a\n");
        assert_eq!(
            bindings[1].value,
            Value::StringLiteral {
                value: String::from("xA"),
                raw: String::from("x\\u0041"),
                delimiter: '"',
                trimticks: None,
            }
        );
        match &bindings[2].value {
            Value::NodeLiteral { tag, .. } => assert_eq!(tag, "aA"),
            other => panic!("expected node literal, got {other:?}"),
        }
    }

    #[test]
    fn rejects_invalid_quoted_escapes() {
        for (source, message) in [
            ("value = \"x\\q\"\n", "Invalid escape sequence"),
            ("value = \"x\\u{110000}\"\n", "Invalid unicode escape"),
            ("tag:node = <\"a\\q\">\n", "Invalid escape sequence"),
        ] {
            let error = parse(source).expect_err("expected syntax error");
            assert_eq!(error.code, "SYNTAX_ERROR");
            assert_eq!(error.message, message);
        }
    }

    #[test]
    fn parses_trimticks_from_tokens() {
        let bindings = parse("note:trimtick = >`\n  one\n  two\n`\n").expect("token parse");
        assert_eq!(
            bindings[0].value,
            Value::StringLiteral {
                value: String::from("one\ntwo"),
                raw: String::from("\n  one\n  two\n"),
                delimiter: '`',
                trimticks: Some(TrimtickMetadata {
                    marker_width: 1,
                    raw_value: String::from("\n  one\n  two\n"),
                }),
            }
        );
    }

    #[test]
    fn parses_multiline_node_attributes_from_tokens() {
        let bindings = parse("s:node = <span\n  @\n  {class = \"line-4\"}\n  (\"world\")\n>\n")
            .expect("token parse");
        assert!(matches!(bindings[0].value, Value::NodeLiteral { .. }));
    }

    #[test]
    fn parses_multiline_binding_layout_from_tokens() {
        let bindings = parse("name\n:\nstring =\n\"playground\"\n").expect("token parse");
        assert_eq!(bindings.len(), 1);
        assert_eq!(bindings[0].datatype.as_deref(), Some("string"));
        assert!(matches!(bindings[0].value, Value::StringLiteral { .. }));
    }

    #[test]
    fn rejects_empty_quoted_reference_segments() {
        let object_key_error =
            parse("a = { \"\" = 1 }\nv = ~a.[\"\"]\n").expect_err("expected syntax error");
        assert_eq!(object_key_error.code, "SYNTAX_ERROR");
        assert_eq!(object_key_error.message, "Keys must not be empty");

        for source in ["a = 1\nv = ~a@[\"\"]\n", "a = 1\nv = ~a[\"\"]\n"] {
            let error = parse(source).expect_err("expected syntax error");
            assert_eq!(error.code, "SYNTAX_ERROR");
            assert!(
                error
                    .message
                    .contains("Empty quoted path segments are not valid")
            );
        }
    }

    #[test]
    fn reports_missing_equals_after_key_with_key_name() {
        let error = parse("a hello\n").expect_err("expected syntax error");
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
        let error = parse("a = hello\n").expect_err("expected syntax error");
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
        let bindings = parse("a\n@ \n{\nn\n:\nn \n=\n1\n}\n:\nn \n= \n2\n").expect("token parse");
        assert_eq!(bindings.len(), 1);
        assert_eq!(bindings[0].key, "a");
        assert_eq!(bindings[0].datatype.as_deref(), Some("n"));
        assert!(bindings[0].attributes.contains_key("n"));
        assert!(matches!(bindings[0].value, Value::NumberLiteral { .. }));
    }

    #[test]
    fn parses_root_quoted_member_reference_after_dollar_dot() {
        let bindings = parse("\"a.b\" = 1\nv = ~$. [\"a.b\"]\n").expect("token parse");
        assert!(matches!(bindings[1].value, Value::CloneReference { .. }));
    }

    #[test]
    fn rejects_root_bracket_reference_without_dot_after_dollar() {
        let error = parse("a = 1\nv = ~$[\"a\"]\n").expect_err("expected syntax error");
        assert_eq!(error.code, "SYNTAX_ERROR");
        assert_eq!(error.message, "Expected `.` after `$`");
    }

    #[test]
    fn rejects_deep_valid_nesting_with_structured_diagnostic() {
        let source = format!("v = {}0{}", "[".repeat(300), "]".repeat(300));
        let error =
            parse_document_from_tokens(&source, 256, 1).expect_err("expected nesting error");
        assert_eq!(error.code, "NESTING_DEPTH_EXCEEDED");
        assert!(error.message.contains("max_nesting_depth 256"));
    }

    #[test]
    fn rejects_empty_quoted_keys_in_binding_positions() {
        let error = parse("\"\" = 1\n").expect_err("expected syntax error");
        assert_eq!(error.code, "SYNTAX_ERROR");
        assert_eq!(error.message, "Keys must not be empty");
    }

    #[test]
    fn rejects_nested_attribute_heads_at_default_depth() {
        let error = parse("a@{b@{c=3}=2} = 1\n").expect_err("expected attribute depth error");
        assert_eq!(error.code, "ATTRIBUTE_DEPTH_EXCEEDED");
    }
}
