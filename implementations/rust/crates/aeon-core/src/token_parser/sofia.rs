use std::borrow::Cow;
use std::cell::Cell;
use std::collections::{BTreeMap, HashSet};
use std::ops::{Deref, DerefMut};

use crate::header::apply_trimticks;
use crate::sansa::parse_address as parse_sansa_address;
use crate::{
    AttributeValue, Binding, Diagnostic, NullLiteralMode, ReferenceSegment, Span, Token, TokenKind,
    TrimtickMetadata, Value,
};

use super::{
    ParserLimits, RESERVED_ATTRIBUTE_KEYS, classify_temporal_literal, datatype_base,
    datatype_bracket_specs, decode_quoted_token, invalid_temporal_literal,
    is_ascii_whitespace_only, is_bare_key_kind, is_reserved_null_sentinel, is_valid_number_literal,
    render_quoted_string, validate_binding_node_datatype, validate_reserved_datatype_adornments,
};

#[derive(Debug, PartialEq, Eq)]
pub(super) enum ParseOutcome {
    Parsed(Vec<Binding>),
    Recovered {
        bindings: Vec<Binding>,
        errors: Vec<Diagnostic>,
    },
    Failed(Diagnostic),
}

pub(super) fn parse_document(tokens: &[Token], limits: ParserLimits) -> ParseOutcome {
    let mut session = ParserSession::new(limits, false);
    session
        .finish_tokens(Cow::Borrowed(tokens))
        .expect("one-shot Sofia tokens contain exactly one final EOF")
}

pub(super) fn parse_document_recovery(tokens: &[Token], limits: ParserLimits) -> ParseOutcome {
    let mut session = ParserSession::new(limits, true);
    session
        .finish_tokens(Cow::Borrowed(tokens))
        .expect("one-shot Sofia tokens contain exactly one final EOF")
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum ParserSessionError {
    Finished,
    EofBeforeFinish,
    MissingFinalEof,
}

#[derive(Debug, PartialEq, Eq)]
pub(super) enum ParserSessionProgress {
    NeedMoreInput,
    Complete(ParseOutcome),
}

pub(super) struct ParserSession<'a> {
    tokens: Cow<'a, [Token]>,
    token_start_index: usize,
    completed_binding_cursor: usize,
    state: ParserState,
    frames: Vec<Frame>,
    product: Option<Product>,
    finished: bool,
}

impl<'a> ParserSession<'a> {
    pub(super) fn new(limits: ParserLimits, recovery: bool) -> Self {
        Self {
            tokens: Cow::Owned(Vec::new()),
            token_start_index: 0,
            completed_binding_cursor: 0,
            state: ParserState::new(limits, recovery),
            frames: vec![Frame::Document(DocumentFrame::new())],
            product: None,
            finished: false,
        }
    }

    #[allow(dead_code)]
    pub(super) fn push_tokens(
        &mut self,
        tokens: Cow<'a, [Token]>,
    ) -> Result<ParserSessionProgress, ParserSessionError> {
        if self.finished {
            return Err(ParserSessionError::Finished);
        }
        if tokens.iter().any(|token| token.kind == TokenKind::Eof) {
            return Err(ParserSessionError::EofBeforeFinish);
        }
        self.append_tokens(tokens);
        if let Some(outcome) = self.run_available(false) {
            self.finished = true;
            Ok(ParserSessionProgress::Complete(outcome))
        } else {
            self.compact_consumed_tokens();
            Ok(ParserSessionProgress::NeedMoreInput)
        }
    }

    pub(super) fn finish_tokens(
        &mut self,
        tokens: Cow<'a, [Token]>,
    ) -> Result<ParseOutcome, ParserSessionError> {
        if self.finished {
            return Err(ParserSessionError::Finished);
        }
        let Some((last, prefix)) = tokens.split_last() else {
            return Err(ParserSessionError::MissingFinalEof);
        };
        if last.kind != TokenKind::Eof {
            return Err(ParserSessionError::MissingFinalEof);
        }
        if prefix.iter().any(|token| token.kind == TokenKind::Eof) {
            return Err(ParserSessionError::EofBeforeFinish);
        }

        self.append_tokens(tokens);
        self.finished = true;
        Ok(self
            .run_available(true)
            .expect("final EOF must drive the Sofia parser to a terminal outcome"))
    }

    fn append_tokens(&mut self, tokens: Cow<'a, [Token]>) {
        if self.tokens.is_empty() {
            self.tokens = tokens;
        } else {
            self.tokens.to_mut().extend_from_slice(&tokens);
        }
    }

    fn compact_consumed_tokens(&mut self) {
        let mut retain_from = self
            .state
            .current
            .saturating_sub(1)
            .max(self.token_start_index);
        for frame in &self.frames {
            if let Some(index) = frame.earliest_retained_token() {
                retain_from = retain_from.min(index);
            }
        }

        let drain = retain_from.saturating_sub(self.token_start_index);
        if drain == 0 {
            return;
        }
        self.tokens.to_mut().drain(..drain);
        self.token_start_index = retain_from;
    }

    /// Borrows top-level bindings whose terminating delimiter has been parsed
    /// since the previous call. The parser retains the sole AST copy until the
    /// whole-document validation pipeline can consume it.
    pub(super) fn newly_completed_bindings(&mut self) -> &[Binding] {
        let Some(document_index) = self
            .frames
            .iter()
            .position(|frame| matches!(frame, Frame::Document(_)))
        else {
            return &[];
        };
        let Frame::Document(document) = &self.frames[document_index] else {
            unreachable!("located Sofia document frame changed variant");
        };
        debug_assert!(self.completed_binding_cursor <= document.bindings.len());
        let start = self.completed_binding_cursor;
        self.completed_binding_cursor = document.bindings.len();
        &document.bindings[start..]
    }

    /// Releases every top-level binding already reported through
    /// `newly_completed_bindings`. The active binding under construction is
    /// held by its own frame and is unaffected.
    pub(super) fn release_completed_bindings(&mut self) -> usize {
        let Some(document) = self.frames.iter_mut().find_map(|frame| match frame {
            Frame::Document(document) => Some(document),
            _ => None,
        }) else {
            return 0;
        };
        debug_assert_eq!(self.completed_binding_cursor, document.bindings.len());
        let released = std::mem::take(&mut document.bindings).len();
        self.completed_binding_cursor = 0;
        released
    }

    pub(super) fn retained_token_count(&self) -> usize {
        self.tokens.len()
    }

    pub(super) fn retained_token_storage_bytes(&self) -> usize {
        match &self.tokens {
            Cow::Borrowed(_) => 0,
            Cow::Owned(tokens) => tokens
                .capacity()
                .saturating_mul(std::mem::size_of::<Token>())
                .saturating_add(
                    tokens
                        .iter()
                        .map(|token| token.text.capacity())
                        .sum::<usize>(),
                ),
        }
    }

    pub(super) fn active_frame_count(&self) -> usize {
        self.frames.len()
    }

    pub(super) fn structural_identity_count(&self) -> usize {
        self.state.structural_identities.len()
    }

    pub(super) fn structural_identity_storage_bytes(&self) -> usize {
        self.state
            .structural_identities
            .capacity()
            .saturating_mul(std::mem::size_of::<String>())
            .saturating_add(
                self.state
                    .structural_identities
                    .iter()
                    .map(String::capacity)
                    .sum::<usize>(),
            )
    }

    pub(super) fn completed_binding_count(&self) -> usize {
        self.frames
            .iter()
            .find_map(|frame| match frame {
                Frame::Document(document) => Some(document.bindings.len()),
                _ => None,
            })
            .unwrap_or(0)
    }

    pub(super) fn completed_binding_storage_bytes(&self) -> usize {
        self.frames
            .iter()
            .find_map(|frame| match frame {
                Frame::Document(document) => Some(
                    document
                        .bindings
                        .capacity()
                        .saturating_mul(std::mem::size_of::<Binding>()),
                ),
                _ => None,
            })
            .unwrap_or(0)
    }

    fn run_available(&mut self, final_input: bool) -> Option<ParseOutcome> {
        debug_assert_eq!(
            self.tokens.last().map(|token| token.kind) == Some(TokenKind::Eof),
            final_input
        );

        loop {
            let frame = self
                .frames
                .pop()
                .expect("Sofia frame stack exhausted without a document product");
            let frame_snapshot = (!final_input).then(|| frame.clone());

            debug_assert_eq!(
                self.state.current_value_nesting_depth,
                self.frames
                    .iter()
                    .filter(|frame| frame.counts_as_value_container())
                    .count()
                    + usize::from(frame.counts_as_value_container()),
                "Sofia value depth diverged from active container frames",
            );

            let input = self.product.take();
            let input_snapshot = (!final_input).then(|| input.clone());
            let state_snapshot = (!final_input).then(|| self.state.clone());
            let (step, needs_token) = {
                let mut parser = Parser::new(
                    &self.tokens,
                    self.token_start_index,
                    &mut self.state,
                    final_input,
                );
                let step = frame.step(&mut parser, input, &mut self.product);
                (step, parser.needs_token())
            };
            // A streaming transition may discover that it needs current or
            // lookahead input only after entering a helper. Roll the entire
            // transition back so the durable session exposes no partial
            // consumption or mutation. Final one-shot parsing skips snapshots.
            if needs_token {
                debug_assert!(!final_input, "final Sofia parse requested another token");
                self.state = state_snapshot.expect("streaming transition must snapshot state");
                self.product = input_snapshot.expect("streaming transition must snapshot product");
                self.frames
                    .push(frame_snapshot.expect("streaming transition must snapshot its frame"));
                return None;
            }
            match step {
                Step::Continue(frame) => {
                    debug_assert!(
                        self.product.is_none(),
                        "Sofia continue transition produced an unconsumed product"
                    );
                    self.frames.push(frame);
                }
                Step::Push { parent, child } => {
                    debug_assert!(
                        self.product.is_none(),
                        "Sofia push transition produced an unconsumed product"
                    );
                    self.frames.push(parent);
                    self.frames.push(child);
                }
                Step::Complete if self.frames.is_empty() => {
                    return Some(match self.product.take() {
                        Some(Product::Document(document)) => {
                            debug_assert_eq!(self.state.current_value_nesting_depth, 0);
                            debug_assert!(
                                Parser::new(
                                    &self.tokens,
                                    self.token_start_index,
                                    &mut self.state,
                                    true,
                                )
                                .is_at_end()
                            );
                            debug_assert!(self.frames.is_empty());
                            debug_assert!(self.product.is_none());
                            if self.state.recovery {
                                ParseOutcome::Recovered {
                                    bindings: document.bindings,
                                    errors: document.errors,
                                }
                            } else {
                                debug_assert!(document.errors.is_empty());
                                ParseOutcome::Parsed(document.bindings)
                            }
                        }
                        Some(
                            Product::AttributeEntry(_)
                            | Product::Attributes(_)
                            | Product::Binding(_)
                            | Product::Datatype(_)
                            | Product::Values(_)
                            | Product::Value(_),
                        )
                        | None => unreachable!("Sofia root frame returned the wrong product"),
                    });
                }
                Step::Complete => {
                    debug_assert!(
                        self.product.is_some(),
                        "Sofia frame completed without a product"
                    );
                }
                Step::Failed(error) => {
                    debug_assert!(
                        self.product.is_none(),
                        "Sofia failure transition produced an unconsumed product"
                    );
                    let mut document = None;
                    let mut unwound = Vec::new();
                    while let Some(parent) = self.frames.pop() {
                        unwound.push(parent.clone());
                        if let Frame::Document(frame) = parent {
                            document = Some(frame);
                            break;
                        }
                    }
                    let Some(frame) = document else {
                        return Some(ParseOutcome::Failed(error));
                    };
                    let (recovery, recovery_needs_token) = {
                        let mut parser = Parser::new(
                            &self.tokens,
                            self.token_start_index,
                            &mut self.state,
                            final_input,
                        );
                        let recovery = frame.recover_child_failure(&mut parser, error);
                        (recovery, parser.needs_token())
                    };
                    if recovery_needs_token {
                        debug_assert!(!final_input, "final Sofia recovery requested another token");
                        self.state =
                            state_snapshot.expect("streaming transition must snapshot state");
                        self.product =
                            input_snapshot.expect("streaming transition must snapshot product");
                        self.frames.extend(unwound.into_iter().rev());
                        self.frames.push(
                            frame_snapshot.expect("streaming transition must snapshot its frame"),
                        );
                        return None;
                    }
                    match recovery {
                        Ok(frame) => self.frames.push(Frame::Document(frame)),
                        Err(error) => return Some(ParseOutcome::Failed(error)),
                    }
                }
            }
        }
    }
}

#[cfg(feature = "sofia-fuzz")]
pub(super) fn fuzz_incremental_session(data: &[u8], limits: ParserLimits) {
    use crate::lexer::LexerSession;
    use crate::utf8_decoder::Utf8Decoder;
    use crate::{LexerOptions, tokenize};

    let Some((&header, remainder)) = data.split_first() else {
        return;
    };
    let plan_len = usize::from(header & 0x0f).min(remainder.len());
    let (plan, source) = remainder.split_at(plan_len);
    let recovery = header & 0x10 != 0;
    let options = LexerOptions {
        include_newlines: true,
        ..LexerOptions::default()
    };

    let mut decoder = Utf8Decoder::default();
    let mut lexer = LexerSession::new(options);
    let mut parser = ParserSession::new(limits, recovery);
    let mut incremental_tokens = Vec::new();
    let mut incremental_errors = Vec::new();
    let mut terminal = None;
    let mut consumed = 0usize;
    let mut operation = 0usize;

    while consumed < source.len() {
        let opcode = plan
            .get(operation % plan.len().max(1))
            .copied()
            .unwrap_or(0);
        operation += 1;
        let action = opcode & 0x03;
        let chunk_size = 1 + usize::from(opcode >> 2);

        if action == 1 && terminal.is_none() {
            match parser
                .push_tokens(Cow::Owned(Vec::new()))
                .expect("empty non-final fuzz push should be accepted")
            {
                ParserSessionProgress::NeedMoreInput => {}
                ParserSessionProgress::Complete(outcome) => terminal = Some(outcome),
            }
        }

        let end = (consumed + chunk_size).min(source.len());
        let mut decoded = Vec::new();
        if decoder
            .push(&source[consumed..end], |_, text| {
                decoded.push(text.to_owned());
            })
            .is_err()
        {
            return;
        }
        consumed = end;

        for text in decoded {
            let batch = lexer.push(Cow::Owned(text));
            incremental_tokens.extend(batch.tokens.iter().cloned());
            incremental_errors.extend(batch.errors.iter().cloned());
            if terminal.is_none() {
                match parser
                    .push_tokens(Cow::Owned(batch.tokens))
                    .expect("non-final fuzz token batch should be accepted")
                {
                    ParserSessionProgress::NeedMoreInput => {}
                    ParserSessionProgress::Complete(outcome) => terminal = Some(outcome),
                }
            }
        }

        if action == 2 && terminal.is_none() {
            match parser
                .push_tokens(Cow::Owned(Vec::new()))
                .expect("empty non-final fuzz push should be accepted")
            {
                ParserSessionProgress::NeedMoreInput => {}
                ParserSessionProgress::Complete(outcome) => terminal = Some(outcome),
            }
        }
        if action == 3 {
            break;
        }
    }

    if decoder.finish().is_err() {
        return;
    }

    let final_batch = lexer.finish();
    incremental_tokens.extend(final_batch.tokens.iter().cloned());
    incremental_errors.extend(final_batch.errors.iter().cloned());
    if terminal.is_none() {
        terminal = Some(
            parser
                .finish_tokens(Cow::Owned(final_batch.tokens))
                .expect("final fuzz token batch should finish the parser"),
        );
    }

    let source = std::str::from_utf8(&source[..consumed])
        .expect("a successfully finished decoder must contain valid UTF-8");
    let one_shot = tokenize(source, options);
    assert_eq!(incremental_tokens, one_shot.tokens);
    assert_eq!(incremental_errors, one_shot.errors);

    if one_shot.errors.is_empty() {
        let expected = if recovery {
            parse_document_recovery(&one_shot.tokens, limits)
        } else {
            parse_document(&one_shot.tokens, limits)
        };
        assert_eq!(terminal, Some(expected));
    }

    assert_eq!(
        parser.push_tokens(Cow::Owned(Vec::new())),
        Err(ParserSessionError::Finished)
    );
    assert!(matches!(
        parser.finish_tokens(Cow::Owned(Vec::new())),
        Err(ParserSessionError::Finished)
    ));
}

#[derive(Clone)]
struct ParserState {
    current: usize,
    max_value_nesting_depth: usize,
    max_attribute_depth: usize,
    max_clarifier_values: usize,
    max_generic_depth: usize,
    max_generic_arguments: usize,
    max_datatype_components: usize,
    current_value_nesting_depth: usize,
    current_datatype_components: usize,
    structural_identities: HashSet<String>,
    recovery: bool,
}

