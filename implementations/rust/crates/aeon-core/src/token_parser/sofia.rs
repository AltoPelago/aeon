use std::collections::{BTreeMap, HashSet};

use crate::header::apply_trimticks;
use crate::sansa::parse_address as parse_sansa_address;
use crate::{
    AttributeValue, Binding, NullLiteralMode, ReferenceSegment, Span, Token, TokenKind,
    TrimtickMetadata, Value,
};

use super::{
    ParserLimits, RESERVED_ATTRIBUTE_KEYS, classify_temporal_literal, datatype_base,
    datatype_bracket_specs, decode_quoted_token, invalid_temporal_literal,
    is_ascii_whitespace_only, is_bare_key_kind, is_reserved_null_sentinel, is_valid_number_literal,
    render_quoted_string, validate_binding_node_datatype, validate_reserved_datatype_adornments,
};

pub(super) enum ParseOutcome {
    Parsed(Vec<Binding>),
    Unsupported,
}

pub(super) fn parse_document(tokens: &[Token], limits: ParserLimits) -> ParseOutcome {
    Parser::new(tokens, limits).run()
}

struct Parser<'a> {
    tokens: &'a [Token],
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
}

impl<'a> Parser<'a> {
    fn new(tokens: &'a [Token], limits: ParserLimits) -> Self {
        debug_assert_eq!(tokens.last().map(|token| token.kind), Some(TokenKind::Eof));
        Self {
            tokens,
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
        }
    }

    fn run(mut self) -> ParseOutcome {
        let mut frames = vec![Frame::Document(DocumentFrame::new())];
        let mut product = None;

        loop {
            let Some(frame) = frames.pop() else {
                debug_assert!(
                    false,
                    "Sofia frame stack exhausted without a document product"
                );
                return ParseOutcome::Unsupported;
            };

            let input = product.take();
            match frame.step(&mut self, input, &mut product) {
                Step::Continue(frame) => frames.push(frame),
                Step::Push { parent, child } => {
                    frames.push(parent);
                    frames.push(child);
                }
                Step::Complete if frames.is_empty() => {
                    return match product.take() {
                        Some(Product::Document(bindings)) => {
                            debug_assert_eq!(self.current_value_nesting_depth, 0);
                            ParseOutcome::Parsed(bindings)
                        }
                        Some(
                            Product::AttributeEntry(_)
                            | Product::Attributes(_)
                            | Product::Binding(_)
                            | Product::Datatype(_)
                            | Product::Values(_)
                            | Product::Value(_),
                        )
                        | None => {
                            debug_assert!(false, "Sofia root frame returned the wrong product");
                            ParseOutcome::Unsupported
                        }
                    };
                }
                Step::Complete => {
                    debug_assert!(product.is_some(), "Sofia frame completed without a product");
                }
                Step::Unsupported => return ParseOutcome::Unsupported,
            }
        }
    }

    fn parse_scalar(&mut self) -> Option<Value> {
        let token = self.peek();
        match token.kind {
            TokenKind::String => {
                let token = self.advance();
                Some(Value::StringLiteral {
                    value: decode_quoted_token(token).ok()?,
                    raw: token.text[1..token.text.len() - 1].to_string(),
                    delimiter: token.quote.unwrap_or('"'),
                    trimticks: None,
                })
            }
            TokenKind::Number => {
                let raw = token.text.clone();
                if invalid_temporal_literal(&raw).is_some() || !is_valid_number_literal(&raw) {
                    return None;
                }
                self.advance();
                Some(classify_temporal_literal(&raw).unwrap_or(Value::NumberLiteral { raw }))
            }
            TokenKind::Identifier if token.text == "Infinity" => {
                let token = self.advance();
                Some(Value::InfinityLiteral {
                    raw: token.text.clone(),
                    span: token.span,
                })
            }
            TokenKind::Identifier if token.text == "NaN" => {
                let token = self.advance();
                Some(Value::NaNLiteral {
                    raw: token.text.clone(),
                    span: token.span,
                })
            }
            TokenKind::Symbol
                if token.text == "-"
                    && self.peek_next().kind == TokenKind::Identifier
                    && self.peek_next().text == "Infinity" =>
            {
                let start = self.advance().span.start;
                let end = self.advance().span.end;
                Some(Value::InfinityLiteral {
                    raw: String::from("-Infinity"),
                    span: Span { start, end },
                })
            }
            TokenKind::Symbol
                if token.text == "-"
                    && self.peek_next().kind == TokenKind::Identifier
                    && self.peek_next().text == "NaN" =>
            {
                let start = self.advance().span.start;
                let end = self.advance().span.end;
                Some(Value::NaNLiteral {
                    raw: String::from("-NaN"),
                    span: Span { start, end },
                })
            }
            TokenKind::Symbol if token.text == "!" => self.parse_null_literal(),
            TokenKind::True | TokenKind::False => Some(Value::BooleanLiteral {
                raw: self.advance().text.clone(),
            }),
            TokenKind::Yes | TokenKind::No | TokenKind::On | TokenKind::Off => {
                Some(Value::ToggleLiteral {
                    raw: self.advance().text.clone(),
                })
            }
            TokenKind::HexLiteral => Some(Value::HexLiteral {
                raw: self.advance().text.clone(),
            }),
            TokenKind::RadixLiteral => Some(Value::RadixLiteral {
                raw: self.advance().text.clone(),
            }),
            TokenKind::EncodingLiteral => Some(Value::EncodingLiteral {
                raw: self.advance().text.clone(),
            }),
            TokenKind::SeparatorLiteral => Some(Value::SeparatorLiteral {
                raw: self.advance().text.clone(),
            }),
            TokenKind::SansaAddressLiteral => {
                let token = self.advance();
                let raw = token.text.clone();
                let address = parse_sansa_address(&raw).ok()?;
                let canonical = address.canonical.clone();
                Some(Value::SansaAddressLiteral {
                    address,
                    raw,
                    canonical,
                })
            }
            TokenKind::RightAngle => self.parse_trimtick(),
            _ => None,
        }
    }

