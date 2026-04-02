import {
    type CommentMetadata,
    type CommentForm,
    type ReservedCommentSubtype,
    type Token,
    type Position,
    TokenType,
    createPosition,
    createSpan,
    createToken,
} from './tokens.js';
import {
    LexerError,
    UnexpectedCharacterError,
    UnterminatedStringError,
    InvalidEscapeSequenceError,
    InvalidNumberError,
    InvalidTimeError,
    InvalidDateError,
    InvalidDateTimeError,
    UnterminatedBlockCommentError,
} from './errors.js';

/**
 * Lexer options
 */
export interface LexerOptions {
    /** Include comment tokens in output (default: false) */
    readonly includeComments?: boolean;
    /** Include newline tokens in output (default: false) */
    readonly includeNewlines?: boolean;
}

/**
 * Result of lexing
 */
export interface LexResult {
    readonly tokens: readonly Token[];
    readonly errors: readonly LexerError[];
}

/**
 * Keywords mapping
 */
const KEYWORDS: ReadonlyMap<string, TokenType> = new Map([
    ['true', TokenType.True],
    ['false', TokenType.False],
    ['yes', TokenType.Yes],
    ['no', TokenType.No],
    ['on', TokenType.On],
    ['off', TokenType.Off],
]);

/**
 * Check if character is a letter
 */
function isLetter(c: string): boolean {
    return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
}

/**
 * Check if character is a digit
 */
function isDigit(c: string): boolean {
    return c >= '0' && c <= '9';
}

/**
 * Check if character is a hex digit
 */
function isHexDigit(c: string): boolean {
    return isDigit(c) || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
}

/**
 * Check if character is alphanumeric or underscore
 */
function isAlphanumeric(c: string): boolean {
    return isLetter(c) || isDigit(c) || c === '_';
}

function isEncodingChar(c: string): boolean {
    return isLetter(c)
        || isDigit(c)
        || c === '+'
        || c === '/'
        || c === '='
        || c === '-'
        || c === '_'
        || c === '.';
}

function isEncodingStartChar(c: string): boolean {
    return c !== '=' && isEncodingChar(c);
}

function isRadixChar(c: string): boolean {
    return isLetter(c)
        || isDigit(c)
        || c === '+'
        || c === '-'
        || c === '.'
        || c === '_'
        || c === '&'
        || c === '!';
}

function isRadixStartChar(c: string): boolean {
    return c === '+' || c === '-' || isLetter(c) || isDigit(c) || c === '&' || c === '!';
}

function isPrintableAscii(c: string): boolean {
    const code = c.charCodeAt(0);
    return code >= 0x21 && code <= 0x7e;
}

function isSlashChannelMarker(c: string): boolean {
    return c === '#' || c === '@' || c === '?' || c === '{' || c === '[' || c === '(';
}

function slashChannelClosingMarker(openMarker: string): string {
    if (openMarker === '{') return '}';
    if (openMarker === '[') return ']';
    if (openMarker === '(') return ')';
    return openMarker;
}

function isSeparatorBoundary(c: string): boolean {
    return c === '\n' || c === ',' || c === ']' || c === ')' || c === '}';
}

function isHorizontalWhitespace(c: string): boolean {
    return c === ' ' || c === '\t';
}


/**
 * AEON Lexer
 * 
 * Hand-written lexer for AEON documents. Produces a stream of tokens
 * with accurate span information for error reporting.
 */
export class Lexer {
    private readonly input: string;
    private readonly options: LexerOptions;
    private offset: number = 0;
    private line: number = 1;
    private column: number = 1;
    private sawLeadingShebang: boolean = false;
    private readonly tokens: Token[] = [];
    private readonly errors: LexerError[] = [];

    constructor(input: string, options: LexerOptions = {}) {
        this.input = input;
        this.options = options;
    }

    /**
     * Tokenize the input
     */
    tokenize(): LexResult {
        while (!this.isAtEnd()) {
            this.scanToken();
        }

        // Add EOF token
        const pos = this.currentPosition();
        this.tokens.push(createToken(
            TokenType.EOF,
            '',
            createSpan(pos, pos)
        ));

        return {
            tokens: this.tokens,
            errors: this.errors,
        };
    }

    private isAtEnd(): boolean {
        return this.offset >= this.input.length;
    }

    private currentPosition(): Position {
        return createPosition(this.line, this.column, this.offset);
    }

    private peek(): string {
        if (this.isAtEnd()) return '\0';
        return this.input[this.offset]!;
    }

