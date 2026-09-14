use std::collections::BTreeMap;

use crate::{Binding, Span, Token, TokenKind, Value};

use super::{
    ParserLimits, classify_temporal_literal, decode_quoted_token, invalid_temporal_literal,
    is_bare_key_kind, is_valid_number_literal,
};

pub(super) enum ParseOutcome {
    Parsed(Vec<Binding>),
    Unsupported,
}

pub(super) fn parse_document(tokens: &[Token], _limits: ParserLimits) -> ParseOutcome {
    Parser::new(tokens).run()
}

struct Parser<'a> {
    tokens: &'a [Token],
    current: usize,
}

impl<'a> Parser<'a> {
    fn new(tokens: &'a [Token]) -> Self {
        debug_assert_eq!(tokens.last().map(|token| token.kind), Some(TokenKind::Eof));
        Self { tokens, current: 0 }
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
                        Some(Product::Document(bindings)) => ParseOutcome::Parsed(bindings),
                        Some(Product::Binding(_) | Product::Value(_)) | None => {
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
    Document(DocumentFrame),
    Binding(BindingFrame),
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
            Self::Document(frame) => frame.step(parser, product, output),
            Self::Binding(frame) => frame.step(parser, product, output),
            Self::Value => {
                if product.is_some() {
                    debug_assert!(false, "Sofia value frame received a product");
                    return Step::Unsupported;
                }
                parser.parse_scalar().map_or(Step::Unsupported, |value| {
                    complete(output, Product::Value(value))
                })
            }
        }
    }
}

enum Product {
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
                let token = parser.peek();
                if !is_bare_key_kind(token.kind) || token.text == "aeon" {
                    return Step::Unsupported;
                }
                let start = token.span.start;
                let key = parser.advance().text.clone();
                parser.skip_newlines();
                if !parser.check(TokenKind::Equals) {
                    return Step::Unsupported;
                }
                parser.advance();
                parser.skip_newlines();

                Step::Push {
                    parent: Frame::Binding(Self {
                        phase: BindingPhase::Value { start, key },
                    }),
                    child: Frame::Value,
                }
            }
            BindingPhase::Value { start, key } => {
                let Some(Product::Value(value)) = product else {
                    debug_assert!(false, "Sofia binding frame expected a value product");
                    return Step::Unsupported;
                };
                let end = parser.previous().span.end;
                complete(
                    output,
                    Product::Binding(Binding {
                        key,
                        is_header: false,
                        structural_id: None,
                        datatype: None,
                        attributes: BTreeMap::new(),
                        attribute_order: Vec::new(),
                        value,
                        span: Span { start, end },
                    }),
                )
            }
        }
    }
}

enum BindingPhase {
    Key,
    Value { start: crate::Position, key: String },
}

#[cfg(test)]
mod tests {
    use crate::{LexerOptions, Value, tokenize};

    use super::{ParseOutcome, ParserLimits, parse_document};

    const TEST_LIMITS: ParserLimits = ParserLimits::new(256, 8, 8, 8, 32, 64);

    fn parse(input: &str) -> ParseOutcome {
        let lexed = tokenize(
            input,
            LexerOptions {
                include_newlines: true,
                ..LexerOptions::default()
            },
        );
        assert!(lexed.errors.is_empty());
        parse_document(&lexed.tokens, TEST_LIMITS)
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
        assert!(matches!(parse("items = [1, 2]"), ParseOutcome::Unsupported));
    }
}