impl ParserState {
    fn new(limits: ParserLimits, recovery: bool) -> Self {
        Self {
            current: 0,
            max_value_nesting_depth: limits.max_value_nesting_depth,
            max_attribute_depth: limits.max_attribute_depth,
            max_clarifier_values: limits.max_clarifier_values,
            max_generic_depth: limits.max_generic_depth,
            max_generic_arguments: limits.max_generic_arguments,
            max_datatype_components: limits.max_datatype_components,
            current_value_nesting_depth: 0,
            current_datatype_components: 0,
            structural_identities: HashSet::new(),
            recovery,
        }
    }
}

struct Parser<'tokens, 'state> {
    tokens: &'tokens [Token],
    token_start_index: usize,
    state: &'state mut ParserState,
    final_input: bool,
    needs_token: Cell<bool>,
}

static UNAVAILABLE_TOKEN: Token = Token {
    kind: TokenKind::Eof,
    text: String::new(),
    span: Span::zero(),
    comment: None,
    quote: None,
};

impl<'tokens, 'state> Deref for Parser<'tokens, 'state> {
    type Target = ParserState;

    fn deref(&self) -> &Self::Target {
        self.state
    }
}

impl DerefMut for Parser<'_, '_> {
    fn deref_mut(&mut self) -> &mut Self::Target {
        self.state
    }
}

impl<'tokens, 'state> Parser<'tokens, 'state> {
    fn new(
        tokens: &'tokens [Token],
        token_start_index: usize,
        state: &'state mut ParserState,
        final_input: bool,
    ) -> Self {
        Self {
            tokens,
            token_start_index,
            state,
            final_input,
            needs_token: Cell::new(false),
        }
    }

    fn needs_token(&self) -> bool {
        self.needs_token.get()
    }

    fn unavailable_token(&self) -> &'tokens Token {
        debug_assert!(
            !self.final_input,
            "final Sofia parse exhausted its EOF token"
        );
        // The EOF-shaped sentinel lets existing transitions unwind normally.
        // `run_available` observes this flag and restores the pre-step state,
        // so the sentinel can never become a semantic EOF or diagnostic.
        self.needs_token.set(true);
        &UNAVAILABLE_TOKEN
    }

    fn parse_scalar(&mut self) -> Result<Option<Value>, Diagnostic> {
        let token = self.peek();
        match token.kind {
            TokenKind::String => {
                let token = self.advance();
                Ok(Some(Value::StringLiteral {
                    value: decode_quoted_token(token)?,
                    raw: token.text[1..token.text.len() - 1].to_string(),
                    delimiter: token.quote.unwrap_or('"'),
                    trimticks: None,
                }))
            }
            TokenKind::Number => {
                let raw = self.advance().text.clone();
                if let Some(value) = classify_temporal_literal(&raw) {
                    return Ok(Some(value));
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
                Ok(Some(Value::NumberLiteral { raw }))
            }
            TokenKind::Identifier if token.text == "Infinity" => {
                let token = self.advance();
                Ok(Some(Value::InfinityLiteral {
                    raw: token.text.clone(),
                    span: token.span,
                }))
            }
            TokenKind::Identifier if token.text == "NaN" => {
                let token = self.advance();
                Ok(Some(Value::NaNLiteral {
                    raw: token.text.clone(),
                    span: token.span,
                }))
            }
            TokenKind::Symbol
                if token.text == "-"
                    && self.peek_next().kind == TokenKind::Identifier
                    && self.peek_next().text == "Infinity" =>
            {
                let start = self.advance().span.start;
                let end = self.advance().span.end;
                Ok(Some(Value::InfinityLiteral {
                    raw: String::from("-Infinity"),
                    span: Span { start, end },
                }))
            }
            TokenKind::Symbol
                if token.text == "-"
                    && self.peek_next().kind == TokenKind::Identifier
                    && self.peek_next().text == "NaN" =>
            {
                let start = self.advance().span.start;
                let end = self.advance().span.end;
                Ok(Some(Value::NaNLiteral {
                    raw: String::from("-NaN"),
                    span: Span { start, end },
                }))
            }
            TokenKind::Symbol if token.text == "!" => self.parse_null_literal(),
            TokenKind::True | TokenKind::False => Ok(Some(Value::BooleanLiteral {
                raw: self.advance().text.clone(),
            })),
            TokenKind::Yes | TokenKind::No | TokenKind::On | TokenKind::Off => {
                Ok(Some(Value::ToggleLiteral {
                    raw: self.advance().text.clone(),
                }))
            }
            TokenKind::HexLiteral => Ok(Some(Value::HexLiteral {
                raw: self.advance().text.clone(),
            })),
            TokenKind::RadixLiteral => Ok(Some(Value::RadixLiteral {
                raw: self.advance().text.clone(),
            })),
            TokenKind::EncodingLiteral => Ok(Some(Value::EncodingLiteral {
                raw: self.advance().text.clone(),
            })),
            TokenKind::SeparatorLiteral => Ok(Some(Value::SeparatorLiteral {
                raw: self.advance().text.clone(),
            })),
            TokenKind::SansaAddressLiteral => {
                let token = self.advance();
                let raw = token.text.clone();
                let address = parse_sansa_address(&raw).map_err(|error| Diagnostic {
                    code: String::from("SYNTAX_ERROR"),
                    path: Some(String::from("$")),
                    span: Some(token.span),
                    phase: None,
                    message: error.message,
                })?;
                let canonical = address.canonical.clone();
                Ok(Some(Value::SansaAddressLiteral {
                    address,
                    raw,
                    canonical,
                }))
            }
            TokenKind::RightAngle => self.parse_trimtick(),
            _ => Ok(None),
        }
    }

    fn parse_null_literal(&mut self) -> Result<Option<Value>, Diagnostic> {
        let bang = self.advance().span;
        match self.peek().kind {
            TokenKind::Identifier => {
                let token = self.peek();
                let span = Span {
                    start: bang.start,
                    end: token.span.end,
                };
                if !is_reserved_null_sentinel(&token.text) {
                    return Err(Diagnostic::new(
                        "INVALID_NULL_SENTINEL",
                        format!("Invalid null sentinel '{}'", token.text),
                    )
                    .at_path("$")
                    .with_span(span));
                }
                let value = self.advance().text.clone();
                Ok(Some(Value::NullLiteral {
                    mode: NullLiteralMode::Reserved,
                    raw: format!("!{value}"),
                    value,
                }))
            }
            TokenKind::String => {
                let token = self.advance();
                let value = decode_quoted_token(token)?;
                let span = Span {
                    start: bang.start,
                    end: token.span.end,
                };
                if value.is_empty() {
                    return Err(Diagnostic::new(
                        "INVALID_NULL_REASON_EMPTY",
                        "Null reason must not be empty",
                    )
                    .at_path("$")
                    .with_span(span));
                }
                if is_ascii_whitespace_only(&value) {
                    return Err(Diagnostic::new(
                        "INVALID_NULL_REASON_WHITESPACE",
                        "Null reason must not be ASCII-whitespace-only",
                    )
                    .at_path("$")
                    .with_span(span));
                }
                if is_reserved_null_sentinel(&value) {
                    return Err(Diagnostic::new(
                        "INVALID_NULL_REASON_COLLISION",
                        format!("Null reason collides with reserved sentinel '{value}'"),
                    )
                    .at_path("$")
                    .with_span(span));
                }
                Ok(Some(Value::NullLiteral {
                    mode: NullLiteralMode::Reason,
                    raw: format!("!{}", render_quoted_string(&value)),
                    value,
                }))
            }
            _ => Err(Diagnostic::new(
                "INVALID_NULL_LITERAL",
                "Null literal must be followed by a reserved sentinel or quoted reason",
            )
            .at_path("$")
            .with_span(bang)),
        }
    }

    fn parse_trimtick(&mut self) -> Result<Option<Value>, Diagnostic> {
        let mut marker_width = 0usize;
        let mut previous_end = None;
        while self.check(TokenKind::RightAngle) {
            let token = self.peek();
            if previous_end.is_some_and(|end| end != token.span.start.offset) {
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
        let raw = decode_quoted_token(self.advance())?;
        Ok(Some(Value::StringLiteral {
            value: apply_trimticks(&raw, marker_width),
            raw: raw.clone(),
            delimiter: '`',
            trimticks: Some(TrimtickMetadata {
                marker_width,
                raw_value: raw,
            }),
        }))
    }

    fn enter_value_container(&mut self) -> Result<(), Diagnostic> {
        self.current_value_nesting_depth += 1;
        if let Some(projected_depth) = self.projected_opening_container_depth() {
            let span = self.peek().span;
            self.current_value_nesting_depth -= 1;
            return Err(Diagnostic {
                code: String::from("NESTING_DEPTH_EXCEEDED"),
                path: Some(String::from("$")),
                span: Some(span),
                phase: None,
                message: format!(
                    "Value nesting depth {} exceeds max_value_nesting_depth {}",
                    projected_depth, self.max_value_nesting_depth
                ),
            });
        }
        if self.current_value_nesting_depth > self.max_value_nesting_depth {
            let span = self.peek().span;
            let observed_depth = self.current_value_nesting_depth;
            self.current_value_nesting_depth -= 1;
            return Err(Diagnostic {
                code: String::from("NESTING_DEPTH_EXCEEDED"),
                path: Some(String::from("$")),
                span: Some(span),
                phase: None,
                message: format!(
                    "Value nesting depth {} exceeds max_value_nesting_depth {}",
                    observed_depth, self.max_value_nesting_depth
                ),
            });
        }
        Ok(())
    }

    fn projected_opening_container_depth(&self) -> Option<usize> {
        let mut extra_depth = 0usize;
        let current = self
            .current
            .checked_sub(self.token_start_index)
            .expect("parser cursor must not precede retained tokens");
        for token in &self.tokens[current..] {
            match token.kind {
                TokenKind::LeftBracket
                | TokenKind::LeftParen
                | TokenKind::LeftBrace
                | TokenKind::LeftAngle => extra_depth += 1,
                _ => break,
            }
        }
        let projected_depth = self.current_value_nesting_depth + extra_depth.saturating_sub(1);
        (projected_depth > self.max_value_nesting_depth).then_some(projected_depth)
    }

    fn parse_key(&mut self) -> Result<(String, bool, crate::Position), Diagnostic> {
        let token = self.peek();
        let start = token.span.start;
        match token.kind {
            kind if is_bare_key_kind(kind) => {
                if token.text == "aeon" {
                    let saved = self.current;
                    self.advance();
                    self.skip_newlines();
                    if self.check(TokenKind::Colon) {
                        self.advance();
                        self.skip_newlines();
                        if !self.check(TokenKind::Identifier) {
                            return Err(
                                self.error_at_current("Expected header field after `aeon:`")
                            );
                        }
                        let field = self.advance().text.clone();
                        return Ok((format!("aeon:{field}"), true, start));
                    }
                    self.current = saved;
                }
                Ok((self.advance().text.clone(), false, start))
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
                Ok((key, false, start))
            }
            _ => Err(self.error_at_current("Expected key")),
        }
    }

    fn parse_node_tag(&mut self) -> Result<String, Diagnostic> {
        match self.peek().kind {
            kind if is_bare_key_kind(kind) => Ok(self.advance().text.clone()),
            TokenKind::String => {
                if self.peek().quote == Some('`') {
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
                let key = self.decode_reference_key(key_token)?;
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
            let key = self.decode_reference_key(key_token)?;
            self.consume(
                TokenKind::RightBracket,
                "Expected `]` after quoted reference key",
            )?;
            segments.push(ReferenceSegment::Key(key));
        } else {
            segments.push(ReferenceSegment::Key(self.parse_reference_key()?));
        }

        loop {
            if self.match_kind(TokenKind::Dot) {
                if self.match_kind(TokenKind::At) {
                    self.consume(
                        TokenKind::Dot,
                        "Expected `.` after attribute address-space marker",
                    )?;
                    let key = if self.match_kind(TokenKind::LeftBracket) {
                        let token =
                            self.consume(TokenKind::String, "Expected quoted attribute key")?;
                        let key = self.decode_reference_key(token)?;
                        self.consume(
                            TokenKind::RightBracket,
                            "Expected `]` after quoted attribute key",
                        )?;
                        key
                    } else {
                        self.parse_reference_key()?
                    };
                    segments.push(ReferenceSegment::Attr(key));
                } else {
                    let key = if self.match_kind(TokenKind::LeftBracket) {
                        let token =
                            self.consume(TokenKind::String, "Expected quoted member key")?;
                        let key = self.decode_reference_key(token)?;
                        self.consume(
                            TokenKind::RightBracket,
                            "Expected `]` after quoted member key",
                        )?;
                        key
                    } else {
                        self.parse_reference_key()?
                    };
                    segments.push(ReferenceSegment::Key(key));
                }
                continue;
            }

            if self.match_kind(TokenKind::LeftBracket) {
                if self.check(TokenKind::String) {
                    let token = self.advance();
                    let key = self.decode_reference_key(token)?;
                    self.consume(TokenKind::RightBracket, "Expected `]` after quoted key")?;
                    segments.push(ReferenceSegment::Key(key));
                } else {
                    let token = self.consume(TokenKind::Number, "Expected index segment")?;
                    let index = token
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

        let span = Span {
            start,
            end: self.previous().span.end,
        };
        Ok(if is_pointer {
            Value::PointerReference { segments, span }
        } else {
            Value::CloneReference { segments, span }
        })
    }

    fn parse_reference_key(&mut self) -> Result<String, Diagnostic> {
        match self.peek().kind {
            kind if is_bare_key_kind(kind) => Ok(self.advance().text.clone()),
            TokenKind::String => {
                let token = self.advance();
                self.decode_reference_key(token)
            }
            _ => Err(self.error_at_current("Expected reference path segment")),
        }
    }

    fn decode_reference_key(&self, token: &Token) -> Result<String, Diagnostic> {
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

    fn parse_optional_structural_identity(&mut self) -> Result<Option<String>, Diagnostic> {
        if !self.check(TokenKind::StructuralIdentity) {
            return Ok(None);
        }
        let token = self.advance();
        let identity = token.text.clone();
        if !self.structural_identities.insert(identity.clone()) {
            return Err(Diagnostic::new(
                "DUPLICATE_STRUCTURAL_IDENTITY",
                format!("Duplicate structural identity: '{identity}'"),
            )
            .at_path("$")
            .with_span(token.span));
        }
        Ok(Some(identity))
    }

    fn open_attribute_block(&mut self, depth: usize) -> Result<(), Diagnostic> {
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
        Ok(())
    }

    fn begin_datatype(&mut self) {
        self.current_datatype_components = 0;
    }

    fn try_parse_atomic_datatype(&mut self) -> Result<Option<String>, Diagnostic> {
        if !is_bare_key_kind(self.peek().kind) {
            return Ok(None);
        }
        let mut next = self.current + 1;
        while self.token_at(next).kind == TokenKind::Newline {
            next += 1;
        }
        if matches!(
            self.token_at(next).kind,
            TokenKind::LeftAngle | TokenKind::LeftBracket
        ) {
            return Ok(None);
        }

        self.count_datatype_component(self.peek().span)?;
        let datatype = self.advance().text.clone();
        self.skip_newlines();
        validate_reserved_datatype_adornments(&datatype, self.previous().span)?;
        Ok(Some(datatype))
    }

    fn count_datatype_component(&mut self, span: Span) -> Result<(), Diagnostic> {
        self.current_datatype_components += 1;
        if self.current_datatype_components > self.max_datatype_components {
            return Err(Diagnostic {
                code: String::from("DATATYPE_COMPONENTS_EXCEEDED"),
                path: Some(String::from("$")),
                span: Some(span),
                phase: None,
                message: format!(
                    "Datatype component count {} exceeds max_datatype_components {}",
                    self.current_datatype_components, self.max_datatype_components
                ),
            });
        }
        Ok(())
    }

    fn normalized_datatype(&self, start: usize, end: usize) -> String {
        let start = start
            .checked_sub(self.token_start_index)
            .expect("datatype start must remain retained");
        let end = end
            .checked_sub(self.token_start_index)
            .expect("datatype end must remain retained");
        self.tokens[start..end]
            .iter()
            .fold(String::new(), |mut datatype, token| {
                if token.kind == TokenKind::Number {
                    datatype.push_str(&crate::normalize_number_literal(&token.text));
                } else {
                    datatype.push_str(&token.text);
                }
                datatype
            })
            .chars()
            .filter(|ch| !matches!(ch, ' ' | '\t' | '\n' | '\r'))
            .collect()
    }

    fn leave_value_container(&mut self) {
        debug_assert!(self.current_value_nesting_depth > 0);
        self.current_value_nesting_depth -= 1;
    }

    fn has_separator_collision(&self) -> bool {
        let comma = self.peek();
        let previous_value = self
            .current
            .checked_sub(1)
            .and_then(|index| self.get_token(index));
        let next_token = self.get_token(self.current + 1);
        let could_collide = previous_value
            .is_some_and(|token| token.kind == TokenKind::SeparatorLiteral)
            && previous_value.is_some_and(|token| token.span.end.offset == comma.span.start.offset);
        if could_collide && next_token.is_none() && !self.final_input {
            self.needs_token.set(true);
        }
        could_collide
            && next_token.is_some_and(|token| token.span.start.offset == comma.span.end.offset)
    }

    fn separator_collision_error(&self) -> Diagnostic {
        Diagnostic {
            code: String::from("INVALID_SEPARATOR_CHAR"),
            path: Some(String::from("$")),
            span: Some(self.peek().span),
            phase: None,
            message: String::from("Invalid separator character `,`"),
        }
    }

    fn skip_newlines(&mut self) {
        while self.check(TokenKind::Newline) {
            self.advance();
        }
    }

    fn synchronize_to_next_binding(&mut self) -> bool {
        while !self.is_at_end() {
            let token = self.peek();
            let is_binding_key = is_bare_key_kind(token.kind)
                || (token.kind == TokenKind::String && token.quote != Some('`'));
            if is_binding_key
                && matches!(
                    self.peek_next().kind,
                    TokenKind::Equals | TokenKind::Colon | TokenKind::At
                )
            {
                return true;
            }
            self.advance();
        }
        false
    }

    fn error_at_current(&self, message: impl Into<String>) -> Diagnostic {
        Diagnostic {
            code: String::from("SYNTAX_ERROR"),
            path: Some(String::from("$")),
            span: Some(self.peek().span),
            phase: None,
            message: message.into(),
        }
    }

    fn check(&self, kind: TokenKind) -> bool {
        self.peek().kind == kind
    }

    fn consume(&mut self, kind: TokenKind, message: &str) -> Result<&'tokens Token, Diagnostic> {
        if self.check(kind) {
            return Ok(self.advance());
        }
        Err(self.error_at_current(message))
    }

    fn match_kind(&mut self, kind: TokenKind) -> bool {
        if !self.check(kind) {
            return false;
        }
        self.advance();
        true
    }

    fn is_at_end(&self) -> bool {
        self.check(TokenKind::Eof)
    }

    fn advance(&mut self) -> &'tokens Token {
        if self.current >= self.token_start_index + self.tokens.len() {
            return self.unavailable_token();
        }
        debug_assert!(!self.is_at_end(), "Sofia advanced past EOF");
        let token = self
            .get_token(self.current)
            .expect("parser cursor must address a retained token");
        self.current += 1;
        token
    }

    fn previous(&self) -> &'tokens Token {
        self.get_token(self.current.saturating_sub(1))
            .unwrap_or_else(|| self.unavailable_token())
    }

    fn previous_non_newline(&self) -> &'tokens Token {
        let current = self
            .current
            .saturating_sub(self.token_start_index)
            .min(self.tokens.len());
        self.tokens[..current]
            .iter()
            .rev()
            .find(|token| token.kind != TokenKind::Newline)
            .unwrap_or_else(|| self.previous())
    }

    fn tokens_text(&self, start: usize, end: usize) -> String {
        let start = start
            .checked_sub(self.token_start_index)
            .expect("raw token start must remain retained");
        let end = end
            .checked_sub(self.token_start_index)
            .expect("raw token end must remain retained");
        self.tokens[start..end]
            .iter()
            .map(|token| token.text.as_str())
            .collect()
    }

    fn peek(&self) -> &'tokens Token {
        self.token_at(self.current)
    }

    fn peek_next(&self) -> &'tokens Token {
        if let Some(token) = self.get_token(self.current + 1) {
            return token;
        }
        if self.final_input {
            return self.tokens.last().expect("final token stream has EOF");
        }
        self.unavailable_token()
    }

    fn token_at(&self, index: usize) -> &'tokens Token {
        self.get_token(index)
            .unwrap_or_else(|| self.unavailable_token())
    }

    fn get_token(&self, index: usize) -> Option<&'tokens Token> {
        index
            .checked_sub(self.token_start_index)
            .and_then(|index| self.tokens.get(index))
    }
}

