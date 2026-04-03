import { type Token, TokenType } from '@aeon/lexer';

/**
 * Sentinel thrown when the parser oracle runs out of tokens at a
 * decision point. This is NOT an error — it means we've reached the
 * cursor and can harvest the `expected` set.
 */
class EndOfInput {
    readonly expected: ReadonlySet<TokenType>;
    constructor(expected: ReadonlySet<TokenType>) {
        this.expected = expected;
    }
}

/**
 * All token types that represent scalar/literal values in AEON.
 */
const VALUE_STARTING_TYPES: readonly TokenType[] = [
    // Containers
    TokenType.LeftBrace,     // { object
    TokenType.LeftBracket,   // [ list
    TokenType.LeftParen,     // ( tuple
    TokenType.LeftAngle,     // < node

    // References
    TokenType.Tilde,         // ~ clone
    TokenType.TildeArrow,    // ~> pointer

    // Scalars
    TokenType.String,
    TokenType.Number,
    TokenType.True,
    TokenType.False,
    TokenType.Yes,
    TokenType.No,
    TokenType.On,
    TokenType.Off,
    TokenType.HexLiteral,
    TokenType.RadixLiteral,
    TokenType.EncodingLiteral,
    TokenType.SeparatorLiteral,
    TokenType.Date,
    TokenType.DateTime,
    TokenType.Time,
    TokenType.Identifier,    // Infinity, or future identifiers

    // Trimtick strings start with >
    TokenType.RightAngle,
];

/**
 * The ParserOracle predicts valid next token types by replaying a
 * simplified AEON grammar over a partial token stream.
 *
 * When the parser hits the end of the token stream at a point where
 * it would `check()` or `consume()`, it throws an `EndOfInput`
 * carrying the set of token types it was looking for.
 */
export class ParserOracle {
    private readonly tokens: readonly Token[];
    private current: number = 0;

    constructor(tokens: readonly Token[]) {
        this.tokens = tokens;
    }

    /**
     * Run the grammar over the token stream and return the set of
     * token types that could validly come next.
     */
    predict(): TokenType[] {
        this.current = 0;
        try {
            this.parseDocument();
            // Successfully parsed everything — at EOF, a new binding or
            // end-of-file is valid.
            return [TokenType.Identifier, TokenType.String, TokenType.EOF];
        } catch (e) {
            if (e instanceof EndOfInput) {
                return Array.from(e.expected);
            }
            // Grammar mismatch — input has a syntax error.
            // Return empty; callers should fall back to generic suggestions.
            return [];
        }
    }

    // ─── Token navigation ───────────────────────────────────

    private isAtEnd(): boolean {
        return this.current >= this.tokens.length;
    }

    private peek(): Token | undefined {
        return this.tokens[this.current];
    }

    /**
     * Check if the current token matches `type`.
     * If we're at EOF, record `type` as expected and return false.
     */
    private check(type: TokenType): boolean {
        if (this.isAtEnd()) return false;
        return this.peek()!.type === type;
    }

    /**
     * Check any of several types.
     */
    private checkAny(...types: TokenType[]): boolean {
        if (this.isAtEnd()) return false;
        return types.includes(this.peek()!.type);
    }

    private advance(): Token {
        const t = this.tokens[this.current]!;
        this.current++;
        return t;
    }

    /**
     * Consume a specific token type or signal EndOfInput.
     */
    private consume(type: TokenType): Token {
        if (this.isAtEnd()) {
            throw new EndOfInput(new Set([type]));
        }
        if (this.peek()!.type === type) return this.advance();
        throw new Error(`Expected ${type}, got ${this.peek()!.type}`);
    }

    /**
     * Consume one of several types or signal EndOfInput.
     */
    private consumeAny(...types: TokenType[]): Token {
        if (this.isAtEnd()) {
            throw new EndOfInput(new Set(types));
        }
        if (types.includes(this.peek()!.type)) return this.advance();
        throw new Error(`Expected one of ${types.join('|')}, got ${this.peek()!.type}`);
    }