    private peekNext(): string {
        if (this.offset + 1 >= this.input.length) return '\0';
        return this.input[this.offset + 1]!;
    }

    private peekN(distance: number): string {
        const index = this.offset + distance - 1;
        if (index >= this.input.length) return '\0';
        return this.input[index]!;
    }

    private advance(): string {
        const c = this.input[this.offset]!;
        this.offset++;
        if (c === '\n') {
            this.line++;
            this.column = 1;
        } else {
            this.column++;
        }
        return c;
    }

    private match(expected: string): boolean {
        if (this.isAtEnd()) return false;
        if (this.input[this.offset] !== expected) return false;
        this.advance();
        return true;
    }

    private addToken(type: TokenType, value: string, start: Position): void {
        const end = this.currentPosition();
        this.tokens.push(createToken(type, value, createSpan(start, end)));
    }

    private scanToken(): void {
        const start = this.currentPosition();
        const c = this.advance();

        switch (c) {
            // Single character tokens
            case '{': this.addToken(TokenType.LeftBrace, c, start); break;
            case '}': this.addToken(TokenType.RightBrace, c, start); break;
            case '[': this.addToken(TokenType.LeftBracket, c, start); break;
            case ']': this.addToken(TokenType.RightBracket, c, start); break;
            case '(': this.addToken(TokenType.LeftParen, c, start); break;
            case ')': this.addToken(TokenType.RightParen, c, start); break;
            case '<': this.addToken(TokenType.LeftAngle, c, start); break;
            case '>': this.addToken(TokenType.RightAngle, c, start); break;
            case '=': this.addToken(TokenType.Equals, c, start); break;
            case ':': this.addToken(TokenType.Colon, c, start); break;
            case ',': this.addToken(TokenType.Comma, c, start); break;
            case '.':
                if (isDigit(this.peek())) {
                    this.scanNumber(c, start);
                } else {
                    this.addToken(TokenType.Dot, c, start);
                }
                break;
            case '@': this.addToken(TokenType.At, c, start); break;
            case '&': this.addToken(TokenType.Ampersand, c, start); break;
            case ';': this.addToken(TokenType.Semicolon, c, start); break;

            // Tilde (may be ~ or ~>)
            case '~':
                if (this.match('>')) {
                    this.addToken(TokenType.TildeArrow, '~>', start);
                } else {
                    this.addToken(TokenType.Tilde, '~', start);
                }
                break;

            // Separator literal (^content)
            case '^':
                this.scanSeparatorLiteral(start);
                break;

            // Hex literal (#FF00AA)
            case '#':
                if (this.isLeadingShebangStart(start) && this.peek() === '!') {
                    this.scanShebangComment(start);
                    break;
                }
                if (isHexDigit(this.peek())) {
                    this.scanHexLiteral(start);
                } else {
                    this.addToken(TokenType.Hash, c, start);
                }
                break;

            // Encoding literal ($Base64...)
            case '$':
                if (this.peek() === '.') {
                    this.addToken(TokenType.Dollar, c, start);
                } else if (isEncodingStartChar(this.peek())) {
                    this.scanEncodingLiteral(start);
                } else {
                    this.addToken(TokenType.Dollar, c, start);
                }
                break;

            // Radix literal (%1011)
            case '%':
                if (isRadixStartChar(this.peek())) {
                    this.scanRadixLiteral(start);
                } else {
                    this.addToken(TokenType.Percent, c, start);
                }
                break;

            // Comment or division
            case '/':
                if (this.match('/')) {
                    this.scanLineComment(start);
                } else if (this.match('*')) {
                    this.scanBlockComment(start);
                } else if (isSlashChannelMarker(this.peek())) {
                    this.scanSlashChannelBlockComment(start);
                } else {
                    this.addToken(TokenType.Symbol, c, start);
                }
                break;

            // String literals
            case '"':
            case "'":
            case '`':
                this.scanString(c, start);
                break;

            // Newline
            case '\n':
                if (this.options.includeNewlines) {
                    this.addToken(TokenType.Newline, '\n', start);
                }
                break;

            // Whitespace
            case ' ':
            case '\t':
            case '\r':
                // Skip whitespace
                break;

            // Numbers (including negative)
            case '-':
            case '+':
                if (isDigit(this.peek())) {
                    this.scanNumber(c, start);
                } else if (this.peek() === '.' && isDigit(this.peekN(2))) {
                    this.advance(); // consume .
                    this.scanNumber(`${c}.`, start);
                } else {
                    this.addToken(TokenType.Symbol, c, start);
                }
                break;

            default:
                if (isDigit(c)) {
                    this.scanNumber(c, start);
                } else if (isLetter(c)) {
                    this.scanIdentifierOrKeyword(c, start);
                } else if (isPrintableAscii(c)) {
                    this.addToken(TokenType.Symbol, c, start);
                } else {
                    this.errors.push(new UnexpectedCharacterError(c, createSpan(start, this.currentPosition())));
                }
                break;
        }
    }

