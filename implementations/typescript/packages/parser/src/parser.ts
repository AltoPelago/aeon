import { type Token, TokenType, createSpan, type Span } from '@aeon/lexer';
import type {
    Document,
    Header,
    Binding,
    Value,
    TypeAnnotation,
    Attribute,
    AttributeValue,
    ObjectNode,
    ListNode,
    TupleLiteral,
    NodeLiteral,
    StringLiteral,
    NumberLiteral,
    InfinityLiteral,
    BooleanLiteral,
    SwitchLiteral,
    HexLiteral,
    DateLiteral,
    DateTimeLiteral,
    TimeLiteral,
    SeparatorLiteral,
    CloneReference,
    PointerReference,
    ReferencePathSegment,
} from './ast.js';
import {
    ParserError,
    SyntaxError,
    DuplicateKeyError,
    InvalidSeparatorCharError,
    SeparatorDepthExceededError,
    GenericDepthExceededError,
    AttributeDepthExceededError,
    NestingDepthExceededError,
} from './errors.js';
import { applyTrimticks, type TrimtickMarkerWidth } from './trimticks.js';

/**
 * Parser options
 */
export interface ParserOptions {
    /** Maximum nesting depth for attribute heads (default: 1) */
    readonly maxAttributeDepth?: number;
    /** Maximum number of separator segments in datatype annotation (default: 1) */
    readonly maxSeparatorDepth?: number;
    /** Maximum nesting depth for nested generic type annotations (default: 1) */
    readonly maxGenericDepth?: number;
    /** Maximum nesting depth for value structures like lists and objects (default: 256) */
    readonly maxNestingDepth?: number;
}

/**
 * Parse result
 */
export interface ParseResult {
    readonly document: Document | null;
    readonly errors: readonly ParserError[];
}

/**
 * Recursive-descent parser for AEON documents
 */
class Parser {
    private readonly tokens: readonly Token[];
    private readonly maxAttributeDepth: number;
    private readonly maxSeparatorDepth: number;
    private readonly maxGenericDepth: number;
    private readonly maxNestingDepth: number;
    private currentNestingDepth: number = 0;
    private current: number = 0;
    private readonly errors: ParserError[] = [];

    constructor(tokens: readonly Token[], options: ParserOptions = {}) {
        this.tokens = tokens;
        this.maxAttributeDepth = options.maxAttributeDepth ?? 1;
        this.maxSeparatorDepth = options.maxSeparatorDepth ?? 1;
        this.maxGenericDepth = options.maxGenericDepth ?? 1;
        this.maxNestingDepth = options.maxNestingDepth ?? 256;
    }

    /**
     * Parse the document
     */
    parse(): ParseResult {
        try {
            const document = this.parseDocument();
            return {
                document,
                errors: this.errors,
            };
        } catch (e) {
            if (e instanceof ParserError) {
                this.errors.push(e);
            }
            return {
                document: null,
                errors: this.errors,
            };
        }
    }

    // ============================================
    // Document parsing
    // ============================================

    private parseDocument(): Document {
        const start = this.peek().span.start;
        let header: Header | null = null;
        const bindings: Binding[] = [];

        // Check for header forms
        if (this.isHeaderStart()) {
            header = this.parseHeader();
        }

        // Parse body bindings
        while (!this.isAtEnd()) {
            try {
                if (bindings.length > 0 && this.isStructuredHeaderStart()) {
                    const headerStart = this.peek();
                    this.errors.push(
                        new SyntaxError(
                            'Structured headers must precede body bindings',
                            headerStart.span,
                            'top-level binding',
                            'aeon:header'
                        )
                    );
                    this.parseHeader();
                    continue;
                }
                const binding = this.parseBinding();
                if (binding) {
                    bindings.push(binding);
                    this.consumeSeparatorOrLineBreak(TokenType.EOF, 'Expected \',\' or newline between top-level bindings');
                }
            } catch (e) {
                if (e instanceof ParserError) {
                    this.errors.push(e);
                    this.synchronize();
                } else {
                    throw e;
                }
            }
        }

        const end = this.previous().span.end;
        return {
            type: 'Document',
            header,
            bindings,
            envelope: null,
            span: createSpan(start, end),
        };
    }

    private isHeaderStart(): boolean {
        if (!this.check(TokenType.Identifier)) return false;
        const token = this.peek();
        if (token.value !== 'aeon') return false;
        // Look ahead for colon
        if (this.current + 1 < this.tokens.length) {
            const next = this.tokens[this.current + 1]!;
            if (next.type !== TokenType.Colon) return false;
            const nextNext = this.tokens[this.current + 2];
            const nextNextNext = this.tokens[this.current + 3];
            if (
                nextNext?.type === TokenType.Identifier &&
                nextNext.value === 'envelope' &&
                nextNextNext?.type === TokenType.Equals
            ) {
                return false;
            }
            return true;
        }
        return false;
    }

    private isStructuredHeaderStart(): boolean {
        if (!this.isHeaderStart()) return false;
        const fieldToken = this.tokens[this.current + 2];
        const equalsToken = this.tokens[this.current + 3];
        return fieldToken?.type === TokenType.Identifier
            && fieldToken.value === 'header'
            && equalsToken?.type === TokenType.Equals;
    }