    /**
     * If we're at EOF and need a decision, throw with the given
     * expected set.
     */
    private expectAtDecision(types: readonly TokenType[]): void {
        if (this.isAtEnd()) {
            throw new EndOfInput(new Set(types));
        }
    }

    // ─── Grammar rules ──────────────────────────────────────

    private parseDocument(): void {
        // Optional header
        if (this.isAtEnd()) {
            throw new EndOfInput(new Set([TokenType.Identifier, TokenType.String]));
        }
        if (this.isHeaderStart()) {
            this.parseHeader();
        }

        // Body bindings
        while (!this.isAtEnd()) {
            this.parseBinding();
            this.skipSeparator();
        }
    }

    private isHeaderStart(): boolean {
        if (this.isAtEnd()) return false;
        const t = this.peek()!;
        if (t.type !== TokenType.Identifier || t.value !== 'aeon') return false;
        if (this.current + 1 >= this.tokens.length) return false;
        return this.tokens[this.current + 1]!.type === TokenType.Colon;
    }

    private parseHeader(): void {
        while (this.isHeaderStart()) {
            this.consume(TokenType.Identifier); // aeon
            this.consume(TokenType.Colon);
            this.consume(TokenType.Identifier); // field
            this.consume(TokenType.Equals);
            this.parseValue();
            this.skipSeparator();
        }
    }

    private parseBinding(): void {
        this.expectAtDecision([TokenType.Identifier, TokenType.String]);

        // Key
        this.consumeAny(TokenType.Identifier, TokenType.String);

        // Optional attributes: @{...}
        while (this.check(TokenType.At)) {
            this.parseAttribute();
        }

        // Optional datatype: :type
        if (this.isAtEnd()) {
            // After key, could have : or = next
            throw new EndOfInput(new Set([TokenType.Colon, TokenType.Equals, TokenType.At]));
        }
        if (this.check(TokenType.Colon)) {
            this.advance();
            this.parseTypeAnnotation();
        }

        // Equals
        this.consume(TokenType.Equals);

        // Value
        this.parseValue();
    }

    private parseAttribute(): void {
        this.consume(TokenType.At);
        this.consume(TokenType.LeftBrace);

        while (!this.check(TokenType.RightBrace)) {
            this.expectAtDecision([TokenType.Identifier, TokenType.String, TokenType.RightBrace]);

            // attr key
            this.consumeAny(TokenType.Identifier, TokenType.String);

            // Optional nested attributes
            while (this.check(TokenType.At)) {
                this.parseAttribute();
            }

            // Optional datatype
            if (this.isAtEnd()) {
                throw new EndOfInput(new Set([TokenType.Colon, TokenType.Equals]));
            }
            if (this.check(TokenType.Colon)) {
                this.advance();
                this.parseTypeAnnotation();
            }

            this.consume(TokenType.Equals);
            this.parseValue();
            this.skipSeparatorUntil(TokenType.RightBrace);
        }
        this.consume(TokenType.RightBrace);
    }

    private parseTypeAnnotation(): void {
        this.consume(TokenType.Identifier); // type name

        // Optional generics <...>
        if (this.check(TokenType.LeftAngle)) {
            this.advance();
            this.consume(TokenType.Identifier); // first arg
            while (this.check(TokenType.Comma)) {
                this.advance();
                this.consume(TokenType.Identifier);
            }
            this.consume(TokenType.RightAngle);
        }

        // Optional bracket specifiers [...]
        while (this.check(TokenType.LeftBracket)) {
            this.advance();
            // Consume until ]
            while (!this.check(TokenType.RightBracket) && !this.isAtEnd()) {
                this.advance();
            }
            this.consume(TokenType.RightBracket);
        }
    }

    private parseValue(): void {
        this.expectAtDecision(VALUE_STARTING_TYPES);

        const token = this.peek()!;

        switch (token.type) {
            case TokenType.LeftBrace:
                this.parseObject();
                return;

            case TokenType.LeftBracket:
                this.parseList();
                return;

            case TokenType.LeftParen:
                this.parseTuple();
                return;

            case TokenType.LeftAngle:
                this.parseNode();
                return;

            case TokenType.Tilde:
                this.advance();
                this.parseReferencePath();
                return;

            case TokenType.TildeArrow:
                this.advance();
                this.parseReferencePath();
                return;

            case TokenType.RightAngle:
                // Trimtick string: >`...`
                this.parseTrimtick();
                return;

            default:
                // All other literals — just consume
                this.advance();
                return;
        }
    }