    fn parse_null_literal(&mut self) -> Option<Value> {
        if !self.check(TokenKind::Symbol) || self.peek().text != "!" {
            return None;
        }
        self.advance();
        match self.peek().kind {
            TokenKind::Identifier if is_reserved_null_sentinel(&self.peek().text) => {
                let value = self.advance().text.clone();
                Some(Value::NullLiteral {
                    mode: NullLiteralMode::Reserved,
                    raw: format!("!{value}"),
                    value,
                })
            }
            TokenKind::String => {
                let value = decode_quoted_token(self.advance()).ok()?;
                if value.is_empty()
                    || is_ascii_whitespace_only(&value)
                    || is_reserved_null_sentinel(&value)
                {
                    return None;
                }
                Some(Value::NullLiteral {
                    mode: NullLiteralMode::Reason,
                    raw: format!("!{}", render_quoted_string(&value)),
                    value,
                })
            }
            _ => None,
        }
    }

    fn parse_trimtick(&mut self) -> Option<Value> {
        let mut marker_width = 0usize;
        let mut previous_end = None;
        while self.check(TokenKind::RightAngle) {
            let token = self.peek();
            if previous_end.is_some_and(|end| end != token.span.start.offset) {
                return None;
            }
            marker_width += 1;
            if marker_width > 4 {
                return None;
            }
            previous_end = Some(token.span.end.offset);
            self.advance();
        }
        if !self.check(TokenKind::String) || self.peek().quote != Some('`') {
            return None;
        }
        let raw = decode_quoted_token(self.advance()).ok()?;
        Some(Value::StringLiteral {
            value: apply_trimticks(&raw, marker_width),
            raw: raw.clone(),
            delimiter: '`',
            trimticks: Some(TrimtickMetadata {
                marker_width,
                raw_value: raw,
            }),
        })
    }

    fn enter_value_container(&mut self) -> bool {
        if self.current_value_nesting_depth >= self.max_value_nesting_depth {
            return false;
        }
        self.current_value_nesting_depth += 1;
        true
    }

    fn parse_key(&mut self) -> Option<(String, bool, crate::Position)> {
        let token = self.peek();
        let start = token.span.start;
        match token.kind {
            kind if is_bare_key_kind(kind) && token.text != "aeon" => {
                Some((self.advance().text.clone(), false, start))
            }
            TokenKind::String if token.quote != Some('`') => {
                let key = decode_quoted_token(self.advance()).ok()?;
                (!key.is_empty()).then_some((key, false, start))
            }
            _ => None,
        }
    }

    fn parse_node_tag(&mut self) -> Option<String> {
        match self.peek().kind {
            kind if is_bare_key_kind(kind) => Some(self.advance().text.clone()),
            TokenKind::String if self.peek().quote != Some('`') => {
                let tag = decode_quoted_token(self.advance()).ok()?;
                (!tag.is_empty()).then_some(tag)
            }
            _ => None,
        }
    }

    fn parse_reference(&mut self) -> Option<Value> {
        let start = self.peek().span.start;
        let is_pointer = match self.peek().kind {
            TokenKind::TildeArrow => {
                self.advance();
                true
            }
            TokenKind::Tilde => {
                self.advance();
                false
            }
            _ => return None,
        };

        let mut segments = Vec::new();
        if self.check(TokenKind::Dollar) {
            self.advance();
            if !self.check(TokenKind::Dot) {
                return None;
            }
            self.advance();
            if self.check(TokenKind::LeftBracket) {
                segments.push(ReferenceSegment::Key(self.parse_bracketed_reference_key()?));
            } else {
                segments.push(ReferenceSegment::Key(self.parse_reference_key()?));
            }
        } else if self.check(TokenKind::LeftBracket) {
            segments.push(ReferenceSegment::Key(self.parse_bracketed_reference_key()?));
        } else {
            segments.push(ReferenceSegment::Key(self.parse_reference_key()?));
        }

        loop {
            if self.check(TokenKind::Dot) {
                self.advance();
                if self.check(TokenKind::At) {
                    self.advance();
                    if !self.check(TokenKind::Dot) {
                        return None;
                    }
                    self.advance();
                    let key = if self.check(TokenKind::LeftBracket) {
                        self.parse_bracketed_reference_key()?
                    } else {
                        self.parse_reference_key()?
                    };
                    segments.push(ReferenceSegment::Attr(key));
                } else {
                    let key = if self.check(TokenKind::LeftBracket) {
                        self.parse_bracketed_reference_key()?
                    } else {
                        self.parse_reference_key()?
                    };
                    segments.push(ReferenceSegment::Key(key));
                }
                continue;
            }

            if self.check(TokenKind::LeftBracket) {
                self.advance();
                if self.check(TokenKind::String) {
                    let key = self.parse_reference_key()?;
                    if !self.check(TokenKind::RightBracket) {
                        return None;
                    }
                    self.advance();
                    segments.push(ReferenceSegment::Key(key));
                } else if self.check(TokenKind::Number) {
                    let index = self.advance().text.parse::<usize>().ok()?;
                    if !self.check(TokenKind::RightBracket) {
                        return None;
                    }
                    self.advance();
                    segments.push(ReferenceSegment::Index(index));
                } else {
                    return None;
                }
                continue;
            }
            break;
        }

        let span = Span {
            start,
            end: self.previous().span.end,
        };
        Some(if is_pointer {
            Value::PointerReference { segments, span }
        } else {
            Value::CloneReference { segments, span }
        })
    }