    private parseHeader(): Header {
        const start = this.peek().span.start;
        const fields = new Map<string, Value>();
        const bindings: Binding[] = [];
        let hasStructured = false;
        let hasShorthand = false;
        const seenShorthandFields = new Set<string>();

        // Parse header lines (aeon:xxx = ...)
        while (this.isHeaderStart()) {
            this.advance(); // consume 'aeon'
            this.consume(TokenType.Colon, "Expected ':' after 'aeon'");
            const fieldToken = this.consume(TokenType.Identifier, "Expected header field name");
            const fieldName = fieldToken.value;
            this.consume(TokenType.Equals, "Expected '=' in header");

            if (fieldName === 'header') {
                hasStructured = true;
                const value = this.parseValue();
                // Extract fields from structured header
                if (value.type === 'ObjectNode') {
                    for (const binding of value.bindings) {
                        bindings.push(binding);
                        fields.set(binding.key, binding.value);
                    }
                }
            } else {
                hasShorthand = true;
                const value = this.parseValue();
                const bindingSpan = createSpan(fieldToken.span.start, value.span.end);
                bindings.push({
                    type: 'Binding',
                    key: fieldName,
                    value,
                    datatype: null,
                    attributes: [],
                    span: bindingSpan,
                });
                if (seenShorthandFields.has(fieldName)) {
                    this.errors.push(new DuplicateKeyError(`aeon:${fieldName}`, fieldToken.span));
                }
                seenShorthandFields.add(fieldName);
                fields.set(fieldName, value);
            }

            this.consumeSeparatorOrLineBreak(TokenType.EOF, 'Expected \',\' or newline between header bindings');
        }

        const end = this.previous().span.end;
        const form: 'structured' | 'shorthand' = hasStructured ? 'structured' : 'shorthand';
        return {
            type: 'Header',
            form,
            hasStructured,
            hasShorthand,
            bindings,
            fields,
            span: createSpan(start, end),
        };
    }

    // ============================================
    // Binding parsing
    // ============================================

    private parseBinding(): Binding | null {
        // Skip any stray newlines at the start
        // (handled by lexer not including newlines by default)

        if (this.isAtEnd()) return null;

        const start = this.peek().span.start;

        // Parse key
        if (!this.check(TokenType.Identifier) && !this.check(TokenType.String)) {
            if (this.isAtEnd()) return null;
            throw new SyntaxError(
                `Expected key, found '${this.peek().value}'`,
                this.peek().span,
                'key',
                this.peek().value
            );
        }
        const keyToken = this.advance();
        const key = this.keyFromToken(keyToken);

        // Parse optional attributes @{...}
        const attributes: Attribute[] = [];
        while (this.check(TokenType.At)) {
            attributes.push(this.parseAttribute(1));
        }

        // Parse optional datatype :type
        let datatype: TypeAnnotation | null = null;
        if (this.check(TokenType.Colon)) {
            this.advance(); // consume :
            datatype = this.parseTypeAnnotation();
        }

        // Expect =
        if (!this.check(TokenType.Equals)) {
            throw new SyntaxError(
                `Expected '=' after key '${key}'`,
                this.peek().span,
                '=',
                this.peek().value
            );
        }
        this.advance(); // consume =

        // Parse value
        const value = this.parseValue();

        const end = this.previous().span.end;
        return {
            type: 'Binding',
            key,
            value,
            datatype,
            attributes,
            span: createSpan(start, end),
        };
    }

    private parseAttribute(depth: number): Attribute {
        if (depth > this.maxAttributeDepth) {
            throw new AttributeDepthExceededError(depth, this.maxAttributeDepth, this.peek().span);
        }
        const start = this.peek().span.start;
        this.advance(); // consume @
        this.consume(TokenType.LeftBrace, "Expected '{' after '@'");

        const entries = new Map<string, AttributeValue>();

        while (!this.check(TokenType.RightBrace) && !this.isAtEnd()) {
            const attrKeyToken = this.consumeOneOf([TokenType.Identifier, TokenType.String], "Expected attribute key");
            const attrKey = this.keyFromToken(attrKeyToken);
            const attributes: Attribute[] = [];
            while (this.check(TokenType.At)) {
                attributes.push(this.parseAttribute(depth + 1));
            }

            // Optional datatype
            let attrDatatype: TypeAnnotation | null = null;
            if (this.check(TokenType.Colon)) {
                this.advance();
                attrDatatype = this.parseTypeAnnotation();
            }

            this.consume(TokenType.Equals, "Expected '=' in attribute");
            const attrValue = this.parseValue();

            entries.set(attrKey, { value: attrValue, datatype: attrDatatype, attributes });

            if (!this.check(TokenType.RightBrace)) {
                this.consumeSeparatorOrLineBreak(TokenType.RightBrace, 'Expected \',\' or newline between attribute entries');
            }
        }

        this.consume(TokenType.RightBrace, "Expected '}' to close attribute");
        const end = this.previous().span.end;

        return {
            type: 'Attribute',
            entries,
            span: createSpan(start, end),
        };
    }