    private scanString(delimiter: string, start: Position): void {
        const isMultiline = delimiter === '`';
        let value = '';

        while (!this.isAtEnd()) {
            const c = this.peek();

            if (c === delimiter) {
                this.advance();
                const end = this.currentPosition();
                this.tokens.push({
                    type: TokenType.String,
                    value,
                    span: createSpan(start, end),
                    quote: delimiter as '"' | "'" | '`',
                });
                return;
            }

            if (c === '\n' && !isMultiline) {
                this.errors.push(new UnterminatedStringError(delimiter, createSpan(start, this.currentPosition())));
                return;
            }

            if (c === '\\') {
                this.advance();
                const escaped = this.scanEscapeSequence(start);
                if (escaped !== null) {
                    value += escaped;
                }
            } else {
                value += this.advance();
            }
        }

        this.errors.push(new UnterminatedStringError(delimiter, createSpan(start, this.currentPosition())));
    }

    private scanEscapeSequence(_stringStart: Position): string | null {
        if (this.isAtEnd()) {
            return null;
        }

        const escapeStart = this.currentPosition();
        const c = this.advance();

        switch (c) {
            case '"': return '"';
            case "'": return "'";
            case '`': return '`';
            case '\\': return '\\';
            case 'n': return '\n';
            case 'r': return '\r';
            case 't': return '\t';
            case 'b': return '\b';
            case 'f': return '\f';
            case 'u':
                return this.scanUnicodeEscape(escapeStart);
            default:
                this.errors.push(new InvalidEscapeSequenceError(
                    `\\${c}`,
                    createSpan(escapeStart, this.currentPosition())
                ));
                return c;
        }
    }

    private scanUnicodeEscape(start: Position): string | null {
        // Check for \u{XXXXX} (1-6 hex digits)
        if (this.peek() === '{') {
            this.advance();
            let hex = '';
            while (!this.isAtEnd() && this.peek() !== '}') {
                if (isHexDigit(this.peek())) {
                    hex += this.advance();
                } else {
                    this.errors.push(new InvalidEscapeSequenceError(
                        `\\u{${hex}${this.peek()}`,
                        createSpan(start, this.currentPosition())
                    ));
                    return null;
                }
            }
            if (this.isAtEnd() || this.peek() !== '}') {
                this.errors.push(new InvalidEscapeSequenceError(
                    `\\u{${hex}`,
                    createSpan(start, this.currentPosition())
                ));
                return null;
            }
            this.advance(); // consume }

            if (hex.length < 1 || hex.length > 6) {
                this.errors.push(new InvalidEscapeSequenceError(
                    `\\u{${hex}}`,
                    createSpan(start, this.currentPosition())
                ));
                return null;
            }

            const codePoint = parseInt(hex, 16);
            if (codePoint > 0x10FFFF) {
                this.errors.push(new InvalidEscapeSequenceError(
                    `\\u{${hex}}`,
                    createSpan(start, this.currentPosition())
                ));
                return null;
            }
            return String.fromCodePoint(codePoint);
        }

        // Standard \uXXXX (4 hex digits)
        let hex = '';
        for (let i = 0; i < 4; i++) {
            if (this.isAtEnd() || !isHexDigit(this.peek())) {
                this.errors.push(new InvalidEscapeSequenceError(
                    `\\u${hex}`,
                    createSpan(start, this.currentPosition())
                ));
                return null;
            }
            hex += this.advance();
        }
        return String.fromCharCode(parseInt(hex, 16));
    }