#[derive(Clone)]
enum Frame {
    AttributeEntry(AttributeEntryFrame),
    AttributeMembers(AttributeMembersFrame),
    AnonymousValue(AnonymousValueFrame),
    Datatype(DatatypeFrame),
    Document(DocumentFrame),
    Binding(BindingFrame),
    Node(NodeFrame),
    NodeChildren(NodeChildrenFrame),
    Sequence(ValueSequenceFrame),
    Object(ObjectFrame),
    Value,
}

impl Frame {
    const fn counts_as_value_container(&self) -> bool {
        matches!(self, Self::Node(_) | Self::Sequence(_) | Self::Object(_))
    }

    fn earliest_retained_token(&self) -> Option<usize> {
        match self {
            Self::Datatype(frame) if !matches!(frame.phase, DatatypePhase::Name) => {
                Some(frame.start)
            }
            Self::Node(frame) => Some(frame.start_index()),
            _ => None,
        }
    }

    fn step(
        self,
        parser: &mut Parser<'_, '_>,
        product: Option<Product>,
        output: &mut Option<Product>,
    ) -> Step {
        match self {
            Self::AttributeEntry(frame) => frame.step(parser, product, output),
            Self::AttributeMembers(frame) => frame.step(parser, product, output),
            Self::AnonymousValue(frame) => frame.step(parser, product, output),
            Self::Datatype(frame) => frame.step(parser, product, output),
            Self::Document(frame) => frame.step(parser, product, output),
            Self::Binding(frame) => frame.step(parser, product, output),
            Self::Node(frame) => frame.step(parser, product, output),
            Self::NodeChildren(frame) => frame.step(parser, product, output),
            Self::Sequence(frame) => frame.step(parser, product, output),
            Self::Object(frame) => frame.step(parser, product, output),
            Self::Value => {
                assert!(product.is_none(), "Sofia value frame received a product");
                let container = match parser.peek().kind {
                    TokenKind::LeftBracket => Some(ContainerKind::List),
                    TokenKind::LeftParen => Some(ContainerKind::Tuple),
                    TokenKind::LeftBrace => {
                        if let Err(error) = parser.enter_value_container() {
                            return Step::Failed(error);
                        }
                        parser.advance();
                        return Step::Continue(Frame::Object(ObjectFrame::new()));
                    }
                    TokenKind::LeftAngle => {
                        if let Err(error) = parser.enter_value_container() {
                            return Step::Failed(error);
                        }
                        let start_index = parser.current;
                        parser.advance();
                        return Step::Continue(Frame::Node(NodeFrame::new(start_index)));
                    }
                    TokenKind::Tilde | TokenKind::TildeArrow => {
                        return match parser.parse_reference() {
                            Ok(value) => complete(output, Product::Value(value)),
                            Err(error) => Step::Failed(error),
                        };
                    }
                    _ => None,
                };
                if let Some(kind) = container {
                    if let Err(error) = parser.enter_value_container() {
                        return Step::Failed(error);
                    }
                    parser.advance();
                    return Step::Continue(Frame::Sequence(ValueSequenceFrame::new(kind)));
                }
                match parser.parse_scalar() {
                    Ok(Some(value)) => complete(output, Product::Value(value)),
                    Ok(None) => Step::Failed(
                        parser
                            .error_at_current(format!("Unexpected token '{}'", parser.peek().text)),
                    ),
                    Err(error) => Step::Failed(error),
                }
            }
        }
    }
}

#[derive(Clone)]
enum Product {
    AttributeEntry(ParsedAttributeEntry),
    Attributes(ParsedAttributes),
    Datatype(String),
    Document(ParsedDocument),
    Binding(Binding),
    Values(Vec<Value>),
    Value(Value),
}

enum Step {
    Continue(Frame),
    Push { parent: Frame, child: Frame },
    Complete,
    Failed(Diagnostic),
}

fn complete(output: &mut Option<Product>, product: Product) -> Step {
    debug_assert!(output.is_none(), "Sofia product outbox was not empty");
    *output = Some(product);
    Step::Complete
}

fn debug_assert_map_order<T>(members: &BTreeMap<String, T>, order: &[String]) {
    debug_assert_eq!(members.len(), order.len());
    debug_assert!(order.iter().all(|key| members.contains_key(key)));
}

#[derive(Clone)]
struct ParsedDocument {
    bindings: Vec<Binding>,
    errors: Vec<Diagnostic>,
}

#[derive(Clone)]
struct DocumentFrame {
    bindings: Vec<Binding>,
    errors: Vec<Diagnostic>,
    phase: DocumentPhase,
}

impl DocumentFrame {
    fn new() -> Self {
        Self {
            bindings: Vec::new(),
            errors: Vec::new(),
            phase: DocumentPhase::Binding,
        }
    }

    fn recover_child_failure(
        mut self,
        parser: &mut Parser<'_, '_>,
        error: Diagnostic,
    ) -> Result<Self, Diagnostic> {
        parser.current_value_nesting_depth = 0;
        if parser.recovery {
            self.errors.push(error);
            parser.synchronize_to_next_binding();
        } else if error.code == "SYNTAX_ERROR" && error.message == "Expected key" {
            if !parser.synchronize_to_next_binding() {
                return Err(error);
            }
        } else {
            return Err(error);
        }
        parser.skip_newlines();
        self.phase = DocumentPhase::Binding;
        Ok(self)
    }

    fn recover_own_failure(mut self, parser: &mut Parser<'_, '_>, error: Diagnostic) -> Step {
        if !parser.recovery {
            return Step::Failed(error);
        }
        parser.current_value_nesting_depth = 0;
        self.errors.push(error);
        parser.synchronize_to_next_binding();
        parser.skip_newlines();
        self.phase = DocumentPhase::Binding;
        Step::Continue(Frame::Document(self))
    }

    fn step(
        mut self,
        parser: &mut Parser<'_, '_>,
        product: Option<Product>,
        output: &mut Option<Product>,
    ) -> Step {
        match self.phase {
            DocumentPhase::Binding => {
                assert!(
                    product.is_none(),
                    "Sofia document frame received an early product"
                );
                parser.skip_newlines();
                if parser.is_at_end() {
                    return complete(
                        output,
                        Product::Document(ParsedDocument {
                            bindings: self.bindings,
                            errors: self.errors,
                        }),
                    );
                }
                if parser.check(TokenKind::Colon) {
                    let error = parser.error_at_current("Expected key");
                    return self.recover_own_failure(parser, error);
                }
                self.phase = DocumentPhase::Delimiter;
                Step::Push {
                    parent: Frame::Document(self),
                    child: Frame::Binding(BindingFrame::new()),
                }
            }
            DocumentPhase::Delimiter => {
                let Some(Product::Binding(binding)) = product else {
                    unreachable!("Sofia document frame expected a binding product");
                };
                self.bindings.push(binding);

                if parser.is_at_end() {
                    return complete(
                        output,
                        Product::Document(ParsedDocument {
                            bindings: self.bindings,
                            errors: self.errors,
                        }),
                    );
                }
                if parser.check(TokenKind::Comma) {
                    parser.advance();
                } else if parser.check(TokenKind::Newline) {
                    parser.skip_newlines();
                } else {
                    let error = parser.error_at_current("Expected binding delimiter");
                    return self.recover_own_failure(parser, error);
                }

                self.phase = DocumentPhase::Binding;
                Step::Continue(Frame::Document(self))
            }
        }
    }
}

#[derive(Clone)]
enum DocumentPhase {
    Binding,
    Delimiter,
}

#[derive(Clone)]
struct BindingFrame {
    phase: BindingPhase,
}

impl BindingFrame {
    fn new() -> Self {
        Self {
            phase: BindingPhase::Key,
        }
    }

    fn step(
        self,
        parser: &mut Parser<'_, '_>,
        product: Option<Product>,
        output: &mut Option<Product>,
    ) -> Step {
        match self.phase {
            BindingPhase::Key => {
                assert!(
                    product.is_none(),
                    "Sofia binding frame received an early product"
                );
                let (key, is_header, start) = match parser.parse_key() {
                    Ok(key) => key,
                    Err(error) => return Step::Failed(error),
                };
                parser.skip_newlines();
                let structural_id = match parser.parse_optional_structural_identity() {
                    Ok(structural_id) => structural_id,
                    Err(error) => return Step::Failed(error),
                };
                parser.skip_newlines();
                let head = BindingHead {
                    start,
                    key,
                    is_header,
                    structural_id,
                    datatype: None,
                    attributes: BTreeMap::new(),
                    attribute_order: Vec::new(),
                };
                if parser.check(TokenKind::At) {
                    if let Err(error) = parser.open_attribute_block(1) {
                        return Step::Failed(error);
                    }
                    Step::Push {
                        parent: Frame::Binding(Self {
                            phase: BindingPhase::Attributes(head),
                        }),
                        child: Frame::AttributeMembers(AttributeMembersFrame::block(1)),
                    }
                } else {
                    Self::push_datatype_or_value(parser, head, output)
                }
            }
            BindingPhase::Attributes(mut head) => {
                let Some(Product::Attributes(attributes)) = product else {
                    unreachable!("Sofia binding frame expected attributes");
                };
                head.attributes = attributes.members;
                head.attribute_order = attributes.order;
                parser.skip_newlines();
                if parser.check(TokenKind::At) {
                    return Step::Failed(parser.error_at_current(
                        "Only one attribute block is allowed before a binding datatype",
                    ));
                }
                Self::push_datatype_or_value(parser, head, output)
            }
            BindingPhase::Datatype(mut head) => {
                let Some(Product::Datatype(datatype)) = product else {
                    unreachable!("Sofia binding frame expected a datatype product");
                };
                if let Err(error) =
                    validate_binding_node_datatype(&datatype, parser.previous().span)
                {
                    return Step::Failed(error);
                }
                head.datatype = Some(datatype);
                Self::push_value(parser, head, output)
            }
            BindingPhase::Value(head) => {
                let Some(Product::Value(value)) = product else {
                    unreachable!("Sofia binding frame expected a value product");
                };
                Self::finish(parser, head, value, output)
            }
        }
    }

    fn push_datatype_or_value(
        parser: &mut Parser<'_, '_>,
        mut head: BindingHead,
        output: &mut Option<Product>,
    ) -> Step {
        if parser.check(TokenKind::Colon) {
            parser.advance();
            parser.skip_newlines();
            parser.begin_datatype();
            match parser.try_parse_atomic_datatype() {
                Ok(Some(datatype)) => {
                    if let Err(error) =
                        validate_binding_node_datatype(&datatype, parser.previous().span)
                    {
                        return Step::Failed(error);
                    }
                    head.datatype = Some(datatype);
                    return Self::push_value(parser, head, output);
                }
                Ok(None) => {}
                Err(error) => return Step::Failed(error),
            }
            Step::Push {
                parent: Frame::Binding(Self {
                    phase: BindingPhase::Datatype(head),
                }),
                child: Frame::Datatype(DatatypeFrame::new(0)),
            }
        } else {
            Self::push_value(parser, head, output)
        }
    }

    fn push_value(
        parser: &mut Parser<'_, '_>,
        head: BindingHead,
        output: &mut Option<Product>,
    ) -> Step {
        parser.skip_newlines();
        if !parser.check(TokenKind::Equals) {
            return Step::Failed(
                parser.error_at_current(format!("Expected '=' after key '{}'", head.key)),
            );
        }
        parser.advance();
        parser.skip_newlines();
        match parser.parse_scalar() {
            Ok(Some(value)) => return Self::finish(parser, head, value, output),
            Ok(None) => {}
            Err(error) => return Step::Failed(error),
        }
        Step::Push {
            parent: Frame::Binding(Self {
                phase: BindingPhase::Value(head),
            }),
            child: Frame::Value,
        }
    }

    fn finish(
        parser: &Parser<'_, '_>,
        head: BindingHead,
        value: Value,
        output: &mut Option<Product>,
    ) -> Step {
        let end = parser.previous().span.end;
        complete(
            output,
            Product::Binding(Binding {
                key: head.key,
                is_header: head.is_header,
                structural_id: head.structural_id,
                datatype: head.datatype,
                attributes: head.attributes,
                attribute_order: head.attribute_order,
                value,
                span: Span {
                    start: head.start,
                    end,
                },
            }),
        )
    }
}

#[derive(Clone)]
enum BindingPhase {
    Key,
    Attributes(BindingHead),
    Datatype(BindingHead),
    Value(BindingHead),
}

#[derive(Clone)]
struct BindingHead {
    start: crate::Position,
    key: String,
    is_header: bool,
    structural_id: Option<String>,
    datatype: Option<String>,
    attributes: BTreeMap<String, AttributeValue>,
    attribute_order: Vec<String>,
}

#[derive(Clone)]
struct AnonymousValueFrame {
    phase: AnonymousValuePhase,
}

