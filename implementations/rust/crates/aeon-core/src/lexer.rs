use std::borrow::Cow;

use crate::temporal::invalid_temporal_literal;
use crate::{CompileOptions, Position, Span};

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
    StructuralIdentity,
    SansaAddressLiteral,
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
    let mut lexer = LexerSession::one_shot(options);
    let mut result = lexer.push(Cow::Borrowed(input));
    let final_result = lexer.finish();
    result.tokens.extend(final_result.tokens);
    result.errors.extend(final_result.errors);
    result
}

const MAX_LEX_ERRORS: usize = 256;

#[derive(Debug, Clone, Copy)]
struct QuotedStringState {
    start: Position,
    quote: char,
    escaped: bool,
}

#[derive(Debug, Clone, Copy)]
enum CommentState {
    Line {
        start: Position,
        metadata: CommentMetadata,
    },
    Block {
        start: Position,
        closing: char,
        metadata: CommentMetadata,
        saw_closing: bool,
    },
}

#[derive(Debug, Clone, Copy)]
enum NumberPhase {
    Integer { temporal_eligible: bool },
    AfterInteger,
    FractionDigits,
    ExponentSign,
    ExponentDigitsRequired,
    ExponentDigits,
    InvalidExponent,
    Temporal,
}

#[derive(Debug, Clone, Copy)]
struct NumberState {
    start: Position,
    phase: NumberPhase,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PrefixedLiteralKind {
    Hex,
    Radix,
    Encoding,
}

#[derive(Debug, Clone, Copy)]
struct PrefixedLiteralState {
    start: Position,
    kind: PrefixedLiteralKind,
}

#[derive(Debug, Clone, Copy)]
struct SeparatorLiteralState {
    start: Position,
    quote: Option<char>,
    escaped: bool,
}

#[derive(Debug, Clone, Copy)]
struct IdentifierState {
    start: Position,
}

#[derive(Debug, Clone, Copy)]
struct StructuralIdentityState {
    start: Position,
    search_offset: usize,
}

#[derive(Debug, Clone)]
struct SansaAddressState {
    start: Position,
    stack: Vec<char>,
    in_quote: bool,
    escaped: bool,
}

#[derive(Debug, Clone, Copy)]
struct ShebangState;

#[derive(Debug, Clone, Copy)]
struct CarriageReturnState {
    start: Position,
}

#[derive(Debug, Clone, Copy)]
struct LexerCheckpoint {
    offset: usize,
    line: usize,
    column: usize,
    tokens_len: usize,
    errors_len: usize,
    error_count: usize,
    previous_token_kind: Option<TokenKind>,
}

pub(crate) struct LexerSession<'a> {
    input: Cow<'a, str>,
    buffer_start_offset: usize,
    compact_input: bool,
    max_retained_token_bytes: Option<usize>,
    options: LexerOptions,
    offset: usize,
    line: usize,
    column: usize,
    tokens: Vec<Token>,
    errors: Vec<LexError>,
    previous_token_kind: Option<TokenKind>,
    error_count: usize,
    aborted: bool,
    quoted_string: Option<QuotedStringState>,
    comment: Option<CommentState>,
    number: Option<NumberState>,
    prefixed_literal: Option<PrefixedLiteralState>,
    separator_literal: Option<SeparatorLiteralState>,
    identifier: Option<IdentifierState>,
    structural_identity: Option<StructuralIdentityState>,
    sansa_address: Option<SansaAddressState>,
    shebang: Option<ShebangState>,
    carriage_return: Option<CarriageReturnState>,
    saw_leading_bom: bool,
    finished: bool,
}

impl<'a> LexerSession<'a> {
    pub(crate) fn new(options: LexerOptions) -> Self {
        Self::with_compaction(options, true, None)
    }

    #[allow(dead_code)]
    pub(crate) fn with_retained_token_limit(
        options: LexerOptions,
        max_retained_token_bytes: usize,
    ) -> Self {
        Self::with_compaction(options, true, Some(max_retained_token_bytes))
    }

    pub(crate) fn with_compile_limits(
        options: LexerOptions,
        compile_options: &CompileOptions,
    ) -> Self {
        Self::with_retained_token_limit(options, retained_token_byte_limit(compile_options))
    }

    fn one_shot(options: LexerOptions) -> Self {
        let mut lexer = Self::new(options);
        lexer.compact_input = false;
        lexer
    }

    fn with_compaction(
        options: LexerOptions,
        compact_input: bool,
        max_retained_token_bytes: Option<usize>,
    ) -> Self {
        Self {
            input: Cow::Owned(String::new()),
            buffer_start_offset: 0,
            compact_input,
            max_retained_token_bytes,
            options,
            offset: 0,
            line: 1,
            column: 1,
            tokens: Vec::new(),
            errors: Vec::new(),
            previous_token_kind: None,
            error_count: 0,
            aborted: false,
            quoted_string: None,
            comment: None,
            number: None,
            prefixed_literal: None,
            separator_literal: None,
            identifier: None,
            structural_identity: None,
            sansa_address: None,
            shebang: None,
            carriage_return: None,
            saw_leading_bom: false,
            finished: false,
        }
    }

    pub(crate) fn push(&mut self, chunk: Cow<'a, str>) -> LexResult {
        assert!(!self.finished, "cannot push input after lexer finish");
        if let Some(limit) = self.max_retained_token_bytes {
            return self.push_bounded(chunk.as_ref(), limit);
        }
        self.push_piece(chunk)
    }

    fn push_bounded(&mut self, mut chunk: &str, limit: usize) -> LexResult {
        let mut result = LexResult {
            tokens: Vec::new(),
            errors: Vec::new(),
        };
        while !chunk.is_empty() && !self.aborted {
            let retained = self.input.len();
            let allowance = limit.saturating_add(1).saturating_sub(retained);
            let end = bounded_char_boundary(chunk, allowance);
            let (piece, remainder) = chunk.split_at(end);
            let batch = self.push_piece(Cow::Owned(piece.to_owned()));
            result.tokens.extend(batch.tokens);
            result.errors.extend(batch.errors);
            if self.input.len() > limit {
                let start = self
                    .active_token_start_position()
                    .unwrap_or_else(|| self.current_position());
                let observed = self.input.len();
                result.errors.push(LexError {
                    code: String::from("INCREMENTAL_TOKEN_RETENTION_EXCEEDED"),
                    message: format!(
                        "Incremental token retained {observed} bytes, exceeding configured limit of {limit} bytes"
                    ),
                    span: Span {
                        start,
                        end: self.current_position(),
                    },
                });
                self.abort_and_release_retained_input();
                break;
            }
            chunk = remainder;
        }
        result
    }

    fn push_piece(&mut self, chunk: Cow<'a, str>) -> LexResult {
        if self.input.is_empty() && self.offset == 0 {
            self.input = chunk;
        } else {
            self.input.to_mut().push_str(&chunk);
        }
        self.scan_available(false);
        self.compact_input_buffer();
        self.take_result()
    }

    fn abort_and_release_retained_input(&mut self) {
        self.aborted = true;
        self.quoted_string = None;
        self.comment = None;
        self.number = None;
        self.prefixed_literal = None;
        self.separator_literal = None;
        self.identifier = None;
        self.structural_identity = None;
        self.sansa_address = None;
        self.shebang = None;
        self.carriage_return = None;
        self.offset = self.input.len();
        self.compact_input_buffer();
    }

    pub(crate) fn finish(&mut self) -> LexResult {
        assert!(!self.finished, "cannot finish lexer more than once");
        self.scan_available(true);
        if self.quoted_string.is_some() {
            self.finish_quoted_string();
        }
        if self.comment.is_some() {
            self.finish_comment();
        }
        let pos = self.current_position();
        self.tokens.push(Token {
            kind: TokenKind::Eof,
            text: String::new(),
            span: Span {
                start: pos,
                end: pos,
            },
            comment: None,
            quote: None,
        });
        self.finished = true;
        self.compact_input_buffer();
        self.take_result()
    }

    fn take_result(&mut self) -> LexResult {
        LexResult {
            tokens: std::mem::take(&mut self.tokens),
            errors: std::mem::take(&mut self.errors),
        }
    }

    fn scan_available(&mut self, final_input: bool) {
        if self.aborted {
            self.offset = self.input.len();
            return;
        }

        loop {
            if self.quoted_string.is_some() {
                if !self.scan_quoted_string() {
                    if final_input {
                        self.finish_quoted_string();
                    }
                    return;
                }
                continue;
            }

            if self.comment.is_some() {
                if !self.scan_comment() {
                    if final_input {
                        self.finish_comment();
                    }
                    return;
                }
                continue;
            }
            if self.number.is_some() {
                if !self.scan_number(final_input) {
                    return;
                }
                continue;
            }
            if self.prefixed_literal.is_some() {
                if !self.scan_prefixed_literal(final_input) {
                    return;
                }
                continue;
            }
            if self.separator_literal.is_some() {
                if !self.scan_separator_literal(final_input) {
                    return;
                }
                continue;
            }
            if self.identifier.is_some() {
                if !self.scan_identifier(final_input) {
                    return;
                }
                continue;
            }
            if self.structural_identity.is_some() {
                if !self.scan_structural_identity(final_input) {
                    return;
                }
                continue;
            }
            if self.sansa_address.is_some() {
                if !self.scan_sansa_address(final_input) {
                    return;
                }
                continue;
            }
            if self.shebang.is_some() {
                if !self.scan_shebang(final_input) {
                    return;
                }
                continue;
            }
            if self.carriage_return.is_some() {
                if !self.scan_carriage_return(final_input) {
                    return;
                }
                continue;
            }

            if self.is_at_end() {
                return;
            }

            let checkpoint = self.checkpoint();
            let stable_at_boundary = self.scan_token();
            if self.aborted {
                return;
            }
            if self.quoted_string.is_some() {
                if final_input {
                    self.finish_quoted_string();
                }
                return;
            }
            if self.comment.is_some() {
                if final_input {
                    self.finish_comment();
                }
                return;
            }
            if self.number.is_some() {
                if final_input && self.scan_number(true) {
                    continue;
                }
                return;
            }
            if self.prefixed_literal.is_some() {
                if final_input && self.scan_prefixed_literal(true) {
                    continue;
                }
                return;
            }
            if self.separator_literal.is_some() {
                if final_input && self.scan_separator_literal(true) {
                    continue;
                }
                return;
            }
            if self.identifier.is_some() {
                if final_input && self.scan_identifier(true) {
                    continue;
                }
                return;
            }
            if self.structural_identity.is_some() {
                if final_input && self.scan_structural_identity(true) {
                    continue;
                }
                return;
            }
            if self.sansa_address.is_some() {
                if final_input && self.scan_sansa_address(true) {
                    continue;
                }
                return;
            }
            if self.shebang.is_some() {
                if final_input && self.scan_shebang(true) {
                    continue;
                }
                return;
            }
            if self.carriage_return.is_some() {
                if final_input && self.scan_carriage_return(true) {
                    continue;
                }
                return;
            }

            if !final_input && self.is_at_end() && !stable_at_boundary {
                self.restore(checkpoint);
                return;
            }
        }
    }

