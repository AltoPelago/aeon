use std::collections::{BTreeMap, HashSet};

use crate::{Binding, Span, Token, TokenKind, Value};

use super::{
    ParserLimits, classify_temporal_literal, decode_quoted_token, invalid_temporal_literal,
    is_bare_key_kind, is_valid_number_literal, validate_binding_node_datatype,
    validate_reserved_datatype_adornments,
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
                        Some(Product::Binding(_) | Product::Datatype(_) | Product::Value(_))
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
            _ => None,
        }
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

    fn parse_optional_structural_identity(&mut self) -> Option<Option<String>> {
        if !self.check(TokenKind::StructuralIdentity) {
            return Some(None);
        }
        let identity = self.advance().text.clone();
        self.structural_identities
            .insert(identity.clone())
            .then_some(Some(identity))
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

    fn peek(&self) -> &'a Token {
        &self.tokens[self.current]
    }
}

enum Frame {
    AnonymousValue(AnonymousValueFrame),
    Datatype(DatatypeFrame),
    Document(DocumentFrame),
    Binding(BindingFrame),
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
            Self::AnonymousValue(frame) => frame.step(parser, product, output),
            Self::Datatype(frame) => frame.step(parser, product, output),
            Self::Document(frame) => frame.step(parser, product, output),
            Self::Binding(frame) => frame.step(parser, product, output),
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
    Datatype(String),
    Document(Vec<Binding>),
    Binding(Binding),
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
                if parser.check(TokenKind::At) {
                    return Step::Unsupported;
                }
                let head = BindingHead {
                    start,
                    key,
                    is_header,
                    structural_id,
                    datatype: None,
                };
                if parser.check(TokenKind::Colon) {
                    parser.advance();
                    parser.skip_newlines();
                    parser.begin_datatype();
                    return Step::Push {
                        parent: Frame::Binding(Self {
                            phase: BindingPhase::Datatype(head),
                        }),
                        child: Frame::Datatype(DatatypeFrame::new(0)),
                    };
                }
                Self::push_value(parser, head)
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
                        attributes: BTreeMap::new(),
                        attribute_order: Vec::new(),
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
    Datatype(BindingHead),
    Value(BindingHead),
}

struct BindingHead {
    start: crate::Position,
    key: String,
    is_header: bool,
    structural_id: Option<String>,
    datatype: Option<String>,
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
                if parser.check(TokenKind::At) {
                    return Step::Unsupported;
                }
                let head = AnonymousHead {
                    structural_id,
                    datatype: None,
                };
                if parser.check(TokenKind::Colon) {
                    parser.advance();
                    parser.skip_newlines();
                    parser.begin_datatype();
                    return Step::Push {
                        parent: Frame::AnonymousValue(Self {
                            phase: AnonymousValuePhase::Datatype(head),
                        }),
                        child: Frame::Datatype(DatatypeFrame::new(0)),
                    };
                }
                Self::push_value(parser, head)
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
                        attributes: BTreeMap::new(),
                        attribute_order: Vec::new(),
                        value: Box::new(value),
                    }),
                )
            }
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
    Datatype(AnonymousHead),
    Value(AnonymousHead),
}

struct AnonymousHead {
    structural_id: Option<String>,
    datatype: Option<String>,
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
    use crate::{LexerOptions, Value, tokenize};

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
            parse("typed@{source = \"test\"}:list<string> = [1, 2]"),
            ParseOutcome::Unsupported
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