    private parseObject(): void {
        this.consume(TokenType.LeftBrace);
        while (!this.check(TokenType.RightBrace)) {
            this.expectAtDecision([TokenType.Identifier, TokenType.String, TokenType.RightBrace]);
            this.parseBinding();
            this.skipSeparatorUntil(TokenType.RightBrace);
        }
        this.consume(TokenType.RightBrace);
    }

    private parseList(): void {
        this.consume(TokenType.LeftBracket);
        while (!this.check(TokenType.RightBracket)) {
            this.expectAtDecision([...VALUE_STARTING_TYPES, TokenType.RightBracket]);
            this.parseValue();
            this.skipSeparatorUntil(TokenType.RightBracket);
        }
        this.consume(TokenType.RightBracket);
    }

    private parseTuple(): void {
        this.consume(TokenType.LeftParen);
        while (!this.check(TokenType.RightParen)) {
            this.expectAtDecision([...VALUE_STARTING_TYPES, TokenType.RightParen]);
            this.parseValue();
            this.skipSeparatorUntil(TokenType.RightParen);
        }
        this.consume(TokenType.RightParen);
    }

    private parseNode(): void {
        this.consume(TokenType.LeftAngle);
        // Tag
        this.consumeAny(TokenType.Identifier, TokenType.String);

        // Optional attributes / datatype
        while (this.check(TokenType.At)) {
            this.parseAttribute();
        }
        if (this.check(TokenType.Colon)) {
            this.advance();
            this.consume(TokenType.Identifier);
        }

        // Either > (empty) or ( children )>
        if (this.isAtEnd()) {
            throw new EndOfInput(new Set([TokenType.RightAngle, TokenType.LeftParen]));
        }
        if (this.check(TokenType.RightAngle)) {
            this.advance();
            return;
        }
        this.consume(TokenType.LeftParen);
        while (!this.check(TokenType.RightParen)) {
            this.expectAtDecision([...VALUE_STARTING_TYPES, TokenType.RightParen]);
            this.parseValue();
            this.skipSeparatorUntil(TokenType.RightParen);
        }
        this.consume(TokenType.RightParen);
        this.consume(TokenType.RightAngle);
    }

    private parseTrimtick(): void {
        // Consume 1–4 > characters
        while (this.check(TokenType.RightAngle)) {
            this.advance();
        }
        this.consume(TokenType.String);
    }

    private parseReferencePath(): void {
        // Optional $. prefix
        if (this.check(TokenType.Dollar)) {
            this.advance();
            if (this.check(TokenType.Dot)) this.advance();
        }
        // Initial segment
        this.consumeAny(TokenType.Identifier, TokenType.String, TokenType.LeftBracket);
        // Eat the bracket content if we consumed [
        if (this.tokens[this.current - 1]!.type === TokenType.LeftBracket) {
            this.consumeAny(TokenType.String, TokenType.Number);
            this.consume(TokenType.RightBracket);
        }

        // Continuation segments
        while (this.checkAny(TokenType.Dot, TokenType.LeftBracket, TokenType.At)) {
            if (this.check(TokenType.Dot)) {
                this.advance();
                this.consumeAny(TokenType.Identifier, TokenType.String);
            } else if (this.check(TokenType.At)) {
                this.advance();
                this.consumeAny(TokenType.Identifier, TokenType.String);
            } else {
                this.advance(); // [
                this.consumeAny(TokenType.String, TokenType.Number);
                this.consume(TokenType.RightBracket);
            }
        }
    }

    // ─── Separator handling ─────────────────────────────────

    private skipSeparator(): void {
        if (this.check(TokenType.Comma)) this.advance();
    }

    private skipSeparatorUntil(closeType: TokenType): void {
        if (this.check(closeType)) return;
        if (this.check(TokenType.Comma)) this.advance();
    }
}