    private scanNumber(first: string, start: Position): void {
        let value = first;
        let hasError = false;
        const startsWithLeadingDot = value === '.' || value === '-.' || value === '+.';

        // Helper to scan digits with underscores (only between digits)
        // Returns false if underscore rules are violated
        const scanDigitsWithUnderscores = (allowUnderscores: boolean): boolean => {
            let lastWasUnderscore = false;
            let scannedAny = false;
            while (isDigit(this.peek()) || this.peek() === '_') {
                if (this.peek() === '_') {
                    if (!allowUnderscores) {
                        value += this.advance();
                        hasError = true;
                        continue;
                    }
                    // Check: must have a digit before (either in value or just scanned)
                    const lastChar = value[value.length - 1];
                    if (lastWasUnderscore || (lastChar !== undefined && !isDigit(lastChar))) {
                        // Consecutive underscores or underscore not after digit
                        value += this.advance(); // consume the bad underscore
                        hasError = true;
                        continue;
                    }
                    lastWasUnderscore = true;
                } else {
                    lastWasUnderscore = false;
                }
                value += this.advance();
                scannedAny = true;
            }
            // Cannot end with underscore
            if (lastWasUnderscore) {
                hasError = true;
            }
            return scannedAny || !lastWasUnderscore;
        };

        // Integer part
        scanDigitsWithUnderscores(true);

        // Check for time literal (HH:MM:SS with optional fractional seconds / zone)
        if (!hasError && !startsWithLeadingDot && first !== '+' && first !== '-' && this.peek() === ':' && value.length === 2 && !value.includes('_')) {
            this.scanTime(value, start);
            return;
        }

        // Check for date literal (YYYY-MM-DD)
        if (!hasError && !startsWithLeadingDot && this.peek() === '-' && value.length === 4 && !value.includes('_')) {
            this.scanDateOrDateTime(value, start);
            return;
        }

        // Fractional part - check for . followed by _ (invalid: 1._2)
        // or . followed by digit (valid: 1.2)
        if (!startsWithLeadingDot && this.peek() === '.') {
            const nextChar = this.peekNext();
            if (nextChar === '_') {
                // Invalid: 1._2
                value += this.advance(); // consume .
                value += this.advance(); // consume _
                hasError = true;
                // Continue scanning to consume the rest
                scanDigitsWithUnderscores(true);
            } else if (isDigit(nextChar)) {
                value += this.advance(); // consume .
                scanDigitsWithUnderscores(true);
            }
            // else: standalone . is not part of the number (e.g., 1.foo)
        }

        // Exponent
        if (this.peek() === 'e' || this.peek() === 'E') {
            value += this.advance();
            if (this.peek() === '+' || this.peek() === '-') {
                value += this.advance();
            }
            // After 'e', 'e+', or 'e-', next char must be digit, not underscore.
            // Once the exponent starts, underscores are allowed between digits.
            if (this.peek() === '_') {
                value += this.advance(); // consume the bad underscore
                hasError = true;
                // Continue scanning to consume the rest
                scanDigitsWithUnderscores(true);
            } else if (isDigit(this.peek())) {
                scanDigitsWithUnderscores(true);
            } else {
                // No digits after exponent - invalid
                hasError = true;
            }
        }

        if (hasError) {
            this.errors.push(new InvalidNumberError(value, createSpan(start, this.currentPosition())));
            return;
        }

        if (startsWithLeadingDot && !/\.\d/.test(value)) {
            this.errors.push(new InvalidNumberError(value, createSpan(start, this.currentPosition())));
            return;
        }

        // Validate: no leading zeros (except 0 itself or 0.xxx)
        const normalized = value.replace(/_/g, '');
        const normalizedBody = normalized[0] === '+' || normalized[0] === '-'
            ? normalized.slice(1)
            : normalized;
        if (normalizedBody.length > 1 && normalizedBody[0] === '0' && normalizedBody[1] !== '.') {
            this.errors.push(new InvalidNumberError(value, createSpan(start, this.currentPosition())));
            return;
        }

        this.addToken(TokenType.Number, value, start);
    }

    private scanTime(hours: string, start: Position): void {
        let value = hours;

        while (isDigit(this.peek()) || this.peek() === ':' || this.peek() === '.') {
            value += this.advance();
        }

        if (this.peek() === 'Z') {
            value += this.advance();
        } else if (this.peek() === '+' || this.peek() === '-') {
            value += this.advance();
            while (isDigit(this.peek()) || this.peek() === ':') {
                value += this.advance();
            }
        }

        if (isValidTimeLiteral(value)) {
            this.addToken(TokenType.Time, value, start);
            return;
        }
        this.errors.push(new InvalidTimeError(value, createSpan(start, this.currentPosition())));
    }