    private parseTypeAnnotation(genericDepth: number = 0): TypeAnnotation {
        if (genericDepth > this.maxGenericDepth) {
            throw new GenericDepthExceededError(genericDepth, this.maxGenericDepth, this.peek().span);
        }
        const start = this.peek().span.start;
        const name = this.consume(TokenType.Identifier, "Expected type name").value;
        const genericArgs: string[] = [];
        let radixBase: number | null = null;
        const separators: string[] = [];

        // Parse optional generic args: TypeName<arg1, arg2>
        if (this.check(TokenType.LeftAngle)) {
            if (name === 'radix') {
                throw new SyntaxError(
                    "Radix datatype bases must use bracket syntax like 'radix[10]'",
                    this.peek().span,
                    'radix[10]',
                    this.peek().value
                );
            }
            this.advance(); // consume <
            genericArgs.push(this.parseGenericArgument(genericDepth));

            while (this.check(TokenType.Comma)) {
                this.advance();
                genericArgs.push(this.parseGenericArgument(genericDepth));
            }

            this.consume(TokenType.RightAngle, "Expected '>' to close generic arguments");
        }

        // Parse repeated separator specifiers: [x][,][;]
        while (this.check(TokenType.LeftBracket)) {
            this.advance(); // consume [
            if (RESERVED_V1_DATATYPES.has(name) && !BRACKETED_V1_DATATYPES.has(name)) {
                throw new SyntaxError(
                    `Datatype '${name}' does not support bracket specifiers in v1`,
                    this.peek().span,
                    null,
                    name
                );
            }
            if (name === 'radix' && radixBase === null) {
                radixBase = this.parseRadixBaseSpecifier();
                this.consume(TokenType.RightBracket, "Expected ']' to close radix base spec");
                continue;
            }
            if (name === 'radix') {
                throw new SyntaxError(
                    "Radix datatype allows exactly one base bracket like 'radix[10]'",
                    this.peek().span,
                    'radix[10]',
                    this.peek().value
                );
            }
            const spec = RESERVED_V1_DATATYPES.has(name)
                ? this.parseSeparatorCharacter()
                : this.parseCustomBracketSpecifier();
            separators.push(spec);
            this.consume(TokenType.RightBracket, "Expected ']' to close separator spec");
            if (separators.length > this.maxSeparatorDepth) {
                throw new SeparatorDepthExceededError(separators.length, this.maxSeparatorDepth, this.previous().span);
            }
        }

        this.validateReservedDatatypeAdornments(name, genericArgs, radixBase, separators);

        const end = this.previous().span.end;
        return {
            type: 'TypeAnnotation',
            name,
            genericArgs,
            radixBase,
            separators,
            span: createSpan(start, end),
        };
    }

    private validateReservedDatatypeAdornments(
        name: string,
        genericArgs: readonly string[],
        radixBase: number | null,
        separators: readonly string[]
    ): void {
        if (!RESERVED_V1_DATATYPES.has(name)) return;

        if (genericArgs.length > 0 && !GENERIC_V1_DATATYPES.has(name)) {
            throw new SyntaxError(
                `Datatype '${name}' does not support generic arguments in v1`,
                this.previous().span,
                null,
                name
            );
        }

        if ((radixBase !== null || separators.length > 0) && !BRACKETED_V1_DATATYPES.has(name)) {
            throw new SyntaxError(
                `Datatype '${name}' does not support bracket specifiers in v1`,
                this.previous().span,
                null,
                name
            );
        }
    }

    private parseGenericArgument(genericDepth: number): string {
        const token = this.peek();
        if (token.type !== TokenType.Identifier && token.type !== TokenType.Number) {
            throw new SyntaxError(
                'Expected generic argument',
                token.span,
                'generic argument',
                token.value
            );
        }

        if (token.type === TokenType.Number) {
            this.advance();
            return token.value;
        }

        const type = this.parseTypeAnnotation(genericDepth + 1);
        return this.formatTypeAnnotation(type);
    }

    private formatTypeAnnotation(type: TypeAnnotation): string {
        const generics = type.genericArgs.length > 0 ? `<${type.genericArgs.join(', ')}>` : '';
        const radixBase = type.radixBase != null ? `[${type.radixBase}]` : '';
        const separators = type.separators.map((separator) => `[${separator}]`).join('');
        return `${type.name}${generics}${radixBase}${separators}`;
    }

    private parseRadixBaseSpecifier(): number {
        if (this.check(TokenType.RightBracket)) {
            throw new SyntaxError(
                'Radix base must be an integer from 2 to 64',
                this.peek().span,
                'integer from 2 to 64',
                this.peek().value
            );
        }
        const token = this.consume(TokenType.Number, 'Expected radix base');
        const raw = token.value.replace(/_/g, '');
        if (!/^(0|[1-9]\d*)$/.test(raw) || raw !== token.value) {
            throw new SyntaxError(
                'Radix base must be a base-10 integer without leading zeroes',
                token.span,
                'integer from 2 to 64',
                token.value
            );
        }

        const base = Number(raw);
        if (!Number.isInteger(base) || base < 2 || base > 64) {
            throw new SyntaxError(
                'Radix base must be an integer from 2 to 64',
                token.span,
                'integer from 2 to 64',
                token.value
            );
        }
        return base;
    }

    // ============================================
    // Value parsing
    // ============================================

    private parseValue(): Value {
        this.currentNestingDepth++;
        if (this.currentNestingDepth > this.maxNestingDepth) {
            throw new NestingDepthExceededError(this.currentNestingDepth, this.maxNestingDepth, this.peek().span);
        }
        try {
            return this.doParseValue();
        } finally {
            this.currentNestingDepth--;
        }
    }