impl AnonymousValueFrame {
    fn new() -> Self {
        Self {
            phase: AnonymousValuePhase::Head,
        }
    }

    fn step(
        self,
        parser: &mut Parser<'_, '_>,
        product: Option<Product>,
        output: &mut Option<Product>,
    ) -> Step {
        match self.phase {
            AnonymousValuePhase::Head => {
                assert!(
                    product.is_none(),
                    "Sofia anonymous-value frame received an early product"
                );
                if !matches!(
                    parser.peek().kind,
                    TokenKind::StructuralIdentity | TokenKind::Colon | TokenKind::At
                ) {
                    return Step::Continue(Frame::Value);
                }

                let structural_id = match parser.parse_optional_structural_identity() {
                    Ok(structural_id) => structural_id,
                    Err(error) => return Step::Failed(error),
                };
                parser.skip_newlines();
                let head = AnonymousHead {
                    structural_id,
                    datatype: None,
                    attributes: BTreeMap::new(),
                    attribute_order: Vec::new(),
                };
                if parser.check(TokenKind::At) {
                    if let Err(error) = parser.open_attribute_block(1) {
                        return Step::Failed(error);
                    }
                    Step::Push {
                        parent: Frame::AnonymousValue(Self {
                            phase: AnonymousValuePhase::Attributes(head),
                        }),
                        child: Frame::AttributeMembers(AttributeMembersFrame::block(1)),
                    }
                } else {
                    Self::push_datatype_or_value(parser, head)
                }
            }
            AnonymousValuePhase::Attributes(mut head) => {
                let Some(Product::Attributes(attributes)) = product else {
                    unreachable!("Sofia anonymous-value frame expected attributes");
                };
                head.attributes = attributes.members;
                head.attribute_order = attributes.order;
                parser.skip_newlines();
                if parser.check(TokenKind::At) {
                    return Step::Failed(parser.error_at_current(
                        "Only one attribute block is allowed before an anonymous value datatype",
                    ));
                }
                Self::push_datatype_or_value(parser, head)
            }
            AnonymousValuePhase::Datatype(mut head) => {
                let Some(Product::Datatype(datatype)) = product else {
                    unreachable!("Sofia anonymous-value frame expected a datatype product");
                };
                if let Err(error) =
                    validate_binding_node_datatype(&datatype, parser.previous().span)
                {
                    return Step::Failed(error);
                }
                head.datatype = Some(datatype);
                Self::push_value(parser, head)
            }
            AnonymousValuePhase::Value(head) => {
                let Some(Product::Value(value)) = product else {
                    unreachable!("Sofia anonymous-value frame expected a value product");
                };
                complete(
                    output,
                    Product::Value(Value::TypedValue {
                        structural_id: head.structural_id,
                        datatype: head.datatype,
                        attributes: head.attributes,
                        attribute_order: head.attribute_order,
                        value: Box::new(value),
                    }),
                )
            }
        }
    }

    fn push_datatype_or_value(parser: &mut Parser<'_, '_>, head: AnonymousHead) -> Step {
        if parser.check(TokenKind::Colon) {
            parser.advance();
            parser.skip_newlines();
            parser.begin_datatype();
            Step::Push {
                parent: Frame::AnonymousValue(Self {
                    phase: AnonymousValuePhase::Datatype(head),
                }),
                child: Frame::Datatype(DatatypeFrame::new(0)),
            }
        } else {
            Self::push_value(parser, head)
        }
    }

    fn push_value(parser: &mut Parser<'_, '_>, head: AnonymousHead) -> Step {
        parser.skip_newlines();
        if !parser.check(TokenKind::Equals) {
            return Step::Failed(
                parser.error_at_current("Expected `=` after anonymous value head"),
            );
        }
        parser.advance();
        parser.skip_newlines();
        Step::Push {
            parent: Frame::AnonymousValue(Self {
                phase: AnonymousValuePhase::Value(head),
            }),
            child: Frame::Value,
        }
    }
}

#[derive(Clone)]
enum AnonymousValuePhase {
    Head,
    Attributes(AnonymousHead),
    Datatype(AnonymousHead),
    Value(AnonymousHead),
}

#[derive(Clone)]
struct AnonymousHead {
    structural_id: Option<String>,
    datatype: Option<String>,
    attributes: BTreeMap<String, AttributeValue>,
    attribute_order: Vec<String>,
}

#[derive(Clone)]
struct ParsedAttributes {
    members: BTreeMap<String, AttributeValue>,
    order: Vec<String>,
}

#[derive(Clone)]
struct ParsedAttributeEntry {
    key: String,
    key_span: Span,
    value: AttributeValue,
}

#[derive(Clone)]
struct AttributeMembersFrame {
    kind: AttributeMembersKind,
    depth: usize,
    members: BTreeMap<String, AttributeValue>,
    order: Vec<String>,
    phase: AttributeMembersPhase,
}

impl AttributeMembersFrame {
    fn block(depth: usize) -> Self {
        Self::new(AttributeMembersKind::Block, depth)
    }

    fn object() -> Self {
        Self::new(AttributeMembersKind::Object, 0)
    }

    fn new(kind: AttributeMembersKind, depth: usize) -> Self {
        Self {
            kind,
            depth,
            members: BTreeMap::new(),
            order: Vec::new(),
            phase: AttributeMembersPhase::Entry,
        }
    }

    fn step(
        mut self,
        parser: &mut Parser<'_, '_>,
        product: Option<Product>,
        output: &mut Option<Product>,
    ) -> Step {
        match self.phase {
            AttributeMembersPhase::Entry => {
                assert!(
                    product.is_none(),
                    "Sofia attribute members received an early product"
                );
                parser.skip_newlines();
                if parser.check(TokenKind::RightBrace) {
                    parser.advance();
                    debug_assert_map_order(&self.members, &self.order);
                    return complete(
                        output,
                        Product::Attributes(ParsedAttributes {
                            members: self.members,
                            order: self.order,
                        }),
                    );
                }
                let depth = self.depth;
                self.phase = AttributeMembersPhase::Delimiter;
                Step::Push {
                    parent: Frame::AttributeMembers(self),
                    child: Frame::AttributeEntry(AttributeEntryFrame::new(depth)),
                }
            }
            AttributeMembersPhase::Delimiter => {
                let Some(Product::AttributeEntry(entry)) = product else {
                    unreachable!("Sofia attribute members expected an entry product");
                };
                if self.members.contains_key(&entry.key) {
                    return Step::Failed(
                        Diagnostic::new("DUPLICATE_KEY", format!("Duplicate key: '{}'", entry.key))
                            .at_path("$")
                            .with_span(entry.key_span),
                    );
                }
                self.order.push(entry.key.clone());
                self.members.insert(entry.key, entry.value);

                let mut saw_newline = false;
                while parser.check(TokenKind::Newline) {
                    saw_newline = true;
                    parser.advance();
                }
                if parser.check(TokenKind::Comma) {
                    if parser.has_separator_collision() {
                        return Step::Failed(parser.separator_collision_error());
                    }
                    parser.advance();
                    parser.skip_newlines();
                } else if parser.check(TokenKind::RightBrace) {
                    parser.advance();
                    debug_assert_map_order(&self.members, &self.order);
                    return complete(
                        output,
                        Product::Attributes(ParsedAttributes {
                            members: self.members,
                            order: self.order,
                        }),
                    );
                } else if !saw_newline {
                    return Step::Failed(parser.error_at_current(self.kind.delimiter_message()));
                }

                self.phase = AttributeMembersPhase::Entry;
                Step::Continue(Frame::AttributeMembers(self))
            }
        }
    }
}

#[derive(Clone, Copy)]
enum AttributeMembersKind {
    Block,
    Object,
}

impl AttributeMembersKind {
    const fn delimiter_message(self) -> &'static str {
        match self {
            Self::Block => "Expected attribute delimiter",
            Self::Object => "Expected object member delimiter",
        }
    }
}

#[derive(Clone)]
enum AttributeMembersPhase {
    Entry,
    Delimiter,
}

#[derive(Clone)]
struct AttributeEntryFrame {
    depth: usize,
    phase: AttributeEntryPhase,
}

impl AttributeEntryFrame {
    fn new(depth: usize) -> Self {
        Self {
            depth,
            phase: AttributeEntryPhase::Key,
        }
    }

    fn step(
        self,
        parser: &mut Parser<'_, '_>,
        product: Option<Product>,
        output: &mut Option<Product>,
    ) -> Step {
        match self.phase {
            AttributeEntryPhase::Key => {
                assert!(
                    product.is_none(),
                    "Sofia attribute entry received an early product"
                );
                let key_span = parser.peek().span;
                let (key, _, _) = match parser.parse_key() {
                    Ok(key) => key,
                    Err(error) => return Step::Failed(error),
                };
                if RESERVED_ATTRIBUTE_KEYS.contains(&key.as_str()) {
                    return Step::Failed(
                        parser.error_at_current(format!("Reserved attribute key: {key}")),
                    );
                }
                parser.skip_newlines();
                let structural_id = match parser.parse_optional_structural_identity() {
                    Ok(structural_id) => structural_id,
                    Err(error) => return Step::Failed(error),
                };
                parser.skip_newlines();
                let head = AttributeEntryHead {
                    key,
                    key_span,
                    structural_id,
                    datatype: None,
                    nested_attrs: BTreeMap::new(),
                    nested_attr_order: Vec::new(),
                };
                if parser.check(TokenKind::At) {
                    let nested_depth = self.depth + 1;
                    if let Err(error) = parser.open_attribute_block(nested_depth) {
                        return Step::Failed(error);
                    }
                    Step::Push {
                        parent: Frame::AttributeEntry(Self {
                            depth: self.depth,
                            phase: AttributeEntryPhase::NestedAttributes(head),
                        }),
                        child: Frame::AttributeMembers(AttributeMembersFrame::block(nested_depth)),
                    }
                } else {
                    Self::push_datatype_or_value(parser, self.depth, head)
                }
            }
            AttributeEntryPhase::NestedAttributes(mut head) => {
                let Some(Product::Attributes(attributes)) = product else {
                    unreachable!("Sofia attribute entry expected nested attributes");
                };
                head.nested_attrs = attributes.members;
                head.nested_attr_order = attributes.order;
                parser.skip_newlines();
                if parser.check(TokenKind::At) {
                    return Step::Failed(parser.error_at_current(
                        "Only one attribute block is allowed before an attribute entry datatype",
                    ));
                }
                Self::push_datatype_or_value(parser, self.depth, head)
            }
            AttributeEntryPhase::Datatype(mut head) => {
                let Some(Product::Datatype(datatype)) = product else {
                    unreachable!("Sofia attribute entry expected a datatype");
                };
                if let Err(error) =
                    validate_binding_node_datatype(&datatype, parser.previous().span)
                {
                    return Step::Failed(error);
                }
                head.datatype = Some(datatype);
                Self::push_value(parser, self.depth, head)
            }
            AttributeEntryPhase::Value(head) => {
                let Some(Product::Value(value)) = product else {
                    unreachable!("Sofia attribute entry expected a value");
                };
                Self::finish(parser, head, Some(value), None, output)
            }
            AttributeEntryPhase::ObjectValue(head) => {
                let Some(Product::Attributes(object)) = product else {
                    unreachable!("Sofia attribute entry expected object members");
                };
                Self::finish(parser, head, None, Some(object), output)
            }
        }
    }

    fn push_datatype_or_value(
        parser: &mut Parser<'_, '_>,
        depth: usize,
        head: AttributeEntryHead,
    ) -> Step {
        if parser.check(TokenKind::Colon) {
            parser.advance();
            parser.skip_newlines();
            parser.begin_datatype();
            Step::Push {
                parent: Frame::AttributeEntry(Self {
                    depth,
                    phase: AttributeEntryPhase::Datatype(head),
                }),
                child: Frame::Datatype(DatatypeFrame::new(0)),
            }
        } else {
            Self::push_value(parser, depth, head)
        }
    }

    fn push_value(parser: &mut Parser<'_, '_>, depth: usize, head: AttributeEntryHead) -> Step {
        parser.skip_newlines();
        if !parser.check(TokenKind::Equals) {
            let message = if depth == 0 {
                "Expected `=` after object member key"
            } else {
                "Expected `=` after attribute key"
            };
            return Step::Failed(parser.error_at_current(message));
        }
        parser.advance();
        parser.skip_newlines();
        if parser.check(TokenKind::LeftBrace) {
            parser.advance();
            Step::Push {
                parent: Frame::AttributeEntry(Self {
                    depth,
                    phase: AttributeEntryPhase::ObjectValue(head),
                }),
                child: Frame::AttributeMembers(AttributeMembersFrame::object()),
            }
        } else {
            Step::Push {
                parent: Frame::AttributeEntry(Self {
                    depth,
                    phase: AttributeEntryPhase::Value(head),
                }),
                child: Frame::Value,
            }
        }
    }

    fn finish(
        parser: &Parser<'_, '_>,
        head: AttributeEntryHead,
        value: Option<Value>,
        object: Option<ParsedAttributes>,
        output: &mut Option<Product>,
    ) -> Step {
        let end = parser.previous().span.end;
        let (object_members, object_member_order) = object.map_or_else(
            || (BTreeMap::new(), Vec::new()),
            |object| (object.members, object.order),
        );
        let mut attribute = AttributeValue::with_parts(
            head.structural_id,
            head.datatype,
            value,
            head.nested_attrs,
            head.nested_attr_order,
            object_members,
            object_member_order,
        );
        attribute.span = Some(Span {
            start: head.key_span.start,
            end,
        });
        complete(
            output,
            Product::AttributeEntry(ParsedAttributeEntry {
                key: head.key,
                key_span: head.key_span,
                value: attribute,
            }),
        )
    }
}

#[derive(Clone)]
enum AttributeEntryPhase {
    Key,
    NestedAttributes(AttributeEntryHead),
    Datatype(AttributeEntryHead),
    Value(AttributeEntryHead),
    ObjectValue(AttributeEntryHead),
}

#[derive(Clone)]
struct AttributeEntryHead {
    key: String,
    key_span: Span,
    structural_id: Option<String>,
    datatype: Option<String>,
    nested_attrs: BTreeMap<String, AttributeValue>,
    nested_attr_order: Vec<String>,
}

#[derive(Clone)]
struct DatatypeFrame {
    start: usize,
    name: String,
    generic_depth: usize,
    phase: DatatypePhase,
}

impl DatatypeFrame {
    fn new(generic_depth: usize) -> Self {
        Self {
            start: 0,
            name: String::new(),
            generic_depth,
            phase: DatatypePhase::Name,
        }
    }