    private scanDateOrDateTime(year: string, start: Position): void {
        let value = year;

        // Consume -MM-DD
        value += this.advance(); // -
        for (let i = 0; i < 2 && isDigit(this.peek()); i++) {
            value += this.advance();
        }
        if (this.peek() === '-') {
            value += this.advance();
            for (let i = 0; i < 2 && isDigit(this.peek()); i++) {
                value += this.advance();
            }
        }

        // Check for T (datetime)
        if (this.peek() === 'T') {
            value += this.advance();
            // Time part
            while (isDigit(this.peek()) || this.peek() === ':' || this.peek() === '.') {
                value += this.advance();
            }
            // Timezone
            if (this.peek() === 'Z') {
                value += this.advance();
            } else if (this.peek() === '+' || this.peek() === '-') {
                value += this.advance();
                while (isDigit(this.peek()) || this.peek() === ':') {
                    value += this.advance();
                }
            }
            // ZRUT zone (& followed by zone id)
            if (this.peek() === '&') {
                value += this.advance();
                let zone = '';
                while (isAlphanumeric(this.peek()) || this.peek() === '/' || this.peek() === '_') {
                    const ch = this.advance();
                    value += ch;
                    zone += ch;
                }
                if (!isValidZrutZone(zone)) {
                    this.errors.push(new InvalidDateTimeError(value, createSpan(start, this.currentPosition())));
                    return;
                }
            }
            if (isValidDateTimeLiteral(value)) {
                this.addToken(TokenType.DateTime, value, start);
            } else {
                this.errors.push(new InvalidDateTimeError(value, createSpan(start, this.currentPosition())));
            }
        } else {
            if (isValidDateLiteral(value)) {
                this.addToken(TokenType.Date, value, start);
            } else {
                this.errors.push(new InvalidDateError(value, createSpan(start, this.currentPosition())));
            }
        }
    }

    private scanHexLiteral(start: Position): void {
        let value = '#';

        while (isHexDigit(this.peek()) || this.peek() === '_') {
            value += this.advance();
        }

        if (value.length === 1) {
            this.errors.push(new UnexpectedCharacterError('#', createSpan(start, this.currentPosition())));
            return;
        }

        if (value.endsWith('_')) {
            this.errors.push(new InvalidNumberError(value, createSpan(start, this.currentPosition())));
            return;
        }

        this.addToken(TokenType.HexLiteral, value, start);
    }

    private scanRadixLiteral(start: Position): void {
        let value = '%';

        while (isRadixChar(this.peek())) {
            value += this.advance();
        }

        if (value.length === 1) {
            this.errors.push(new UnexpectedCharacterError('%', createSpan(start, this.currentPosition())));
            return;
        }

        if (!isValidRadixPayload(value.slice(1))) {
            this.errors.push(new InvalidNumberError(value, createSpan(start, this.currentPosition())));
            return;
        }

        this.addToken(TokenType.RadixLiteral, value, start);
    }

    private scanEncodingLiteral(start: Position): void {
        let value = '$';

        // Keep root-qualified paths (`$.a`) lexically distinct from encoding literals.
        if (!isEncodingStartChar(this.peek())) {
            this.addToken(TokenType.Dollar, value, start);
            return;
        }

        while (!this.isAtEnd()) {
            const c = this.peek();
            if (isEncodingChar(c)) {
                value += this.advance();
            } else {
                break;
            }
        }

        if (value.length === 1) {
            this.errors.push(new UnexpectedCharacterError('$', createSpan(start, this.currentPosition())));
            return;
        }

        if (!isValidEncodingPayload(value.slice(1))) {
            this.errors.push(new InvalidNumberError(value, createSpan(start, this.currentPosition())));
            return;
        }

        this.addToken(TokenType.EncodingLiteral, value, start);
    }

    private scanSeparatorLiteral(start: Position): void {
        let value = '^';
        let inQuote: string | null = null; // Track which quote character we're inside

        // Raw separator payload terminates on grammar boundaries outside quotes.
        while (!this.isAtEnd()) {
            const c = this.peek();
            const next = this.peekNext();

            // Check for terminators only when not inside quotes.
            if (inQuote === null && isSeparatorBoundary(c)) {
                break;
            }

            // Unescaped spaces inside raw payload are only allowed as trailing padding
            // immediately before the next grammar boundary. Interior spaces must be escaped.
            if (inQuote === null && isHorizontalWhitespace(c) && !this.onlyWhitespaceUntilSeparatorBoundary()) {
                break;
            }

            // Handle the small set of raw separator escapes we still allow.
            if (inQuote === null && c === '\\' && (next === '\\' || next === ',' || next === ' ')) {
                value += this.advance(); // consume backslash
                value += this.advance(); // consume escaped character
                continue;
            }

            // Handle quote state transitions.
            if (c === '"' || c === "'") {
                if (inQuote === null) {
                    // Entering a quoted section.
                    inQuote = c;
                } else if (inQuote === c) {
                    // Exiting the quoted section.
                    inQuote = null;
                }
                // If inQuote is a different character, we're still inside the other quote type.
            }

            // Handle escape sequences inside quotes.
            if (inQuote !== null && c === '\\') {
                value += this.advance(); // consume backslash
                if (!this.isAtEnd()) {
                    value += this.advance(); // consume escaped character
                }
                continue;
            }

            value += this.advance();
        }

        if (value === '^') {
            this.addToken(TokenType.Caret, value, start);
            return;
        }

        if (!isValidSeparatorPayload(value.slice(1))) {
            this.errors.push(new InvalidNumberError(value, createSpan(start, this.currentPosition())));
            return;
        }

        this.addToken(TokenType.SeparatorLiteral, value, start);
    }

