use crate::{Position, Span};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TokenKind {
    LeftBrace,
    RightBrace,
    LeftBracket,
    RightBracket,
    LeftParen,
    RightParen,
    LeftAngle,
    RightAngle,
    Equals,
    Colon,
    Comma,
    Dot,
    At,
    Tilde,
    TildeArrow,
    Caret,
    Hash,
    Dollar,
    Percent,
    Ampersand,
    Semicolon,
    String,
    Number,
    HexLiteral,
    RadixLiteral,
    EncodingLiteral,
    SeparatorLiteral,
    True,
    False,
    Yes,
    No,
    On,
    Off,
    Identifier,
    Symbol,
    LineComment,
    BlockComment,
    Newline,
    Eof,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommentChannel {
    Plain,
    Doc,
    Annotation,
    Hint,
    Reserved,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommentForm {
    Line,
    Block,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReservedCommentSubtype {
    Structure,
    Profile,
    Instructions,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CommentMetadata {
    pub channel: CommentChannel,
    pub form: CommentForm,
    pub subtype: Option<ReservedCommentSubtype>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Token {
    pub kind: TokenKind,
    pub text: String,
    pub span: Span,
    pub comment: Option<CommentMetadata>,
    pub quote: Option<char>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LexError {
    pub code: String,
    pub message: String,
    pub span: Span,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct LexerOptions {
    pub include_comments: bool,
    pub include_newlines: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LexResult {
    pub tokens: Vec<Token>,
    pub errors: Vec<LexError>,
}

pub fn tokenize(input: &str, options: LexerOptions) -> LexResult {
    Lexer::new(input, options).tokenize()
}

struct Lexer<'a> {
    input: &'a str,
    options: LexerOptions,
    offset: usize,
    line: usize,
    column: usize,
    tokens: Vec<Token>,
    errors: Vec<LexError>,
}

impl<'a> Lexer<'a> {
    fn new(input: &'a str, options: LexerOptions) -> Self {
        Self {
            input,
            options,
            offset: 0,
            line: 1,
            column: 1,
            tokens: Vec::new(),
            errors: Vec::new(),
        }
    }

    fn tokenize(mut self) -> LexResult {
        while !self.is_at_end() {
            self.scan_token();
        }
        let pos = self.current_position();
        self.tokens.push(Token {
            kind: TokenKind::Eof,
            text: String::new(),
            span: Span { start: pos, end: pos },
            comment: None,
            quote: None,
        });
        LexResult {
            tokens: self.tokens,
            errors: self.errors,
        }
    }

    fn scan_token(&mut self) {
        let start = self.current_position();
        let ch = self.advance();
        match ch {
            ' ' | '\t' => {}
            '\n' => {
                if self.options.include_newlines {
                    self.push_token(TokenKind::Newline, "\n", start, None, None);
                }
            }
            '\r' => {
                if self.match_char('\n') {
                    if self.options.include_newlines {
                        self.push_token(TokenKind::Newline, "\r\n", start, None, None);
                    }
                } else if self.options.include_newlines {
                    self.push_token(TokenKind::Newline, "\r", start, None, None);
                }
            }
            '{' => self.push_token(TokenKind::LeftBrace, "{", start, None, None),
            '}' => self.push_token(TokenKind::RightBrace, "}", start, None, None),
            '[' => self.push_token(TokenKind::LeftBracket, "[", start, None, None),
            ']' => self.push_token(TokenKind::RightBracket, "]", start, None, None),
            '(' => self.push_token(TokenKind::LeftParen, "(", start, None, None),
            ')' => self.push_token(TokenKind::RightParen, ")", start, None, None),
            '<' => self.push_token(TokenKind::LeftAngle, "<", start, None, None),
            '>' => self.push_token(TokenKind::RightAngle, ">", start, None, None),
            '=' => self.push_token(TokenKind::Equals, "=", start, None, None),
            ':' => self.push_token(TokenKind::Colon, ":", start, None, None),
            ',' => self.push_token(TokenKind::Comma, ",", start, None, None),
            '.' => {
                if self.peek().is_ascii_digit() {
                    self.scan_number(start, '.');
                } else {
                    self.push_token(TokenKind::Dot, ".", start, None, None);
                }
            }
            '@' => self.push_token(TokenKind::At, "@", start, None, None),
            '&' => self.push_token(TokenKind::Ampersand, "&", start, None, None),
            ';' => self.push_token(TokenKind::Semicolon, ";", start, None, None),
            '~' => {
                if self.match_char('>') {
                    self.push_token(TokenKind::TildeArrow, "~>", start, None, None);
                } else {
                    self.push_token(TokenKind::Tilde, "~", start, None, None);
                }
            }
            '^' => self.scan_separator_literal(start),
            '#' => {
                if self.peek().is_ascii_hexdigit() {
                    self.scan_hex_literal(start);
                } else {
                    self.push_token(TokenKind::Hash, "#", start, None, None);
                }
            }
            '$' => {
                if self.peek() == '.' || self.peek() == '[' {
                    self.push_token(TokenKind::Dollar, "$", start, None, None);
                } else if is_encoding_start_char(self.peek()) {
                    self.scan_prefixed_literal(start, TokenKind::EncodingLiteral, is_encoding_char, is_valid_encoding_payload);
                } else {
                    self.push_token(TokenKind::Dollar, "$", start, None, None);
                }
            }
            '%' => {
                if is_radix_start_char(self.peek()) {
                    self.scan_prefixed_literal(start, TokenKind::RadixLiteral, is_radix_char, is_valid_radix_payload);
                } else {
                    self.push_token(TokenKind::Percent, "%", start, None, None);
                }
            }
            '/' => self.scan_slash_channel_or_symbol(start),
            '"' | '\'' | '`' => self.scan_string(start, ch),
            '+' | '-' => {
                if self.peek().is_ascii_digit() || self.peek() == '.' {
                    self.scan_number(start, ch);
                } else {
                    let text = self.slice_from(start.offset);
                    self.push_token(TokenKind::Symbol, &text, start, None, None);
                }
            }
            _ if ch.is_ascii_digit() => self.scan_number(start, ch),
            _ if is_identifier_start(ch) => self.scan_identifier(start),
            _ if is_printable_ascii(ch) => {
                let text = self.slice_from(start.offset);
                self.push_token(TokenKind::Symbol, &text, start, None, None);
            }
            _ => self.errors.push(LexError {
                code: String::from("UNEXPECTED_CHARACTER"),
                message: format!("Unexpected character `{ch}`"),
                span: Span {
                    start,
                    end: self.current_position(),
                },
            }),
        }
    }

    fn scan_identifier(&mut self, start: Position) {
        while is_identifier_continue(self.peek()) {
            self.advance();
        }
        let text = self.slice_from(start.offset);
        let kind = match text.as_str() {
            "true" => TokenKind::True,
            "false" => TokenKind::False,
            "yes" => TokenKind::Yes,
            "no" => TokenKind::No,
            "on" => TokenKind::On,
            "off" => TokenKind::Off,
            _ => TokenKind::Identifier,
        };
        self.push_token(kind, &text, start, None, None);
    }

    fn scan_number(&mut self, start: Position, first: char) {
        if first != '.' && first != '+' && first != '-' {
            while self.peek().is_ascii_digit() || self.peek() == '_' {
                self.advance();
            }

            if matches!(self.peek(), '-' | ':') {
                self.scan_temporal_tail();
                let text = self.slice_from(start.offset);
                self.push_token(TokenKind::Number, &text, start, None, None);
                return;
            }
        } else if self.peek().is_ascii_digit() {
            while self.peek().is_ascii_digit() || self.peek() == '_' {
                self.advance();
            }
        }

        if self.peek() == '.' && self.peek_next().is_ascii_digit() {
            self.advance();
            while self.peek().is_ascii_digit() || self.peek() == '_' {
                self.advance();
            }
        }

        if matches!(self.peek(), 'e' | 'E') {
            let checkpoint = self.offset;
            self.advance();
            if matches!(self.peek(), '+' | '-') {
                self.advance();
            }
            if self.peek().is_ascii_digit() {
                while self.peek().is_ascii_digit() || self.peek() == '_' {
                    self.advance();
                }
            } else {
                self.offset = checkpoint;
                self.column = self.recompute_column(self.offset);
            }
        }

        let text = self.slice_from(start.offset);
        self.push_token(TokenKind::Number, &text, start, None, None);
    }

    fn scan_temporal_tail(&mut self) {
        while !self.is_at_end() {
            match self.peek() {
                ' ' | '\t' | '\n' | '\r' | ',' | ']' | ')' | '}' => break,
                _ => {
                    self.advance();
                }
            }
        }
    }

    fn scan_string(&mut self, start: Position, quote: char) {
        while !self.is_at_end() {
            let ch = self.peek();
            if ch == quote {
                self.advance();
                let text = self.slice_from(start.offset);
                self.push_token(TokenKind::String, &text, start, None, Some(quote));
                return;
            }
            if ch == '\\' {
                self.advance();
                if !self.is_at_end() {
                    self.advance();
                }
                continue;
            }
            self.advance();
        }
        self.errors.push(LexError {
            code: String::from("UNTERMINATED_STRING"),
            message: format!("Unterminated string literal (started with {quote})"),
            span: Span {
                start,
                end: self.current_position(),
            },
        });
    }

    fn scan_separator_literal(&mut self, start: Position) {
        let mut saw_payload_char = false;
        while !self.is_at_end() {
            match self.peek() {
                '\n' | '\r' | ',' | ']' | ')' | '}' => break,
                ' ' if !saw_payload_char => {
                    self.errors.push(LexError {
                        code: String::from("SYNTAX_ERROR"),
                        message: String::from(
                            "Separator literals must not begin with an unescaped space",
                        ),
                        span: Span {
                            start,
                            end: self.current_position(),
                        },
                    });
                    return;
                }
                '\\'
                    if matches!(self.peek_next(), '\\' | ',' | ' ') =>
                {
                    self.advance();
                    self.advance();
                    saw_payload_char = true;
                }
                '\\' => {
                    saw_payload_char = true;
                    self.advance();
                }
                _ => {
                    if self.peek() != ' ' {
                        saw_payload_char = true;
                    }
                    self.advance();
                }
            }
        }
        let text = self.slice_from(start.offset);
        if text == "^" {
            self.errors.push(LexError {
                code: String::from("SYNTAX_ERROR"),
                message: String::from("Separator literals must contain a payload"),
                span: Span {
                    start,
                    end: self.current_position(),
                },
            });
            return;
        }
        if !is_valid_separator_payload(&text[1..]) {
            self.errors.push(LexError {
                code: String::from("SYNTAX_ERROR"),
                message: format!("Invalid separator literal `{text}`"),
                span: Span {
                    start,
                    end: self.current_position(),
                },
            });
            return;
        }
        self.push_token(TokenKind::SeparatorLiteral, &text, start, None, None);
    }

    fn scan_hex_literal(&mut self, start: Position) {
        while self.peek().is_ascii_hexdigit() || self.peek() == '_' {
            self.advance();
        }
        let text = self.slice_from(start.offset);
        if text.len() == 1 || text.ends_with('_') {
            self.errors.push(LexError {
                code: String::from("SYNTAX_ERROR"),
                message: format!("Invalid hex literal `{text}`"),
                span: Span {
                    start,
                    end: self.current_position(),
                },
            });
            return;
        }
        self.push_token(TokenKind::HexLiteral, &text, start, None, None);
    }

    fn scan_prefixed_literal(
        &mut self,
        start: Position,
        kind: TokenKind,
        predicate: fn(char) -> bool,
        validator: fn(&str) -> bool,
    ) {
        while predicate(self.peek()) {
            self.advance();
        }
        let text = self.slice_from(start.offset);
        if !validator(&text[1..]) {
            self.errors.push(LexError {
                code: String::from("SYNTAX_ERROR"),
                message: format!(
                    "Invalid {} `{text}`",
                    match kind {
                        TokenKind::RadixLiteral => "radix literal",
                        TokenKind::EncodingLiteral => "encoding literal",
                        _ => "prefixed literal",
                    }
                ),
                span: Span {
                    start,
                    end: self.current_position(),
                },
            });
            return;
        }
        self.push_token(kind, &text, start, None, None);
    }

    fn scan_slash_channel_or_symbol(&mut self, start: Position) {
        match self.peek() {
            '/' => {
                self.advance();
                while !self.is_at_end() && !matches!(self.peek(), '\n' | '\r') {
                    self.advance();
                }
                let text = self.slice_from(start.offset);
                self.maybe_push_comment(
                    TokenKind::LineComment,
                    &text,
                    start,
                    CommentMetadata {
                        channel: CommentChannel::Plain,
                        form: CommentForm::Line,
                        subtype: None,
                    },
                );
            }
            '#' | '@' | '?' | '{' | '[' | '(' | '*' => {
                let marker = self.advance();
                let closing = slash_channel_closing_marker(marker);
                while !self.is_at_end() {
                    if self.peek() == closing && self.peek_next() == '/' {
                        self.advance();
                        self.advance();
                        let text = self.slice_from(start.offset);
                        self.maybe_push_comment(
                            TokenKind::BlockComment,
                            &text,
                            start,
                            comment_metadata_for_marker(marker),
                        );
                        return;
                    }
                    self.advance();
                }
                self.errors.push(LexError {
                    code: String::from("UNTERMINATED_BLOCK_COMMENT"),
                    message: String::from("Unterminated block comment"),
                    span: Span {
                        start,
                        end: self.current_position(),
                    },
                });
            }
            _ => self.push_token(TokenKind::Symbol, "/", start, None, None),
        }
    }

    fn maybe_push_comment(
        &mut self,
        kind: TokenKind,
        text: &str,
        start: Position,
        comment: CommentMetadata,
    ) {
        if self.options.include_comments {
            self.push_token(kind, text, start, Some(comment), None);
        }
    }

    fn push_token(
        &mut self,
        kind: TokenKind,
        text: &str,
        start: Position,
        comment: Option<CommentMetadata>,
        quote: Option<char>,
    ) {
        self.tokens.push(Token {
            kind,
            text: text.to_owned(),
            span: Span {
                start,
                end: self.current_position(),
            },
            comment,
            quote,
        });
    }

    fn is_at_end(&self) -> bool {
        self.offset >= self.input.len()
    }

    fn current_position(&self) -> Position {
        Position {
            line: self.line,
            column: self.column,
            offset: self.offset,
        }
    }

    fn peek(&self) -> char {
        self.input[self.offset..].chars().next().unwrap_or('\0')
    }

    fn peek_next(&self) -> char {
        let mut chars = self.input[self.offset..].chars();
        let _ = chars.next();
        chars.next().unwrap_or('\0')
    }

    fn advance(&mut self) -> char {
        let ch = self.peek();
        if ch == '\0' {
            return ch;
        }
        self.offset += ch.len_utf8();
        if ch == '\n' {
            self.line += 1;
            self.column = 1;
        } else {
            self.column += 1;
        }
        ch
    }

    fn match_char(&mut self, expected: char) -> bool {
        if self.peek() != expected {
            return false;
        }
        self.advance();
        true
    }

    fn slice_from(&self, start_offset: usize) -> String {
        self.input[start_offset..self.offset].to_owned()
    }

    fn recompute_column(&self, offset: usize) -> usize {
        let mut column = 1usize;
        for ch in self.input[..offset].chars().rev() {
            if ch == '\n' {
                break;
            }
            column += 1;
        }
        column
    }
}

fn is_identifier_start(ch: char) -> bool {
    ch.is_ascii_alphabetic() || ch == '_'
}

fn is_identifier_continue(ch: char) -> bool {
    ch.is_ascii_alphanumeric() || ch == '_'
}

fn is_encoding_char(ch: char) -> bool {
    ch.is_ascii_alphanumeric() || matches!(ch, '+' | '/' | '=' | '-' | '_')
}

fn is_encoding_start_char(ch: char) -> bool {
    ch != '=' && is_encoding_char(ch)
}

fn is_radix_char(ch: char) -> bool {
    ch.is_ascii_alphanumeric() || matches!(ch, '+' | '-' | '.' | '_' | '&' | '!')
}

fn is_radix_start_char(ch: char) -> bool {
    matches!(ch, '+' | '-' | '&' | '!') || ch.is_ascii_alphanumeric()
}

fn is_radix_digit(ch: char) -> bool {
    ch.is_ascii_alphanumeric() || matches!(ch, '&' | '!')
}

fn is_valid_radix_payload(payload: &str) -> bool {
    if payload.is_empty() {
        return false;
    }
    let chars: Vec<char> = payload.chars().collect();
    let mut index = if matches!(chars.first(), Some('+' | '-')) { 1 } else { 0 };
    if index >= chars.len() {
        return false;
    }
    let mut saw_digit = false;
    let mut saw_decimal = false;
    let mut prev_was_digit = false;
    while index < chars.len() {
        let ch = chars[index];
        if is_radix_digit(ch) {
            saw_digit = true;
            prev_was_digit = true;
        } else if ch == '_' {
            if !prev_was_digit || index + 1 >= chars.len() || !is_radix_digit(chars[index + 1]) {
                return false;
            }
            prev_was_digit = false;
        } else if ch == '.' {
            if saw_decimal || !prev_was_digit || index + 1 >= chars.len() || !is_radix_digit(chars[index + 1]) {
                return false;
            }
            saw_decimal = true;
            prev_was_digit = false;
        } else {
            return false;
        }
        index += 1;
    }
    saw_digit && prev_was_digit
}

fn is_valid_encoding_payload(payload: &str) -> bool {
    if payload.is_empty() {
        return false;
    }
    if !payload
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '+' | '/' | '=' | '-' | '_'))
    {
        return false;
    }
    match payload.find('=') {
        None => true,
        Some(index) => payload[index..].chars().all(|ch| ch == '='),
    }
}

fn is_printable_ascii(ch: char) -> bool {
    matches!(ch as u32, 0x21..=0x7e)
}

fn slash_channel_closing_marker(marker: char) -> char {
    match marker {
        '{' => '}',
        '[' => ']',
        '(' => ')',
        _ => marker,
    }
}

fn comment_metadata_for_marker(marker: char) -> CommentMetadata {
    match marker {
        '#' => CommentMetadata {
            channel: CommentChannel::Doc,
            form: CommentForm::Block,
            subtype: None,
        },
        '@' => CommentMetadata {
            channel: CommentChannel::Annotation,
            form: CommentForm::Block,
            subtype: None,
        },
        '?' => CommentMetadata {
            channel: CommentChannel::Hint,
            form: CommentForm::Block,
            subtype: None,
        },
        '{' | '[' | '(' => CommentMetadata {
            channel: CommentChannel::Reserved,
            form: CommentForm::Block,
            subtype: Some(match marker {
                '{' => ReservedCommentSubtype::Structure,
                '[' => ReservedCommentSubtype::Profile,
                _ => ReservedCommentSubtype::Instructions,
            }),
        },
        _ => CommentMetadata {
            channel: CommentChannel::Plain,
            form: CommentForm::Block,
            subtype: None,
        },
    }
}

fn is_valid_separator_payload(payload: &str) -> bool {
    !payload.chars().any(|ch| matches!(ch, '[' | ']' | '{' | '}' | '(' | ')'))
}

#[cfg(test)]
mod tests {
    use super::{tokenize, CommentChannel, LexerOptions, TokenKind};

    #[test]
    fn tokenizes_basic_binding() {
        let result = tokenize("name = \"Pat\"", LexerOptions::default());
        let kinds = result.tokens.iter().map(|token| token.kind).collect::<Vec<_>>();
        assert_eq!(
            kinds,
            vec![TokenKind::Identifier, TokenKind::Equals, TokenKind::String, TokenKind::Eof]
        );
        assert!(result.errors.is_empty());
    }

    #[test]
    fn includes_newlines_when_requested() {
        let result = tokenize("a = 1\nb = 2", LexerOptions {
            include_newlines: true,
            ..LexerOptions::default()
        });
        assert!(result.tokens.iter().any(|token| token.kind == TokenKind::Newline));
    }

    #[test]
    fn includes_comments_with_metadata_when_requested() {
        let result = tokenize("/# doc#/", LexerOptions {
            include_comments: true,
            ..LexerOptions::default()
        });
        assert_eq!(result.tokens[0].kind, TokenKind::BlockComment);
        assert_eq!(
            result.tokens[0].comment.expect("comment metadata").channel,
            CommentChannel::Doc
        );
    }

    #[test]
    fn tracks_spans_incrementally() {
        let result = tokenize("a = 1\nb = 2", LexerOptions {
            include_newlines: true,
            ..LexerOptions::default()
        });
        let token = result
            .tokens
            .iter()
            .find(|token| token.text == "b")
            .expect("binding key token");
        assert_eq!(token.span.start.line, 2);
        assert_eq!(token.span.start.column, 1);
    }

    #[test]
    fn reports_unterminated_block_comment() {
        let result = tokenize("/@ missing", LexerOptions::default());
        assert_eq!(result.errors.len(), 1);
        assert_eq!(result.errors[0].code, "UNTERMINATED_BLOCK_COMMENT");
    }

    #[test]
    fn tokenizes_escaped_backticks_inside_backtick_strings() {
        let result = tokenize("value = `\\``", LexerOptions::default());
        assert!(result.errors.is_empty());
        let token = result
            .tokens
            .iter()
            .find(|token| token.kind == TokenKind::String)
            .expect("string token");
        assert_eq!(token.text, "`\\``");
        assert_eq!(token.quote, Some('`'));
    }

    #[test]
    fn tokenizes_hex_literals_with_underscores() {
        let result = tokenize("hex = #00_00_00", LexerOptions::default());
        assert!(result.errors.is_empty());
        let token = result
            .tokens
            .iter()
            .find(|token| token.kind == TokenKind::HexLiteral)
            .expect("hex token");
        assert_eq!(token.text, "#00_00_00");
    }

    #[test]
    fn tokenizes_radix_literals_with_sign_decimal_and_extended_digits() {
        let result = tokenize("value = %+9&.!", LexerOptions::default());
        assert!(result.errors.is_empty());
        let token = result
            .tokens
            .iter()
            .find(|token| token.kind == TokenKind::RadixLiteral)
            .expect("radix token");
        assert_eq!(token.text, "%+9&.!");
    }

    #[test]
    fn radix_literals_terminate_at_non_radix_boundary_characters() {
        for source in ["value = %1/2", "value = %1=2"] {
            let result = tokenize(source, LexerOptions::default());
            assert!(result.errors.is_empty(), "{source}");
            let token = result
                .tokens
                .iter()
                .find(|token| token.kind == TokenKind::RadixLiteral)
                .expect("radix token");
            assert_eq!(token.text, "%1", "{source}");
        }
    }

    #[test]
    fn rejects_invalid_radix_underscore_and_decimal_placement() {
        for source in ["value = %1_", "value = %1__1", "value = %1."] {
            let result = tokenize(source, LexerOptions::default());
            assert_eq!(result.errors.len(), 1, "{source}");
        }
    }

    #[test]
    fn invalid_radix_starts_fall_back_to_plain_tokens() {
        for source in ["value = %_1", "value = %.1"] {
            let result = tokenize(source, LexerOptions::default());
            assert!(result.errors.is_empty(), "{source}");
            assert_eq!(result.tokens[2].kind, TokenKind::Percent, "{source}");
        }
    }

    #[test]
    fn tokenizes_standard_and_urlsafe_encoding_literals() {
        let result = tokenize("value = $abc-_+/==", LexerOptions::default());
        assert!(result.errors.is_empty());
        let token = result
            .tokens
            .iter()
            .find(|token| token.kind == TokenKind::EncodingLiteral)
            .expect("encoding token");
        assert_eq!(token.text, "$abc-_+/==");
    }

    #[test]
    fn encoding_literals_terminate_at_non_encoding_boundary_characters() {
        let result = tokenize("value = $abc.", LexerOptions::default());
        assert!(result.errors.is_empty());
        let token = result
            .tokens
            .iter()
            .find(|token| token.kind == TokenKind::EncodingLiteral)
            .expect("encoding token");
        assert_eq!(token.text, "$abc");
    }

    #[test]
    fn rejects_invalid_encoding_start_and_padding_placement() {
        let bad_padding = tokenize("value = $abc=a=", LexerOptions::default());
        assert_eq!(bad_padding.errors.len(), 1);

        let bad_start = tokenize("value = $=abc", LexerOptions::default());
        assert!(bad_start.errors.is_empty());
        assert_eq!(bad_start.tokens[2].kind, TokenKind::Dollar);
    }

    #[test]
    fn separator_literals_allow_comment_like_text() {
        let result = tokenize("^http://www.aeonite.org/*hello*/file.aeon", LexerOptions::default());
        assert!(result.errors.is_empty());
        let token = result
            .tokens
            .iter()
            .find(|token| token.kind == TokenKind::SeparatorLiteral)
            .expect("separator token");
        assert_eq!(token.text, "^http://www.aeonite.org/*hello*/file.aeon");
    }

    #[test]
    fn separator_literals_reject_bracket_brace_and_paren_chars() {
        for source in [
            "^http://www.aeonite.org/[...]/",
            "^http://www.aeonite.org/{...}/",
            "^http://www.aeonite.org/(...)/",
            "^http://www.aeonite.org//[hello",
        ] {
            let result = tokenize(source, LexerOptions::default());
            assert_eq!(result.errors.len(), 1, "{source}");
        }
    }
}