    fn checkpoint(&self) -> LexerCheckpoint {
        LexerCheckpoint {
            offset: self.offset,
            line: self.line,
            column: self.column,
            tokens_len: self.tokens.len(),
            errors_len: self.errors.len(),
            error_count: self.error_count,
            previous_token_kind: self.previous_token_kind,
        }
    }

    fn restore(&mut self, checkpoint: LexerCheckpoint) {
        self.offset = checkpoint.offset;
        self.line = checkpoint.line;
        self.column = checkpoint.column;
        self.tokens.truncate(checkpoint.tokens_len);
        self.errors.truncate(checkpoint.errors_len);
        self.error_count = checkpoint.error_count;
        self.previous_token_kind = checkpoint.previous_token_kind;
    }

    fn scan_quoted_string(&mut self) -> bool {
        let mut state = self
            .quoted_string
            .expect("quoted string scanner requires active state");
        while !self.is_at_end() {
            let ch = self.advance();
            if state.escaped {
                state.escaped = false;
                continue;
            }
            if ch == '\\' {
                state.escaped = true;
                continue;
            }
            if ch == state.quote {
                let text = self.slice_from(state.start.offset);
                self.push_token(
                    TokenKind::String,
                    &text,
                    state.start,
                    None,
                    Some(state.quote),
                );
                self.quoted_string = None;
                return true;
            }
        }
        self.quoted_string = Some(state);
        false
    }

    fn finish_quoted_string(&mut self) {
        let state = self
            .quoted_string
            .take()
            .expect("quoted string finish requires active state");
        self.push_error(LexError {
            code: String::from("UNTERMINATED_STRING"),
            message: format!("Unterminated string literal (started with {})", state.quote),
            span: Span {
                start: state.start,
                end: self.current_position(),
            },
        });
    }

    fn scan_comment(&mut self) -> bool {
        match self.comment.expect("comment scanner requires active state") {
            CommentState::Line { start, metadata } => {
                while !self.is_at_end() && !matches!(self.peek(), '\n' | '\r') {
                    self.advance();
                }
                if self.is_at_end() {
                    return false;
                }

                let text = self.slice_from(start.offset);
                self.maybe_push_comment(TokenKind::LineComment, &text, start, metadata);
                self.comment = None;
                true
            }
            CommentState::Block {
                start,
                closing,
                metadata,
                mut saw_closing,
            } => {
                while !self.is_at_end() {
                    let ch = self.advance();
                    if saw_closing && ch == '/' {
                        let text = self.slice_from(start.offset);
                        self.maybe_push_comment(TokenKind::BlockComment, &text, start, metadata);
                        self.comment = None;
                        return true;
                    }
                    saw_closing = ch == closing;
                }
                self.comment = Some(CommentState::Block {
                    start,
                    closing,
                    metadata,
                    saw_closing,
                });
                false
            }
        }
    }

    fn finish_comment(&mut self) {
        match self
            .comment
            .take()
            .expect("comment finish requires active state")
        {
            CommentState::Line { start, metadata } => {
                let text = self.slice_from(start.offset);
                self.maybe_push_comment(TokenKind::LineComment, &text, start, metadata);
            }
            CommentState::Block { start, .. } => self.push_error(LexError {
                code: String::from("UNTERMINATED_BLOCK_COMMENT"),
                message: String::from("Unterminated block comment"),
                span: Span {
                    start,
                    end: self.current_position(),
                },
            }),
        }
    }

    fn begin_number(&mut self, start: Position, first: char) -> bool {
        self.number = Some(NumberState {
            start,
            phase: match first {
                '.' => NumberPhase::FractionDigits,
                '+' | '-' => NumberPhase::Integer {
                    temporal_eligible: false,
                },
                _ => NumberPhase::Integer {
                    temporal_eligible: true,
                },
            },
        });
        self.scan_number(false)
    }

    fn scan_number(&mut self, final_input: bool) -> bool {
        let mut state = self.number.expect("number scanner requires active state");
        loop {
            match state.phase {
                NumberPhase::Integer { temporal_eligible } => {
                    while self.peek().is_ascii_digit() || self.peek() == '_' {
                        self.advance();
                    }
                    if self.is_at_end() {
                        if final_input {
                            return self.complete_number(state.start);
                        }
                        self.number = Some(state);
                        return false;
                    }
                    if temporal_eligible && matches!(self.peek(), '-' | ':') {
                        state.phase = NumberPhase::Temporal;
                    } else {
                        state.phase = NumberPhase::AfterInteger;
                    }
                }
                NumberPhase::AfterInteger => {
                    if self.peek() == '.' {
                        if self.peek_next() == '\0' && self.next_char_reaches_input_end() {
                            if final_input {
                                return self.complete_number(state.start);
                            }
                            self.number = Some(state);
                            return false;
                        }
                        if self.peek_next().is_ascii_digit() {
                            self.advance();
                            state.phase = NumberPhase::FractionDigits;
                            continue;
                        }
                    }
                    if matches!(self.peek(), 'e' | 'E') {
                        self.advance();
                        state.phase = NumberPhase::ExponentSign;
                    } else {
                        return self.complete_number(state.start);
                    }
                }
                NumberPhase::FractionDigits => {
                    while self.peek().is_ascii_digit() || self.peek() == '_' {
                        self.advance();
                    }
                    if self.is_at_end() {
                        if final_input {
                            return self.complete_number(state.start);
                        }
                        self.number = Some(state);
                        return false;
                    }
                    if matches!(self.peek(), 'e' | 'E') {
                        self.advance();
                        state.phase = NumberPhase::ExponentSign;
                    } else {
                        return self.complete_number(state.start);
                    }
                }
                NumberPhase::ExponentSign => {
                    if self.is_at_end() {
                        if final_input {
                            return self.fail_number(state.start);
                        }
                        self.number = Some(state);
                        return false;
                    }
                    if matches!(self.peek(), '+' | '-') {
                        self.advance();
                    }
                    state.phase = NumberPhase::ExponentDigitsRequired;
                }
                NumberPhase::ExponentDigitsRequired => {
                    if self.is_at_end() {
                        if final_input {
                            return self.fail_number(state.start);
                        }
                        self.number = Some(state);
                        return false;
                    }
                    if self.peek().is_ascii_digit() {
                        state.phase = NumberPhase::ExponentDigits;
                    } else {
                        state.phase = NumberPhase::InvalidExponent;
                    }
                }
                NumberPhase::ExponentDigits => {
                    while self.peek().is_ascii_digit() || self.peek() == '_' {
                        self.advance();
                    }
                    if self.is_at_end() {
                        if final_input {
                            return self.complete_number(state.start);
                        }
                        self.number = Some(state);
                        return false;
                    }
                    return self.complete_number(state.start);
                }
                NumberPhase::InvalidExponent => {
                    while self.peek().is_ascii_alphanumeric() || self.peek() == '_' {
                        self.advance();
                    }
                    if self.is_at_end() && !final_input {
                        self.number = Some(state);
                        return false;
                    }
                    return self.fail_number(state.start);
                }
                NumberPhase::Temporal => {
                    while !self.is_at_end()
                        && !matches!(
                            self.peek(),
                            ' ' | '\t' | '\n' | '\r' | ',' | ']' | ')' | '}'
                        )
                    {
                        self.advance();
                    }
                    if self.is_at_end() && !final_input {
                        self.number = Some(state);
                        return false;
                    }
                    return self.complete_temporal(state.start);
                }
            }
        }
    }

    fn complete_number(&mut self, start: Position) -> bool {
        let text = self.slice_from(start.offset);
        self.number = None;
        self.push_token(TokenKind::Number, &text, start, None, None);
        true
    }

    fn fail_number(&mut self, start: Position) -> bool {
        let text = self.slice_from(start.offset);
        self.number = None;
        self.push_error(LexError {
            code: String::from("INVALID_NUMBER"),
            message: format!("Invalid number literal `{text}`"),
            span: Span {
                start,
                end: self.current_position(),
            },
        });
        true
    }

    fn complete_temporal(&mut self, start: Position) -> bool {
        let text = self.slice_from(start.offset);
        self.number = None;
        if let Some((code, message)) = invalid_temporal_literal(&text) {
            self.push_error(LexError {
                code: String::from(code),
                message,
                span: Span {
                    start,
                    end: self.current_position(),
                },
            });
        } else {
            self.push_token(TokenKind::Number, &text, start, None, None);
        }
        true
    }

    fn begin_prefixed_literal(&mut self, start: Position, kind: PrefixedLiteralKind) -> bool {
        self.prefixed_literal = Some(PrefixedLiteralState { start, kind });
        self.scan_prefixed_literal(false)
    }

    fn scan_prefixed_literal(&mut self, final_input: bool) -> bool {
        let state = self
            .prefixed_literal
            .expect("prefixed literal scanner requires active state");
        while match state.kind {
            PrefixedLiteralKind::Hex => self.peek().is_ascii_hexdigit() || self.peek() == '_',
            PrefixedLiteralKind::Radix => is_radix_char(self.peek()),
            PrefixedLiteralKind::Encoding => is_encoding_char(self.peek()),
        } {
            self.advance();
        }

        if self.is_at_end() && !final_input {
            return false;
        }

        let text = self.slice_from(state.start.offset);
        self.prefixed_literal = None;
        let (token_kind, valid, code, family) = match state.kind {
            PrefixedLiteralKind::Hex => (
                TokenKind::HexLiteral,
                text.len() != 1 && has_valid_literal_underscores(&text),
                "SYNTAX_ERROR",
                "hex literal",
            ),
            PrefixedLiteralKind::Radix => (
                TokenKind::RadixLiteral,
                is_valid_radix_payload(&text[1..]),
                "INVALID_NUMBER",
                "radix literal",
            ),
            PrefixedLiteralKind::Encoding => (
                TokenKind::EncodingLiteral,
                is_valid_encoding_payload(&text[1..]),
                "SYNTAX_ERROR",
                "encoding literal",
            ),
        };
        if valid {
            self.push_token(token_kind, &text, state.start, None, None);
        } else {
            self.push_error(LexError {
                code: String::from(code),
                message: format!("Invalid {family} `{text}`"),
                span: Span {
                    start: state.start,
                    end: self.current_position(),
                },
            });
        }
        true
    }