    private doParseValue(): Value {
        // Node introducer syntax
        if (this.check(TokenType.LeftAngle)) {
            return this.parseNode();
        }

        // Node values must begin with the '<' introducer.
        if (this.check(TokenType.Identifier) && this.peekNext()?.type === TokenType.LeftAngle) {
            throw new SyntaxError(
                "Node values must use the '<tag>' or '<tag(...)>' forms",
                this.peek().span,
                '<tag>',
                this.peek().value
            );
        }

        // Object
        if (this.check(TokenType.LeftBrace)) {
            return this.parseObject();
        }

        // List
        if (this.check(TokenType.LeftBracket)) {
            return this.parseList();
        }

        // Tuple
        if (this.check(TokenType.LeftParen)) {
            return this.parseTuple();
        }

        // Clone reference
        if (this.check(TokenType.Tilde)) {
            return this.parseCloneReference();
        }

        // Pointer reference
        if (this.check(TokenType.TildeArrow)) {
            return this.parsePointerReference();
        }

        // Literals
        return this.parseLiteral();
    }

    private parseNode(): NodeLiteral {
        const start = this.peek().span.start;
        this.consume(TokenType.LeftAngle, "Expected '<' to start node literal");
        const tag = this.parseNodeTag();

        const attributes: Attribute[] = [];
        while (this.check(TokenType.At)) {
            attributes.push(this.parseAttribute(1));
        }

        let datatype: TypeAnnotation | null = null;
        if (this.check(TokenType.Colon)) {
            this.advance(); // consume :
            datatype = this.parseTypeAnnotation();
            if (datatype.genericArgs.length > 0 || datatype.radixBase !== null || datatype.separators.length > 0) {
                throw new SyntaxError(
                    'Node head datatypes must be simple labels without generics or separator specs',
                    datatype.span,
                    'simple node head datatype',
                    this.formatTypeAnnotation(datatype)
                );
            }
        }

        const children: Value[] = [];
        if (this.check(TokenType.RightAngle)) {
            this.advance();
            const end = this.previous().span.end;
            return {
                type: 'NodeLiteral',
                tag,
                attributes,
                datatype,
                children,
                span: createSpan(start, end),
            };
        }

        this.consume(TokenType.LeftParen, "Expected '(' or '>' after node tag");

        while (!this.check(TokenType.RightParen) && !this.isAtEnd()) {
            children.push(this.parseValue());
            if (!this.check(TokenType.RightParen)) {
                this.consumeSeparatorOrLineBreak(TokenType.RightParen, 'Expected \',\' or newline between node children');
            }
        }

        this.consume(TokenType.RightParen, "Expected ')' to close node children");
        this.consume(TokenType.RightAngle, "Expected '>' after node children");
        const end = this.previous().span.end;
        return {
            type: 'NodeLiteral',
            tag,
            attributes,
            datatype,
            children,
            span: createSpan(start, end),
        };
    }

    private parseNodeTag(): string {
        const token = this.consumeOneOf([TokenType.Identifier, TokenType.String], "Expected node tag after '<'");
        if (token.type === TokenType.String) {
            if (token.quote === '`') {
                throw new SyntaxError(
                    'Backtick-quoted node tags are not supported',
                    token.span,
                    'single or double quoted node tag',
                    token.value
                );
            }
            if (token.value.length === 0) {
                throw new SyntaxError(
                    'Quoted node tags must not be empty',
                    token.span,
                    'quoted node tag',
                    token.value
                );
            }
        }
        return token.value;
    }

    private parseObject(): ObjectNode {
        const start = this.peek().span.start;
        this.advance(); // consume {

        const bindings: Binding[] = [];
        const keys = new Set<string>();
        const attributes: Attribute[] = [];

        while (!this.check(TokenType.RightBrace) && !this.isAtEnd()) {
            // Parse optional attributes before binding
            while (this.check(TokenType.At)) {
                attributes.push(this.parseAttribute(1));
            }

            if (this.check(TokenType.RightBrace)) break;

            const binding = this.parseBinding();
            if (binding) {
                // Check for duplicate key
                if (keys.has(binding.key)) {
                    this.errors.push(new DuplicateKeyError(binding.key, binding.span));
                } else {
                    keys.add(binding.key);
                }
                bindings.push(binding);
            }

            if (!this.check(TokenType.RightBrace)) {
                this.consumeSeparatorOrLineBreak(TokenType.RightBrace, 'Expected \',\' or newline between object bindings');
            }
        }

        if (!this.check(TokenType.RightBrace)) {
            throw new SyntaxError(
                "Expected '}' to close object",
                this.peek().span,
                '}',
                this.peek().value
            );
        }
        this.advance(); // consume }

        const end = this.previous().span.end;
        return {
            type: 'ObjectNode',
            bindings,
            attributes,
            span: createSpan(start, end),
        };
    }