    fn step(
        mut self,
        parser: &mut Parser<'_, '_>,
        product: Option<Product>,
        output: &mut Option<Product>,
    ) -> Step {
        match self.phase {
            DatatypePhase::Name => {
                assert!(
                    product.is_none(),
                    "Sofia datatype frame received an early product"
                );
                if let Err(error) = parser.count_datatype_component(parser.peek().span) {
                    return Step::Failed(error);
                }
                if parser.peek().kind == TokenKind::String {
                    return Step::Failed(Diagnostic {
                        code: String::from("SYNTAX_ERROR"),
                        path: Some(String::from("$")),
                        span: Some(parser.peek().span),
                        phase: None,
                        message: String::from("Quoted type names are not supported"),
                    });
                }
                if !is_bare_key_kind(parser.peek().kind) {
                    return Step::Failed(parser.error_at_current("Expected datatype annotation"));
                }
                self.start = parser.current;
                self.name = parser.advance().text.clone();
                parser.skip_newlines();

                if parser.check(TokenKind::LeftAngle) {
                    parser.advance();
                    if self.generic_depth > parser.max_generic_depth {
                        return Step::Failed(Diagnostic {
                            code: String::from("GENERIC_DEPTH_EXCEEDED"),
                            path: Some(String::from("$")),
                            span: Some(parser.previous().span),
                            phase: None,
                            message: format!(
                                "Generic depth {} exceeds max_generic_depth {}",
                                self.generic_depth, parser.max_generic_depth
                            ),
                        });
                    }
                    if self.name == "radix" {
                        return Step::Failed(Diagnostic {
                            code: String::from("SYNTAX_ERROR"),
                            path: Some(String::from("$")),
                            span: Some(parser.previous().span),
                            phase: None,
                            message: String::from(
                                "Radix datatype bases must use bracket syntax like `radix[10]`",
                            ),
                        });
                    }
                    parser.skip_newlines();
                    self.phase = DatatypePhase::GenericArgument { count: 0 };
                    Step::Continue(Frame::Datatype(self))
                } else if parser.check(TokenKind::LeftBracket) {
                    parser.advance();
                    parser.skip_newlines();
                    self.phase = DatatypePhase::ClarifierValue { count: 0 };
                    Step::Continue(Frame::Datatype(self))
                } else {
                    self.finish(parser, output)
                }
            }
            DatatypePhase::GenericArgument { count } => match parser.peek().kind {
                kind if is_bare_key_kind(kind) => {
                    let child_depth = self.generic_depth + 1;
                    self.phase = DatatypePhase::GenericChild { count };
                    Step::Push {
                        parent: Frame::Datatype(self),
                        child: Frame::Datatype(Self::new(child_depth)),
                    }
                }
                TokenKind::Number => {
                    let span = parser.advance().span;
                    if let Err(error) = parser.count_datatype_component(span) {
                        return Step::Failed(error);
                    }
                    let count = count + 1;
                    if count > parser.max_generic_arguments {
                        return Step::Failed(Diagnostic {
                            code: String::from("GENERIC_ARGUMENTS_EXCEEDED"),
                            path: Some(String::from("$")),
                            span: Some(parser.previous().span),
                            phase: None,
                            message: format!(
                                "Generic argument count {count} exceeds max_generic_arguments {}",
                                parser.max_generic_arguments
                            ),
                        });
                    }
                    self.phase = DatatypePhase::GenericDelimiter { count };
                    Step::Continue(Frame::Datatype(self))
                }
                _ => Step::Failed(parser.error_at_current("Expected generic argument")),
            },
            DatatypePhase::GenericChild { count } => {
                let Some(Product::Datatype(_)) = product else {
                    unreachable!("Sofia datatype frame expected a datatype product");
                };
                let count = count + 1;
                if count > parser.max_generic_arguments {
                    return Step::Failed(Diagnostic {
                        code: String::from("GENERIC_ARGUMENTS_EXCEEDED"),
                        path: Some(String::from("$")),
                        span: Some(parser.previous().span),
                        phase: None,
                        message: format!(
                            "Generic argument count {count} exceeds max_generic_arguments {}",
                            parser.max_generic_arguments
                        ),
                    });
                }
                self.phase = DatatypePhase::GenericDelimiter { count };
                Step::Continue(Frame::Datatype(self))
            }
            DatatypePhase::GenericDelimiter { count } => {
                assert!(
                    product.is_none(),
                    "Sofia datatype delimiter received a product"
                );
                parser.skip_newlines();
                if parser.check(TokenKind::RightAngle) {
                    parser.advance();
                    parser.skip_newlines();
                    self.phase = DatatypePhase::Suffix;
                } else if parser.check(TokenKind::Comma) {
                    parser.advance();
                    parser.skip_newlines();
                    self.phase = DatatypePhase::GenericArgument { count };
                } else {
                    return Step::Failed(
                        parser.error_at_current("Expected ',' between generic arguments"),
                    );
                }
                Step::Continue(Frame::Datatype(self))
            }
            DatatypePhase::Suffix => {
                assert!(
                    product.is_none(),
                    "Sofia datatype suffix received a product"
                );
                if parser.check(TokenKind::LeftBracket) {
                    parser.advance();
                    parser.skip_newlines();
                    self.phase = DatatypePhase::ClarifierValue { count: 0 };
                    Step::Continue(Frame::Datatype(self))
                } else {
                    self.finish(parser, output)
                }
            }
            DatatypePhase::ClarifierValue { count } => {
                assert!(
                    product.is_none(),
                    "Sofia clarifier frame received a product"
                );
                parser.skip_newlines();
                let token = parser.peek().clone();
                match token.kind {
                    TokenKind::Number => {
                        if !is_valid_number_literal(&token.text) {
                            return Step::Failed(Diagnostic {
                                code: String::from("INVALID_NUMBER"),
                                path: Some(String::from("$")),
                                span: Some(token.span),
                                phase: None,
                                message: format!("Number literal `{}` is not valid", token.text),
                            });
                        }
                    }
                    TokenKind::String => {}
                    TokenKind::RightBracket if count == 0 => {
                        return Step::Failed(parser.error_at_current(
                            "Datatype clarifier must contain at least one string or number",
                        ));
                    }
                    _ => {
                        return Step::Failed(parser.error_at_current("Expected clarifier value"));
                    }
                }
                parser.advance();
                let count = count + 1;
                if count > parser.max_clarifier_values {
                    return Step::Failed(Diagnostic {
                        code: String::from("CLARIFIER_VALUES_EXCEEDED"),
                        path: Some(String::from("$")),
                        span: Some(token.span),
                        phase: None,
                        message: format!(
                            "Clarifier value count {count} exceeds max_clarifier_values {}",
                            parser.max_clarifier_values
                        ),
                    });
                }
                if let Err(error) = parser.count_datatype_component(token.span) {
                    return Step::Failed(error);
                }
                self.phase = DatatypePhase::ClarifierDelimiter { count };
                Step::Continue(Frame::Datatype(self))
            }
            DatatypePhase::ClarifierDelimiter { count } => {
                assert!(
                    product.is_none(),
                    "Sofia clarifier delimiter received a product"
                );
                parser.skip_newlines();
                if parser.check(TokenKind::RightBracket) {
                    parser.advance();
                    parser.skip_newlines();
                    if parser.check(TokenKind::LeftBracket) {
                        return Step::Failed(Diagnostic {
                            code: String::from("SYNTAX_ERROR"),
                            path: Some(String::from("$")),
                            span: Some(parser.peek().span),
                            phase: None,
                            message: String::from(
                                "Datatype clarifiers must use a single bracketed list like `sep[\"/\", \".\"]`",
                            ),
                        });
                    }
                    self.phase = DatatypePhase::Finish;
                } else if parser.check(TokenKind::Comma) {
                    parser.advance();
                    self.phase = DatatypePhase::ClarifierValue { count };
                } else {
                    return Step::Failed(
                        parser.error_at_current("Expected ',' between clarifier values"),
                    );
                }
                Step::Continue(Frame::Datatype(self))
            }
            DatatypePhase::Finish => {
                assert!(
                    product.is_none(),
                    "Sofia completed datatype received a product"
                );
                self.finish(parser, output)
            }
        }
    }

    fn finish(self, parser: &Parser<'_, '_>, output: &mut Option<Product>) -> Step {
        let datatype = parser.normalized_datatype(self.start, parser.current);
        if let Err(error) = validate_reserved_datatype_adornments(&datatype, parser.previous().span)
        {
            return Step::Failed(error);
        }
        complete(output, Product::Datatype(datatype))
    }
}

#[derive(Clone)]
enum DatatypePhase {
    Name,
    GenericArgument { count: usize },
    GenericChild { count: usize },
    GenericDelimiter { count: usize },
    Suffix,
    ClarifierValue { count: usize },
    ClarifierDelimiter { count: usize },
    Finish,
}

#[derive(Clone)]
struct NodeFrame {
    phase: NodePhase,
}

impl NodeFrame {
    fn new(start_index: usize) -> Self {
        Self {
            phase: NodePhase::Tag { start_index },
        }
    }

    const fn start_index(&self) -> usize {
        match &self.phase {
            NodePhase::Tag { start_index } => *start_index,
            NodePhase::Attributes(head)
            | NodePhase::Datatype(head)
            | NodePhase::Closure(head)
            | NodePhase::Children(head) => head.start_index,
        }
    }

    fn step(
        self,
        parser: &mut Parser<'_, '_>,
        product: Option<Product>,
        output: &mut Option<Product>,
    ) -> Step {
        match self.phase {
            NodePhase::Tag { start_index } => {
                assert!(
                    product.is_none(),
                    "Sofia node frame received an early product"
                );
                parser.skip_newlines();
                let head_start = parser.peek().span.start;
                let tag = match parser.parse_node_tag() {
                    Ok(tag) => tag,
                    Err(error) => return Step::Failed(error),
                };
                let mut head = NodeHead {
                    start_index,
                    head_start,
                    head_end: parser.previous().span.end,
                    tag,
                    structural_id: None,
                    attributes: Vec::new(),
                    attribute_order: Vec::new(),
                    datatype: None,
                };
                parser.skip_newlines();
                let structural_id = match parser.parse_optional_structural_identity() {
                    Ok(structural_id) => structural_id,
                    Err(error) => return Step::Failed(error),
                };
                if structural_id.is_some() {
                    head.head_end = parser.previous().span.end;
                }
                head.structural_id = structural_id;
                parser.skip_newlines();
                if parser.check(TokenKind::At) {
                    if let Err(error) = parser.open_attribute_block(1) {
                        return Step::Failed(error);
                    }
                    Step::Push {
                        parent: Frame::Node(Self {
                            phase: NodePhase::Attributes(head),
                        }),
                        child: Frame::AttributeMembers(AttributeMembersFrame::block(1)),
                    }
                } else {
                    Self::push_datatype_or_closure(parser, head)
                }
            }
            NodePhase::Attributes(mut head) => {
                let Some(Product::Attributes(attributes)) = product else {
                    unreachable!("Sofia node frame expected attributes");
                };
                head.head_end = parser.previous().span.end;
                head.attribute_order = attributes.order;
                head.attributes.push(attributes.members);
                parser.skip_newlines();
                if parser.check(TokenKind::At) {
                    return Step::Failed(parser.error_at_current(
                        "Only one attribute block is allowed before a node datatype",
                    ));
                }
                Self::push_datatype_or_closure(parser, head)
            }
            NodePhase::Datatype(mut head) => {
                let Some(Product::Datatype(datatype)) = product else {
                    unreachable!("Sofia node frame expected a datatype");
                };
                let base = datatype_base(&datatype);
                if (datatype.contains('<') && base != "node")
                    || !datatype_bracket_specs(&datatype).is_empty()
                {
                    return Step::Failed(parser.error_at_current(
                        "Node head datatypes must be simple labels or node<T> without clarifiers",
                    ));
                }
                head.head_end = parser.previous_non_newline().span.end;
                head.datatype = Some(datatype);
                Step::Continue(Frame::Node(Self {
                    phase: NodePhase::Closure(head),
                }))
            }
            NodePhase::Closure(head) => {
                assert!(product.is_none(), "Sofia node closure received a product");
                parser.skip_newlines();
                if parser.check(TokenKind::RightAngle) {
                    parser.advance();
                    return Self::finish(parser, head, Vec::new(), output);
                }
                if !parser.check(TokenKind::LeftParen) {
                    return Step::Failed(
                        parser.error_at_current("Expected `(` or `>` in node literal"),
                    );
                }
                parser.advance();
                Step::Push {
                    parent: Frame::Node(Self {
                        phase: NodePhase::Children(head),
                    }),
                    child: Frame::NodeChildren(NodeChildrenFrame::new()),
                }
            }
            NodePhase::Children(head) => {
                let Some(Product::Values(children)) = product else {
                    unreachable!("Sofia node frame expected children");
                };
                if !parser.check(TokenKind::RightParen) {
                    return Step::Failed(
                        parser.error_at_current("Expected `)` after node children"),
                    );
                }
                parser.advance();
                parser.skip_newlines();
                if !parser.check(TokenKind::RightAngle) {
                    return Step::Failed(
                        parser.error_at_current("Expected `>` after node children"),
                    );
                }
                parser.advance();
                Self::finish(parser, head, children, output)
            }
        }
    }

    fn push_datatype_or_closure(parser: &mut Parser<'_, '_>, head: NodeHead) -> Step {
        if parser.check(TokenKind::Colon) {
            parser.advance();
            parser.begin_datatype();
            Step::Push {
                parent: Frame::Node(Self {
                    phase: NodePhase::Datatype(head),
                }),
                child: Frame::Datatype(DatatypeFrame::new(0)),
            }
        } else {
            Step::Continue(Frame::Node(Self {
                phase: NodePhase::Closure(head),
            }))
        }
    }

    fn finish(
        parser: &mut Parser<'_, '_>,
        head: NodeHead,
        children: Vec<Value>,
        output: &mut Option<Product>,
    ) -> Step {
        debug_assert_eq!(parser.previous().kind, TokenKind::RightAngle);
        parser.leave_value_container();
        complete(
            output,
            Product::Value(Value::NodeLiteral {
                raw: parser.tokens_text(head.start_index, parser.current),
                tag: head.tag,
                structural_id: head.structural_id,
                attributes: head.attributes,
                attribute_order: head.attribute_order,
                datatype: head.datatype,
                children,
                head_span: Span {
                    start: head.head_start,
                    end: head.head_end,
                },
            }),
        )
    }
}

#[derive(Clone)]
enum NodePhase {
    Tag { start_index: usize },
    Attributes(NodeHead),
    Datatype(NodeHead),
    Closure(NodeHead),
    Children(NodeHead),
}

#[derive(Clone)]
struct NodeHead {
    start_index: usize,
    head_start: crate::Position,
    head_end: crate::Position,
    tag: String,
    structural_id: Option<String>,
    attributes: Vec<BTreeMap<String, AttributeValue>>,
    attribute_order: Vec<String>,
    datatype: Option<String>,
}

#[derive(Clone)]
struct NodeChildrenFrame {
    children: Vec<Value>,
    phase: NodeChildrenPhase,
}

impl NodeChildrenFrame {
    fn new() -> Self {
        Self {
            children: Vec::new(),
            phase: NodeChildrenPhase::Child,
        }
    }

    fn step(
        mut self,
        parser: &mut Parser<'_, '_>,
        product: Option<Product>,
        output: &mut Option<Product>,
    ) -> Step {
        match self.phase {
            NodeChildrenPhase::Child => {
                assert!(
                    product.is_none(),
                    "Sofia node children received an early product"
                );
                parser.skip_newlines();
                if parser.check(TokenKind::RightParen) {
                    return complete(output, Product::Values(self.children));
                }
                self.phase = NodeChildrenPhase::Delimiter;
                Step::Push {
                    parent: Frame::NodeChildren(self),
                    child: Frame::AnonymousValue(AnonymousValueFrame::new()),
                }
            }
            NodeChildrenPhase::Delimiter => {
                let Some(Product::Value(child)) = product else {
                    unreachable!("Sofia node children expected a value");
                };
                self.children.push(child);

                let mut saw_newline = false;
                while parser.check(TokenKind::Newline) {
                    saw_newline = true;
                    parser.advance();
                }
                if parser.check(TokenKind::Comma) {
                    if parser.has_separator_collision() {
                        return Step::Failed(parser.separator_collision_error());
                    }
                    parser.advance();
                    parser.skip_newlines();
                } else if parser.check(TokenKind::RightParen) {
                    return complete(output, Product::Values(self.children));
                } else if !saw_newline {
                    return Step::Failed(parser.error_at_current("Expected node child delimiter"));
                }

                self.phase = NodeChildrenPhase::Child;
                Step::Continue(Frame::NodeChildren(self))
            }
        }
    }
}

#[derive(Clone)]
enum NodeChildrenPhase {
    Child,
    Delimiter,
}

#[derive(Clone, Copy)]
enum ContainerKind {
    List,
    Tuple,
}

impl ContainerKind {
    const fn terminator(self) -> TokenKind {
        match self {
            Self::List => TokenKind::RightBracket,
            Self::Tuple => TokenKind::RightParen,
        }
    }
}

#[derive(Clone)]
struct ValueSequenceFrame {
    kind: ContainerKind,
    items: Vec<Value>,
    phase: SequencePhase,
}

impl ValueSequenceFrame {
    fn new(kind: ContainerKind) -> Self {
        Self {
            kind,
            items: Vec::new(),
            phase: SequencePhase::Item,
        }
    }

    fn step(
        mut self,
        parser: &mut Parser<'_, '_>,
        product: Option<Product>,
        output: &mut Option<Product>,
    ) -> Step {
        match self.phase {
            SequencePhase::Item => {
                assert!(
                    product.is_none(),
                    "Sofia sequence frame received an early product"
                );
                parser.skip_newlines();
                if parser.check(self.kind.terminator()) {
                    return self.finish(parser, output);
                }
                self.phase = SequencePhase::Delimiter;
                Step::Push {
                    parent: Frame::Sequence(self),
                    child: Frame::AnonymousValue(AnonymousValueFrame::new()),
                }
            }
            SequencePhase::Delimiter => {
                let Some(Product::Value(value)) = product else {
                    unreachable!("Sofia sequence frame expected a value product");
                };
                self.items.push(value);

                match self.kind {
                    ContainerKind::List => {
                        let mut saw_newline = false;
                        while parser.check(TokenKind::Newline) {
                            saw_newline = true;
                            parser.advance();
                        }
                        if parser.check(TokenKind::Comma) {
                            if parser.has_separator_collision() {
                                return Step::Failed(parser.separator_collision_error());
                            }
                            parser.advance();
                            parser.skip_newlines();
                        } else if parser.check(TokenKind::RightBracket) {
                            return self.finish(parser, output);
                        } else if !saw_newline {
                            return Step::Failed(
                                parser.error_at_current("Expected list delimiter"),
                            );
                        }
                    }
                    ContainerKind::Tuple => {
                        if parser.check(TokenKind::Comma) {
                            parser.advance();
                            parser.skip_newlines();
                            if parser.check(TokenKind::Comma) {
                                return Step::Failed(
                                    parser.error_at_current("Expected tuple delimiter"),
                                );
                            }
                        } else if parser.check(TokenKind::RightParen) {
                            return self.finish(parser, output);
                        } else if parser.check(TokenKind::Newline) {
                            parser.skip_newlines();
                        } else {
                            return Step::Failed(
                                parser.error_at_current("Expected tuple delimiter"),
                            );
                        }
                    }
                }

                self.phase = SequencePhase::Item;
                Step::Continue(Frame::Sequence(self))
            }
        }
    }