    fn parse_bracketed_reference_key(&mut self) -> Option<String> {
        if !self.check(TokenKind::LeftBracket) {
            return None;
        }
        self.advance();
        if !self.check(TokenKind::String) {
            return None;
        }
        let key = self.parse_reference_key()?;
        if !self.check(TokenKind::RightBracket) {
            return None;
        }
        self.advance();
        Some(key)
    }

    fn parse_reference_key(&mut self) -> Option<String> {
        match self.peek().kind {
            kind if is_bare_key_kind(kind) => Some(self.advance().text.clone()),
            TokenKind::String => {
                let key = decode_quoted_token(self.advance()).ok()?;
                (!key.is_empty()).then_some(key)
            }
            _ => None,
        }
    }

    fn parse_optional_structural_identity(&mut self) -> Option<Option<String>> {
        if !self.check(TokenKind::StructuralIdentity) {
            return Some(None);
        }
        let identity = self.advance().text.clone();
        self.structural_identities
            .insert(identity.clone())
            .then_some(Some(identity))
    }

    fn open_attribute_block(&mut self, depth: usize) -> bool {
        if depth > self.max_attribute_depth || !self.check(TokenKind::At) {
            return false;
        }
        self.advance();
        self.skip_newlines();
        if !self.check(TokenKind::LeftBrace) {
            return false;
        }
        self.advance();
        true
    }

    fn begin_datatype(&mut self) {
        self.current_datatype_components = 0;
    }

    fn count_datatype_component(&mut self) -> bool {
        self.current_datatype_components += 1;
        self.current_datatype_components <= self.max_datatype_components
    }

    fn normalized_datatype(&self, start: usize, end: usize) -> String {
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
            .and_then(|index| self.tokens.get(index));
        let next_token = self.tokens.get(self.current + 1);
        previous_value.is_some_and(|token| token.kind == TokenKind::SeparatorLiteral)
            && previous_value.is_some_and(|token| token.span.end.offset == comma.span.start.offset)
            && next_token.is_some_and(|token| token.span.start.offset == comma.span.end.offset)
    }

    fn skip_newlines(&mut self) {
        while self.check(TokenKind::Newline) {
            self.advance();
        }
    }

    fn check(&self, kind: TokenKind) -> bool {
        self.peek().kind == kind
    }

    fn is_at_end(&self) -> bool {
        self.check(TokenKind::Eof)
    }

    fn advance(&mut self) -> &'a Token {
        debug_assert!(!self.is_at_end(), "Sofia advanced past EOF");
        let token = &self.tokens[self.current];
        self.current += 1;
        token
    }

    fn previous(&self) -> &'a Token {
        &self.tokens[self.current.saturating_sub(1)]
    }

    fn previous_non_newline(&self) -> &'a Token {
        self.tokens[..self.current]
            .iter()
            .rev()
            .find(|token| token.kind != TokenKind::Newline)
            .unwrap_or_else(|| self.previous())
    }

    fn tokens_text(&self, start: usize, end: usize) -> String {
        self.tokens[start..end]
            .iter()
            .map(|token| token.text.as_str())
            .collect()
    }

    fn peek(&self) -> &'a Token {
        &self.tokens[self.current]
    }

    fn peek_next(&self) -> &'a Token {
        self.tokens
            .get(self.current + 1)
            .unwrap_or_else(|| self.tokens.last().expect("token stream has EOF"))
    }
}

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
    fn step(
        self,
        parser: &mut Parser<'_>,
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
                if product.is_some() {
                    debug_assert!(false, "Sofia value frame received a product");
                    return Step::Unsupported;
                }
                let container = match parser.peek().kind {
                    TokenKind::LeftBracket => Some(ContainerKind::List),
                    TokenKind::LeftParen => Some(ContainerKind::Tuple),
                    TokenKind::LeftBrace => {
                        if !parser.enter_value_container() {
                            return Step::Unsupported;
                        }
                        parser.advance();
                        return Step::Continue(Frame::Object(ObjectFrame::new()));
                    }
                    TokenKind::LeftAngle => {
                        if !parser.enter_value_container() {
                            return Step::Unsupported;
                        }
                        let start_index = parser.current;
                        parser.advance();
                        return Step::Continue(Frame::Node(NodeFrame::new(start_index)));
                    }
                    TokenKind::Tilde | TokenKind::TildeArrow => {
                        return parser.parse_reference().map_or(Step::Unsupported, |value| {
                            complete(output, Product::Value(value))
                        });
                    }
                    _ => None,
                };
                if let Some(kind) = container {
                    if !parser.enter_value_container() {
                        return Step::Unsupported;
                    }
                    parser.advance();
                    return Step::Continue(Frame::Sequence(ValueSequenceFrame::new(kind)));
                }
                parser.parse_scalar().map_or(Step::Unsupported, |value| {
                    complete(output, Product::Value(value))
                })
            }
        }
    }
}