    private parseList(): ListNode {
        const start = this.peek().span.start;
        this.advance(); // consume [

        const elements: Value[] = [];
        const attributes: Attribute[] = [];

        while (!this.check(TokenType.RightBracket) && !this.isAtEnd()) {
            const element = this.parseValue();
            elements.push(element);

            if (!this.check(TokenType.RightBracket)) {
                this.consumeSeparatorOrLineBreak(TokenType.RightBracket, 'Expected \',\' or newline between list elements');
            }
        }

        if (!this.check(TokenType.RightBracket)) {
            throw new SyntaxError(
                "Expected ']' to close list",
                this.peek().span,
                ']',
                this.peek().value
            );
        }
        this.advance(); // consume ]

        const end = this.previous().span.end;
        return {
            type: 'ListNode',
            elements,
            attributes,
            span: createSpan(start, end),
        };
    }

    private parseTuple(): TupleLiteral {
        const start = this.peek().span.start;
        this.advance(); // consume (

        const elements: Value[] = [];
        const attributes: Attribute[] = [];

        while (!this.check(TokenType.RightParen) && !this.isAtEnd()) {
            const element = this.parseValue();
            elements.push(element);

            if (this.check(TokenType.Comma)) {
                this.advance();
                while (this.check(TokenType.Newline)) {
                    this.advance();
                }
                if (this.check(TokenType.RightParen)) {
                    break;
                }
                if (this.check(TokenType.Comma)) {
                    throw new SyntaxError(
                        "Expected ',' or newline between tuple elements",
                        this.peek().span,
                        "',' or newline",
                        this.peek().value
                    );
                }
                continue;
            }

            if (!this.check(TokenType.RightParen)) {
                this.consumeSeparatorOrLineBreak(TokenType.RightParen, 'Expected \',\' or newline between tuple elements');
            }
        }

        if (!this.check(TokenType.RightParen)) {
            throw new SyntaxError(
                "Expected ')' to close tuple",
                this.peek().span,
                ')',
                this.peek().value
            );
        }
        this.advance(); // consume )

        const end = this.previous().span.end;
        return {
            type: 'TupleLiteral',
            elements,
            attributes,
            raw: '',
            span: createSpan(start, end),
        };
    }

    private parseCloneReference(): CloneReference {
        const start = this.peek().span.start;
        this.advance(); // consume ~

        const path = this.parsePath();
        const end = this.previous().span.end;

        return {
            type: 'CloneReference',
            path,
            span: createSpan(start, end),
        };
    }

    private parsePointerReference(): PointerReference {
        const start = this.peek().span.start;
        this.advance(); // consume ~>

        const path = this.parsePath();
        const end = this.previous().span.end;

        return {
            type: 'PointerReference',
            path,
            span: createSpan(start, end),
        };
    }

    private parsePath(): ReferencePathSegment[] {
        const path: ReferencePathSegment[] = [];
        let sawRootDot = false;
        let sawExplicitRoot = false;

        if (this.check(TokenType.Dollar)) {
            this.advance(); // consume $
            sawExplicitRoot = true;
            if (this.check(TokenType.Dot)) {
                this.advance(); // consume explicit dot after $
                sawRootDot = true;
            }
        }

        this.parsePathInitialSegment(path, sawRootDot, sawExplicitRoot);

        while (this.check(TokenType.Dot) || this.check(TokenType.LeftBracket) || this.check(TokenType.At)) {
            if (this.check(TokenType.Dot)) {
                this.advance(); // consume .
                if (this.check(TokenType.LeftBracket)) {
                    path.push(this.parseQuotedBracketMemberSegment());
                } else {
                    path.push(this.parseMemberSegment("Expected member path segment after '.'"));
                }
                continue;
            }

            if (this.check(TokenType.At)) {
                this.advance(); // consume @
                path.push(this.parseAttributePathSegment());
                continue;
            }

            path.push(this.parseBracketPathSegment());
        }

        return path;
    }

    private parseLiteral(): Value {
        const token = this.peek();

        switch (token.type) {
            case TokenType.RightAngle:
                return this.parseTrimtickString();

            case TokenType.String:
                this.advance();
                return this.createStringLiteral(token);

            case TokenType.Number:
                this.advance();
                return this.createNumberLiteral(token);

            case TokenType.Identifier:
                if (token.value === 'Infinity') {
                    this.advance();
                    return this.createInfinityLiteral(token.value as 'Infinity');
                }
                throw new SyntaxError(
                    `Unexpected token '${token.value}'`,
                    token.span,
                    'value',
                    token.value
                );

            case TokenType.Symbol:
                if (token.value === '-' && this.peekNext()?.type === TokenType.Identifier && this.peekNext()?.value === 'Infinity') {
                    const minus = this.advance();
                    const infinity = this.advance();
                    return this.createInfinityLiteral('-Infinity', createSpan(minus.span.start, infinity.span.end));
                }
                throw new SyntaxError(
                    `Unexpected token '${token.value}'`,
                    token.span,
                    'value',
                    token.value
                );

            case TokenType.True:
            case TokenType.False:
                this.advance();
                return this.createBooleanLiteral(token);

            case TokenType.Yes:
            case TokenType.No:
            case TokenType.On:
            case TokenType.Off:
                this.advance();
                return this.createSwitchLiteral(token);

            case TokenType.HexLiteral:
                this.advance();
                return this.createHexLiteral(token);

            case TokenType.Date:
                this.advance();
                return this.createDateLiteral(token);

            case TokenType.DateTime:
                this.advance();
                return this.createDateTimeLiteral(token);

            case TokenType.Time:
                this.advance();
                return this.createTimeLiteral(token);

            case TokenType.SeparatorLiteral:
                this.advance();
                return this.createSeparatorLiteral(token);

            case TokenType.Caret:
                throw new SyntaxError(
                    'Separator literals must contain a payload',
                    token.span,
                    'separator literal payload',
                    token.value
                );

            case TokenType.RadixLiteral:
                this.advance();
                return {
                    type: 'RadixLiteral',
                    value: token.value.substring(1), // remove %
                    raw: token.value,
                    span: token.span,
                } as Value;

            case TokenType.EncodingLiteral:
                this.advance();
                return {
                    type: 'EncodingLiteral',
                    value: token.value.substring(1), // remove $
                    raw: token.value,
                    span: token.span,
                } as Value;

            default:
                throw new SyntaxError(
                    `Unexpected token '${token.value}'`,
                    token.span,
                    'value',
                    token.value
                );
        }
    }

