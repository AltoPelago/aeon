/** SANSA owns path-step grammar; this cursor owns AEON token decoding/spans
 * and projects directly into the structural reference AST. */
import { TokenType, type Token } from '@altopelago/aeon-lexer';
import { parseDotSelectorFromCursor, parsePositionSelectorFromCursor, validatePositionIndex, type SansaSelectorCursor } from '@altopelago/sansa/parsing/selector-cursor';
import type { SansaSelector } from '@altopelago/sansa';
import type { ReferencePathSegment } from './ast.js';
import { SyntaxError } from './errors.js';

export interface ReferenceTokenCursor {
    peek(): Token;
    peekNext(): Token | undefined;
    peekAhead?(offset: number): Token | undefined;
    check(type: TokenType): boolean;
    advance(): Token;
    consume(type: TokenType, message: string): Token;
    isKeyToken(token: Token): boolean;
}

const projectMember = (name: string): string => name;
const projectPosition = (index: number): number => index;

function punctuationType(char: string): TokenType | undefined {
    switch (char) {
        case '.': return TokenType.Dot;
        case '[': return TokenType.LeftBracket;
        case ']': return TokenType.RightBracket;
        case '@': return TokenType.At;
        default: return undefined;
    }
}
export class ReferenceReader implements SansaSelectorCursor {
    protected context: 'initial' | 'member' | 'attribute' | 'bracket' = 'initial';
    private quotedToken: Token | undefined;
    private virtualClose = false;
    protected output!: ReferencePathSegment[];
    constructor(protected readonly tokens: ReferenceTokenCursor) {}
    error(message: string, expected: string, token = this.tokens.peek()): never {
        throw new SyntaxError(message, token.span, expected, token.value);
    }
    key(message: string): string {
        const token = this.tokens.peek();
        if (!this.tokens.isKeyToken(token)) return this.error(message, 'key');
        this.tokens.advance();
        return this.keyValue(token);
    }
    private keyValue(token: Token): string {
        if (token.type === TokenType.String && token.quote === '`') return this.backtick(token);
        if (!token.value.length) return this.emptyKey(token);
        return token.value;
    }
    private backtick(token: Token): never {
        return this.error(this.context === 'attribute' ? 'Backtick-quoted keys are not supported in attribute segments' : 'Backtick-quoted keys are not supported in paths', 'single or double quoted key', token);
    }
    private emptyKey(token: Token): never {
        return this.error(this.context === 'attribute' ? 'Quoted attribute keys must not be empty' : 'Quoted path keys must not be empty', 'non-empty key', token);
    }