    fn finish(self, parser: &mut Parser<'_, '_>, output: &mut Option<Product>) -> Step {
        debug_assert!(parser.check(self.kind.terminator()));
        parser.advance();
        parser.leave_value_container();
        let value = match self.kind {
            ContainerKind::List => Value::ListNode { items: self.items },
            ContainerKind::Tuple => Value::TupleLiteral { items: self.items },
        };
        complete(output, Product::Value(value))
    }
}

#[derive(Clone)]
enum SequencePhase {
    Item,
    Delimiter,
}

#[derive(Clone)]
struct ObjectFrame {
    bindings: Vec<Binding>,
    phase: ObjectPhase,
}

impl ObjectFrame {
    fn new() -> Self {
        Self {
            bindings: Vec::new(),
            phase: ObjectPhase::Binding,
        }
    }

    fn step(
        mut self,
        parser: &mut Parser<'_, '_>,
        product: Option<Product>,
        output: &mut Option<Product>,
    ) -> Step {
        match self.phase {
            ObjectPhase::Binding => {
                assert!(
                    product.is_none(),
                    "Sofia object frame received an early product"
                );
                parser.skip_newlines();
                if parser.check(TokenKind::RightBrace) {
                    return self.finish(parser, output);
                }
                self.phase = ObjectPhase::Delimiter;
                Step::Push {
                    parent: Frame::Object(self),
                    child: Frame::Binding(BindingFrame::new()),
                }
            }
            ObjectPhase::Delimiter => {
                let Some(Product::Binding(binding)) = product else {
                    unreachable!("Sofia object frame expected a binding product");
                };
                self.bindings.push(binding);

                let mut saw_newline = false;
                while parser.check(TokenKind::Newline) {
                    saw_newline = true;
                    parser.advance();
                }
                if parser.check(TokenKind::Comma) {
                    if parser.has_separator_collision() {
                        return Step::Failed(parser.separator_collision_error());
                    }
                    parser.advance();
                    parser.skip_newlines();
                } else if parser.check(TokenKind::RightBrace) {
                    return self.finish(parser, output);
                } else if !saw_newline {
                    return Step::Failed(
                        parser.error_at_current("Expected object member delimiter"),
                    );
                }

                self.phase = ObjectPhase::Binding;
                Step::Continue(Frame::Object(self))
            }
        }
    }

    fn finish(self, parser: &mut Parser<'_, '_>, output: &mut Option<Product>) -> Step {
        debug_assert!(parser.check(TokenKind::RightBrace));
        parser.advance();
        parser.leave_value_container();
        complete(
            output,
            Product::Value(Value::ObjectNode {
                bindings: self.bindings,
            }),
        )
    }
}

#[derive(Clone)]
enum ObjectPhase {
    Binding,
    Delimiter,
}

#[cfg(test)]
mod tests {
    use std::borrow::Cow;

    use crate::lexer::LexerSession;
    use crate::utf8_decoder::Utf8Decoder;
    use crate::{LexerOptions, NullLiteralMode, ReferenceSegment, TokenKind, Value, tokenize};

    use super::{
        Frame, ParseOutcome, Parser, ParserLimits, ParserSession, ParserSessionError,
        ParserSessionProgress, ParserState, Product, parse_document, parse_document_recovery,
    };

    const TEST_LIMITS: ParserLimits = ParserLimits::new(256, 8, 8, 8, 32, 64);