    private createStringLiteral(token: Token): StringLiteral {
        return {
            type: 'StringLiteral',
            value: token.value,
            raw: token.value, // Could store original with quotes if needed
            delimiter: token.quote ?? '"',
            span: token.span,
        };
    }

    private parseTrimtickString(): StringLiteral {
        const startToken = this.peek();
        let markerWidth = 0;
        let previousAngle: Token | null = null;

        while (this.check(TokenType.RightAngle)) {
            const angle = this.peek();
            if (previousAngle && previousAngle.span.end.offset !== angle.span.start.offset) {
                throw new SyntaxError(
                    'Trimtick marker must be contiguous',
                    angle.span,
                    'trimticks',
                    angle.value
                );
            }
            markerWidth += 1;
            if (markerWidth > 4) {
                throw new SyntaxError(
                    'Trimtick marker may contain at most four ">" characters',
                    angle.span,
                    'trimticks',
                    angle.value
                );
            }
            previousAngle = this.advance();
        }

        if (!this.check(TokenType.String) || this.peek().quote !== '`') {
            throw new SyntaxError(
                'Trimtick marker must be followed by a backtick string',
                this.peek().span,
                'trimticks',
                this.peek().value
            );
        }

        const token = this.advance();
        const rawValue = token.value;

        return {
            type: 'StringLiteral',
            value: applyTrimticks(rawValue, markerWidth as TrimtickMarkerWidth),
            raw: rawValue,
            delimiter: '`',
            trimticks: {
                markerWidth: markerWidth as TrimtickMarkerWidth,
                rawValue,
            },
            span: createSpan(startToken.span.start, token.span.end),
        };
    }

    private createNumberLiteral(token: Token): NumberLiteral {
        return {
            type: 'NumberLiteral',
            value: token.value.replace(/_/g, ''),
            raw: token.value,
            span: token.span,
        };
    }

    private createInfinityLiteral(raw: 'Infinity' | '-Infinity', span?: Span): InfinityLiteral {
        return {
            type: 'InfinityLiteral',
            value: raw,
            raw,
            span: span ?? this.previous().span,
        };
    }

    private createBooleanLiteral(token: Token): BooleanLiteral {
        return {
            type: 'BooleanLiteral',
            value: token.value.toLowerCase() === 'true',
            raw: token.value,
            span: token.span,
        };
    }

    private createSwitchLiteral(token: Token): SwitchLiteral {
        const normalized = token.value.toLowerCase();
        if (normalized === 'yes' || normalized === 'no' || normalized === 'on' || normalized === 'off') {
            return {
                type: 'SwitchLiteral',
                value: normalized,
                raw: token.value,
                span: token.span,
            };
        }

        throw new SyntaxError(
            `Unexpected switch literal '${token.value}'`,
            token.span,
            'switch literal',
            token.value
        );
    }

    private createHexLiteral(token: Token): HexLiteral {
        return {
            type: 'HexLiteral',
            value: token.value.substring(1), // remove #
            raw: token.value,
            span: token.span,
        };
    }

    private createDateLiteral(token: Token): DateLiteral {
        return {
            type: 'DateLiteral',
            value: token.value,
            raw: token.value,
            span: token.span,
        };
    }

    private createDateTimeLiteral(token: Token): DateTimeLiteral {
        return {
            type: 'DateTimeLiteral',
            value: token.value,
            raw: token.value,
            span: token.span,
        };
    }

    private createTimeLiteral(token: Token): TimeLiteral {
        return {
            type: 'TimeLiteral',
            value: token.value,
            raw: token.value,
            span: token.span,
        };
    }

    private createSeparatorLiteral(token: Token): SeparatorLiteral {
        return {
            type: 'SeparatorLiteral',
            value: token.value.substring(1), // remove ^
            raw: token.value,
            span: token.span,
        };
    }

    // ============================================
    // Utility methods
    // ============================================

    private isAtEnd(): boolean {
        return this.peek().type === TokenType.EOF;
    }

    private peek(): Token {
        return this.tokens[this.current]!;
    }

    private peekNext(): Token | undefined {
        if (this.current + 1 >= this.tokens.length) return undefined;
        return this.tokens[this.current + 1];
    }

    private previous(): Token {
        return this.tokens[this.current - 1] ?? this.tokens[0]!;
    }

    private advance(): Token {
        if (!this.isAtEnd()) this.current++;
        return this.previous();
    }