    get index() { return this.tokens.peek().span.start.offset; }
    peekSyntax(): string {
        switch (this.tokens.peek().type) {
            case TokenType.At: return '@';
            case TokenType.LeftBracket: return '[';
            default: return '';
        }
    }
    match(char: string) {
        const type = punctuationType(char);
        if (type === undefined || !(this.tokens.peek().type === type)) return false;
        this.tokens.advance(); return true;
    }
    consume(char: string) {
        if (char === ']' && this.virtualClose) { this.virtualClose = false; return; }
        const type = punctuationType(char)!;
        if ((this.tokens.peek().type === type)) { this.tokens.advance(); return; }
        return this.expectedPunctuation(char, type);
    }
    private expectedPunctuation(char: string, type: TokenType) {
        const message = char === ']' ? this.context === 'attribute' ? "Expected ']' after quoted attribute key" : this.context === 'bracket' ? "Expected ']' after quoted path segment" : "Expected ']' after quoted member path segment" : `Expected '${char}'`;
        return this.tokens.consume(type, message);
    }
    matchRangeSeparator() { return false; } // AEON v1 numeric tokens have no range syntax.
    parseIdentifier() { return this.key("Expected member path segment after '.'"); }
    take(type: TokenType, message: string): Token {
        if (this.tokens.peek().type === type) return this.tokens.advance();
        return this.tokens.consume(type, message);
    }
    parseQuotedPayload(): string {
        const token = this.tokens.peek();
        if (token.type !== TokenType.String) return this.expectedQuotedPayload();
        this.tokens.advance();
        return this.quotedValue(token);
    }
    private quotedValue(token: Token): string {
        if (token.quote === '`') return this.backtick(token);
        if (!token.value.length) {
            // AEON requires the closing token before reporting an empty key.
            this.consume(']');
            return this.emptyKey(token);
        }
        return token.value;
    }
    private expectedQuotedPayload(): never {
        const message = this.context === 'attribute' ? "Expected quoted attribute key after '@['" : this.context === 'bracket' ? 'Expected quoted member path segment' : "Expected quoted member path segment after '.['";
        this.tokens.consume(TokenType.String, message);
        throw new Error('Expected quoted-payload failure');
    }
    parseOptionalPositionIndex() {
        const token = this.take(TokenType.Number, 'Expected numeric index or quoted key segment');
        this.take(TokenType.RightBracket, "Expected ']' after index segment");
        const value = validatePositionIndex(token.value, undefined,
            (message) => this.error(message, 'SANSA positional index (0..999999)', token));
        // Shared grammar consumes the closing bracket; expose it once virtually.
        this.virtualClose = true;
        return value;
    }
    fail(): never { return this.error('Quoted path keys must not be empty', 'non-empty key', this.quotedToken); }
    emitMember(name: string, _quoted: boolean): void { this.output.push(name); }
    private emitAttribute(name: string, _quoted: boolean): void { this.output.push({ type: 'attr', key: name }); }
    emit(selector: SansaSelector | string | number): void {
        if (typeof selector === 'string' || typeof selector === 'number') this.output.push(selector);
        else if (selector.type === 'attributeSpace') this.attribute();
        else if (selector.type === 'member') this.output.push(selector.name);
        else if (selector.type === 'position') this.output.push(selector.index);
        else throw new Error('Non-structural reference projection');
    }
    protected attribute(): void {
        this.take(TokenType.Dot, "Expected '.' after attribute address-space marker");
        this.context = 'attribute';
        if (this.tokens.peek().type === TokenType.LeftBracket) {
            this.tokens.advance();
            const name = this.parseQuotedPayload();
            this.take(TokenType.RightBracket, "Expected ']' after quoted attribute key");
            this.emitAttribute(name, true);
        } else this.emitAttribute(this.key('Expected attribute path segment'), false);
    }
    bracket(): void {
        this.context = 'bracket';
        if (this.tokens.peekNext()?.type === TokenType.String) {
            this.tokens.advance();
            const name = this.quotedValue(this.tokens.advance());
            this.take(TokenType.RightBracket, "Expected ']' after quoted path segment");
            this.emitMember(name, true);
        } else this.emit(parsePositionSelectorFromCursor(this, projectPosition));
    }
    readPath(): ReferencePathSegment[] {
        try {
            this.read();
            return this.path();
        } catch (error) {
            // Lazy error stacks retain this receiver: release partial buffers.
            this.output = undefined!;
            this.quotedToken = undefined;
            throw error;
        }
    }
    read(): void {
        this.output = [];
        this.context = 'initial';
        this.quotedToken = undefined;
        this.virtualClose = false;
        this.readInitial();
        for (;;) {
            const type = this.tokens.peek().type;
            if (type === TokenType.LeftBracket) this.bracket();
            else if (type === TokenType.Dot) { this.context = 'member'; this.emit(parseDotSelectorFromCursor(this, projectMember)); }
            else break;
        }
    }
    protected readInitial(): void {
        let root = false, rootDot = false;
        if ((this.tokens.peek().type === TokenType.Dollar)) {
            this.tokens.advance(); root = true;
            if ((this.tokens.peek().type === TokenType.Dot)) { this.tokens.advance(); rootDot = true; }
        }
        if (this.tokens.isKeyToken(this.tokens.peek())) {
            const quoted = this.tokens.peek().type === TokenType.String;
            this.emitMember(this.keyValue(this.tokens.advance()), quoted);
        } else if ((this.tokens.peek().type === TokenType.LeftBracket)) {
            if (root && !rootDot && this.tokens.peekNext()?.type === TokenType.String) this.error("Expected '.' after '$' before quoted root-member segment", 'reference path');
            this.bracket();
        } else this.error('Expected path segment', 'identifier, string key, or bracket segment');
    }
    path(): ReferencePathSegment[] {
        // Growth capacity belongs to the reader, not the retained AST path.
        return (this.output as ReferencePathSegment[]).slice();
    }
}

/** Stream into the legacy structural projection without constructing an unused
 * authored-selection AST. Same shared grammar; no additional selector parser. */
export function parseReferenceAddress(tokens: ReferenceTokenCursor): ReferencePathSegment[] {
    const reader = new ReferenceReader(tokens);
    reader.read();
    return reader.path();
}