    const BOUNDED_INCREMENTAL_CORPUS: &[&str] = &[
        concat!(
            "\u{feff}#!/usr/bin/env aeon\r\n",
            "first = \"Sofía 🌊\"\rsecond = 2\n",
            "third = true\r\n",
        ),
        r#"root\root\:list = [
  \child\:string = "value"
  :number = 1
  { "nested key"\nested\:object = {} }
]"#,
        r#"clone = ~$.["root.key"][1].member
pointer = ~>root.@.meta.["x.y"][0]
literal = ~true.off"#,
        r#"tree = <"root tag"\root\@{class:string = "top"}:node<custom>(
  "text"
  \child\:string = "typed"
  <leaf>
)>"#,
        "/* plain 🌊 */ note = >`\n  one\n  two\n`\nreason = !\"postponed\"",
        "broken = [1,,2]\nlater = true",
        "items = [1, 2 ",
    ];

    fn parse(input: &str) -> ParseOutcome {
        parse_with_limits(input, TEST_LIMITS)
    }

    fn parse_with_limits(input: &str, limits: ParserLimits) -> ParseOutcome {
        let lexed = tokenize(
            input,
            LexerOptions {
                include_newlines: true,
                ..LexerOptions::default()
            },
        );
        assert!(lexed.errors.is_empty());
        parse_document(&lexed.tokens, limits)
    }

    fn parse_recovery(input: &str) -> ParseOutcome {
        let lexed = tokenize(
            input,
            LexerOptions {
                include_newlines: true,
                ..LexerOptions::default()
            },
        );
        assert!(lexed.errors.is_empty());
        parse_document_recovery(&lexed.tokens, TEST_LIMITS)
    }

    fn parse_incremental_at_split(input: &str, split: usize, recovery: bool) -> ParseOutcome {
        assert!(input.is_char_boundary(split));
        let options = LexerOptions {
            include_newlines: true,
            ..LexerOptions::default()
        };
        let mut lexer = LexerSession::new(options);
        let mut parser = ParserSession::new(TEST_LIMITS, recovery);

        for chunk in [&input[..split], &input[split..]] {
            let batch = lexer.push(Cow::Owned(chunk.to_owned()));
            assert!(batch.errors.is_empty());
            assert_eq!(
                parser
                    .push_tokens(Cow::Owned(batch.tokens))
                    .expect("non-final token batch should be accepted"),
                ParserSessionProgress::NeedMoreInput
            );
        }

        let final_batch = lexer.finish();
        assert!(final_batch.errors.is_empty());
        parser
            .finish_tokens(Cow::Owned(final_batch.tokens))
            .expect("final lexer batch should finish the parser")
    }

    fn parse_incremental_bytes(input: &str, chunk_sizes: &[usize], recovery: bool) -> ParseOutcome {
        assert_eq!(chunk_sizes.iter().sum::<usize>(), input.len());
        let options = LexerOptions {
            include_newlines: true,
            ..LexerOptions::default()
        };
        let mut decoder = Utf8Decoder::default();
        let mut lexer = LexerSession::new(options);
        let mut parser = ParserSession::new(TEST_LIMITS, recovery);
        let mut terminal = None;
        let mut offset = 0;
        let mut decoded_bytes = 0;

        for &chunk_size in chunk_sizes {
            let end = offset + chunk_size;
            let mut decoded = Vec::new();
            decoder
                .push(&input.as_bytes()[offset..end], |absolute_offset, text| {
                    decoded.push((absolute_offset, text.to_owned()));
                })
                .expect("bounded corpus must contain valid UTF-8");
            offset = end;

            for (absolute_offset, text) in decoded {
                assert_eq!(absolute_offset, decoded_bytes);
                decoded_bytes += text.len();
                if terminal.is_some() {
                    continue;
                }
                let batch = lexer.push(Cow::Owned(text));
                assert!(batch.errors.is_empty());
                match parser
                    .push_tokens(Cow::Owned(batch.tokens))
                    .expect("decoded token batch should be accepted")
                {
                    ParserSessionProgress::NeedMoreInput => {}
                    ParserSessionProgress::Complete(outcome) => terminal = Some(outcome),
                }
            }
        }

        decoder
            .finish()
            .expect("complete bounded corpus input must finish UTF-8");
        assert_eq!(decoded_bytes, input.len());
        if let Some(outcome) = terminal {
            return outcome;
        }

        let final_batch = lexer.finish();
        assert!(final_batch.errors.is_empty());
        parser
            .finish_tokens(Cow::Owned(final_batch.tokens))
            .expect("final lexer batch should finish the parser")
    }

    fn fixed_byte_schedule(length: usize, width: usize) -> Vec<usize> {
        assert!(width > 0);
        let mut schedule = Vec::new();
        let mut remaining = length;
        while remaining > 0 {
            let size = remaining.min(width);
            schedule.push(size);
            remaining -= size;
        }
        schedule
    }

    fn randomized_byte_schedule(length: usize, seed: u64) -> Vec<usize> {
        let mut schedule = Vec::new();
        let mut remaining = length;
        let mut state = seed;
        while remaining > 0 {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            let size = remaining.min(1 + (state as usize % 23));
            schedule.push(size);
            remaining -= size;
        }
        schedule
    }

    #[test]
    fn parser_session_keeps_one_shot_tokens_borrowed() {
        let lexed = tokenize(
            "name = \"Sofía\"",
            LexerOptions {
                include_newlines: true,
                ..LexerOptions::default()
            },
        );
        assert!(lexed.errors.is_empty());

        let mut session = ParserSession::new(TEST_LIMITS, false);
        let outcome = session
            .finish_tokens(Cow::Borrowed(&lexed.tokens))
            .expect("one-shot token slice should finish");

        assert!(matches!(outcome, ParseOutcome::Parsed(_)));
        assert!(matches!(session.tokens, Cow::Borrowed(_)));
    }

    #[test]
    fn parser_session_accepts_incremental_lexer_batches_without_early_eof() {
        let input = "name = \"Sofía\"\nitems = [1, true, { nested = \"yes\" }]\nref = ~name";
        let options = LexerOptions {
            include_newlines: true,
            ..LexerOptions::default()
        };
        let expected = parse(input);
        let mut lexer = LexerSession::new(options);
        let mut parser = ParserSession::new(TEST_LIMITS, false);
        let mut furthest_cursor = 0;

        for character in input.chars() {
            let mut encoded = [0; 4];
            let batch = lexer.push(Cow::Owned(character.encode_utf8(&mut encoded).to_owned()));
            assert!(batch.errors.is_empty());
            assert!(
                batch
                    .tokens
                    .iter()
                    .all(|token| token.kind != TokenKind::Eof)
            );
            assert_eq!(
                parser
                    .push_tokens(Cow::Owned(batch.tokens))
                    .expect("non-final lexer batch should queue"),
                ParserSessionProgress::NeedMoreInput
            );
            furthest_cursor = furthest_cursor.max(parser.state.current);
        }

        assert!(
            furthest_cursor > 0,
            "parser should advance before final input"
        );

        let final_batch = lexer.finish();
        assert!(final_batch.errors.is_empty());
        assert_eq!(
            final_batch
                .tokens
                .iter()
                .filter(|token| token.kind == TokenKind::Eof)
                .count(),
            1
        );
        assert_eq!(
            final_batch.tokens.last().map(|token| token.kind),
            Some(TokenKind::Eof)
        );

        let actual = parser
            .finish_tokens(Cow::Owned(final_batch.tokens))
            .expect("final lexer batch should finish the parser session");
        assert_eq!(actual, expected);
    }

    #[test]
    fn parser_session_reports_each_delimited_top_level_binding_once() {
        let options = LexerOptions {
            include_newlines: true,
            ..LexerOptions::default()
        };
        let mut lexer = LexerSession::new(options);
        let mut parser = ParserSession::new(TEST_LIMITS, false);

        for (chunk, expected_key) in [
            ("aeon:mode = \"strict\"\n", None),
            ("first = 1\n", Some("aeon:mode")),
            ("nested = { child = true }\n", Some("first")),
            ("pending = \"not delimited\"", Some("nested")),
        ] {
            let batch = lexer.push(Cow::Owned(chunk.to_owned()));
            assert!(batch.errors.is_empty());
            assert_eq!(
                parser
                    .push_tokens(Cow::Owned(batch.tokens))
                    .expect("completed binding chunk should be accepted"),
                ParserSessionProgress::NeedMoreInput
            );
            let completed = parser.newly_completed_bindings();
            assert_eq!(completed.len(), usize::from(expected_key.is_some()));
            if let Some(expected_key) = expected_key {
                assert_eq!(completed[0].key, expected_key);
            }
            assert!(parser.newly_completed_bindings().is_empty());
        }

        let final_batch = lexer.finish();
        let outcome = parser
            .finish_tokens(Cow::Owned(final_batch.tokens))
            .expect("final input should complete the document");
        let ParseOutcome::Parsed(bindings) = outcome else {
            panic!("valid input should produce parsed bindings");
        };
        assert_eq!(
            bindings
                .iter()
                .map(|binding| binding.key.as_str())
                .collect::<Vec<_>>(),
            ["aeon:mode", "first", "nested", "pending"]
        );
    }

    #[test]
    fn parser_session_releases_reported_top_level_bindings_and_finishes_remaining_binding() {
        let mut lexer = LexerSession::new(LexerOptions {
            include_newlines: true,
            ..LexerOptions::default()
        });
        let mut parser = ParserSession::new(TEST_LIMITS, false);

        for (chunk, expected_key) in [
            ("first = 1\n", None),
            ("second = { child = true }\n", Some("first")),
            ("third = 3", Some("second")),
        ] {
            let batch = lexer.push(Cow::Owned(chunk.to_owned()));
            assert!(batch.errors.is_empty());
            assert_eq!(
                parser
                    .push_tokens(Cow::Owned(batch.tokens))
                    .expect("chunk should remain non-terminal"),
                ParserSessionProgress::NeedMoreInput
            );
            let completed = parser.newly_completed_bindings();
            if let Some(expected_key) = expected_key {
                assert_eq!(completed.len(), 1);
                assert_eq!(completed[0].key, expected_key);
                assert_eq!(parser.release_completed_bindings(), 1);
                assert_eq!(parser.completed_binding_count(), 0);
                assert_eq!(parser.completed_binding_storage_bytes(), 0);
            } else {
                assert!(completed.is_empty());
            }
        }

        let outcome = parser
            .finish_tokens(Cow::Owned(lexer.finish().tokens))
            .expect("final EOF should complete the remaining binding");
        let ParseOutcome::Parsed(bindings) = outcome else {
            panic!("strict parser should return its remaining document");
        };
        assert_eq!(bindings.len(), 1);
        assert_eq!(bindings[0].key, "third");
    }

    #[test]
    fn parser_session_matches_one_shot_at_every_character_split() {
        let positive = [
            "name = \"Sofía\"\nage = 49, enabled = true",
            "items = [1, true, { nested = \"yes\" }]\nref = ~$.items[0]",
            "root\\root\\:list = [\\child\\:string = \"value\", { nested = true }]",
            "aeon\n:\nprofile = \"core\"\ntrim = >`\n  one\n  two\n`",
        ];

        for input in positive {
            let expected = parse(input);
            for split in (0..=input.len()).filter(|split| input.is_char_boundary(*split)) {
                assert_eq!(
                    parse_incremental_at_split(input, split, false),
                    expected,
                    "incremental Sofia mismatch at byte split {split} for:\n{input}"
                );
            }
        }

        let recovery = "broken = [1,,2]\nlater = true";
        let expected = parse_recovery(recovery);
        for split in (0..=recovery.len()).filter(|split| recovery.is_char_boundary(*split)) {
            assert_eq!(
                parse_incremental_at_split(recovery, split, true),
                expected,
                "incremental Sofia recovery mismatch at byte split {split}"
            );
        }
    }

    #[test]
    fn parser_session_bounded_core_corpus_matches_byte_at_a_time() {
        for input in BOUNDED_INCREMENTAL_CORPUS {
            let schedule = vec![1; input.len()];
            for recovery in [false, true] {
                let expected = if recovery {
                    parse_recovery(input)
                } else {
                    parse(input)
                };
                assert_eq!(
                    parse_incremental_bytes(input, &schedule, recovery),
                    expected,
                    "byte-at-a-time mismatch with recovery={recovery} for:\n{input}"
                );
            }
        }
    }

    #[test]
    fn parser_session_bounded_core_corpus_matches_fixed_and_randomized_schedules() {
        const FIXED_WIDTHS: &[usize] = &[2, 3, 4, 7, 16, 31];
        const RANDOM_SEEDS: &[u64] = &[0x5eed, 0xae01, 0x5af1_a123];

        for input in BOUNDED_INCREMENTAL_CORPUS {
            for recovery in [false, true] {
                let expected = if recovery {
                    parse_recovery(input)
                } else {
                    parse(input)
                };
                for &width in FIXED_WIDTHS {
                    let schedule = fixed_byte_schedule(input.len(), width);
                    assert_eq!(
                        parse_incremental_bytes(input, &schedule, recovery),
                        expected,
                        "fixed-width {width} mismatch with recovery={recovery} for:\n{input}"
                    );
                }
                for &seed in RANDOM_SEEDS {
                    let schedule = randomized_byte_schedule(input.len(), seed);
                    assert_eq!(
                        parse_incremental_bytes(input, &schedule, recovery),
                        expected,
                        "random seed {seed:#x} mismatch with recovery={recovery} for:\n{input}"
                    );
                }
            }
        }
    }

    #[test]
    fn parser_session_matches_one_shot_at_every_selected_byte_split() {
        for input in [
            BOUNDED_INCREMENTAL_CORPUS[0],
            BOUNDED_INCREMENTAL_CORPUS[4],
            BOUNDED_INCREMENTAL_CORPUS[5],
        ] {
            for recovery in [false, true] {
                let expected = if recovery {
                    parse_recovery(input)
                } else {
                    parse(input)
                };
                for split in 0..=input.len() {
                    assert_eq!(
                        parse_incremental_bytes(input, &[split, input.len() - split], recovery,),
                        expected,
                        "byte split {split} mismatch with recovery={recovery} for:\n{input}"
                    );
                }
            }
        }
    }

    #[test]
    fn parser_session_reclaims_consumed_flat_document_tokens() {
        let input = (0..512)
            .map(|index| format!("key_{index} = {index}\n"))
            .collect::<String>();
        let expected = parse(&input);
        let options = LexerOptions {
            include_newlines: true,
            ..LexerOptions::default()
        };
        let mut lexer = LexerSession::new(options);
        let mut parser = ParserSession::new(TEST_LIMITS, false);
        let mut peak_retained = 0;

        for character in input.chars() {
            let batch = lexer.push(Cow::Owned(character.to_string()));
            assert!(batch.errors.is_empty());
            assert_eq!(
                parser
                    .push_tokens(Cow::Owned(batch.tokens))
                    .expect("flat document batch should be accepted"),
                ParserSessionProgress::NeedMoreInput
            );
            peak_retained = peak_retained.max(parser.tokens.len());
        }

        assert!(parser.token_start_index > 1_000);
        assert!(
            peak_retained <= 4,
            "flat parser queue retained {peak_retained} tokens"
        );
        let final_batch = lexer.finish();
        let actual = parser
            .finish_tokens(Cow::Owned(final_batch.tokens))
            .expect("flat document should finish");
        assert_eq!(actual, expected);
    }

    #[test]
    fn parser_session_retains_raw_node_and_datatype_anchors_across_compaction() {
        let prefix = (0..64)
            .map(|index| format!("prefix_{index} = {index}\n"))
            .collect::<String>();
        let input = format!(
            "{prefix}typed:map<string,list<number>> = true\ntree = <root(1, <leaf>, \"🌊\")>"
        );
        let expected = parse(&input);
        let options = LexerOptions {
            include_newlines: true,
            ..LexerOptions::default()
        };
        let mut lexer = LexerSession::new(options);
        let mut parser = ParserSession::new(TEST_LIMITS, false);

        for character in input.chars() {
            let batch = lexer.push(Cow::Owned(character.to_string()));
            assert!(batch.errors.is_empty());
            assert_eq!(
                parser
                    .push_tokens(Cow::Owned(batch.tokens))
                    .expect("anchored raw batch should be accepted"),
                ParserSessionProgress::NeedMoreInput
            );
        }

        assert!(parser.token_start_index > 100);
        let final_batch = lexer.finish();
        let actual = parser
            .finish_tokens(Cow::Owned(final_batch.tokens))
            .expect("anchored raw document should finish");
        assert_eq!(actual, expected);

        let ParseOutcome::Parsed(bindings) = actual else {
            panic!("anchored raw document should parse");
        };
        assert_eq!(
            bindings[64].datatype.as_deref(),
            Some("map<string,list<number>>")
        );
        let Value::NodeLiteral { raw, .. } = &bindings[65].value else {
            panic!("final binding should retain a raw node literal");
        };
        assert_eq!(raw, "<root(1,<leaf>,\"🌊\")>");
    }

    #[cfg(feature = "sofia-fuzz")]
    #[test]
    fn incremental_fuzz_harness_covers_seed_and_utf8_lifecycle_paths() {
        super::fuzz_incremental_session(
            "200name = \"Sofía 🌊\"\nitems = [1, true]".as_bytes(),
            TEST_LIMITS,
        );
        super::fuzz_incremental_session(b"230name = \"Sofia\"\nlater = [1, 2, 3]", TEST_LIMITS);
        super::fuzz_incremental_session(b"Q1broken = [1,,2]\nlater = true", TEST_LIMITS);
        super::fuzz_incremental_session(&[0, 0xf0, b'('], TEST_LIMITS);
        super::fuzz_incremental_session(&[0, 0xf0, 0x9f], TEST_LIMITS);
    }

    #[test]
    fn parser_session_defers_incomplete_constructs_until_finish() {
        let input = "items = [1, 2 ";
        let options = LexerOptions {
            include_newlines: true,
            ..LexerOptions::default()
        };
        let expected = parse(input);
        let mut lexer = LexerSession::new(options);
        let mut parser = ParserSession::new(TEST_LIMITS, false);

        let batch = lexer.push(Cow::Borrowed(input));
        assert!(batch.errors.is_empty());
        assert_eq!(
            parser
                .push_tokens(Cow::Owned(batch.tokens))
                .expect("incomplete construct should suspend"),
            ParserSessionProgress::NeedMoreInput
        );

        let final_batch = lexer.finish();
        let actual = parser
            .finish_tokens(Cow::Owned(final_batch.tokens))
            .expect("final input should resolve to the truncation diagnostic");
        assert_eq!(actual, expected);
    }

    #[test]
    fn parser_session_reports_deterministic_malformed_input_during_push() {
        let input = "name = @ true\n";
        let options = LexerOptions {
            include_newlines: true,
            ..LexerOptions::default()
        };
        let expected = parse(input);
        let mut lexer = LexerSession::new(options);
        let mut parser = ParserSession::new(TEST_LIMITS, false);

        let batch = lexer.push(Cow::Borrowed(input));
        assert!(batch.errors.is_empty());
        assert_eq!(
            parser
                .push_tokens(Cow::Owned(batch.tokens))
                .expect("complete malformed construct should be diagnosed"),
            ParserSessionProgress::Complete(expected)
        );
        assert!(matches!(
            parser.finish_tokens(Cow::Owned(lexer.finish().tokens)),
            Err(ParserSessionError::Finished)
        ));
    }

    #[test]
    fn parser_session_enforces_final_eof_and_single_finish() {
        let lexed = tokenize(
            "name = true",
            LexerOptions {
                include_newlines: true,
                ..LexerOptions::default()
            },
        );
        assert!(lexed.errors.is_empty());
        let eof = lexed.tokens.last().expect("lexer should emit EOF").clone();
        let body = lexed.tokens[..lexed.tokens.len() - 1].to_vec();

        let mut early_eof = ParserSession::new(TEST_LIMITS, false);
        assert_eq!(
            early_eof.push_tokens(Cow::Owned(vec![eof.clone()])),
            Err(ParserSessionError::EofBeforeFinish)
        );

        let mut missing_eof = ParserSession::new(TEST_LIMITS, false);
        assert!(matches!(
            missing_eof.finish_tokens(Cow::Owned(body.clone())),
            Err(ParserSessionError::MissingFinalEof)
        ));
        assert!(matches!(
            missing_eof.finish_tokens(Cow::Owned(Vec::new())),
            Err(ParserSessionError::MissingFinalEof)
        ));

        let mut duplicate_eof = ParserSession::new(TEST_LIMITS, false);
        assert!(matches!(
            duplicate_eof.finish_tokens(Cow::Owned(vec![eof.clone(), eof.clone()])),
            Err(ParserSessionError::EofBeforeFinish)
        ));

        let mut finished = ParserSession::new(TEST_LIMITS, false);
        finished
            .push_tokens(Cow::Owned(body))
            .expect("body tokens should queue");
        assert!(matches!(
            finished.finish_tokens(Cow::Owned(vec![eof.clone()])),
            Ok(ParseOutcome::Parsed(_))
        ));
        assert_eq!(
            finished.push_tokens(Cow::Owned(Vec::new())),
            Err(ParserSessionError::Finished)
        );
        assert!(matches!(
            finished.finish_tokens(Cow::Owned(vec![eof])),
            Err(ParserSessionError::Finished)
        ));
    }

    #[test]
    #[should_panic(expected = "Sofia value frame received a product")]
    fn frame_product_mismatches_are_invariant_failures() {
        let lexed = tokenize(
            "",
            LexerOptions {
                include_newlines: true,
                ..LexerOptions::default()
            },
        );
        let mut state = ParserState::new(TEST_LIMITS, false);
        let mut parser = Parser::new(&lexed.tokens, 0, &mut state, true);
        let mut output = None;
        let _ = Frame::Value.step(&mut parser, Some(Product::Values(Vec::new())), &mut output);
    }

    fn assert_native_failure(input: &str, limits: ParserLimits, code: &str) -> crate::Diagnostic {
        let ParseOutcome::Failed(error) = parse_with_limits(input, limits) else {
            panic!("expected Sofia failure for input:\n{input}");
        };
        assert_eq!(error.code, code);
        error
    }

    #[test]
    fn iterative_frames_parse_scalar_documents() {
        let ParseOutcome::Parsed(bindings) = parse("name = \"Pat\"\nage = 49, enabled = true")
        else {
            panic!("scalar document should use the Sofia frame path");
        };

        assert_eq!(bindings.len(), 3);
        assert!(matches!(bindings[0].value, Value::StringLiteral { .. }));
        assert!(matches!(bindings[1].value, Value::NumberLiteral { .. }));
        assert!(matches!(bindings[2].value, Value::BooleanLiteral { .. }));
    }

    #[test]
    fn malformed_scalar_position_is_reported_natively() {
        let error = assert_native_failure("broken = [1,,2]", TEST_LIMITS, "SYNTAX_ERROR");
        assert_eq!(error.message, "Unexpected token ','");
    }

    #[test]
    fn native_document_recovery_preserves_baseline_synchronization() {
        let source = "@ nonsense\nlater = true";
        let ParseOutcome::Parsed(bindings) = parse(source) else {
            panic!("strict Expected-key recovery should stay on Sofia");
        };
        assert_eq!(bindings.len(), 1);
        assert_eq!(bindings[0].key, "later");

        let ParseOutcome::Recovered { bindings, errors } = parse_recovery(source) else {
            panic!("recovery parsing should stay on Sofia");
        };
        assert_eq!(bindings.len(), 1);
        assert_eq!(bindings[0].key, "later");
        assert_eq!(errors.len(), 1);
        assert_eq!(errors[0].code, "SYNTAX_ERROR");
        assert_eq!(errors[0].message, "Expected key");
        let span = errors[0].span.expect("error span");
        assert_eq!(span.start.offset, 0);
        assert_eq!(span.end.offset, 1);
        assert_eq!((span.start.line, span.start.column), (1, 1));
        assert_eq!((span.end.line, span.end.column), (1, 2));
    }

    #[test]
    fn native_binding_and_document_delimiter_errors_recover_later_bindings() {
        let missing_equals = "broken hello\nlater = true";
        let ParseOutcome::Failed(error) = parse(missing_equals) else {
            panic!("strict missing-equals failure should stay on Sofia");
        };
        assert_eq!(error.code, "SYNTAX_ERROR");
        assert_eq!(error.message, "Expected '=' after key 'broken'");

        let ParseOutcome::Recovered { bindings, errors } = parse_recovery(missing_equals) else {
            panic!("missing-equals recovery should stay on Sofia");
        };
        assert_eq!(bindings.len(), 1);
        assert_eq!(bindings[0].key, "later");
        assert_eq!(errors, [error]);

        let delimiter = "first = 1 garbage\nlater = true";
        let ParseOutcome::Recovered { bindings, errors } = parse_recovery(delimiter) else {
            panic!("delimiter recovery should stay on Sofia");
        };
        assert_eq!(bindings.len(), 2);
        assert_eq!(bindings[0].key, "first");
        assert_eq!(bindings[1].key, "later");
        assert_eq!(errors.len(), 1);
        assert_eq!(errors[0].message, "Expected binding delimiter");
    }

    #[test]
    fn iterative_binding_frames_preserve_header_source_planes() {
        let source = r#"aeon
:
header = { mode:string = "strict" }
aeon:profile = "core"
"aeon:mode" = "body"
aeon = "ordinary""#;
        let ParseOutcome::Parsed(bindings) = parse(source) else {
            panic!("header keys should use the Sofia path");
        };

        assert_eq!(bindings.len(), 4);
        assert_eq!(bindings[0].key, "aeon:header");
        assert!(bindings[0].is_header);
        assert!(matches!(bindings[0].value, Value::ObjectNode { .. }));
        assert_eq!(bindings[1].key, "aeon:profile");
        assert!(bindings[1].is_header);
        assert_eq!(bindings[2].key, "aeon:mode");
        assert!(!bindings[2].is_header);
        assert_eq!(bindings[3].key, "aeon");
        assert!(!bindings[3].is_header);
        assert_eq!(bindings[0].span.start.offset, 0);
        assert_eq!(
            bindings[0].span.end.offset,
            source.find("\naeon:profile").expect("first header end")
        );
    }

    #[test]
    fn iterative_scalar_parser_closes_the_remaining_literal_gap() {
        let source = r#"positive = Infinity
negative = -Infinity
not_a_number = -NaN
reserved = !notSet
reason = !"postponed"
absolute = $.inventory:csv[","]
context = ?.name
trim = >`
  one
  two
`"#;
        let ParseOutcome::Parsed(bindings) = parse(source) else {
            panic!("remaining literals should use the Sofia path");
        };

        assert!(matches!(bindings[0].value, Value::InfinityLiteral { .. }));
        let Value::InfinityLiteral { raw, span } = &bindings[1].value else {
            panic!("expected negative infinity");
        };
        assert_eq!(raw, "-Infinity");
        assert_eq!(&source[span.start.offset..span.end.offset], "-Infinity");
        let Value::NaNLiteral { raw, .. } = &bindings[2].value else {
            panic!("expected negative NaN");
        };
        assert_eq!(raw, "-NaN");

        let Value::NullLiteral { mode, raw, value } = &bindings[3].value else {
            panic!("expected reserved null");
        };
        assert_eq!(mode, &NullLiteralMode::Reserved);
        assert_eq!(raw, "!notSet");
        assert_eq!(value, "notSet");
        let Value::NullLiteral { mode, raw, value } = &bindings[4].value else {
            panic!("expected reason null");
        };
        assert_eq!(mode, &NullLiteralMode::Reason);
        assert_eq!(raw, "!\"postponed\"");
        assert_eq!(value, "postponed");

        let Value::SansaAddressLiteral { raw, canonical, .. } = &bindings[5].value else {
            panic!("expected absolute SANSA address");
        };
        assert_eq!(raw, r#"$.inventory:csv[","]"#);
        assert_eq!(canonical, raw);
        assert!(matches!(
            bindings[6].value,
            Value::SansaAddressLiteral { .. }
        ));

        let Value::StringLiteral {
            value,
            raw,
            delimiter,
            trimticks,
        } = &bindings[7].value
        else {
            panic!("expected trimtick string");
        };
        assert_eq!(value, "one\ntwo");
        assert_eq!(raw, "\n  one\n  two\n");
        assert_eq!(*delimiter, '`');
        let metadata = trimticks.as_ref().expect("trimtick metadata");
        assert_eq!(metadata.marker_width, 1);
        assert_eq!(metadata.raw_value, *raw);
    }

    #[test]
    fn iterative_reference_parser_preserves_kinds_segments_and_spans() {
        let source = r#"clone = ~$.["root.key"][1].member
pointer = ~>root.@.meta.["x.y"][0]
literal = ~true.off"#;
        let ParseOutcome::Parsed(bindings) = parse(source) else {
            panic!("references should use the Sofia path");
        };

        let Value::CloneReference { segments, span } = &bindings[0].value else {
            panic!("expected clone reference");
        };
        assert_eq!(
            segments,
            &[
                ReferenceSegment::Key(String::from("root.key")),
                ReferenceSegment::Index(1),
                ReferenceSegment::Key(String::from("member")),
            ]
        );
        let clone_start = source.find("~$.").expect("clone reference start");
        assert_eq!(span.start.offset, clone_start);
        assert_eq!(
            span.end.offset,
            clone_start + r#"~$.["root.key"][1].member"#.len()
        );

        let Value::PointerReference { segments, .. } = &bindings[1].value else {
            panic!("expected pointer reference");
        };
        assert_eq!(
            segments,
            &[
                ReferenceSegment::Key(String::from("root")),
                ReferenceSegment::Attr(String::from("meta")),
                ReferenceSegment::Key(String::from("x.y")),
                ReferenceSegment::Index(0),
            ]
        );
        let Value::CloneReference { segments, .. } = &bindings[2].value else {
            panic!("expected literal-word clone reference");
        };
        assert_eq!(
            segments,
            &[
                ReferenceSegment::Key(String::from("true")),
                ReferenceSegment::Key(String::from("off")),
            ]
        );
    }

    #[test]
    fn scalar_and_reference_failures_are_reported_natively() {
        let failures = [
            (
                "bad = !missing",
                "INVALID_NULL_SENTINEL",
                "Invalid null sentinel 'missing'",
            ),
            (
                "bad = 01",
                "INVALID_NUMBER",
                "Number literal `01` is not valid",
            ),
            (
                "bad = >>>>>`value`",
                "SYNTAX_ERROR",
                "Trimtick marker may contain at most four \">\" characters",
            ),
            (
                "bad = ~$[\"source\"]",
                "SYNTAX_ERROR",
                "Expected `.` after `$`",
            ),
            (
                "bad = ~source.@.[\"\"]",
                "SYNTAX_ERROR",
                "Empty quoted path segments are not valid",
            ),
        ];

        for (source, code, message) in failures {
            let error = assert_native_failure(source, TEST_LIMITS, code);
            assert_eq!(error.message, message);
        }
    }

    #[test]
    fn container_node_attribute_and_datatype_failures_are_reported_natively() {
        let failures = [
            ("bad = [1 2]", "SYNTAX_ERROR", "Expected list delimiter"),
            ("bad = [1)", "SYNTAX_ERROR", "Expected list delimiter"),
            ("bad = (1 2)", "SYNTAX_ERROR", "Expected tuple delimiter"),
            ("bad = (1]", "SYNTAX_ERROR", "Expected tuple delimiter"),
            (
                "bad = { first = 1 second = 2 }",
                "SYNTAX_ERROR",
                "Expected object member delimiter",
            ),
            (
                "bad = { first = 1 ]",
                "SYNTAX_ERROR",
                "Expected object member delimiter",
            ),
            (
                "bad = <root(1 2)>",
                "SYNTAX_ERROR",
                "Expected node child delimiter",
            ),
            (
                "bad = <root(1]>",
                "SYNTAX_ERROR",
                "Expected node child delimiter",
            ),
            (
                "bad = <root(1)",
                "SYNTAX_ERROR",
                "Expected `>` after node children",
            ),
            ("bad = <>", "SYNTAX_ERROR", "Expected node tag"),
            (
                "bad = <\"\">",
                "SYNTAX_ERROR",
                "Empty quoted node tags are not valid",
            ),
            (
                "bad = <`root`>",
                "SYNTAX_ERROR",
                "Backtick strings are not valid node tags",
            ),
            (
                "bad = <root garbage>",
                "SYNTAX_ERROR",
                "Expected `(` or `>` in node literal",
            ),
            (
                "bad = <root@{first=1}@{second=2}>",
                "SYNTAX_ERROR",
                "Only one attribute block is allowed before a node datatype",
            ),
            (
                "bad = <root:pair<string>>",
                "SYNTAX_ERROR",
                "Node head datatypes must be simple labels or node<T> without clarifiers",
            ),
            (
                "bad = [@{first=1}@{second=2} = 3]",
                "SYNTAX_ERROR",
                "Only one attribute block is allowed before an anonymous value datatype",
            ),
            (
                "bad = [:number 1]",
                "SYNTAX_ERROR",
                "Expected `=` after anonymous value head",
            ),
            (
                "bad@{first=1}@{second=2} = 3",
                "SYNTAX_ERROR",
                "Only one attribute block is allowed before a binding datatype",
            ),
            (
                "bad@{first=1 first=2} = 3",
                "SYNTAX_ERROR",
                "Expected attribute delimiter",
            ),
            (
                "bad@{first=1, first=2} = 3",
                "DUPLICATE_KEY",
                "Duplicate key: 'first'",
            ),
            (
                "bad@{__proto__=1} = 3",
                "SYNTAX_ERROR",
                "Reserved attribute key: __proto__",
            ),
            (
                "bad@{first = { nested=1 other=2 }} = 3",
                "SYNTAX_ERROR",
                "Expected object member delimiter",
            ),
            (
                "bad = [^0,0,0,1]",
                "INVALID_SEPARATOR_CHAR",
                "Invalid separator character `,`",
            ),
            (
                "bad:outer<first second> = 1",
                "SYNTAX_ERROR",
                "Expected ',' between generic arguments",
            ),
            (
                "bad:custom[] = 1",
                "SYNTAX_ERROR",
                "Datatype clarifier must contain at least one string or number",
            ),
            (
                "bad:custom[\"first\"][\"second\"] = 1",
                "SYNTAX_ERROR",
                "Datatype clarifiers must use a single bracketed list like `sep[\"/\", \".\"]`",
            ),
            (
                "bad:radix<10> = 1",
                "SYNTAX_ERROR",
                "Radix datatype bases must use bracket syntax like `radix[10]`",
            ),
        ];

        for (source, code, message) in failures {
            let error = assert_native_failure(source, TEST_LIMITS, code);
            assert_eq!(
                error.message, message,
                "diagnostic drift for input:\n{source}"
            );
        }
    }

    #[test]
    fn iterative_reference_parser_handles_very_deep_paths_without_frames() {
        let segment_count = 4_096;
        let reference = format!("~root{}", ".child".repeat(segment_count - 1));
        let source = format!("value = {reference}");
        let ParseOutcome::Parsed(bindings) = parse(&source) else {
            panic!("deep references should use the Sofia path");
        };
        let Value::CloneReference { segments, .. } = &bindings[0].value else {
            panic!("expected clone reference");
        };
        assert_eq!(segments.len(), segment_count);
    }

    #[test]
    fn iterative_node_frames_preserve_heads_children_and_raw_text() {
        let source = r#"tree = <"root tag"\root\@{class:string = "top"}:node<custom>(
  "text"
  \child\:string = "typed"
  <leaf>
)>"#;
        let ParseOutcome::Parsed(bindings) = parse(source) else {
            panic!("nodes should use the Sofia frame path");
        };

        let Value::NodeLiteral {
            raw,
            tag,
            structural_id,
            attributes,
            attribute_order,
            datatype,
            children,
            head_span,
        } = &bindings[0].value
        else {
            panic!("expected node value");
        };
        assert_eq!(tag, "root tag");
        assert_eq!(structural_id.as_deref(), Some("root"));
        assert_eq!(attribute_order, &["class"]);
        assert_eq!(attributes.len(), 1);
        assert!(attributes[0].contains_key("class"));
        assert_eq!(datatype.as_deref(), Some("node<custom>"));
        assert_eq!(children.len(), 3);
        assert!(matches!(children[1], Value::TypedValue { .. }));
        assert!(matches!(children[2], Value::NodeLiteral { .. }));
        assert!(
            raw.starts_with("<\"root tag\"root@{"),
            "unexpected raw node text: {raw:?}"
        );
        assert!(raw.ends_with(")>"));
        assert!(head_span.start.offset < head_span.end.offset);
    }

    #[test]
    fn iterative_node_frames_are_stack_safe_and_limit_aware() {
        let depth = 512;
        let mut node = String::from("<leaf>");
        for _ in 1..depth {
            node = format!("<branch({node})>");
        }
        let source = format!("tree = {node}");
        assert!(matches!(
            parse_with_limits(&source, ParserLimits::new(depth, 8, 8, 8, 32, 64)),
            ParseOutcome::Parsed(_)
        ));
        let error = assert_native_failure(
            "tree = <root(<leaf>)>",
            ParserLimits::new(1, 8, 8, 8, 32, 64),
            "NESTING_DEPTH_EXCEEDED",
        );
        assert_eq!(
            error.message,
            "Value nesting depth 2 exceeds max_value_nesting_depth 1"
        );
        assert!(matches!(
            parse_with_limits("tree = <root(1, 2)>", ParserLimits::new(1, 8, 8, 8, 32, 64)),
            ParseOutcome::Parsed(_)
        ));
    }

    #[test]
    fn iterative_frames_parse_nested_containers() {
        let ParseOutcome::Parsed(bindings) = parse("nested = [1, (true, { name = \"Pat\" })]")
        else {
            panic!("nested containers should use the Sofia frame path");
        };

        let Value::ListNode { items } = &bindings[0].value else {
            panic!("expected list value");
        };
        assert_eq!(items.len(), 2);
        assert!(matches!(items[1], Value::TupleLiteral { .. }));
    }

    #[test]
    fn iterative_frames_parse_typed_and_identified_heads() {
        let source = r#"root\root\:list = [
  \child\:string = "value"
  :number = 1
  { "nested key"\nested\:object = {} }
]"#;
        let ParseOutcome::Parsed(bindings) = parse(source) else {
            panic!("typed and identified heads should use the Sofia frame path");
        };

        assert_eq!(bindings[0].structural_id.as_deref(), Some("root"));
        assert_eq!(bindings[0].datatype.as_deref(), Some("list"));
        let Value::ListNode { items } = &bindings[0].value else {
            panic!("expected list value");
        };
        let Value::TypedValue {
            structural_id,
            datatype,
            ..
        } = &items[0]
        else {
            panic!("expected typed anonymous value");
        };
        assert_eq!(structural_id.as_deref(), Some("child"));
        assert_eq!(datatype.as_deref(), Some("string"));
    }

    #[test]
    fn duplicate_identity_is_reported_natively() {
        let error = assert_native_failure(
            "first\\same\\ = 1\nsecond\\same\\ = 2",
            TEST_LIMITS,
            "DUPLICATE_STRUCTURAL_IDENTITY",
        );
        assert_eq!(error.message, "Duplicate structural identity: 'same'");
    }

    #[test]
    fn iterative_attribute_frames_preserve_all_attribute_shapes() {
        let source = r#"payload\root\@{
  source\meta\:string = "user"
  policy@{
    inherited:boolean = true
  }:object = {
    enabled:boolean = true
    nested = { count:number = 2 }
  }
}:object = { value = 1 }
items = [@{note:string = "first"}:number = 1]"#;
        let ParseOutcome::Parsed(bindings) = parse(source) else {
            panic!("attributes should use the Sofia frame path");
        };

        assert_eq!(bindings[0].attribute_order, ["source", "policy"]);
        assert_eq!(
            bindings[0].attributes["source"].structural_id.as_deref(),
            Some("meta")
        );
        let policy = &bindings[0].attributes["policy"];
        assert_eq!(policy.nested_attr_order, ["inherited"]);
        assert_eq!(policy.object_member_order, ["enabled", "nested"]);
        assert_eq!(
            policy.object_members["nested"].object_member_order,
            ["count"]
        );

        let Value::ListNode { items } = &bindings[1].value else {
            panic!("expected list value");
        };
        let Value::TypedValue {
            attributes,
            attribute_order,
            ..
        } = &items[0]
        else {
            panic!("expected attributed anonymous value");
        };
        assert_eq!(attribute_order, &["note"]);
        assert!(attributes.contains_key("note"));
    }

    #[test]
    fn attribute_head_depth_and_object_depth_remain_independent() {
        let nested_head = "root@{outer@{inner = 1} = 2} = 3";
        assert!(matches!(parse(nested_head), ParseOutcome::Parsed(_)));
        let error = assert_native_failure(
            nested_head,
            ParserLimits::new(256, 1, 8, 8, 32, 64),
            "ATTRIBUTE_DEPTH_EXCEEDED",
        );
        assert_eq!(
            error.message,
            "Attribute depth 2 exceeds max_attribute_depth 1"
        );

        let depth = 256;
        let mut object = String::from("1");
        for _ in 0..depth {
            object = format!("{{ child = {object} }}");
        }
        let source = format!("root@{{tree = {object}}} = 1");
        assert!(matches!(
            parse_with_limits(&source, ParserLimits::new(256, 1, 8, 8, 32, 64)),
            ParseOutcome::Parsed(_)
        ));
    }

    #[test]
    fn iterative_datatype_frames_parse_generics_and_clarifiers() {
        let source = r#"payload:custom<
  tuple<string, number>,
  3
>["x", 1_0] = 1"#;
        let ParseOutcome::Parsed(bindings) = parse(source) else {
            panic!("generic datatype should use the Sofia frame path");
        };
        assert_eq!(
            bindings[0].datatype.as_deref(),
            Some(r#"custom<tuple<string,number>,3>["x",10]"#)
        );
    }

    #[test]
    fn iterative_datatype_frames_are_stack_safe_and_limit_aware() {
        let depth = 512;
        let datatype = format!("{}string{}", "custom<".repeat(depth), ">".repeat(depth));
        let source = format!("value:{datatype} = 1");
        assert!(matches!(
            parse_with_limits(&source, ParserLimits::new(256, 8, 8, depth, 32, 1024)),
            ParseOutcome::Parsed(_)
        ));

        let limited = [
            (
                "value:outer<inner<value>> = 1",
                ParserLimits::new(256, 8, 8, 0, 32, 64),
                "GENERIC_DEPTH_EXCEEDED",
            ),
            (
                "value:outer<first, second> = 1",
                ParserLimits::new(256, 8, 8, 8, 1, 64),
                "GENERIC_ARGUMENTS_EXCEEDED",
            ),
            (
                "value:custom[\"first\", \"second\"] = 1",
                ParserLimits::new(256, 8, 1, 8, 32, 64),
                "CLARIFIER_VALUES_EXCEEDED",
            ),
            (
                "value:outer<first, second> = 1",
                ParserLimits::new(256, 8, 8, 8, 32, 2),
                "DATATYPE_COMPONENTS_EXCEEDED",
            ),
        ];
        for (source, limits, code) in limited {
            assert_native_failure(source, limits, code);
        }
    }

    #[test]
    fn iterative_container_depth_is_explicit_and_limit_aware() {
        let depth = 512;
        let source = format!("nested = {}1{}", "[".repeat(depth), "]".repeat(depth));
        assert!(matches!(
            parse_with_limits(&source, ParserLimits::new(depth, 8, 8, 8, 32, 64)),
            ParseOutcome::Parsed(_)
        ));
        let error = assert_native_failure(
            "nested = [[1]]",
            ParserLimits::new(1, 8, 8, 8, 32, 64),
            "NESTING_DEPTH_EXCEEDED",
        );
        assert_eq!(
            error.message,
            "Value nesting depth 2 exceeds max_value_nesting_depth 1"
        );
    }

    const DEEP_STACK_STRESS_DEPTH: usize = 16_384;

    fn retain_deep_parse_result(source: &str, limits: ParserLimits) {
        let ParseOutcome::Parsed(bindings) = parse_with_limits(source, limits) else {
            panic!("Sofia should parse the deep-stack stress input");
        };
        assert_eq!(bindings.len(), 1);
        crate::drop_parser_bindings_iteratively(bindings);
    }

    #[test]
    #[ignore = "run with `npm run test:sofia:deep-stack`"]
    fn sofia_deep_stack_stress_covers_every_recursive_frame_family() {
        let depth = DEEP_STACK_STRESS_DEPTH;
        let value_limits = ParserLimits::new(depth, 8, 8, 8, 32, 64);

        // Newlines prevent the consecutive-opener projection from turning this
        // successful descent into a quadratic pre-scan.
        let nested_list = format!("nested = {}1{}", "[\n".repeat(depth), "\n]".repeat(depth));
        retain_deep_parse_result(&nested_list, value_limits);

        let nested_attribute_object = format!(
            "root@{{tree = {}1{}}} = 1",
            "{ child = ".repeat(depth),
            " }".repeat(depth)
        );
        retain_deep_parse_result(
            &nested_attribute_object,
            ParserLimits::new(1, 1, 8, 8, 32, 64),
        );

        // Node values retain the raw text of every completed subtree, and datatype
        // normalization rebuilds every completed generic subtree. Descend beyond a
        // normal native stack margin, then fail at the configured boundary before
        // those intentionally recursive-shaped results are materialized.
        let nested_node = format!(
            "tree = {}<leaf>{}",
            "<branch(".repeat(depth - 1),
            ")>".repeat(depth - 1)
        );
        let node_error = assert_native_failure(
            &nested_node,
            ParserLimits::new(depth - 1, 8, 8, 8, 32, 64),
            "NESTING_DEPTH_EXCEEDED",
        );
        assert_eq!(
            node_error.message,
            format!(
                "Value nesting depth {depth} exceeds max_value_nesting_depth {}",
                depth - 1
            )
        );

        let nested_datatype = format!(
            "value:{}string{} = 1",
            "custom<".repeat(depth),
            ">".repeat(depth)
        );
        let datatype_error = assert_native_failure(
            &nested_datatype,
            ParserLimits::new(1, 1, 8, depth - 2, 32, depth + 1),
            "GENERIC_DEPTH_EXCEEDED",
        );
        assert_eq!(
            datatype_error.message,
            format!(
                "Generic depth {} exceeds max_generic_depth {}",
                depth - 1,
                depth - 2
            )
        );
    }
}