    private check(type: TokenType): boolean {
        if (this.isAtEnd()) return false;
        return this.peek().type === type;
    }

    private consume(type: TokenType, message: string): Token {
        if (this.check(type)) return this.advance();
        throw new SyntaxError(message, this.peek().span, type, this.peek().value);
    }

    private consumeOneOf(types: readonly TokenType[], message: string): Token {
        for (const type of types) {
            if (this.check(type)) {
                return this.advance();
            }
        }
        throw new SyntaxError(message, this.peek().span, types.join(' | '), this.peek().value);
    }

    private keyFromToken(token: Token): string {
        if (token.type === TokenType.String && token.quote === '`') {
            throw new SyntaxError(
                'Backtick-quoted keys are not supported',
                token.span,
                'single or double quoted key',
                token.value
            );
        }
        return this.assertNonEmptyKey(token.value, token.span, 'Keys must not be empty');
    }

    private assertNonEmptyKey(key: string, span: Span, message: string): string {
        if (key.length === 0) {
            throw new SyntaxError(message, span, 'non-empty key', key);
        }
        return key;
    }

    private parsePathInitialSegment(
        path: ReferencePathSegment[],
        sawRootDot: boolean = false,
        sawExplicitRoot: boolean = false
    ): void {
        if (this.check(TokenType.Identifier) || this.check(TokenType.String)) {
            path.push(this.parseMemberSegment('Expected path segment'));
            return;
        }

        if (this.check(TokenType.LeftBracket)) {
            if (sawExplicitRoot && !sawRootDot && this.peekNext()?.type === TokenType.String) {
                throw new SyntaxError(
                    "Expected '.' after '$' before quoted root-member segment",
                    this.peek().span,
                    'reference path',
                    this.peek().value
                );
            }
            path.push(this.parseBracketPathSegment());
            return;
        }

        throw new SyntaxError(
            "Expected path segment",
            this.peek().span,
            'identifier, string key, or bracket segment',
            this.peek().value
        );
    }

    private parseMemberSegment(message: string): string {
        const token = this.consumeOneOf([TokenType.Identifier, TokenType.String], message);
        if (token.type === TokenType.String && token.quote === '`') {
            throw new SyntaxError(
                'Backtick-quoted keys are not supported in paths',
                token.span,
                'single or double quoted key',
                token.value
            );
        }
        return this.assertNonEmptyKey(token.value, token.span, 'Quoted path keys must not be empty');
    }

    private parseAttributePathSegment(): ReferencePathSegment {
        if (this.check(TokenType.LeftBracket)) {
            this.advance(); // consume [
            const keyToken = this.consume(TokenType.String, "Expected quoted attribute key after '@['");
            if (keyToken.quote === '`') {
                throw new SyntaxError(
                    'Backtick-quoted keys are not supported in attribute segments',
                    keyToken.span,
                    'single or double quoted key',
                    keyToken.value
                );
            }
            this.consume(TokenType.RightBracket, "Expected ']' after quoted attribute key");
            return { type: 'attr', key: this.assertNonEmptyKey(keyToken.value, keyToken.span, 'Quoted attribute keys must not be empty') };
        }

        const keyToken = this.consumeOneOf([TokenType.Identifier, TokenType.String], "Expected attribute path segment");
        if (keyToken.type === TokenType.String && keyToken.quote === '`') {
            throw new SyntaxError(
                'Backtick-quoted keys are not supported in attribute segments',
                keyToken.span,
                'single or double quoted key',
                keyToken.value
            );
        }
        return {
            type: 'attr',
            key: this.assertNonEmptyKey(keyToken.value, keyToken.span, 'Quoted attribute keys must not be empty'),
        };
    }

    private parseBracketPathSegment(): ReferencePathSegment {
        this.advance(); // consume [

        if (this.check(TokenType.String)) {
            const keyToken = this.advance();
            if (keyToken.quote === '`') {
                throw new SyntaxError(
                    'Backtick-quoted keys are not supported in paths',
                    keyToken.span,
                    'single or double quoted key',
                    keyToken.value
                );
            }
            this.consume(TokenType.RightBracket, "Expected ']' after quoted path segment");
            return this.assertNonEmptyKey(keyToken.value, keyToken.span, 'Quoted path keys must not be empty');
        }

        const indexToken = this.consume(TokenType.Number, "Expected numeric index or quoted key segment");
        this.consume(TokenType.RightBracket, "Expected ']' after index segment");

        const numericText = indexToken.value.replace(/_/g, '');
        const parsedIndex = Number.parseInt(numericText, 10);
        if (!Number.isInteger(parsedIndex) || parsedIndex < 0) {
            throw new SyntaxError(
                `Invalid index segment '${indexToken.value}'`,
                indexToken.span,
                'non-negative integer',
                indexToken.value
            );
        }
        return parsedIndex;
    }

    private parseQuotedBracketMemberSegment(): string {
        this.consume(TokenType.LeftBracket, "Expected '[' after '.'");
        const keyToken = this.consume(TokenType.String, "Expected quoted member path segment after '.['");
        if (keyToken.quote === '`') {
            throw new SyntaxError(
                'Backtick-quoted keys are not supported in paths',
                keyToken.span,
                'single or double quoted key',
                keyToken.value
            );
        }
        this.consume(TokenType.RightBracket, "Expected ']' after quoted member path segment");
        return this.assertNonEmptyKey(keyToken.value, keyToken.span, 'Quoted path keys must not be empty');
    }