    fn begin_separator_literal(&mut self, start: Position) -> bool {
        self.separator_literal = Some(SeparatorLiteralState {
            start,
            quote: None,
            escaped: false,
        });
        self.scan_separator_literal(false)
    }

    fn scan_separator_literal(&mut self, final_input: bool) -> bool {
        let mut state = self
            .separator_literal
            .expect("separator literal scanner requires active state");
        loop {
            if self.is_at_end() {
                if !final_input {
                    self.separator_literal = Some(state);
                    return false;
                }
                if let Some(quote) = state.quote {
                    return self.fail_separator_string(state.start, quote);
                }
                return self.complete_separator_literal(state.start);
            }

            if let Some(quote) = state.quote {
                if matches!(self.peek(), '\n' | '\r') {
                    return self.fail_separator_string(state.start, quote);
                }
                let ch = self.advance();
                if state.escaped {
                    state.escaped = false;
                } else if ch == '\\' {
                    state.escaped = true;
                } else if ch == quote {
                    state.quote = None;
                }
                continue;
            }

            match self.peek() {
                '"' | '\'' => {
                    state.quote = Some(self.advance());
                }
                ch if is_separator_raw_char(ch) => {
                    self.advance();
                }
                _ => {
                    return self.complete_separator_literal(state.start);
                }
            }
        }
    }

    fn complete_separator_literal(&mut self, start: Position) -> bool {
        let text = self.slice_from(start.offset);
        self.separator_literal = None;
        if text == "^" {
            self.push_token(TokenKind::Caret, &text, start, None, None);
        } else if is_valid_separator_payload(&text[1..]) {
            self.push_token(TokenKind::SeparatorLiteral, &text, start, None, None);
        } else {
            self.push_error(LexError {
                code: String::from("SYNTAX_ERROR"),
                message: format!("Invalid separator literal `{text}`"),
                span: Span {
                    start,
                    end: self.current_position(),
                },
            });
        }
        true
    }

    fn fail_separator_string(&mut self, start: Position, quote: char) -> bool {
        self.separator_literal = None;
        self.push_error(LexError {
            code: String::from("UNTERMINATED_STRING"),
            message: format!("Unterminated string literal (started with {quote})"),
            span: Span {
                start,
                end: self.current_position(),
            },
        });
        true
    }

    fn begin_identifier(&mut self, start: Position) -> bool {
        self.identifier = Some(IdentifierState { start });
        self.scan_identifier(false)
    }

    fn scan_identifier(&mut self, final_input: bool) -> bool {
        let state = self
            .identifier
            .expect("identifier scanner requires active state");
        while is_identifier_continue(self.peek()) {
            self.advance();
        }
        if self.is_at_end() && !final_input {
            return false;
        }

        let text = self.slice_from(state.start.offset);
        self.identifier = None;
        let kind = match text.as_str() {
            "true" => TokenKind::True,
            "false" => TokenKind::False,
            "yes" => TokenKind::Yes,
            "no" => TokenKind::No,
            "on" => TokenKind::On,
            "off" => TokenKind::Off,
            _ => TokenKind::Identifier,
        };
        self.push_token(kind, &text, state.start, None, None);
        true
    }