    private onlyWhitespaceUntilSeparatorBoundary(): boolean {
        let index = this.offset;
        while (index < this.input.length) {
            const c = this.input[index]!;
            if (isHorizontalWhitespace(c)) {
                index += 1;
                continue;
            }
            return isSeparatorBoundary(c);
        }
        return true;
    }

    private scanIdentifierOrKeyword(first: string, start: Position): void {
        let value = first;

        while (isAlphanumeric(this.peek())) {
            value += this.advance();
        }

        const keywordType = KEYWORDS.get(value);
        if (keywordType !== undefined) {
            this.addToken(keywordType, value, start);
        } else {
            this.addToken(TokenType.Identifier, value, start);
        }
    }

    private scanLineComment(start: Position): void {
        let value = '//';

        while (!this.isAtEnd() && this.peek() !== '\n') {
            value += this.advance();
        }

        if (this.options.includeComments) {
            this.addCommentToken(TokenType.LineComment, value, start, this.classifyLineComment(value, start));
        }
    }

    private scanShebangComment(start: Position): void {
        let value = '#';
        value += this.advance(); // !

        while (!this.isAtEnd() && this.peek() !== '\n') {
            value += this.advance();
        }

        this.sawLeadingShebang = true;
        if (this.options.includeComments) {
            this.addCommentToken(TokenType.LineComment, value, start, { channel: 'plain', form: 'line' });
        }
    }

    private scanBlockComment(start: Position): void {
        let value = '/*';

        while (!this.isAtEnd()) {
            if (this.peek() === '*' && this.peekNext() === '/') {
                value += this.advance(); // *
                value += this.advance(); // /
                if (this.options.includeComments) {
                    this.addCommentToken(TokenType.BlockComment, value, start, classifyComment(value, 'block'));
                }
                return;
            }
            value += this.advance();
        }

        // Unterminated block comment - emit error with span from start to EOF
        this.errors.push(new UnterminatedBlockCommentError(createSpan(start, this.currentPosition())));
        if (this.options.includeComments) {
            this.addCommentToken(TokenType.BlockComment, value, start, classifyComment(value, 'block'));
        }
    }

    private scanSlashChannelBlockComment(start: Position): void {
        const marker = this.advance();
        const closingMarker = slashChannelClosingMarker(marker);
        let value = `/${marker}`;

        while (!this.isAtEnd()) {
            if (this.peek() === closingMarker && this.peekNext() === '/') {
                value += this.advance(); // closing marker
                value += this.advance(); // /
                if (this.options.includeComments) {
                    this.addCommentToken(TokenType.BlockComment, value, start, classifyComment(value, 'block'));
                }
                return;
            }
            value += this.advance();
        }

        this.errors.push(new UnterminatedBlockCommentError(createSpan(start, this.currentPosition())));
        if (this.options.includeComments) {
            this.addCommentToken(TokenType.BlockComment, value, start, classifyComment(value, 'block'));
        }
    }

    private addCommentToken(type: TokenType.LineComment | TokenType.BlockComment, value: string, start: Position, comment: CommentMetadata): void {
        const end = this.currentPosition();
        this.tokens.push(createToken(type, value, createSpan(start, end), comment));
    }

    private isLeadingShebangStart(start: Position): boolean {
        return start.offset === 0 && start.line === 1 && start.column === 1;
    }

    private isHostDirectiveSlot(start: Position): boolean {
        if (start.column !== 1) {
            return false;
        }
        if (start.line === 1) {
            return true;
        }
        return start.line === 2 && this.sawLeadingShebang;
    }