    private parseSeparatorCharacter(): string {
        const token = this.peek();
        let char: string;

        switch (token.type) {
            case TokenType.Identifier:
            case TokenType.Number:
            case TokenType.String:
            case TokenType.Symbol:
                char = token.value;
                break;
            case TokenType.Comma:
                char = ',';
                break;
            case TokenType.Semicolon:
                char = ';';
                break;
            case TokenType.Colon:
                char = ':';
                break;
            case TokenType.Dot:
                char = '.';
                break;
            case TokenType.At:
                char = '@';
                break;
            case TokenType.Hash:
                char = '#';
                break;
            case TokenType.Dollar:
                char = '$';
                break;
            case TokenType.Percent:
                char = '%';
                break;
            case TokenType.Ampersand:
                char = '&';
                break;
            case TokenType.Caret:
                char = '^';
                break;
            case TokenType.Equals:
                char = '=';
                break;
            case TokenType.Tilde:
                char = '~';
                break;
            case TokenType.LeftBracket:
                char = '[';
                break;
            case TokenType.RightBracket:
                char = ']';
                break;
            default:
                throw new SyntaxError(
                    'Expected separator character',
                    token.span,
                    'single separator character',
                    token.value
                );
        }

        this.advance();

        if (char.length !== 1) {
            throw new SyntaxError(
                'Separator datatype bracket specs must contain exactly one character',
                token.span,
                'single separator character',
                token.value
            );
        }
        const code = char.charCodeAt(0);
        if (code < 0x21 || code > 0x7e || char === ',' || char === '[' || char === ']') {
            throw new InvalidSeparatorCharError(char, token.span);
        }

        return char;
    }

    private parseCustomBracketSpecifier(): string {
        const token = this.peek();
        let value: string;

        switch (token.type) {
            case TokenType.Identifier:
            case TokenType.Number:
            case TokenType.String:
            case TokenType.Symbol:
                value = token.value;
                break;
            case TokenType.Comma:
                value = ',';
                break;
            case TokenType.Semicolon:
                value = ';';
                break;
            case TokenType.Colon:
                value = ':';
                break;
            case TokenType.Dot:
                value = '.';
                break;
            case TokenType.At:
                value = '@';
                break;
            case TokenType.Hash:
                value = '#';
                break;
            case TokenType.Dollar:
                value = '$';
                break;
            case TokenType.Percent:
                value = '%';
                break;
            case TokenType.Ampersand:
                value = '&';
                break;
            case TokenType.Caret:
                value = '^';
                break;
            case TokenType.Equals:
                value = '=';
                break;
            case TokenType.Tilde:
                value = '~';
                break;
            case TokenType.LeftBracket:
                value = '[';
                break;
            case TokenType.RightBracket:
                throw new SyntaxError(
                    'Expected separator character',
                    token.span,
                    'separator or radix bracket spec',
                    token.value
                );
            default:
                throw new SyntaxError(
                    'Expected separator character',
                    token.span,
                    'separator or radix bracket spec',
                    token.value
                );
        }

        this.advance();
        if (value === ',' || value === '[') {
            throw new InvalidSeparatorCharError(value, token.span);
        }
        return value;
    }

    private synchronize(): void {
        this.advance();

        while (!this.isAtEnd()) {
            // If we see what looks like the start of a new binding, stop synchronizing
            if (this.check(TokenType.Identifier)) {
                // Peek ahead to see if this is a binding (identifier followed by = or :)
                const next = this.peekNext();
                if (next && (next.type === TokenType.Equals || next.type === TokenType.Colon || next.type === TokenType.At)) {
                    return;
                }
            }
            this.advance();
        }
    }

    private consumeSeparatorOrLineBreak(closeType: TokenType, message: string): void {
        const next = this.peek();

        if (next.type === closeType || next.type === TokenType.EOF) {
            return;
        }
        if (this.check(TokenType.Comma)) {
            this.advance();
            return;
        }
        const prev = this.previous();
        if (next.span.start.line > prev.span.end.line) {
            return;
        }
        throw new SyntaxError(message, next.span, "',' or newline", next.value);
    }
}

const GENERIC_V1_DATATYPES = new Set(['list', 'tuple']);
const BRACKETED_V1_DATATYPES = new Set(['sep', 'set', 'radix']);
const RESERVED_V1_DATATYPES = new Set([
    'n', 'number', 'int', 'int8', 'int16', 'int32', 'int64',
    'uint', 'uint8', 'uint16', 'uint32', 'uint64',
    'float', 'float32', 'float64',
    'string', 'trimtick', 'boolean', 'bool', 'switch', 'infinity',
    'hex', 'date', 'time', 'datetime', 'zrut',
    'encoding', 'base64', 'embed', 'inline',
    'radix', 'radix2', 'radix6', 'radix8', 'radix12',
    'sep', 'set',
    'tuple', 'list', 'object', 'obj', 'envelope', 'o', 'node', 'null',
]);

/**
 * Parse AEON tokens into an AST
 */
export function parse(tokens: readonly Token[], options?: ParserOptions): ParseResult {
    const parser = new Parser(tokens, options);
    return parser.parse();
}