    fn scan_token(&mut self) -> bool {
        let start = self.current_position();
        let ch = self.advance();

        if ch == '\u{feff}' && start.offset == 0 {
            self.saw_leading_bom = true;
            return true;
        }
        if ch == '#'
            && self.peek() == '!'
            && start.line == 1
            && (start.offset == 0
                || (self.saw_leading_bom && start.offset == '\u{feff}'.len_utf8()))
        {
            return self.begin_shebang();
        }

        match ch {
            ' ' | '\t' => {}
            '\n' => {
                if self.options.include_newlines {
                    self.push_token(TokenKind::Newline, "\n", start, None, None);
                }
                return true;
            }
            '\r' => return self.begin_carriage_return(start),
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
                    return self.begin_number(start, '.');
                } else {
                    self.push_token(TokenKind::Dot, ".", start, None, None);
                }
            }
            '@' => self.push_token(TokenKind::At, "@", start, None, None),
            ';' => self.push_token(TokenKind::Semicolon, ";", start, None, None),
            '\\' => return self.begin_structural_identity(start),
            '~' => {
                if self.match_char('>') {
                    self.push_token(TokenKind::TildeArrow, "~>", start, None, None);
                } else {
                    self.push_token(TokenKind::Tilde, "~", start, None, None);
                }
            }
            '^' => return self.begin_separator_literal(start),
            '#' => {
                if self.peek().is_ascii_hexdigit() {
                    return self.begin_prefixed_literal(start, PrefixedLiteralKind::Hex);
                } else {
                    self.push_token(TokenKind::Hash, "#", start, None, None);
                }
            }
            '$' if self.previous_token_is_reference_marker() => {
                self.push_token(TokenKind::Dollar, "$", start, None, None);
            }
            '$' | '?' => return self.begin_sansa_address(start),
            '&' => {
                if is_encoding_start_char(self.peek()) {
                    return self.begin_prefixed_literal(start, PrefixedLiteralKind::Encoding);
                } else {
                    self.push_token(TokenKind::Ampersand, "&", start, None, None);
                }
            }
            '%' => {
                if is_radix_start_char(self.peek()) {
                    return self.begin_prefixed_literal(start, PrefixedLiteralKind::Radix);
                } else {
                    self.push_token(TokenKind::Percent, "%", start, None, None);
                }
            }
            '/' => return self.scan_slash_channel_or_symbol(start),
            '"' | '\'' | '`' => {
                self.quoted_string = Some(QuotedStringState {
                    start,
                    quote: ch,
                    escaped: false,
                });
                return self.scan_quoted_string();
            }
            '+' | '-' => {
                if self.peek().is_ascii_digit() || self.peek() == '.' {
                    return self.begin_number(start, ch);
                } else {
                    let text = self.slice_from(start.offset);
                    self.push_token(TokenKind::Symbol, &text, start, None, None);
                }
            }
            _ if ch.is_ascii_digit() => return self.begin_number(start, ch),
            _ if is_identifier_start(ch) => return self.begin_identifier(start),
            _ if is_printable_ascii(ch) => {
                let text = self.slice_from(start.offset);
                self.push_token(TokenKind::Symbol, &text, start, None, None);
            }
            _ => self.push_error(LexError {
                code: String::from("UNEXPECTED_CHARACTER"),
                message: format!("Unexpected character `{ch}`"),
                span: Span {
                    start,
                    end: self.current_position(),
                },
            }),
        }
        false
    }

    fn begin_shebang(&mut self) -> bool {
        debug_assert_eq!(self.peek(), '!');
        self.advance();
        self.shebang = Some(ShebangState);
        self.scan_shebang(false)
    }

    fn scan_shebang(&mut self, final_input: bool) -> bool {
        while !self.is_at_end() && !matches!(self.peek(), '\n' | '\r') {
            self.advance();
        }
        if self.is_at_end() && !final_input {
            return false;
        }
        self.shebang = None;
        true
    }

    fn begin_carriage_return(&mut self, start: Position) -> bool {
        self.carriage_return = Some(CarriageReturnState { start });
        self.scan_carriage_return(false)
    }

    fn scan_carriage_return(&mut self, final_input: bool) -> bool {
        let state = self
            .carriage_return
            .expect("carriage-return scanner requires active state");
        if self.is_at_end() && !final_input {
            return false;
        }

        let text = if self.match_char('\n') { "\r\n" } else { "\r" };
        self.carriage_return = None;
        if self.options.include_newlines {
            self.push_token(TokenKind::Newline, text, state.start, None, None);
        }
        true
    }

    fn begin_structural_identity(&mut self, start: Position) -> bool {
        self.structural_identity = Some(StructuralIdentityState {
            start,
            search_offset: self.offset,
        });
        self.scan_structural_identity(false)
    }

    fn scan_structural_identity(&mut self, final_input: bool) -> bool {
        let mut state = self
            .structural_identity
            .expect("structural identity scanner requires active state");
        let Some(relative_closer) = self.input[state.search_offset..].find('\\') else {
            if final_input {
                self.structural_identity = None;
                self.push_token(TokenKind::Symbol, "\\", state.start, None, None);
                return true;
            }
            state.search_offset = self.input.len();
            self.structural_identity = Some(state);
            return false;
        };
        let closer_offset = state.search_offset + relative_closer;
        let mut value = String::new();
        while self.offset < closer_offset {
            let ch = self.peek();
            if !ch.is_ascii_alphanumeric() && ch != '-' && ch != '_' {
                value.push(self.advance());
                while self.offset < closer_offset {
                    value.push(self.advance());
                }
                value.push(self.advance());
                self.structural_identity = None;
                self.push_error(LexError {
                    code: String::from("INVALID_STRUCTURAL_IDENTITY"),
                    message: format!("Invalid structural identity: '\\{value}'"),
                    span: Span {
                        start: state.start,
                        end: self.current_position(),
                    },
                });
                return true;
            }
            value.push(self.advance());
        }

        if value.is_empty() {
            self.advance();
            self.structural_identity = None;
            self.push_error(LexError {
                code: String::from("INVALID_STRUCTURAL_IDENTITY"),
                message: String::from("Invalid structural identity: '\\\\'"),
                span: Span {
                    start: state.start,
                    end: self.current_position(),
                },
            });
            return true;
        }

        self.advance();
        self.structural_identity = None;
        self.push_token(
            TokenKind::StructuralIdentity,
            &value,
            state.start,
            None,
            None,
        );
        true
    }

    fn begin_sansa_address(&mut self, start: Position) -> bool {
        self.sansa_address = Some(SansaAddressState {
            start,
            stack: Vec::new(),
            in_quote: false,
            escaped: false,
        });
        self.scan_sansa_address(false)
    }

    fn scan_sansa_address(&mut self, final_input: bool) -> bool {
        let mut state = self
            .sansa_address
            .take()
            .expect("SANSA address scanner requires active state");

        while !self.is_at_end() {
            let ch = self.peek();

            if state.in_quote {
                if state.escaped {
                    state.escaped = false;
                    self.advance();
                    continue;
                }
                match ch {
                    '\\' => {
                        state.escaped = true;
                        self.advance();
                    }
                    '"' => {
                        state.in_quote = false;
                        self.advance();
                    }
                    _ => {
                        self.advance();
                    }
                }
                continue;
            }

            if state.stack.is_empty()
                && matches!(ch, ' ' | '\t' | '\n' | '\r' | ',' | '/' | '}' | ']' | ')')
            {
                break;
            }

            match ch {
                '"' => {
                    state.in_quote = true;
                    self.advance();
                }
                '[' => {
                    state.stack.push(']');
                    self.advance();
                }
                '(' => {
                    state.stack.push(')');
                    self.advance();
                }
                '<' => {
                    state.stack.push('>');
                    self.advance();
                }
                ']' | ')' | '>' if state.stack.last().copied() == Some(ch) => {
                    state.stack.pop();
                    self.advance();
                }
                _ => {
                    self.advance();
                }
            }
        }

        if self.is_at_end() && !final_input {
            self.sansa_address = Some(state);
            return false;
        }

        let text = self.slice_from(state.start.offset);
        self.push_token(
            TokenKind::SansaAddressLiteral,
            &text,
            state.start,
            None,
            None,
        );
        true
    }

    fn scan_slash_channel_or_symbol(&mut self, start: Position) -> bool {
        match self.peek() {
            '/' => {
                self.advance();
                self.comment = Some(CommentState::Line {
                    start,
                    metadata: CommentMetadata {
                        channel: CommentChannel::Plain,
                        form: CommentForm::Line,
                        subtype: None,
                    },
                });
                self.scan_comment()
            }
            '#' | '@' | '?' | '{' | '[' | '(' | '*' => {
                let marker = self.advance();
                self.comment = Some(CommentState::Block {
                    start,
                    closing: slash_channel_closing_marker(marker),
                    metadata: comment_metadata_for_marker(marker),
                    saw_closing: false,
                });
                self.scan_comment()
            }
            _ => {
                self.push_token(TokenKind::Symbol, "/", start, None, None);
                false
            }
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
        self.previous_token_kind = Some(kind);
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

    fn previous_token_is_reference_marker(&self) -> bool {
        matches!(
            self.previous_token_kind,
            Some(TokenKind::Tilde | TokenKind::TildeArrow)
        )
    }

    fn push_error(&mut self, error: LexError) {
        let span = error.span;
        if self.error_count < MAX_LEX_ERRORS {
            self.errors.push(error);
            self.error_count += 1;
        }

        if self.error_count == MAX_LEX_ERRORS && !self.aborted {
            self.errors.push(LexError {
                code: String::from("LEX_ERROR_LIMIT_EXCEEDED"),
                message: format!(
                    "Lexer aborted after reaching the error limit of {MAX_LEX_ERRORS} diagnostics"
                ),
                span,
            });
            self.aborted = true;
            self.offset = self.input.len();
        }
    }

    fn is_at_end(&self) -> bool {
        self.offset >= self.input.len()
    }

    fn current_position(&self) -> Position {
        Position {
            line: self.line,
            column: self.column,
            offset: self.buffer_start_offset + self.offset,
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

    fn next_char_reaches_input_end(&self) -> bool {
        self.offset + self.peek().len_utf8() >= self.input.len()
    }

    fn advance(&mut self) -> char {
        if self.is_at_end() {
            return '\0';
        }
        let ch = self.peek();
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
        let local_start = start_offset
            .checked_sub(self.buffer_start_offset)
            .expect("token start precedes retained lexer input");
        self.input[local_start..self.offset].to_owned()
    }

    fn compact_input_buffer(&mut self) {
        if !self.compact_input {
            return;
        }

        let retain_from = self
            .active_token_start_offset()
            .unwrap_or_else(|| self.current_position().offset);
        let local_retain_from = retain_from
            .checked_sub(self.buffer_start_offset)
            .expect("retained lexer start precedes input buffer");
        if local_retain_from == 0 {
            return;
        }

        let input = self.input.to_mut();
        input.drain(..local_retain_from);
        self.buffer_start_offset += local_retain_from;
        self.offset -= local_retain_from;
        if let Some(state) = &mut self.structural_identity {
            state.search_offset -= local_retain_from;
        }
    }

    fn active_token_start_offset(&self) -> Option<usize> {
        self.active_token_start_position()
            .map(|position| position.offset)
    }

    fn active_token_start_position(&self) -> Option<Position> {
        self.quoted_string
            .map(|state| state.start)
            .or_else(|| {
                self.comment.map(|state| match state {
                    CommentState::Line { start, .. } | CommentState::Block { start, .. } => start,
                })
            })
            .or_else(|| self.number.map(|state| state.start))
            .or_else(|| self.prefixed_literal.map(|state| state.start))
            .or_else(|| self.separator_literal.map(|state| state.start))
            .or_else(|| self.identifier.map(|state| state.start))
            .or_else(|| self.structural_identity.map(|state| state.start))
            .or_else(|| self.sansa_address.as_ref().map(|state| state.start))
    }

    pub(crate) fn retained_input_bytes(&self) -> usize {
        self.input.len()
    }
}

fn is_identifier_start(ch: char) -> bool {
    ch.is_ascii_alphabetic() || ch == '_'
}

fn bounded_char_boundary(input: &str, allowance: usize) -> usize {
    let mut end = allowance.min(input.len());
    while end > 0 && !input.is_char_boundary(end) {
        end -= 1;
    }
    if end == 0 {
        input
            .chars()
            .next()
            .map_or(0, char::len_utf8)
            .min(input.len())
    } else {
        end
    }
}

fn retained_token_byte_limit(options: &CompileOptions) -> usize {
    // A valid quoted scalar may use the ten-byte `\u{10ffff}` spelling. A
    // single string token can later become a value, key, or quoted path
    // segment, so retain enough for the largest applicable semantic limit.
    let quoted_characters = options
        .max_string_codepoints
        .max(options.max_key_segment_codepoints)
        .max(options.max_path_characters);
    let quoted_bytes = quoted_characters.saturating_mul(10).saturating_add(2);
    // Structured-comment payloads are counted as Unicode scalars. Four bytes
    // per scalar plus the longest opening/closing markers is conservative.
    let structured_comment_bytes = options
        .max_structured_comment_characters
        .saturating_mul(4)
        .saturating_add(4);
    let mut limit = options
        .max_numeric_literal_characters
        .min(quoted_bytes)
        .min(structured_comment_bytes);
    if let Some(max_input_bytes) = options.max_input_bytes {
        limit = limit.min(max_input_bytes);
    }
    limit
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
    matches!(ch, '+' | '-' | '.' | '&' | '!') || ch.is_ascii_alphanumeric()
}

fn is_radix_digit(ch: char) -> bool {
    ch.is_ascii_alphanumeric() || matches!(ch, '&' | '!')
}

fn is_valid_radix_payload(payload: &str) -> bool {
    if payload.is_empty() {
        return false;
    }
    let chars: Vec<char> = payload.chars().collect();
    let mut index = if matches!(chars.first(), Some('+' | '-')) {
        1
    } else {
        0
    };
    if index >= chars.len() {
        return false;
    }
    let mut saw_digit = false;
    let mut saw_decimal = false;
    let mut prev_was_digit = false;
    let mut saw_digit_before_decimal = false;
    while index < chars.len() {
        let ch = chars[index];
        if is_radix_digit(ch) {
            saw_digit = true;
            prev_was_digit = true;
            if !saw_decimal {
                saw_digit_before_decimal = true;
            }
        } else if ch == '_' {
            if !prev_was_digit || index + 1 >= chars.len() || !is_radix_digit(chars[index + 1]) {
                return false;
            }
            prev_was_digit = false;
        } else if ch == '.' {
            if saw_decimal || index + 1 >= chars.len() || !is_radix_digit(chars[index + 1]) {
                return false;
            }
            if !prev_was_digit && saw_digit_before_decimal {
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
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '=' | '-' | '_'))
    {
        return false;
    }
    match payload.find('=') {
        None => true,
        Some(index) => payload.len() - index <= 2 && payload[index..].chars().all(|ch| ch == '='),
    }
}

fn has_valid_literal_underscores(raw: &str) -> bool {
    let body = raw.strip_prefix('#').unwrap_or(raw);
    !body.is_empty() && !body.starts_with('_') && !body.ends_with('_') && !body.contains("__")
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
    if payload.is_empty() {
        return false;
    }

    let chars: Vec<char> = payload.chars().collect();
    let mut index = 0;
    while index < chars.len() {
        let ch = chars[index];
        if ch == '"' || ch == '\'' {
            let quote = ch;
            index += 1;
            let mut terminated = false;
            while index < chars.len() {
                let inner = chars[index];
                if inner == '\n' || inner == '\r' {
                    return false;
                }
                if inner == '\\' {
                    index += 2;
                    continue;
                }
                index += 1;
                if inner == quote {
                    terminated = true;
                    break;
                }
            }
            if !terminated {
                return false;
            }
            continue;
        }
        if !is_separator_raw_char(ch) {
            return false;
        }
        index += 1;
    }

    true
}

fn is_separator_raw_char(ch: char) -> bool {
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

#[cfg(test)]
mod tests {
    use std::borrow::Cow;

    use super::{
        CommentChannel, CommentForm, CommentMetadata, LexResult, LexerOptions, LexerSession,
        ReservedCommentSubtype, TokenKind, tokenize,
    };

    fn tokenize_chunks<'a>(chunks: impl IntoIterator<Item = &'a str>) -> LexResult {
        tokenize_chunks_with_options(chunks, LexerOptions::default())
    }

    fn tokenize_chunks_with_options<'a>(
        chunks: impl IntoIterator<Item = &'a str>,
        options: LexerOptions,
    ) -> LexResult {
        let mut lexer = LexerSession::new(options);
        let mut tokens = Vec::new();
        let mut errors = Vec::new();
        for chunk in chunks {
            let result = lexer.push(Cow::Owned(chunk.to_owned()));
            tokens.extend(result.tokens);
            errors.extend(result.errors);
        }
        let result = lexer.finish();
        tokens.extend(result.tokens);
        errors.extend(result.errors);
        LexResult { tokens, errors }
    }

    #[test]
    fn tokenizes_basic_binding() {
        let result = tokenize("name = \"Pat\"", LexerOptions::default());
        let kinds = result
            .tokens
            .iter()
            .map(|token| token.kind)
            .collect::<Vec<_>>();
        assert_eq!(
            kinds,
            vec![
                TokenKind::Identifier,
                TokenKind::Equals,
                TokenKind::String,
                TokenKind::Eof
            ]
        );
        assert!(result.errors.is_empty());
    }

    #[test]
    fn incremental_session_releases_completed_prefixes_without_losing_absolute_spans() {
        let source = "a = 1\n".repeat(512);
        let expected = tokenize(&source, LexerOptions::default());
        let mut lexer = LexerSession::new(LexerOptions::default());
        let mut tokens = Vec::new();
        let mut errors = Vec::new();
        let mut peak_retained = 0usize;

        for ch in source.chars() {
            let result = lexer.push(Cow::Owned(ch.to_string()));
            tokens.extend(result.tokens);
            errors.extend(result.errors);
            peak_retained = peak_retained.max(lexer.retained_input_bytes());
        }
        let result = lexer.finish();
        tokens.extend(result.tokens);
        errors.extend(result.errors);

        assert_eq!(LexResult { tokens, errors }, expected);
        assert_eq!(peak_retained, 1);
        assert_eq!(lexer.retained_input_bytes(), 0);
    }

    #[test]
    fn incremental_buffer_retains_only_the_active_raw_token() {
        let mut lexer = LexerSession::new(LexerOptions::default());
        let prefix = lexer.push(Cow::Borrowed("prefix = \""));
        assert_eq!(prefix.tokens.len(), 2);
        assert!(prefix.errors.is_empty());
        assert_eq!(lexer.retained_input_bytes(), 1);

        let mut expected_active_bytes = 1usize;
        for _ in 0..64 {
            let pending = lexer.push(Cow::Borrowed("🌊"));
            assert!(pending.tokens.is_empty());
            assert!(pending.errors.is_empty());
            expected_active_bytes += "🌊".len();
            assert_eq!(lexer.retained_input_bytes(), expected_active_bytes);
        }

        let completed = lexer.push(Cow::Borrowed("\" tail "));
        assert!(completed.errors.is_empty());
        let string = completed
            .tokens
            .iter()
            .find(|token| token.kind == TokenKind::String)
            .expect("closing quote emits the active string");
        assert_eq!(string.span.start.offset, "prefix = ".len());
        assert_eq!(string.text.len(), expected_active_bytes + 1);
        assert_eq!(lexer.retained_input_bytes(), 1);

        let structural_prefix = "\nroot = 1\n";
        let pending_identity = lexer.push(Cow::Owned(format!("{structural_prefix}\\alpha")));
        assert!(pending_identity.errors.is_empty());
        assert_eq!(lexer.retained_input_bytes(), "\\alpha".len());
        let identity_start =
            "prefix = \"".len() + 64 * "🌊".len() + "\" tail ".len() + structural_prefix.len();
        let completed_identity = lexer.push(Cow::Borrowed("-id\\ "));
        assert!(completed_identity.errors.is_empty());
        let identity = completed_identity
            .tokens
            .iter()
            .find(|token| token.kind == TokenKind::StructuralIdentity)
            .expect("closing backslash emits the active identity");
        assert_eq!(identity.text, "alpha-id");
        assert_eq!(identity.span.start.offset, identity_start);
        assert_eq!(lexer.retained_input_bytes(), 1);
    }

    #[test]
    fn bounded_incremental_session_accepts_the_retained_token_boundary() {
        let mut lexer = LexerSession::with_retained_token_limit(LexerOptions::default(), 5);

        let pending = lexer.push(Cow::Borrowed("\"abcd"));
        assert!(pending.tokens.is_empty());
        assert!(pending.errors.is_empty());
        assert_eq!(lexer.retained_input_bytes(), 5);

        let completed = lexer.push(Cow::Borrowed("\" "));
        assert!(completed.errors.is_empty());
        assert_eq!(completed.tokens[0].kind, TokenKind::String);
        assert_eq!(completed.tokens[0].text, "\"abcd\"");
        assert_eq!(completed.tokens[0].span.start.offset, 0);
        assert_eq!(completed.tokens[0].span.end.offset, 6);
        assert_eq!(lexer.retained_input_bytes(), 1);
    }

    #[test]
    fn bounded_incremental_session_preserves_tokens_below_the_limit() {
        let source = "a = \"wave 🌊\"\nb = 1234\n";
        let expected = tokenize(
            source,
            LexerOptions {
                include_newlines: true,
                ..LexerOptions::default()
            },
        );
        let mut lexer = LexerSession::with_retained_token_limit(
            LexerOptions {
                include_newlines: true,
                ..LexerOptions::default()
            },
            12,
        );

        let mut actual = lexer.push(Cow::Borrowed(source));
        let finished = lexer.finish();
        actual.tokens.extend(finished.tokens);
        actual.errors.extend(finished.errors);

        assert_eq!(actual, expected);
    }

    #[test]
    fn bounded_incremental_session_fails_and_releases_one_byte_beyond_limit() {
        let mut lexer = LexerSession::with_retained_token_limit(LexerOptions::default(), 5);

        let exceeded = lexer.push(Cow::Borrowed("p = \"abcde"));
        assert_eq!(exceeded.tokens.len(), 2);
        assert_eq!(exceeded.errors.len(), 1);
        assert_eq!(
            exceeded.errors[0].code,
            "INCREMENTAL_TOKEN_RETENTION_EXCEEDED"
        );
        assert_eq!(exceeded.errors[0].span.start.offset, "p = ".len());
        assert_eq!(exceeded.errors[0].span.end.offset, "p = \"abcde".len());
        assert!(exceeded.errors[0].message.contains("retained 6 bytes"));
        assert!(exceeded.errors[0].message.contains("limit of 5 bytes"));
        assert_eq!(lexer.retained_input_bytes(), 0);

        let ignored = lexer.push(Cow::Borrowed("ignored"));
        assert!(ignored.tokens.is_empty());
        assert!(ignored.errors.is_empty());
        let finished = lexer.finish();
        assert_eq!(finished.tokens.len(), 1);
        assert_eq!(finished.tokens[0].kind, TokenKind::Eof);
        assert_eq!(lexer.retained_input_bytes(), 0);
    }

    #[test]
    fn bounded_incremental_session_limits_bytes_across_multibyte_chunks() {
        let mut lexer = LexerSession::with_retained_token_limit(LexerOptions::default(), 5);

        let exceeded = lexer.push(Cow::Borrowed("\"🌊x"));
        assert_eq!(exceeded.errors.len(), 1);
        assert_eq!(
            exceeded.errors[0].code,
            "INCREMENTAL_TOKEN_RETENTION_EXCEEDED"
        );
        assert!(exceeded.errors[0].message.contains("retained 6 bytes"));
        assert_eq!(exceeded.errors[0].span.start.offset, 0);
        assert_eq!(exceeded.errors[0].span.end.offset, 6);
        assert_eq!(lexer.retained_input_bytes(), 0);
    }

    #[test]
    fn one_shot_session_keeps_the_borrowed_source_fast_path() {
        let source = String::from("name = \"Pat\"");
        let mut lexer = LexerSession::one_shot(LexerOptions::default());
        let pushed = lexer.push(Cow::Borrowed(&source));
        assert!(pushed.errors.is_empty());
        assert!(matches!(&lexer.input, Cow::Borrowed(_)));
        assert_eq!(lexer.retained_input_bytes(), source.len());

        let finished = lexer.finish();
        assert!(finished.errors.is_empty());
        assert!(matches!(&lexer.input, Cow::Borrowed(_)));
    }

    #[test]
    fn quoted_strings_and_escapes_match_one_shot_at_every_scalar_split() {
        for source in [
            r#"name = "left\"🌊right" next"#,
            r#"name = 'left\'🌊right' next"#,
            r#"name = "line\nwave\u{1f30a}" next"#,
        ] {
            let expected = tokenize(source, LexerOptions::default());
            let mut splits = source
                .char_indices()
                .map(|(index, _)| index)
                .collect::<Vec<_>>();
            splits.push(source.len());

            for split in splits {
                let actual = tokenize_chunks([&source[..split], &source[split..]]);
                assert_eq!(actual, expected, "source {source:?}, split at byte {split}");
            }
        }
    }

    #[test]
    fn raw_backticks_match_one_shot_at_every_scalar_split() {
        for source in [
            "value = `first line\nwave 🌊\nlast line` next",
            r#"value = `escaped \` backtick and \\ slash` next"#,
        ] {
            let expected = tokenize(source, LexerOptions::default());
            let mut splits = source
                .char_indices()
                .map(|(index, _)| index)
                .collect::<Vec<_>>();
            splits.push(source.len());

            for split in splits {
                let actual = tokenize_chunks([&source[..split], &source[split..]]);
                assert_eq!(actual, expected, "source {source:?}, split at byte {split}");
            }

            let raw = expected
                .tokens
                .iter()
                .find(|token| token.kind == TokenKind::String)
                .expect("backtick source contains a string token");
            assert_eq!(raw.quote, Some('`'));
            assert!(raw.text.starts_with('`') && raw.text.ends_with('`'));
        }
    }

    #[test]
    fn trimtick_markers_and_raw_body_match_at_every_scalar_split() {
        let source = "note:trimtick = >>>>`\n    first\n\twave 🌊\n` next";
        let expected = tokenize(source, LexerOptions::default());
        let mut splits = source
            .char_indices()
            .map(|(index, _)| index)
            .collect::<Vec<_>>();
        splits.push(source.len());

        for split in splits {
            let actual = tokenize_chunks([&source[..split], &source[split..]]);
            assert_eq!(actual, expected, "trimtick split at byte {split}");
        }

        let marker = expected
            .tokens
            .windows(5)
            .find(|window| {
                window[..4]
                    .iter()
                    .all(|token| token.kind == TokenKind::RightAngle)
                    && window[4].kind == TokenKind::String
            })
            .expect("four contiguous marker tokens precede the raw body");
        for pair in marker[..4].windows(2) {
            assert_eq!(pair[0].span.end.offset, pair[1].span.start.offset);
        }
        assert_eq!(marker[3].span.end.offset, marker[4].span.start.offset);
        assert_eq!(marker[4].quote, Some('`'));
        assert_eq!(marker[4].text, "`\n    first\n\twave 🌊\n`");
    }

    #[test]
    fn escape_at_chunk_end_suspends_and_completed_string_emits_before_finish() {
        let mut lexer = LexerSession::new(LexerOptions::default());
        let first = lexer.push(Cow::Owned(r#"value = "left\"#.to_owned()));
        assert!(first.errors.is_empty());
        assert!(
            first
                .tokens
                .iter()
                .all(|token| token.kind != TokenKind::String)
        );

        let second = lexer.push(Cow::Owned(r#""right""#.to_owned()));
        assert!(second.errors.is_empty());
        let string = second
            .tokens
            .iter()
            .find(|token| token.kind == TokenKind::String)
            .expect("closing quote emits the completed string during push");
        assert_eq!(string.text, r#""left\"right""#);
        assert_eq!(string.span.start.offset, "value = ".len());
        assert_eq!(string.span.end.offset, r#"value = "left\"right""#.len());

        let final_result = lexer.finish();
        assert!(final_result.errors.is_empty());
        assert_eq!(final_result.tokens.len(), 1);
        assert_eq!(final_result.tokens[0].kind, TokenKind::Eof);
    }

    #[test]
    fn unterminated_quoted_string_reports_only_when_finished() {
        let mut lexer = LexerSession::new(LexerOptions::default());
        let pushed = lexer.push(Cow::Owned(r#""unterminated\"#.to_owned()));
        assert!(pushed.tokens.is_empty());
        assert!(pushed.errors.is_empty());

        let finished = lexer.finish();
        assert_eq!(finished.errors.len(), 1);
        assert_eq!(finished.errors[0].code, "UNTERMINATED_STRING");
        assert_eq!(finished.errors[0].span.start.offset, 0);
        assert_eq!(
            finished.errors[0].span.end.offset,
            r#""unterminated\"#.len()
        );
        assert_eq!(finished.tokens.len(), 1);
        assert_eq!(finished.tokens[0].kind, TokenKind::Eof);
    }

    #[test]
    fn unterminated_raw_backtick_reports_only_when_finished() {
        let mut lexer = LexerSession::new(LexerOptions::default());
        let pushed = lexer.push(Cow::Owned("`first\nwave 🌊\\".to_owned()));
        assert!(pushed.tokens.is_empty());
        assert!(pushed.errors.is_empty());

        let finished = lexer.finish();
        assert_eq!(finished.errors.len(), 1);
        assert_eq!(finished.errors[0].code, "UNTERMINATED_STRING");
        assert_eq!(finished.errors[0].span.start.offset, 0);
        assert_eq!(
            finished.errors[0].span.end.offset,
            "`first\nwave 🌊\\".len()
        );
        assert_eq!(finished.tokens.len(), 1);
        assert_eq!(finished.tokens[0].kind, TokenKind::Eof);
    }

    #[test]
    fn every_comment_channel_matches_one_shot_at_every_scalar_split() {
        let source = "// line 🌊\r\n/* plain */ /# doc #/ /@ annotation @/ /? hint ?/ /{ structure }/ /[ profile ]/ /( instructions )/ tail";
        let options = LexerOptions {
            include_comments: true,
            include_newlines: true,
        };
        let expected = tokenize(source, options);
        let mut splits = source
            .char_indices()
            .map(|(index, _)| index)
            .collect::<Vec<_>>();
        splits.push(source.len());

        for split in splits {
            let actual =
                tokenize_chunks_with_options([&source[..split], &source[split..]], options);
            assert_eq!(actual, expected, "comment split at byte {split}");
        }

        let metadata = expected
            .tokens
            .iter()
            .filter_map(|token| token.comment)
            .collect::<Vec<_>>();
        assert_eq!(
            metadata,
            [
                CommentMetadata {
                    channel: CommentChannel::Plain,
                    form: CommentForm::Line,
                    subtype: None,
                },
                CommentMetadata {
                    channel: CommentChannel::Plain,
                    form: CommentForm::Block,
                    subtype: None,
                },
                CommentMetadata {
                    channel: CommentChannel::Doc,
                    form: CommentForm::Block,
                    subtype: None,
                },
                CommentMetadata {
                    channel: CommentChannel::Annotation,
                    form: CommentForm::Block,
                    subtype: None,
                },
                CommentMetadata {
                    channel: CommentChannel::Hint,
                    form: CommentForm::Block,
                    subtype: None,
                },
                CommentMetadata {
                    channel: CommentChannel::Reserved,
                    form: CommentForm::Block,
                    subtype: Some(ReservedCommentSubtype::Structure),
                },
                CommentMetadata {
                    channel: CommentChannel::Reserved,
                    form: CommentForm::Block,
                    subtype: Some(ReservedCommentSubtype::Profile),
                },
                CommentMetadata {
                    channel: CommentChannel::Reserved,
                    form: CommentForm::Block,
                    subtype: Some(ReservedCommentSubtype::Instructions),
                },
            ]
        );
    }

    #[test]
    fn preambles_and_line_endings_match_one_shot_at_every_scalar_split() {
        let source = concat!(
            "\u{feff}#!/usr/bin/env aeon\r\n",
            "//! format:aeon.test.v1\r\n",
            "first = 1\rsecond = 2\n",
            "\"🌊\" = 3\r\n",
        );
        let options = LexerOptions {
            include_comments: true,
            include_newlines: true,
        };
        let expected = tokenize(source, options);
        let mut splits = source
            .char_indices()
            .map(|(index, _)| index)
            .collect::<Vec<_>>();
        splits.push(source.len());

        for split in splits {
            let actual =
                tokenize_chunks_with_options([&source[..split], &source[split..]], options);
            assert_eq!(actual, expected, "preamble split at byte {split}");
        }

        assert!(expected.errors.is_empty());
        assert_eq!(
            expected
                .tokens
                .iter()
                .filter(|token| token.kind == TokenKind::Newline)
                .map(|token| token.text.as_str())
                .collect::<Vec<_>>(),
            ["\r\n", "\r\n", "\r", "\n", "\r\n"]
        );
        assert!(expected.tokens.iter().all(|token| token.text != "#!"));
    }

    #[test]
    fn split_shebang_and_carriage_return_emit_only_at_deterministic_boundaries() {
        let options = LexerOptions {
            include_newlines: true,
            ..LexerOptions::default()
        };
        let mut lexer = LexerSession::new(options);
        for chunk in ["\u{feff}", "#", "!/usr/bin/env aeon", "\r"] {
            let pending = lexer.push(Cow::Owned(chunk.to_owned()));
            assert!(pending.tokens.is_empty(), "chunk {chunk:?}");
            assert!(pending.errors.is_empty(), "chunk {chunk:?}");
        }

        let completed = lexer.push(Cow::Owned("\nvalue ".to_owned()));
        assert!(completed.errors.is_empty());
        assert_eq!(completed.tokens.len(), 2);
        assert_eq!(completed.tokens[0].kind, TokenKind::Newline);
        assert_eq!(completed.tokens[0].text, "\r\n");
        assert_eq!(
            completed.tokens[0].span.start.offset,
            "\u{feff}#!/usr/bin/env aeon".len()
        );
        assert_eq!(completed.tokens[0].span.start.line, 1);
        assert_eq!(completed.tokens[0].span.end.line, 2);
        assert_eq!(completed.tokens[0].span.end.column, 1);
        assert_eq!(completed.tokens[1].kind, TokenKind::Identifier);
        assert_eq!(completed.tokens[1].text, "value");

        let mut bare = LexerSession::new(options);
        let pending_bare = bare.push(Cow::Owned("a\r".to_owned()));
        assert_eq!(pending_bare.tokens.len(), 1);
        assert_eq!(pending_bare.tokens[0].kind, TokenKind::Identifier);
        let finished_bare = bare.finish();
        assert!(finished_bare.errors.is_empty());
        assert_eq!(finished_bare.tokens[0].kind, TokenKind::Newline);
        assert_eq!(finished_bare.tokens[0].text, "\r");
        assert_eq!(finished_bare.tokens[0].span.start.line, 1);
        assert_eq!(finished_bare.tokens[0].span.end.line, 1);
    }

    #[test]
    fn numeric_temporal_and_prefixed_literals_match_at_every_scalar_split() {
        let source = concat!(
            "a=123_456 b=-42 c=+.75 d=6.02e+23 ",
            "e=2024-02-29 f=23:59:59 g=2025-01-01T09:30:00Z ",
            "h=#00_Ff i=%+9&.! j=&abc-_== k=^root\"🌊,/\"tail end",
        );
        let expected = tokenize(source, LexerOptions::default());
        assert!(expected.errors.is_empty());
        let mut splits = source
            .char_indices()
            .map(|(index, _)| index)
            .collect::<Vec<_>>();
        splits.push(source.len());

        for split in splits {
            let actual = tokenize_chunks([&source[..split], &source[split..]]);
            assert_eq!(actual, expected, "literal split at byte {split}");
        }
    }

    #[test]
    fn identifiers_and_reserved_words_match_at_every_scalar_split() {
        let source = concat!(
            "payload:custom<tuple<string,number>,three>[\"x\",10] = ",
            "true false yes no on off trailing_identifier",
        );
        let expected = tokenize(source, LexerOptions::default());
        assert!(expected.errors.is_empty());
        let mut splits = source
            .char_indices()
            .map(|(index, _)| index)
            .collect::<Vec<_>>();
        splits.push(source.len());

        for split in splits {
            let actual = tokenize_chunks([&source[..split], &source[split..]]);
            assert_eq!(actual, expected, "identifier split at byte {split}");
        }

        let kinds = expected
            .tokens
            .iter()
            .map(|token| token.kind)
            .collect::<Vec<_>>();
        for kind in [
            TokenKind::True,
            TokenKind::False,
            TokenKind::Yes,
            TokenKind::No,
            TokenKind::On,
            TokenKind::Off,
        ] {
            assert!(kinds.contains(&kind), "missing reserved token {kind:?}");
        }
    }

    #[test]
    fn identifier_waits_for_a_deterministic_boundary() {
        let mut lexer = LexerSession::new(LexerOptions::default());
        let pending = lexer.push(Cow::Owned("tru".to_owned()));
        assert!(pending.tokens.is_empty());
        assert!(pending.errors.is_empty());

        let completed = lexer.push(Cow::Owned("e ".to_owned()));
        assert!(completed.errors.is_empty());
        assert_eq!(completed.tokens.len(), 1);
        assert_eq!(completed.tokens[0].kind, TokenKind::True);
        assert_eq!(completed.tokens[0].text, "true");
    }

    #[test]
    fn malformed_literal_diagnostics_match_at_every_scalar_split() {
        let source = concat!(
            "a=1e+ b=2025-13-40 c=#F__f d=%1__0 e=&abc=a= ",
            "f=^\"unterminated",
        );
        let expected = tokenize(source, LexerOptions::default());
        assert_eq!(expected.errors.len(), 6);
        let mut splits = source
            .char_indices()
            .map(|(index, _)| index)
            .collect::<Vec<_>>();
        splits.push(source.len());

        for split in splits {
            let actual = tokenize_chunks([&source[..split], &source[split..]]);
            assert_eq!(actual, expected, "invalid literal split at byte {split}");
        }
    }

    #[test]
    fn incomplete_literals_suspend_until_a_boundary_or_finish() {
        let mut number = LexerSession::new(LexerOptions::default());
        let pending_number = number.push(Cow::Owned("6.02e+".to_owned()));
        assert!(pending_number.tokens.is_empty());
        assert!(pending_number.errors.is_empty());
        let completed_number = number.push(Cow::Owned("23 ".to_owned()));
        assert!(completed_number.errors.is_empty());
        assert_eq!(completed_number.tokens[0].kind, TokenKind::Number);
        assert_eq!(completed_number.tokens[0].text, "6.02e+23");

        let mut temporal = LexerSession::new(LexerOptions::default());
        let pending_temporal = temporal.push(Cow::Owned("2024-02-".to_owned()));
        assert!(pending_temporal.tokens.is_empty());
        assert!(pending_temporal.errors.is_empty());
        let completed_temporal = temporal.push(Cow::Owned("29 ".to_owned()));
        assert!(completed_temporal.errors.is_empty());
        assert_eq!(completed_temporal.tokens[0].kind, TokenKind::Number);
        assert_eq!(completed_temporal.tokens[0].text, "2024-02-29");

        let mut prefixed = LexerSession::new(LexerOptions::default());
        let pending_prefixed = prefixed.push(Cow::Owned("#00_".to_owned()));
        assert!(pending_prefixed.tokens.is_empty());
        assert!(pending_prefixed.errors.is_empty());
        let completed_prefixed = prefixed.push(Cow::Owned("Ff ".to_owned()));
        assert!(completed_prefixed.errors.is_empty());
        assert_eq!(completed_prefixed.tokens[0].kind, TokenKind::HexLiteral);
        assert_eq!(completed_prefixed.tokens[0].text, "#00_Ff");

        let mut separator = LexerSession::new(LexerOptions::default());
        let pending_separator = separator.push(Cow::Owned("^root\"left".to_owned()));
        assert!(pending_separator.tokens.is_empty());
        assert!(pending_separator.errors.is_empty());
        let completed_separator = separator.push(Cow::Owned(" right\"tail ".to_owned()));
        assert!(completed_separator.errors.is_empty());
        assert_eq!(
            completed_separator.tokens[0].kind,
            TokenKind::SeparatorLiteral
        );
        assert_eq!(
            completed_separator.tokens[0].text,
            "^root\"left right\"tail"
        );
    }

    #[test]
    fn incomplete_numeric_and_temporal_errors_are_deferred_to_finish() {
        for (source, code) in [("1e+", "INVALID_NUMBER"), ("2025-13-40", "INVALID_DATE")] {
            let mut lexer = LexerSession::new(LexerOptions::default());
            let pushed = lexer.push(Cow::Owned(source.to_owned()));
            assert!(pushed.tokens.is_empty(), "{source}");
            assert!(pushed.errors.is_empty(), "{source}");

            let finished = lexer.finish();
            assert_eq!(finished.errors.len(), 1, "{source}");
            assert_eq!(finished.errors[0].code, code, "{source}");
            assert_eq!(finished.errors[0].span.start.offset, 0, "{source}");
            assert_eq!(finished.errors[0].span.end.offset, source.len(), "{source}");
        }
    }

    #[test]
    fn comments_emit_only_at_deterministic_boundary_or_finish() {
        let options = LexerOptions {
            include_comments: true,
            ..LexerOptions::default()
        };

        let mut line = LexerSession::new(options);
        let pending_line = line.push(Cow::Owned("// pending 🌊".to_owned()));
        assert!(pending_line.tokens.is_empty());
        assert!(pending_line.errors.is_empty());
        let finished_line = line.finish();
        assert!(finished_line.errors.is_empty());
        assert_eq!(finished_line.tokens[0].kind, TokenKind::LineComment);
        assert_eq!(finished_line.tokens[0].text, "// pending 🌊");

        let mut block = LexerSession::new(options);
        let pending_block = block.push(Cow::Owned("/@ pending 🌊@".to_owned()));
        assert!(pending_block.tokens.is_empty());
        assert!(pending_block.errors.is_empty());
        let completed_block = block.push(Cow::Owned("/".to_owned()));
        assert!(completed_block.errors.is_empty());
        assert_eq!(completed_block.tokens.len(), 1);
        assert_eq!(completed_block.tokens[0].kind, TokenKind::BlockComment);
        assert_eq!(completed_block.tokens[0].text, "/@ pending 🌊@/");
        assert_eq!(
            completed_block.tokens[0]
                .comment
                .expect("annotation metadata")
                .channel,
            CommentChannel::Annotation
        );
    }

    #[test]
    fn unterminated_block_comment_reports_only_when_finished() {
        let mut lexer = LexerSession::new(LexerOptions {
            include_comments: true,
            ..LexerOptions::default()
        });
        let pushed = lexer.push(Cow::Owned("/{ pending }".to_owned()));
        assert!(pushed.tokens.is_empty());
        assert!(pushed.errors.is_empty());

        let finished = lexer.finish();
        assert_eq!(finished.errors.len(), 1);
        assert_eq!(finished.errors[0].code, "UNTERMINATED_BLOCK_COMMENT");
        assert_eq!(finished.errors[0].span.start.offset, 0);
        assert_eq!(finished.errors[0].span.end.offset, "/{ pending }".len());
        assert_eq!(finished.tokens.len(), 1);
        assert_eq!(finished.tokens[0].kind, TokenKind::Eof);
    }

    #[test]
    fn drained_batches_preserve_prior_token_context() {
        let expected = tokenize("~ $", LexerOptions::default());
        let actual = tokenize_chunks(["~ ", "$"]);
        assert_eq!(actual, expected);
        assert_eq!(actual.tokens[1].kind, TokenKind::Dollar);

        for chunks in [
            vec!["~", "$", ".root "],
            vec!["~", ">", "$", ".root "],
            vec!["~>", "$", ".root "],
        ] {
            let source = chunks.concat();
            let actual = tokenize_chunks(chunks);
            let expected = tokenize(&source, LexerOptions::default());
            assert_eq!(actual, expected, "reference chunks for {source:?}");
            assert_eq!(actual.tokens[1].kind, TokenKind::Dollar);
        }
    }

    #[test]
    fn references_sansa_and_structural_identities_match_at_every_scalar_split() {
        let source = r#"root\root-id\:object = {}
clone = ~$.["root.key"][1].member
pointer = ~>root.@.meta.["x.y"][0]
absolute = $.inventory:string["a\"b","."]
context = ?.name next"#;
        let expected = tokenize(source, LexerOptions::default());
        let mut splits = source
            .char_indices()
            .map(|(index, _)| index)
            .collect::<Vec<_>>();
        splits.push(source.len());

        for split in splits {
            let actual = tokenize_chunks([&source[..split], &source[split..]]);
            assert_eq!(actual, expected, "reference/SANSA split at byte {split}");
        }

        assert!(expected.errors.is_empty());
        assert!(expected.tokens.iter().any(|token| {
            token.kind == TokenKind::StructuralIdentity && token.text == "root-id"
        }));
        assert!(expected.tokens.iter().any(|token| {
            token.kind == TokenKind::SansaAddressLiteral
                && token.text == r#"$.inventory:string["a\"b","."]"#
        }));
    }

    #[test]
    fn structural_identity_diagnostics_and_unclosed_fallback_match_at_every_split() {
        for source in [r#"\\ tail"#, r#"\bad value\ tail"#, r#"\open tail"#] {
            let expected = tokenize(source, LexerOptions::default());
            let mut splits = source
                .char_indices()
                .map(|(index, _)| index)
                .collect::<Vec<_>>();
            splits.push(source.len());

            for split in splits {
                let actual = tokenize_chunks([&source[..split], &source[split..]]);
                assert_eq!(
                    actual, expected,
                    "structural identity split at byte {split} for {source:?}"
                );
            }
        }

        let unclosed = tokenize(r#"\open tail"#, LexerOptions::default());
        assert!(unclosed.errors.is_empty());
        assert_eq!(unclosed.tokens[0].kind, TokenKind::Symbol);
        assert_eq!(unclosed.tokens[0].text, "\\");
        assert_eq!(unclosed.tokens[0].span.end.offset, 1);
    }

    #[test]
    fn structural_identity_and_sansa_state_emit_when_later_chunks_complete_them() {
        let mut identity = LexerSession::new(LexerOptions::default());
        let pending_identity = identity.push(Cow::Owned(r#"\alpha"#.to_owned()));
        assert!(pending_identity.tokens.is_empty());
        assert!(pending_identity.errors.is_empty());
        let completed_identity = identity.push(Cow::Owned("-1\\ ".to_owned()));
        assert!(completed_identity.errors.is_empty());
        assert_eq!(
            completed_identity.tokens[0].kind,
            TokenKind::StructuralIdentity
        );
        assert_eq!(completed_identity.tokens[0].text, "alpha-1");

        let mut sansa = LexerSession::new(LexerOptions::default());
        let pending_sansa = sansa.push(Cow::Owned(r#"$.root["left\"#.to_owned()));
        assert!(pending_sansa.tokens.is_empty());
        assert!(pending_sansa.errors.is_empty());
        let completed_sansa = sansa.push(Cow::Owned(r#""right"] tail"#.to_owned()));
        assert!(completed_sansa.errors.is_empty());
        assert_eq!(
            completed_sansa.tokens[0].kind,
            TokenKind::SansaAddressLiteral
        );
        assert_eq!(completed_sansa.tokens[0].text, r#"$.root["left\"right"]"#);
    }

    #[test]
    fn diagnostic_cap_is_session_wide_across_chunks() {
        let invalid = "\u{00a8}";
        let chunks = std::iter::repeat_n(invalid, super::MAX_LEX_ERRORS + 32);
        let result = tokenize_chunks(chunks);
        assert_eq!(result.errors.len(), super::MAX_LEX_ERRORS + 1);
        assert_eq!(
            result.errors.last().map(|error| error.code.as_str()),
            Some("LEX_ERROR_LIMIT_EXCEEDED")
        );
    }

    #[test]
    fn includes_newlines_when_requested() {
        let result = tokenize(
            "a = 1\nb = 2",
            LexerOptions {
                include_newlines: true,
                ..LexerOptions::default()
            },
        );
        assert!(
            result
                .tokens
                .iter()
                .any(|token| token.kind == TokenKind::Newline)
        );
    }

    #[test]
    fn includes_comments_with_metadata_when_requested() {
        let result = tokenize(
            "/# doc#/",
            LexerOptions {
                include_comments: true,
                ..LexerOptions::default()
            },
        );
        assert_eq!(result.tokens[0].kind, TokenKind::BlockComment);
        assert_eq!(
            result.tokens[0].comment.expect("comment metadata").channel,
            CommentChannel::Doc
        );
    }

    #[test]
    fn tracks_spans_incrementally() {
        let result = tokenize(
            "a = 1\nb = 2",
            LexerOptions {
                include_newlines: true,
                ..LexerOptions::default()
            },
        );
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
    fn rejects_hex_literals_with_double_underscore() {
        let result = tokenize("hex = #F__f", LexerOptions::default());
        assert_eq!(result.errors.len(), 1);
        assert!(result.errors[0].message.contains("Invalid hex literal"));
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
    fn tokenizes_leading_dot_radix_literals() {
        for source in ["value = %.1", "value = %+.1", "value = %-.3"] {
            let result = tokenize(source, LexerOptions::default());
            assert!(result.errors.is_empty(), "{source}");
            let token = result
                .tokens
                .iter()
                .find(|token| token.kind == TokenKind::RadixLiteral)
                .expect("radix token");
            let expected = match source.split_whitespace().last() {
                Some(value) => value,
                None => panic!("missing expected radix literal token in source: {source}"),
            };
            assert_eq!(token.text, expected, "{source}");
        }
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
        let source = "value = %_1";
        let result = tokenize(source, LexerOptions::default());
        assert!(result.errors.is_empty(), "{source}");
        assert_eq!(result.tokens[2].kind, TokenKind::Percent, "{source}");
    }

    #[test]
    fn tokenizes_padded_base64url_encoding_literals() {
        let result = tokenize("value = &abc-_==", LexerOptions::default());
        assert!(result.errors.is_empty());
        let token = result
            .tokens
            .iter()
            .find(|token| token.kind == TokenKind::EncodingLiteral)
            .expect("encoding token");
        assert_eq!(token.text, "&abc-_==");
    }

    #[test]
    fn rejects_standard_base64_alphabet_characters_in_encoding_literals() {
        let result = tokenize("value = &abc+/==", LexerOptions::default());
        assert_eq!(result.errors.len(), 1);
    }

    #[test]
    fn encoding_literals_terminate_at_non_encoding_boundary_characters() {
        let result = tokenize("value = &abc.", LexerOptions::default());
        assert!(result.errors.is_empty());
        let token = result
            .tokens
            .iter()
            .find(|token| token.kind == TokenKind::EncodingLiteral)
            .expect("encoding token");
        assert_eq!(token.text, "&abc");
    }

    #[test]
    fn rejects_invalid_encoding_start_and_padding_placement() {
        let bad_padding = tokenize("value = &abc=a=", LexerOptions::default());
        assert_eq!(bad_padding.errors.len(), 1);

        let bad_start = tokenize("value = &=abc", LexerOptions::default());
        assert!(bad_start.errors.is_empty());
        assert_eq!(bad_start.tokens[2].kind, TokenKind::Ampersand);
    }

    #[test]
    fn dollar_prefixed_text_is_not_encoding_literal() {
        let result = tokenize("value = $abc", LexerOptions::default());
        assert!(result.errors.is_empty());
        assert_eq!(result.tokens[2].kind, TokenKind::SansaAddressLiteral);
    }

    #[test]
    fn sansa_address_literals_terminate_before_comments_and_container_boundaries() {
        let line_comment = tokenize(
            "$.name// hello",
            LexerOptions {
                include_comments: true,
                ..LexerOptions::default()
            },
        );
        assert!(line_comment.errors.is_empty());
        assert_eq!(line_comment.tokens[0].kind, TokenKind::SansaAddressLiteral);
        assert_eq!(line_comment.tokens[0].text, "$.name");
        assert_eq!(line_comment.tokens[1].kind, TokenKind::LineComment);

        let block_comment = tokenize(
            "$.name/* hello */",
            LexerOptions {
                include_comments: true,
                ..LexerOptions::default()
            },
        );
        assert!(block_comment.errors.is_empty());
        assert_eq!(block_comment.tokens[0].kind, TokenKind::SansaAddressLiteral);
        assert_eq!(block_comment.tokens[0].text, "$.name");
        assert_eq!(block_comment.tokens[1].kind, TokenKind::BlockComment);

        let list = tokenize("[$.name]", LexerOptions::default());
        assert!(list.errors.is_empty());
        assert_eq!(list.tokens[1].kind, TokenKind::SansaAddressLiteral);
        assert_eq!(list.tokens[1].text, "$.name");
        assert_eq!(list.tokens[2].kind, TokenKind::RightBracket);

        let tuple = tokenize("($.name)", LexerOptions::default());
        assert!(tuple.errors.is_empty());
        assert_eq!(tuple.tokens[1].kind, TokenKind::SansaAddressLiteral);
        assert_eq!(tuple.tokens[1].text, "$.name");
        assert_eq!(tuple.tokens[2].kind, TokenKind::RightParen);
    }

    #[test]
    fn separator_literals_terminate_before_line_comments() {
        let result = tokenize(
            "^aaa// hello",
            LexerOptions {
                include_comments: true,
                ..LexerOptions::default()
            },
        );
        assert!(result.errors.is_empty());
        assert_eq!(result.tokens[0].kind, TokenKind::SeparatorLiteral);
        assert_eq!(result.tokens[0].text, "^aaa");
        assert_eq!(result.tokens[1].kind, TokenKind::LineComment);
        assert_eq!(result.tokens[1].text, "// hello");
    }

    #[test]
    fn bare_caret_tokenizes_as_caret_before_bracket_close() {
        let result = tokenize("x:sep[^] = ^1", LexerOptions::default());
        assert!(result.errors.is_empty());
        assert!(
            result
                .tokens
                .iter()
                .any(|token| token.kind == TokenKind::Caret && token.text == "^")
        );
    }

    #[test]
    fn separator_literals_preserve_quoted_segments_with_punctuation() {
        let result = tokenize(
            "^\"hello world\"|\"this, [is] fine\",tail",
            LexerOptions::default(),
        );
        assert!(result.errors.is_empty());
        assert_eq!(result.tokens[0].kind, TokenKind::SeparatorLiteral);
        assert_eq!(
            result.tokens[0].text,
            "^\"hello world\"|\"this, [is] fine\""
        );
        assert_eq!(result.tokens[1].kind, TokenKind::Comma);
    }

    #[test]
    fn separator_literals_reject_unterminated_quoted_sections() {
        let result = tokenize("^&\"*+,-.", LexerOptions::default());
        assert_eq!(result.errors.len(), 1);
        assert_eq!(result.errors[0].code, "UNTERMINATED_STRING");
    }

    #[test]
    fn separator_literals_stop_before_raw_slashes() {
        let result = tokenize("^root/main", LexerOptions::default());
        assert_eq!(result.tokens[0].kind, TokenKind::SeparatorLiteral);
        assert_eq!(result.tokens[0].text, "^root");
        assert!(result.errors.is_empty());
    }

    #[test]
    fn separator_literals_stop_before_raw_spaces() {
        let result = tokenize("^aaa bbb", LexerOptions::default());
        assert_eq!(result.tokens[0].kind, TokenKind::SeparatorLiteral);
        assert_eq!(result.tokens[0].text, "^aaa");
        assert_eq!(result.tokens[1].kind, TokenKind::Identifier);
        assert_eq!(result.tokens[1].text, "bbb");
    }

    #[test]
    fn lexer_caps_unexpected_character_diagnostics() {
        let payload = "\u{00a8}".repeat(super::MAX_LEX_ERRORS + 32);
        let result = tokenize(&payload, LexerOptions::default());

        assert_eq!(result.errors.len(), super::MAX_LEX_ERRORS + 1);
        assert_eq!(
            result.errors.last().map(|error| error.code.as_str()),
            Some("LEX_ERROR_LIMIT_EXCEEDED")
        );
    }

    #[test]
    fn nul_scalar_advances_inside_and_outside_strings() {
        let outside = "before\0after";
        let outside_result = tokenize(outside, LexerOptions::default());
        assert_eq!(outside_result.errors.len(), 1);
        assert_eq!(outside_result.errors[0].code, "UNEXPECTED_CHARACTER");
        assert_eq!(
            outside_result
                .tokens
                .last()
                .map(|token| token.span.end.offset),
            Some(outside.len())
        );

        let inside = "value = \"before\0after\"";
        let inside_result = tokenize(inside, LexerOptions::default());
        assert!(inside_result.errors.is_empty());
        assert_eq!(
            inside_result
                .tokens
                .last()
                .map(|token| token.span.end.offset),
            Some(inside.len())
        );
        assert!(
            inside_result.tokens.iter().any(|token| {
                token.kind == TokenKind::String && token.text == "\"before\0after\""
            })
        );
    }
}