    private classifyLineComment(value: string, start: Position): CommentMetadata {
        if (value.startsWith('//!') && !this.isHostDirectiveSlot(start)) {
            return { channel: 'plain', form: 'line' };
        }
        return classifyComment(value, 'line');
    }
}

function classifyComment(value: string, form: CommentForm): CommentMetadata {
    const marker = getStructuredMarker(value, form);
    if (marker === null) {
        return { channel: 'plain', form };
    }

    if (marker === '#') {
        return { channel: 'doc', form };
    }
    if (marker === '@') {
        return { channel: 'annotation', form };
    }
    if (marker === '?') {
        return { channel: 'hint', form };
    }
    if (marker === '!') {
        return { channel: 'host', form };
    }

    const subtype = reservedSubtypeFromMarker(marker);
    if (subtype) {
        return { channel: 'reserved', form, subtype };
    }

    return { channel: 'plain', form };
}

function getStructuredMarker(value: string, form: CommentForm): string | null {
    if (form === 'line') {
        if (!value.startsWith('//') || value.length < 3) {
            return null;
        }
        return value[2] ?? null;
    }

    if (value.length < 3 || value[0] !== '/') {
        return null;
    }
    if (value[1] === '*') {
        // All C-style block comments are plain in r6.
        return null;
    }
    if (!isSlashChannelMarker(value[1] ?? '')) {
        return null;
    }
    return value[1] ?? null;
}

function reservedSubtypeFromMarker(marker: string): ReservedCommentSubtype | null {
    if (marker === '{') {
        return 'structure';
    }
    if (marker === '[') {
        return 'profile';
    }
    if (marker === '(') {
        return 'instructions';
    }
    return null;
}

function isValidDateLiteral(value: string): boolean {
    if (value.length !== 10
        || value[4] !== '-'
        || value[7] !== '-'
        || !/^\d{4}$/.test(value.slice(0, 4))
        || !/^\d{2}$/.test(value.slice(5, 7))
        || !/^\d{2}$/.test(value.slice(8, 10))) {
        return false;
    }
    const year = Number.parseInt(value.slice(0, 4), 10);
    const month = Number.parseInt(value.slice(5, 7), 10);
    const day = Number.parseInt(value.slice(8, 10), 10);
    return isValidDateParts(year, month, day);
}

function isValidTimeLiteral(value: string): boolean {
    return matchesTimeCore(value, true) || matchesZonedTime(value);
}

function isValidDateTimeLiteral(value: string): boolean {
    const tIndex = value.indexOf('T');
    if (tIndex === -1) return false;
    const date = value.slice(0, tIndex);
    const rest = value.slice(tIndex + 1);
    if (!isValidDateLiteral(date)) return false;
    if (matchesDateTimeTime(rest) || matchesDateTimeZonedTime(rest)) return true;
    const ampIndex = rest.indexOf('&');
    if (ampIndex === -1) return false;
    const base = rest.slice(0, ampIndex);
    const zone = rest.slice(ampIndex + 1);
    return zone.length > 0 && isValidZrutZone(zone) && (matchesDateTimeTime(base) || matchesDateTimeZonedTime(base));
}

function matchesTimeCore(value: string, allowHourPrecisionMarker: boolean): boolean {
    if (value.length === 3) {
        return allowHourPrecisionMarker
            && value[2] === ':'
            && /^\d{2}$/.test(value.slice(0, 2))
            && isValidHour(Number.parseInt(value.slice(0, 2), 10));
    }
    if (value.length === 5) {
        return value[2] === ':'
            && /^\d{2}$/.test(value.slice(0, 2))
            && /^\d{2}$/.test(value.slice(3, 5))
            && isValidHour(Number.parseInt(value.slice(0, 2), 10))
            && isValidMinuteOrSecond(Number.parseInt(value.slice(3, 5), 10));
    }
    return matchesHms(value);
}

function matchesDateTimeCore(value: string): boolean {
    if (value.length === 2) {
        return /^\d{2}$/.test(value);
    }
    return matchesTimeCore(value, false);
}

function matchesDateTimeTime(value: string): boolean {
    return matchesDateTimeCore(value) || matchesTimeCore(value, true);
}

function matchesHms(value: string): boolean {
    return value.length === 8
        && value[2] === ':'
        && value[5] === ':'
        && /^\d{2}$/.test(value.slice(0, 2))
        && /^\d{2}$/.test(value.slice(3, 5))
        && /^\d{2}$/.test(value.slice(6, 8))
        && isValidHour(Number.parseInt(value.slice(0, 2), 10))
        && isValidMinuteOrSecond(Number.parseInt(value.slice(3, 5), 10))
        && isValidMinuteOrSecond(Number.parseInt(value.slice(6, 8), 10));
}