enum Product {
    AttributeEntry(ParsedAttributeEntry),
    Attributes(ParsedAttributes),
    Datatype(String),
    Document(Vec<Binding>),
    Binding(Binding),
    Values(Vec<Value>),
    Value(Value),
}

enum Step {
    Continue(Frame),
    Push { parent: Frame, child: Frame },
    Complete,
    Unsupported,
}

fn complete(output: &mut Option<Product>, product: Product) -> Step {
    debug_assert!(output.is_none(), "Sofia product outbox was not empty");
    *output = Some(product);
    Step::Complete
}

struct DocumentFrame {
    bindings: Vec<Binding>,
    phase: DocumentPhase,
}

impl DocumentFrame {
    fn new() -> Self {
        Self {
            bindings: Vec::new(),
            phase: DocumentPhase::Binding,
        }
    }

    fn step(
        mut self,
        parser: &mut Parser<'_>,
        product: Option<Product>,
        output: &mut Option<Product>,
    ) -> Step {
        match self.phase {
            DocumentPhase::Binding => {
                if product.is_some() {
                    debug_assert!(false, "Sofia document frame received an early product");
                    return Step::Unsupported;
                }
                parser.skip_newlines();
                if parser.is_at_end() {
                    return complete(output, Product::Document(self.bindings));
                }
                self.phase = DocumentPhase::Delimiter;
                Step::Push {
                    parent: Frame::Document(self),
                    child: Frame::Binding(BindingFrame::new()),
                }
            }
            DocumentPhase::Delimiter => {
                let Some(Product::Binding(binding)) = product else {
                    debug_assert!(false, "Sofia document frame expected a binding product");
                    return Step::Unsupported;
                };
                self.bindings.push(binding);

                if parser.is_at_end() {
                    return complete(output, Product::Document(self.bindings));
                }
                if parser.check(TokenKind::Comma) {
                    parser.advance();
                } else if parser.check(TokenKind::Newline) {
                    parser.skip_newlines();
                } else {
                    return Step::Unsupported;
                }

                self.phase = DocumentPhase::Binding;
                Step::Continue(Frame::Document(self))
            }
        }
    }
}

enum DocumentPhase {
    Binding,
    Delimiter,
}

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
        parser: &mut Parser<'_>,
        product: Option<Product>,
        output: &mut Option<Product>,
    ) -> Step {
        match self.phase {
            BindingPhase::Key => {
                if product.is_some() {
                    debug_assert!(false, "Sofia binding frame received an early product");
                    return Step::Unsupported;
                }
                let Some((key, is_header, start)) = parser.parse_key() else {
                    return Step::Unsupported;
                };
                parser.skip_newlines();
                let Some(structural_id) = parser.parse_optional_structural_identity() else {
                    return Step::Unsupported;
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
                    if !parser.open_attribute_block(1) {
                        return Step::Unsupported;
                    }
                    Step::Push {
                        parent: Frame::Binding(Self {
                            phase: BindingPhase::Attributes(head),
                        }),
                        child: Frame::AttributeMembers(AttributeMembersFrame::block(1)),
                    }
                } else {
                    Self::push_datatype_or_value(parser, head)
                }
            }
            BindingPhase::Attributes(mut head) => {
                let Some(Product::Attributes(attributes)) = product else {
                    debug_assert!(false, "Sofia binding frame expected attributes");
                    return Step::Unsupported;
                };
                head.attributes = attributes.members;
                head.attribute_order = attributes.order;
                parser.skip_newlines();
                if parser.check(TokenKind::At) {
                    return Step::Unsupported;
                }
                Self::push_datatype_or_value(parser, head)
            }
            BindingPhase::Datatype(mut head) => {
                let Some(Product::Datatype(datatype)) = product else {
                    debug_assert!(false, "Sofia binding frame expected a datatype product");
                    return Step::Unsupported;
                };
                if validate_binding_node_datatype(&datatype, parser.previous().span).is_err() {
                    return Step::Unsupported;
                }
                head.datatype = Some(datatype);
                Self::push_value(parser, head)
            }
            BindingPhase::Value(head) => {
                let Some(Product::Value(value)) = product else {
                    debug_assert!(false, "Sofia binding frame expected a value product");
                    return Step::Unsupported;
                };
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
    }

    fn push_datatype_or_value(parser: &mut Parser<'_>, head: BindingHead) -> Step {
        if parser.check(TokenKind::Colon) {
            parser.advance();
            parser.skip_newlines();
            parser.begin_datatype();
            Step::Push {
                parent: Frame::Binding(Self {
                    phase: BindingPhase::Datatype(head),
                }),
                child: Frame::Datatype(DatatypeFrame::new(0)),
            }
        } else {
            Self::push_value(parser, head)
        }
    }

    fn push_value(parser: &mut Parser<'_>, head: BindingHead) -> Step {
        parser.skip_newlines();
        if !parser.check(TokenKind::Equals) {
            return Step::Unsupported;
        }
        parser.advance();
        parser.skip_newlines();
        Step::Push {
            parent: Frame::Binding(Self {
                phase: BindingPhase::Value(head),
            }),
            child: Frame::Value,
        }
    }
}

enum BindingPhase {
    Key,
    Attributes(BindingHead),
    Datatype(BindingHead),
    Value(BindingHead),
}

struct BindingHead {
    start: crate::Position,
    key: String,
    is_header: bool,
    structural_id: Option<String>,
    datatype: Option<String>,
    attributes: BTreeMap<String, AttributeValue>,
    attribute_order: Vec<String>,
}

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
        parser: &mut Parser<'_>,
        product: Option<Product>,
        output: &mut Option<Product>,
    ) -> Step {
        match self.phase {
            AnonymousValuePhase::Head => {
                if product.is_some() {
                    debug_assert!(
                        false,
                        "Sofia anonymous-value frame received an early product"
                    );
                    return Step::Unsupported;
                }
                if !matches!(
                    parser.peek().kind,
                    TokenKind::StructuralIdentity | TokenKind::Colon | TokenKind::At
                ) {
                    return Step::Continue(Frame::Value);
                }

                let Some(structural_id) = parser.parse_optional_structural_identity() else {
                    return Step::Unsupported;
                };
                parser.skip_newlines();
                let head = AnonymousHead {
                    structural_id,
                    datatype: None,
                    attributes: BTreeMap::new(),
                    attribute_order: Vec::new(),
                };
                if parser.check(TokenKind::At) {
                    if !parser.open_attribute_block(1) {
                        return Step::Unsupported;
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
                    debug_assert!(false, "Sofia anonymous-value frame expected attributes");
                    return Step::Unsupported;
                };
                head.attributes = attributes.members;
                head.attribute_order = attributes.order;
                parser.skip_newlines();
                if parser.check(TokenKind::At) {
                    return Step::Unsupported;
                }
                Self::push_datatype_or_value(parser, head)
            }
            AnonymousValuePhase::Datatype(mut head) => {
                let Some(Product::Datatype(datatype)) = product else {
                    debug_assert!(
                        false,
                        "Sofia anonymous-value frame expected a datatype product"
                    );
                    return Step::Unsupported;
                };
                if validate_binding_node_datatype(&datatype, parser.previous().span).is_err() {
                    return Step::Unsupported;
                }
                head.datatype = Some(datatype);
                Self::push_value(parser, head)
            }
            AnonymousValuePhase::Value(head) => {
                let Some(Product::Value(value)) = product else {
                    debug_assert!(
                        false,
                        "Sofia anonymous-value frame expected a value product"
                    );
                    return Step::Unsupported;
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

    fn push_datatype_or_value(parser: &mut Parser<'_>, head: AnonymousHead) -> Step {
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

    fn push_value(parser: &mut Parser<'_>, head: AnonymousHead) -> Step {
        parser.skip_newlines();
        if !parser.check(TokenKind::Equals) {
            return Step::Unsupported;
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

enum AnonymousValuePhase {
    Head,
    Attributes(AnonymousHead),
    Datatype(AnonymousHead),
    Value(AnonymousHead),
}

struct AnonymousHead {
    structural_id: Option<String>,
    datatype: Option<String>,
    attributes: BTreeMap<String, AttributeValue>,
    attribute_order: Vec<String>,
}

struct ParsedAttributes {
    members: BTreeMap<String, AttributeValue>,
    order: Vec<String>,
}

struct ParsedAttributeEntry {
    key: String,
    value: AttributeValue,
}

struct AttributeMembersFrame {
    depth: usize,
    members: BTreeMap<String, AttributeValue>,
    order: Vec<String>,
    phase: AttributeMembersPhase,
}

impl AttributeMembersFrame {
    fn block(depth: usize) -> Self {
        Self::new(depth)
    }

    fn object() -> Self {
        Self::new(0)
    }

    fn new(depth: usize) -> Self {
        Self {
            depth,
            members: BTreeMap::new(),
            order: Vec::new(),
            phase: AttributeMembersPhase::Entry,
        }
    }

    fn step(
        mut self,
        parser: &mut Parser<'_>,
        product: Option<Product>,
        output: &mut Option<Product>,
    ) -> Step {
        match self.phase {
            AttributeMembersPhase::Entry => {
                if product.is_some() {
                    debug_assert!(false, "Sofia attribute members received an early product");
                    return Step::Unsupported;
                }
                parser.skip_newlines();
                if parser.check(TokenKind::RightBrace) {
                    parser.advance();
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
                    debug_assert!(false, "Sofia attribute members expected an entry product");
                    return Step::Unsupported;
                };
                if self.members.contains_key(&entry.key) {
                    return Step::Unsupported;
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
                        return Step::Unsupported;
                    }
                    parser.advance();
                    parser.skip_newlines();
                } else if parser.check(TokenKind::RightBrace) {
                    parser.advance();
                    return complete(
                        output,
                        Product::Attributes(ParsedAttributes {
                            members: self.members,
                            order: self.order,
                        }),
                    );
                } else if !saw_newline {
                    return Step::Unsupported;
                }

                self.phase = AttributeMembersPhase::Entry;
                Step::Continue(Frame::AttributeMembers(self))
            }
        }
    }
}

enum AttributeMembersPhase {
    Entry,
    Delimiter,
}

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
        parser: &mut Parser<'_>,
        product: Option<Product>,
        output: &mut Option<Product>,
    ) -> Step {
        match self.phase {
            AttributeEntryPhase::Key => {
                if product.is_some() {
                    debug_assert!(false, "Sofia attribute entry received an early product");
                    return Step::Unsupported;
                }
                let Some((key, _, start)) = parser.parse_key() else {
                    return Step::Unsupported;
                };
                if RESERVED_ATTRIBUTE_KEYS.contains(&key.as_str()) {
                    return Step::Unsupported;
                }
                parser.skip_newlines();
                let Some(structural_id) = parser.parse_optional_structural_identity() else {
                    return Step::Unsupported;
                };
                parser.skip_newlines();
                let head = AttributeEntryHead {
                    key,
                    start,
                    structural_id,
                    datatype: None,
                    nested_attrs: BTreeMap::new(),
                    nested_attr_order: Vec::new(),
                };
                if parser.check(TokenKind::At) {
                    let nested_depth = self.depth + 1;
                    if !parser.open_attribute_block(nested_depth) {
                        return Step::Unsupported;
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
                    debug_assert!(false, "Sofia attribute entry expected nested attributes");
                    return Step::Unsupported;
                };
                head.nested_attrs = attributes.members;
                head.nested_attr_order = attributes.order;
                parser.skip_newlines();
                if parser.check(TokenKind::At) {
                    return Step::Unsupported;
                }
                Self::push_datatype_or_value(parser, self.depth, head)
            }
            AttributeEntryPhase::Datatype(mut head) => {
                let Some(Product::Datatype(datatype)) = product else {
                    debug_assert!(false, "Sofia attribute entry expected a datatype");
                    return Step::Unsupported;
                };
                if validate_binding_node_datatype(&datatype, parser.previous().span).is_err() {
                    return Step::Unsupported;
                }
                head.datatype = Some(datatype);
                Self::push_value(parser, self.depth, head)
            }
            AttributeEntryPhase::Value(head) => {
                let Some(Product::Value(value)) = product else {
                    debug_assert!(false, "Sofia attribute entry expected a value");
                    return Step::Unsupported;
                };
                Self::finish(parser, head, Some(value), None, output)
            }
            AttributeEntryPhase::ObjectValue(head) => {
                let Some(Product::Attributes(object)) = product else {
                    debug_assert!(false, "Sofia attribute entry expected object members");
                    return Step::Unsupported;
                };
                Self::finish(parser, head, None, Some(object), output)
            }
        }
    }

    fn push_datatype_or_value(
        parser: &mut Parser<'_>,
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

    fn push_value(parser: &mut Parser<'_>, depth: usize, head: AttributeEntryHead) -> Step {
        parser.skip_newlines();
        if !parser.check(TokenKind::Equals) {
            return Step::Unsupported;
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
        parser: &Parser<'_>,
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
            start: head.start,
            end,
        });
        complete(
            output,
            Product::AttributeEntry(ParsedAttributeEntry {
                key: head.key,
                value: attribute,
            }),
        )
    }
}

enum AttributeEntryPhase {
    Key,
    NestedAttributes(AttributeEntryHead),
    Datatype(AttributeEntryHead),
    Value(AttributeEntryHead),
    ObjectValue(AttributeEntryHead),
}

struct AttributeEntryHead {
    key: String,
    start: crate::Position,
    structural_id: Option<String>,
    datatype: Option<String>,
    nested_attrs: BTreeMap<String, AttributeValue>,
    nested_attr_order: Vec<String>,
}

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
        parser: &mut Parser<'_>,
        product: Option<Product>,
        output: &mut Option<Product>,
    ) -> Step {
        match self.phase {
            DatatypePhase::Name => {
                if product.is_some() {
                    debug_assert!(false, "Sofia datatype frame received an early product");
                    return Step::Unsupported;
                }
                if !parser.count_datatype_component() || !is_bare_key_kind(parser.peek().kind) {
                    return Step::Unsupported;
                }
                self.start = parser.current;
                self.name = parser.advance().text.clone();
                parser.skip_newlines();

                if parser.check(TokenKind::LeftAngle) {
                    if self.generic_depth > parser.max_generic_depth || self.name == "radix" {
                        return Step::Unsupported;
                    }
                    parser.advance();
                    parser.skip_newlines();
                    self.phase = DatatypePhase::GenericArgument { count: 0 };
                } else {
                    self.phase = DatatypePhase::Suffix;
                }
                Step::Continue(Frame::Datatype(self))
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
                    if !parser.count_datatype_component() {
                        return Step::Unsupported;
                    }
                    parser.advance();
                    let count = count + 1;
                    if count > parser.max_generic_arguments {
                        return Step::Unsupported;
                    }
                    self.phase = DatatypePhase::GenericDelimiter { count };
                    Step::Continue(Frame::Datatype(self))
                }
                _ => Step::Unsupported,
            },
            DatatypePhase::GenericChild { count } => {
                let Some(Product::Datatype(_)) = product else {
                    debug_assert!(false, "Sofia datatype frame expected a datatype product");
                    return Step::Unsupported;
                };
                let count = count + 1;
                if count > parser.max_generic_arguments {
                    return Step::Unsupported;
                }
                self.phase = DatatypePhase::GenericDelimiter { count };
                Step::Continue(Frame::Datatype(self))
            }
            DatatypePhase::GenericDelimiter { count } => {
                if product.is_some() {
                    debug_assert!(false, "Sofia datatype delimiter received a product");
                    return Step::Unsupported;
                }
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
                    return Step::Unsupported;
                }
                Step::Continue(Frame::Datatype(self))
            }
            DatatypePhase::Suffix => {
                if product.is_some() {
                    debug_assert!(false, "Sofia datatype suffix received a product");
                    return Step::Unsupported;
                }
                if parser.check(TokenKind::LeftBracket) {
                    parser.advance();
                    parser.skip_newlines();
                    self.phase = DatatypePhase::ClarifierValue { count: 0 };
                } else {
                    self.phase = DatatypePhase::Finish;
                }
                Step::Continue(Frame::Datatype(self))
            }
            DatatypePhase::ClarifierValue { count } => {
                if product.is_some() {
                    debug_assert!(false, "Sofia clarifier frame received a product");
                    return Step::Unsupported;
                }
                parser.skip_newlines();
                match parser.peek().kind {
                    TokenKind::Number if is_valid_number_literal(&parser.peek().text) => {}
                    TokenKind::String => {}
                    _ => return Step::Unsupported,
                }
                if !parser.count_datatype_component() {
                    return Step::Unsupported;
                }
                parser.advance();
                let count = count + 1;
                if count > parser.max_clarifier_values {
                    return Step::Unsupported;
                }
                self.phase = DatatypePhase::ClarifierDelimiter { count };
                Step::Continue(Frame::Datatype(self))
            }
            DatatypePhase::ClarifierDelimiter { count } => {
                if product.is_some() {
                    debug_assert!(false, "Sofia clarifier delimiter received a product");
                    return Step::Unsupported;
                }
                parser.skip_newlines();
                if parser.check(TokenKind::RightBracket) {
                    parser.advance();
                    parser.skip_newlines();
                    if parser.check(TokenKind::LeftBracket) {
                        return Step::Unsupported;
                    }
                    self.phase = DatatypePhase::Finish;
                } else if parser.check(TokenKind::Comma) {
                    parser.advance();
                    self.phase = DatatypePhase::ClarifierValue { count };
                } else {
                    return Step::Unsupported;
                }
                Step::Continue(Frame::Datatype(self))
            }
            DatatypePhase::Finish => {
                if product.is_some() {
                    debug_assert!(false, "Sofia completed datatype received a product");
                    return Step::Unsupported;
                }
                let datatype = parser.normalized_datatype(self.start, parser.current);
                if validate_reserved_datatype_adornments(&datatype, parser.previous().span).is_err()
                {
                    return Step::Unsupported;
                }
                complete(output, Product::Datatype(datatype))
            }
        }
    }
}

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

struct NodeFrame {
    phase: NodePhase,
}

impl NodeFrame {
    fn new(start_index: usize) -> Self {
        Self {
            phase: NodePhase::Tag { start_index },
        }
    }

    fn step(
        self,
        parser: &mut Parser<'_>,
        product: Option<Product>,
        output: &mut Option<Product>,
    ) -> Step {
        match self.phase {
            NodePhase::Tag { start_index } => {
                if product.is_some() {
                    debug_assert!(false, "Sofia node frame received an early product");
                    return Step::Unsupported;
                }
                parser.skip_newlines();
                let head_start = parser.peek().span.start;
                let Some(tag) = parser.parse_node_tag() else {
                    return Step::Unsupported;
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
                let Some(structural_id) = parser.parse_optional_structural_identity() else {
                    return Step::Unsupported;
                };
                if structural_id.is_some() {
                    head.head_end = parser.previous().span.end;
                }
                head.structural_id = structural_id;
                parser.skip_newlines();
                if parser.check(TokenKind::At) {
                    if !parser.open_attribute_block(1) {
                        return Step::Unsupported;
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
                    debug_assert!(false, "Sofia node frame expected attributes");
                    return Step::Unsupported;
                };
                head.head_end = parser.previous().span.end;
                head.attribute_order = attributes.order;
                head.attributes.push(attributes.members);
                parser.skip_newlines();
                if parser.check(TokenKind::At) {
                    return Step::Unsupported;
                }
                Self::push_datatype_or_closure(parser, head)
            }
            NodePhase::Datatype(mut head) => {
                let Some(Product::Datatype(datatype)) = product else {
                    debug_assert!(false, "Sofia node frame expected a datatype");
                    return Step::Unsupported;
                };
                let base = datatype_base(&datatype);
                if (datatype.contains('<') && base != "node")
                    || !datatype_bracket_specs(&datatype).is_empty()
                {
                    return Step::Unsupported;
                }
                head.head_end = parser.previous_non_newline().span.end;
                head.datatype = Some(datatype);
                Step::Continue(Frame::Node(Self {
                    phase: NodePhase::Closure(head),
                }))
            }
            NodePhase::Closure(head) => {
                if product.is_some() {
                    debug_assert!(false, "Sofia node closure received a product");
                    return Step::Unsupported;
                }
                parser.skip_newlines();
                if parser.check(TokenKind::RightAngle) {
                    parser.advance();
                    return Self::finish(parser, head, Vec::new(), output);
                }
                if !parser.check(TokenKind::LeftParen) {
                    return Step::Unsupported;
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
                    debug_assert!(false, "Sofia node frame expected children");
                    return Step::Unsupported;
                };
                if !parser.check(TokenKind::RightParen) {
                    return Step::Unsupported;
                }
                parser.advance();
                parser.skip_newlines();
                if !parser.check(TokenKind::RightAngle) {
                    return Step::Unsupported;
                }
                parser.advance();
                Self::finish(parser, head, children, output)
            }
        }
    }

    fn push_datatype_or_closure(parser: &mut Parser<'_>, head: NodeHead) -> Step {
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
        parser: &mut Parser<'_>,
        head: NodeHead,
        children: Vec<Value>,
        output: &mut Option<Product>,
    ) -> Step {
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

enum NodePhase {
    Tag { start_index: usize },
    Attributes(NodeHead),
    Datatype(NodeHead),
    Closure(NodeHead),
    Children(NodeHead),
}

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
        parser: &mut Parser<'_>,
        product: Option<Product>,
        output: &mut Option<Product>,
    ) -> Step {
        match self.phase {
            NodeChildrenPhase::Child => {
                if product.is_some() {
                    debug_assert!(false, "Sofia node children received an early product");
                    return Step::Unsupported;
                }
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
                    debug_assert!(false, "Sofia node children expected a value");
                    return Step::Unsupported;
                };
                self.children.push(child);

                let mut saw_newline = false;
                while parser.check(TokenKind::Newline) {
                    saw_newline = true;
                    parser.advance();
                }
                if parser.check(TokenKind::Comma) {
                    if parser.has_separator_collision() {
                        return Step::Unsupported;
                    }
                    parser.advance();
                    parser.skip_newlines();
                } else if parser.check(TokenKind::RightParen) {
                    return complete(output, Product::Values(self.children));
                } else if !saw_newline {
                    return Step::Unsupported;
                }

                self.phase = NodeChildrenPhase::Child;
                Step::Continue(Frame::NodeChildren(self))
            }
        }
    }
}

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
        parser: &mut Parser<'_>,
        product: Option<Product>,
        output: &mut Option<Product>,
    ) -> Step {
        match self.phase {
            SequencePhase::Item => {
                if product.is_some() {
                    debug_assert!(false, "Sofia sequence frame received an early product");
                    return Step::Unsupported;
                }
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
                    debug_assert!(false, "Sofia sequence frame expected a value product");
                    return Step::Unsupported;
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
                                return Step::Unsupported;
                            }
                            parser.advance();
                            parser.skip_newlines();
                        } else if parser.check(TokenKind::RightBracket) {
                            return self.finish(parser, output);
                        } else if !saw_newline {
                            return Step::Unsupported;
                        }
                    }
                    ContainerKind::Tuple => {
                        if parser.check(TokenKind::Comma) {
                            parser.advance();
                            parser.skip_newlines();
                        } else if parser.check(TokenKind::RightParen) {
                            return self.finish(parser, output);
                        } else if parser.check(TokenKind::Newline) {
                            parser.skip_newlines();
                        } else {
                            return Step::Unsupported;
                        }
                    }
                }

                self.phase = SequencePhase::Item;
                Step::Continue(Frame::Sequence(self))
            }
        }
    }

    fn finish(self, parser: &mut Parser<'_>, output: &mut Option<Product>) -> Step {
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

enum SequencePhase {
    Item,
    Delimiter,
}

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
        parser: &mut Parser<'_>,
        product: Option<Product>,
        output: &mut Option<Product>,
    ) -> Step {
        match self.phase {
            ObjectPhase::Binding => {
                if product.is_some() {
                    debug_assert!(false, "Sofia object frame received an early product");
                    return Step::Unsupported;
                }
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
                    debug_assert!(false, "Sofia object frame expected a binding product");
                    return Step::Unsupported;
                };
                self.bindings.push(binding);

                let mut saw_newline = false;
                while parser.check(TokenKind::Newline) {
                    saw_newline = true;
                    parser.advance();
                }
                if parser.check(TokenKind::Comma) {
                    if parser.has_separator_collision() {
                        return Step::Unsupported;
                    }
                    parser.advance();
                    parser.skip_newlines();
                } else if parser.check(TokenKind::RightBrace) {
                    return self.finish(parser, output);
                } else if !saw_newline {
                    return Step::Unsupported;
                }

                self.phase = ObjectPhase::Binding;
                Step::Continue(Frame::Object(self))
            }
        }
    }

    fn finish(self, parser: &mut Parser<'_>, output: &mut Option<Product>) -> Step {
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

enum ObjectPhase {
    Binding,
    Delimiter,
}

#[cfg(test)]
mod tests {
    use crate::{LexerOptions, NullLiteralMode, ReferenceSegment, Value, tokenize};

    use super::{ParseOutcome, ParserLimits, parse_document};

    const TEST_LIMITS: ParserLimits = ParserLimits::new(256, 8, 8, 8, 32, 64);

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
    fn unsupported_grammar_is_reported_for_baseline_fallback() {
        assert!(matches!(
            parse(r#"aeon:mode = "strict""#),
            ParseOutcome::Unsupported
        ));
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
        assert!(matches!(
            parse_with_limits(
                "tree = <root(<leaf>)>",
                ParserLimits::new(1, 8, 8, 8, 32, 64)
            ),
            ParseOutcome::Unsupported
        ));
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
    fn duplicate_identity_restarts_through_the_baseline() {
        assert!(matches!(
            parse("first\\same\\ = 1\nsecond\\same\\ = 2"),
            ParseOutcome::Unsupported
        ));
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
        assert!(matches!(
            parse_with_limits(nested_head, ParserLimits::new(256, 1, 8, 8, 32, 64)),
            ParseOutcome::Unsupported
        ));

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
            ),
            (
                "value:outer<first, second> = 1",
                ParserLimits::new(256, 8, 8, 8, 1, 64),
            ),
            (
                "value:custom[\"first\", \"second\"] = 1",
                ParserLimits::new(256, 8, 1, 8, 32, 64),
            ),
            (
                "value:outer<first, second> = 1",
                ParserLimits::new(256, 8, 8, 8, 32, 2),
            ),
        ];
        for (source, limits) in limited {
            assert!(matches!(
                parse_with_limits(source, limits),
                ParseOutcome::Unsupported
            ));
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
        assert!(matches!(
            parse_with_limits("nested = [[1]]", ParserLimits::new(1, 8, 8, 8, 32, 64)),
            ParseOutcome::Unsupported
        ));
    }
}