function matchesZonedTime(value: string): boolean {
    if (matchesTimeCore(value, true)) return true;
    if (value.endsWith('Z')) {
        return matchesTimeCore(value.slice(0, -1), true);
    }
    const plusIndex = value.lastIndexOf('+');
    const minusIndex = value.lastIndexOf('-');
    const splitIndex = Math.max(plusIndex, minusIndex);
    if (splitIndex === -1) return false;
    const base = value.slice(0, splitIndex);
    const offset = value.slice(splitIndex + 1);
    return matchesTimeCore(base, true) && matchesOffset(offset);
}

function matchesDateTimeZonedTime(value: string): boolean {
    if (value.endsWith('Z')) {
        return matchesDateTimeTime(value.slice(0, -1));
    }
    const plusIndex = value.lastIndexOf('+');
    const minusIndex = value.lastIndexOf('-');
    const splitIndex = Math.max(plusIndex, minusIndex);
    if (splitIndex === -1) return false;
    const base = value.slice(0, splitIndex);
    const offset = value.slice(splitIndex + 1);
    return matchesDateTimeTime(base) && matchesOffset(offset);
}

function matchesOffset(value: string): boolean {
    return value.length === 5
        && value[2] === ':'
        && /^\d{2}$/.test(value.slice(0, 2))
        && /^\d{2}$/.test(value.slice(3, 5))
        && isValidHour(Number.parseInt(value.slice(0, 2), 10))
        && isValidMinuteOrSecond(Number.parseInt(value.slice(3, 5), 10));
}

function isValidDateParts(year: number, month: number, day: number): boolean {
    if (month < 1 || month > 12 || day < 1) {
        return false;
    }
    const daysInMonth = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    return day <= daysInMonth[month - 1]!;
}

function isLeapYear(year: number): boolean {
    return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function isValidHour(value: number): boolean {
    return value >= 0 && value <= 23;
}

function isValidMinuteOrSecond(value: number): boolean {
    return value >= 0 && value <= 59;
}

function isValidZrutZone(zone: string): boolean {
    if (zone.length === 0) return false;
    if (zone.startsWith('/')) return false;
    if (zone.endsWith('/')) return false;
    if (zone.includes('//')) return false;
    if (zone.includes('/*')) return false;
    if (zone.includes('/[')) return false;
    return true;
}

function isValidSeparatorPayload(payload: string): boolean {
    return !/[()[\]{}]/.test(payload);
}

function isValidRadixDigit(c: string): boolean {
    return isLetter(c) || isDigit(c) || c === '&' || c === '!';
}

function isValidRadixPayload(payload: string): boolean {
    if (payload.length === 0) return false;

    let index = 0;
    if (payload[index] === '+' || payload[index] === '-') {
        index += 1;
    }
    if (index >= payload.length) return false;

    let sawDigit = false;
    let sawDecimal = false;
    let prevWasDigit = false;
    let prevWasUnderscore = false;

    for (; index < payload.length; index += 1) {
        const c = payload[index]!;
        if (isValidRadixDigit(c)) {
            sawDigit = true;
            prevWasDigit = true;
            prevWasUnderscore = false;
            continue;
        }
        if (c === '_') {
            if (!prevWasDigit || index + 1 >= payload.length || !isValidRadixDigit(payload[index + 1]!)) {
                return false;
            }
            prevWasDigit = false;
            prevWasUnderscore = true;
            continue;
        }
        if (c === '.') {
            if (sawDecimal || !prevWasDigit || index + 1 >= payload.length || !isValidRadixDigit(payload[index + 1]!)) {
                return false;
            }
            sawDecimal = true;
            prevWasDigit = false;
            prevWasUnderscore = false;
            continue;
        }
        return false;
    }

    return sawDigit && !prevWasUnderscore && prevWasDigit;
}

function isValidEncodingPayload(payload: string): boolean {
    if (payload.length === 0) return false;
    if (!/^[A-Za-z0-9+/._-]+={0,2}$/.test(payload)) return false;
    const firstPadding = payload.indexOf('=');
    if (firstPadding === -1) return true;
    return payload.slice(firstPadding).split('').every((c) => c === '=');
}

/**
 * Tokenize an AEON document
 */
export function tokenize(input: string, options?: LexerOptions): LexResult {
    const lexer = new Lexer(input, options);
    return lexer.tokenize();
}
