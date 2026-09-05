import { type Token, TokenType, createSpan, type Span } from '@altopelago/aeon-lexer';
import {
    parseAddressOrThrow,
    renderAddress,
    SansaParseError,
    type SansaAddress,
} from '@altopelago/sansa';
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
    NaNLiteral,
    NullLiteral,
    BooleanLiteral,
    ToggleLiteral,
    HexLiteral,
    DateLiteral,
    DateTimeLiteral,
    TimeLiteral,
    SeparatorLiteral,
    SansaAddressLiteral,
    CloneReference,
    PointerReference,
    ReferencePathSegment,
} from './ast.js';
import {
    ParserError,
    SyntaxError,
    DuplicateKeyError,
    DuplicateStructuralIdentityError,
    ClarifierValuesExceededError,
    GenericDepthExceededError,
    GenericArgumentsExceededError,
    DatatypeComponentsExceededError,
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
    /** Maximum clarifier values on one datatype descriptor (default: 1). */
    readonly maxClarifierValues?: number;
    /** @deprecated Use maxClarifierValues. */
    readonly maxSeparatorDepth?: number;
    /** Maximum nesting depth for nested generic type annotations (default: 1) */
    readonly maxGenericDepth?: number;
    /** Maximum generic arguments on one datatype descriptor (default: 32). */
    readonly maxGenericArguments?: number;
    /** Maximum aggregate components in one recursive datatype (default: 64). */
    readonly maxDatatypeComponents?: number;
    /** Maximum nesting depth for value structures like lists and objects (default: 256) */
    readonly maxValueNestingDepth?: number;
    /** @deprecated Use maxValueNestingDepth. */
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
    private readonly maxClarifierValues: number;
    private readonly maxGenericDepth: number;
    private readonly maxGenericArguments: number;
    private readonly maxDatatypeComponents: number;
    private readonly maxValueNestingDepth: number;
    private currentNestingDepth: number = 0;
    private current: number = 0;
    private readonly errors: ParserError[] = [];
    private readonly structuralIdentities = new Map<string, Span>();

    constructor(tokens: readonly Token[], options: ParserOptions = {}) {
        this.tokens = tokens;
        this.maxAttributeDepth = options.maxAttributeDepth ?? 1;
        this.maxClarifierValues = options.maxClarifierValues ?? options.maxSeparatorDepth ?? 1;
        this.maxGenericDepth = options.maxGenericDepth ?? 1;
        this.maxGenericArguments = options.maxGenericArguments ?? 32;
        this.maxDatatypeComponents = options.maxDatatypeComponents ?? 64;
        this.maxValueNestingDepth = options.maxValueNestingDepth ?? options.maxNestingDepth ?? 256;
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
        const keys = new Set<string>();

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
                    if (keys.has(binding.key)) {
                        this.errors.push(new DuplicateKeyError(binding.key, binding.span, this.rootKeyPath(binding.key)));
                    } else {
                        keys.add(binding.key);
                    }
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

    private rootKeyPath(key: string): string {
        if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
            return `$.${key}`;
        }
        return `$.[${JSON.stringify(key)}]`;
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
                    structuralId: null,
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
        if (!this.isKeyToken(this.peek())) {
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

        const structuralId = this.parseOptionalStructuralIdentity();

        // Parse optional attributes @{...}
        const attributes: Attribute[] = [];
        if (this.check(TokenType.At)) {
            attributes.push(this.parseAttribute(1));
            if (this.check(TokenType.At)) {
                throw new SyntaxError(
                    'Only one attribute block is allowed before a binding datatype',
                    this.peek().span,
                    ': or =',
                    this.peek().value
                );
            }
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
        if (datatype) {
            this.validateBindingNodeGeneric(datatype, value);
        }

        const end = this.previous().span.end;
        return {
            type: 'Binding',
            key,
            structuralId,
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
            const attrKeyToken = this.consumeKeyToken("Expected attribute key");
            const attrKey = this.keyFromToken(attrKeyToken);
            if (RESERVED_ATTRIBUTE_KEYS.has(attrKey)) {
                throw new SyntaxError(
                    `Reserved attribute key: ${attrKey}`,
                    attrKeyToken.span,
                    'non-reserved attribute key',
                    attrKeyToken.value
                );
            }
            const structuralId = this.parseOptionalStructuralIdentity();
            const attributes: Attribute[] = [];
            if (this.check(TokenType.At)) {
                attributes.push(this.parseAttribute(depth + 1));
                if (this.check(TokenType.At)) {
                    throw new SyntaxError(
                        'Only one attribute block is allowed before an attribute entry datatype',
                        this.peek().span,
                        ': or =',
                        this.peek().value
                    );
                }
            }

            // Optional datatype
            let attrDatatype: TypeAnnotation | null = null;
            if (this.check(TokenType.Colon)) {
                this.advance();
                attrDatatype = this.parseTypeAnnotation();
            }

            this.consume(TokenType.Equals, "Expected '=' in attribute");
            const attrValue = this.parseValue();

            if (entries.has(attrKey)) {
                this.errors.push(new DuplicateKeyError(attrKey, attrKeyToken.span));
            }
            entries.set(attrKey, { structuralId, value: attrValue, datatype: attrDatatype, attributes });

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

    private parseTypeAnnotation(
        genericDepth: number = 0,
        components: { count: number } = { count: 0 }
    ): TypeAnnotation {
        this.countDatatypeComponent(components, this.peek().span);
        const start = this.peek().span.start;
        const name = this.consume(TokenType.Identifier, "Expected type name").value;
        const genericArgs: string[] = [];
        const clarifiers: (string | number)[] = [];

        // Parse optional generic args: TypeName<arg1, arg2>
        if (this.check(TokenType.LeftAngle)) {
            if (genericDepth > this.maxGenericDepth) {
                throw new GenericDepthExceededError(genericDepth, this.maxGenericDepth, this.peek().span);
            }
            if (name === 'radix') {
                throw new SyntaxError(
                    "Radix datatype bases must use bracket syntax like 'radix[10]'",
                    this.peek().span,
                    'radix[10]',
                    this.peek().value
                );
            }
            this.advance(); // consume <
            genericArgs.push(this.parseGenericArgument(genericDepth, components));
            this.enforceGenericArgumentCount(genericArgs.length);

            while (this.check(TokenType.Comma)) {
                this.advance();
                genericArgs.push(this.parseGenericArgument(genericDepth, components));
                this.enforceGenericArgumentCount(genericArgs.length);
            }

            this.consume(TokenType.RightAngle, "Expected '>' to close generic arguments");
        }

        // Parse optional clarifier: [value1, value2, ...]
        if (this.check(TokenType.LeftBracket)) {
            this.advance(); // consume [
            clarifiers.push(...this.parseClarifierValues());
            this.consume(TokenType.RightBracket, "Expected ']' to close datatype clarifier");
            if (clarifiers.length > this.maxClarifierValues) {
                throw new ClarifierValuesExceededError(clarifiers.length, this.maxClarifierValues, this.previous().span);
            }
            for (let index = 0; index < clarifiers.length; index += 1) {
                this.countDatatypeComponent(components, this.previous().span);
            }
            if (this.check(TokenType.LeftBracket)) {
                throw new SyntaxError(
                    "Datatype clarifiers must use a single bracketed list like 'sep[\"/\", \".\"]'",
                    this.peek().span,
                    'sep["/", "."]',
                    this.peek().value
                );
            }
        }

        this.validateReservedDatatypeAdornments(name, genericArgs);

        const end = this.previous().span.end;
        return {
            type: 'TypeAnnotation',
            name,
            genericArgs,
            clarifiers,
            span: createSpan(start, end),
        };
    }

    private validateReservedDatatypeAdornments(
        name: string,
        genericArgs: readonly string[]
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

    }

    private validateBindingNodeGeneric(datatype: TypeAnnotation, value: Value): void {
        if (datatype.name !== 'node' || datatype.genericArgs.length === 0 || value.type !== 'NodeLiteral') {
            return;
        }

        for (const arg of datatype.genericArgs) {
            const base = arg.split('<', 1)[0] ?? arg;
            if (base !== 'node' && RESERVED_V1_DATATYPES.has(base)) {
                throw new SyntaxError(
                    "Binding-level node<T> claims over node values may use node<T> only for custom profile/domain claims or node<node>",
                    datatype.span,
                    'node<node> or node<custom>',
                    this.formatTypeAnnotation(datatype)
                );
            }
        }
    }

    private parseGenericArgument(genericDepth: number, components: { count: number }): string {
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
            this.countDatatypeComponent(components, token.span);
            return token.value;
        }

        const type = this.parseTypeAnnotation(genericDepth + 1, components);
        return this.formatTypeAnnotation(type);
    }

    private enforceGenericArgumentCount(observed: number): void {
        if (observed > this.maxGenericArguments) {
            throw new GenericArgumentsExceededError(observed, this.maxGenericArguments, this.previous().span);
        }
    }

    private countDatatypeComponent(components: { count: number }, span: Span): void {
        components.count += 1;
        if (components.count > this.maxDatatypeComponents) {
            throw new DatatypeComponentsExceededError(components.count, this.maxDatatypeComponents, span);
        }
    }

    private formatTypeAnnotation(type: TypeAnnotation): string {
        const generics = type.genericArgs.length > 0 ? `<${type.genericArgs.join(', ')}>` : '';
        const clarifiers = type.clarifiers.length > 0
            ? `[${type.clarifiers.map((value) => typeof value === 'string' ? JSON.stringify(value) : String(value)).join(', ')}]`
            : '';
        return `${type.name}${generics}${clarifiers}`;
    }

    private parseClarifierValues(): (string | number)[] {
        if (this.check(TokenType.RightBracket)) {
            throw new SyntaxError(
                'Datatype clarifier must contain at least one string or number',
                this.peek().span,
                'string or number',
                this.peek().value
            );
        }

        const values = [this.parseClarifierValue()];
        while (this.check(TokenType.Comma)) {
            this.advance();
            values.push(this.parseClarifierValue());
        }
        return values;
    }

    private parseClarifierValue(): string | number {
        const token = this.peek();
        if (token.type === TokenType.String) {
            this.advance();
            return token.value;
        }
        if (token.type === TokenType.Number) {
            this.advance();
            return Number(token.value.replace(/_/g, ''));
        }
        throw new SyntaxError(
            'Expected clarifier value',
            token.span,
            'string or number',
            token.value
        );
    }

    // ============================================
    // Value parsing
    // ============================================

    private parseValue(): Value {
        const countsTowardNesting =
            this.check(TokenType.LeftAngle)
            || this.check(TokenType.LeftBrace)
            || this.check(TokenType.LeftBracket)
            || this.check(TokenType.LeftParen);
        if (countsTowardNesting) {
            this.currentNestingDepth++;
            const projectedDepth = this.projectedOpeningContainerDepth();
            if (projectedDepth !== null) {
                this.currentNestingDepth--;
                throw new NestingDepthExceededError(projectedDepth, this.maxValueNestingDepth, this.peek().span);
            }
            if (this.currentNestingDepth > this.maxValueNestingDepth) {
                const observedDepth = this.currentNestingDepth;
                this.currentNestingDepth--;
                throw new NestingDepthExceededError(observedDepth, this.maxValueNestingDepth, this.peek().span);
            }
        }
        try {
            return this.doParseValue();
        } finally {
            if (countsTowardNesting) {
                this.currentNestingDepth--;
            }
        }
    }

    private parseContainerValue(): Value {
        if (!this.check(TokenType.StructuralIdentity) && !this.check(TokenType.Colon) && !this.check(TokenType.At)) {
            return this.parseValue();
        }

        const start = this.peek().span.start;
        const structuralId = this.parseOptionalStructuralIdentity();
        const attributes: Attribute[] = [];
        if (this.check(TokenType.At)) {
            attributes.push(this.parseAttribute(1));
            if (this.check(TokenType.At)) {
                throw new SyntaxError(
                    'Only one attribute block is allowed before an anonymous value datatype',
                    this.peek().span,
                    ': or =',
                    this.peek().value
                );
            }
        }

        let datatype: TypeAnnotation | null = null;
        if (this.check(TokenType.Colon)) {
            this.advance(); // consume :
            datatype = this.parseTypeAnnotation();
        }

        this.consume(TokenType.Equals, "Expected '=' after anonymous value head");
        const value = this.parseValue();

        return {
            type: 'TypedValue',
            structuralId,
            datatype,
            attributes,
            value,
            span: createSpan(start, value.span.end),
        };
    }

    private projectedOpeningContainerDepth(): number | null {
        let extraDepth = 0;
        for (let index = this.current; index < this.tokens.length; index++) {
            switch (this.tokens[index]?.type) {
                case TokenType.LeftBracket:
                case TokenType.LeftParen:
                case TokenType.LeftBrace:
                case TokenType.LeftAngle:
                    extraDepth++;
                    break;
                default:
                    return this.toProjectedOpeningContainerDepth(extraDepth) > this.maxValueNestingDepth
                        ? this.toProjectedOpeningContainerDepth(extraDepth)
                        : null;
            }
        }
        const projectedDepth = this.toProjectedOpeningContainerDepth(extraDepth);
        return projectedDepth > this.maxValueNestingDepth
            ? projectedDepth
            : null;
    }

    private toProjectedOpeningContainerDepth(extraDepth: number): number {
        return this.currentNestingDepth + Math.max(extraDepth - 1, 0);
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

        // SANSA address literal
        if (
            this.check(TokenType.SansaAddressLiteral)
            || this.check(TokenType.Dollar)
            || this.check(TokenType.Question)
        ) {
            return this.parseSansaAddressLiteral();
        }

        // Literals
        return this.parseLiteral();
    }

    private parseNode(): NodeLiteral {
        const start = this.peek().span.start;
        this.consume(TokenType.LeftAngle, "Expected '<' to start node literal");
        const tag = this.parseNodeTag();
        const structuralId = this.parseOptionalStructuralIdentity();

        const attributes: Attribute[] = [];
        if (this.check(TokenType.At)) {
            attributes.push(this.parseAttribute(1));
            if (this.check(TokenType.At)) {
                throw new SyntaxError(
                    'Only one attribute block is allowed before a node datatype',
                    this.peek().span,
                    ':, (, or >',
                    this.peek().value
                );
            }
        }

        let datatype: TypeAnnotation | null = null;
        if (this.check(TokenType.Colon)) {
            this.advance(); // consume :
            datatype = this.parseTypeAnnotation();
            if (datatype.genericArgs.length > 0 && datatype.name !== 'node') {
                throw new SyntaxError(
                    'Generic node head datatypes must use node<T>',
                    datatype.span,
                    'node<T>',
                    this.formatTypeAnnotation(datatype)
                );
            }
            if (datatype.clarifiers.length > 0) {
                throw new SyntaxError(
                    'Node head datatypes must not use clarifiers',
                    datatype.span,
                    'node head datatype',
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
                structuralId,
                attributes,
                datatype,
                children,
                span: createSpan(start, end),
            };
        }

        this.consume(TokenType.LeftParen, "Expected '(' or '>' after node tag");

        while (!this.check(TokenType.RightParen) && !this.isAtEnd()) {
            children.push(this.parseContainerValue());
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
            structuralId,
            attributes,
            datatype,
            children,
            span: createSpan(start, end),
        };
    }

    private parseNodeTag(): string {
        const token = this.consumeKeyToken("Expected node tag after '<'");
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
            if (this.check(TokenType.At)) {
                throw new SyntaxError(
                    'Object attributes must be attached to the object binding or an object member binding',
                    this.peek().span,
                    'object member key',
                    this.peek().value
                );
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
            const element = this.parseContainerValue();
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
            const element = this.parseContainerValue();
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

    private parseSansaAddressLiteral(): SansaAddressLiteral {
        const start = this.peek().span.start;
        const { raw, end } = this.check(TokenType.SansaAddressLiteral)
            ? { raw: this.peek().value, end: this.advance().span.end }
            : this.collectSansaAddressSource();
        let address: SansaAddress;

        try {
            address = parseAddressOrThrow(raw);
        } catch (error) {
            if (error instanceof SansaParseError) {
                throw new SyntaxError(error.message, createSpan(start, end), 'SANSA address literal', raw);
            }
            throw error;
        }

        const canonical = renderAddress(address);
        return {
            type: 'SansaAddressLiteral',
            address,
            value: canonical,
            raw,
            canonical,
            span: createSpan(start, end),
        };
    }

    private collectSansaAddressSource(): { raw: string; end: Span['end'] } {
        let raw = '';
        let angleDepth = 0;
        let bracketDepth = 0;
        let parenDepth = 0;
        let end = this.peek().span.end;

        while (!this.isAtEnd()) {
            const token = this.peek();

            if (
                angleDepth === 0
                && bracketDepth === 0
                && parenDepth === 0
                && (
                    token.span.start.line > end.line
                    || token.type === TokenType.Comma
                    || token.type === TokenType.RightBrace
                    || token.type === TokenType.RightBracket
                    || token.type === TokenType.RightParen
                    || token.type === TokenType.Newline
                )
            ) {
                break;
            }

            raw += this.sansaTokenSource(token);
            end = token.span.end;

            switch (token.type) {
                case TokenType.LeftAngle:
                    angleDepth++;
                    break;
                case TokenType.RightAngle:
                    if (angleDepth > 0) angleDepth--;
                    break;
                case TokenType.LeftBracket:
                    bracketDepth++;
                    break;
                case TokenType.RightBracket:
                    if (bracketDepth > 0) bracketDepth--;
                    break;
                case TokenType.LeftParen:
                    parenDepth++;
                    break;
                case TokenType.RightParen:
                    if (parenDepth > 0) parenDepth--;
                    break;
            }

            this.advance();
        }

        return { raw, end };
    }

    private sansaTokenSource(token: Token): string {
        if (token.type === TokenType.String) {
            if (token.quote !== '"') {
                throw new SyntaxError(
                    'SANSA address quoted payloads must use double quotes',
                    token.span,
                    'double-quoted SANSA payload',
                    token.value
                );
            }
            return JSON.stringify(token.value);
        }
        return token.value;
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

        while (this.check(TokenType.Dot) || this.check(TokenType.LeftBracket)) {
            if (this.check(TokenType.Dot)) {
                this.advance(); // consume .
                if (this.check(TokenType.At)) {
                    this.advance(); // consume @
                    this.consume(TokenType.Dot, "Expected '.' after attribute address-space marker");
                    path.push(this.parseAttributePathSegment());
                } else if (this.check(TokenType.LeftBracket)) {
                    path.push(this.parseQuotedBracketMemberSegment());
                } else {
                    path.push(this.parseMemberSegment("Expected member path segment after '.'"));
                }
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
                if (token.value === 'NaN') {
                    this.advance();
                    return this.createNaNLiteral(token.value as 'NaN');
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
                if (token.value === '-' && this.peekNext()?.type === TokenType.Identifier && this.peekNext()?.value === 'NaN') {
                    const minus = this.advance();
                    const nan = this.advance();
                    return this.createNaNLiteral('-NaN', createSpan(minus.span.start, nan.span.end));
                }
                if (token.value === '!') {
                    return this.parseNullLiteral();
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
                return this.createToggleLiteral(token);

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

    private createNaNLiteral(raw: 'NaN' | '-NaN', span?: Span): NaNLiteral {
        return {
            type: 'NaNLiteral',
            value: raw,
            raw,
            span: span ?? this.previous().span,
        };
    }

    private parseNullLiteral(): NullLiteral {
        const bang = this.advance();
        const next = this.peek();

        if (next.type === TokenType.Identifier) {
            if (!RESERVED_NULL_SENTINELS.has(next.value)) {
                throw new ParserError(
                    `Invalid null sentinel '${next.value}'`,
                    createSpan(bang.span.start, next.span.end),
                    'INVALID_NULL_SENTINEL'
                );
            }
            const ident = this.advance();
            return {
                type: 'NullLiteral',
                mode: 'reserved',
                value: ident.value,
                raw: `!${ident.value}`,
                span: createSpan(bang.span.start, ident.span.end),
            };
        }

        if (next.type === TokenType.String) {
            const string = this.advance();
            const span = createSpan(bang.span.start, string.span.end);
            if (string.value.length === 0) {
                throw new ParserError('Null reason must not be empty', span, 'INVALID_NULL_REASON_EMPTY');
            }
            if (isAsciiWhitespaceOnly(string.value)) {
                throw new ParserError(
                    'Null reason must not be ASCII-whitespace-only',
                    span,
                    'INVALID_NULL_REASON_WHITESPACE'
                );
            }
            if (RESERVED_NULL_SENTINELS.has(string.value)) {
                throw new ParserError(
                    `Null reason collides with reserved sentinel '${string.value}'`,
                    span,
                    'INVALID_NULL_REASON_COLLISION'
                );
            }
            return {
                type: 'NullLiteral',
                mode: 'reason',
                value: string.value,
                raw: `!${JSON.stringify(string.value)}`,
                span,
            };
        }

        throw new ParserError(
            'Null literal must be followed by a reserved sentinel or quoted reason',
            bang.span,
            'INVALID_NULL_LITERAL'
        );
    }

    private createBooleanLiteral(token: Token): BooleanLiteral {
        return {
            type: 'BooleanLiteral',
            value: token.value.toLowerCase() === 'true',
            raw: token.value,
            span: token.span,
        };
    }

    private createToggleLiteral(token: Token): ToggleLiteral {
        const normalized = token.value.toLowerCase();
        if (normalized === 'yes' || normalized === 'no' || normalized === 'on' || normalized === 'off') {
            return {
                type: 'ToggleLiteral',
                value: normalized,
                raw: token.value,
                span: token.span,
            };
        }

        throw new SyntaxError(
            `Unexpected toggle literal '${token.value}'`,
            token.span,
            'toggle literal',
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

    private parseOptionalStructuralIdentity(): string | null {
        if (!this.check(TokenType.StructuralIdentity)) {
            return null;
        }

        const token = this.advance();
        const structuralId = token.value;
        if (this.structuralIdentities.has(structuralId)) {
            this.errors.push(new DuplicateStructuralIdentityError(structuralId, token.span));
        } else {
            this.structuralIdentities.set(structuralId, token.span);
        }
        return structuralId;
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
        if (this.isKeyToken(this.peek())) {
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
        const token = this.consumeKeyToken(message);
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

        const keyToken = this.consumeKeyToken("Expected attribute path segment");
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

    private synchronize(): void {
        this.advance();

        while (!this.isAtEnd()) {
            // If we see what looks like the start of a new binding, stop synchronizing
            if (this.isBareKeyToken(this.peek())) {
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

    private isBareKeyToken(token: Token): boolean {
        switch (token.type) {
            case TokenType.Identifier:
            case TokenType.True:
            case TokenType.False:
            case TokenType.Yes:
            case TokenType.No:
            case TokenType.On:
            case TokenType.Off:
                return true;
            default:
                return false;
        }
    }

    private isKeyToken(token: Token): boolean {
        return this.isBareKeyToken(token) || token.type === TokenType.String;
    }

    private consumeKeyToken(message: string): Token {
        const token = this.peek();
        if (!this.isKeyToken(token)) {
            throw new SyntaxError(message, token.span, 'key', token.value);
        }
        return this.advance();
    }
}

const GENERIC_V1_DATATYPES = new Set(['list', 'tuple', 'triple', 'object', 'node', 'null', 'nan', 'infinity']);
const RESERVED_NULL_SENTINELS = new Set(['none', 'notSet', 'notApplicable', 'tombstone']);
const RESERVED_ATTRIBUTE_KEYS = new Set(['@', '@items', '__proto__', 'constructor', 'prototype']);
const RESERVED_V1_DATATYPES = new Set([
    'n', 'number', 'int', 'int8', 'int16', 'int32', 'int64',
    'uint', 'uint8', 'uint16', 'uint32', 'uint64',
    'float', 'float32', 'float64',
    'string', 'trimtick', 'prose', 'boolean', 'bool', 'toggle', 'infinity', 'nan',
    'hex', 'date', 'time', 'datetime', 'wtc',
    'encoding', 'base64', 'embed', 'inline',
    'radix', 'decimal', 'radix2', 'radix6', 'radix8', 'radix12',
    'sep', 'kadot',
    'sansa',
    'tuple', 'triple', 'list', 'object', 'obj', 'envelope', 'o', 'node', 'null',
]);

/**
 * Parse AEON tokens into an AST
 */
export function parse(tokens: readonly Token[], options?: ParserOptions): ParseResult {
    const parser = new Parser(tokens, options);
    return parser.parse();
}

function isAsciiWhitespaceOnly(value: string): boolean {
    return /^[ \t\r\n]+$/.test(value);
}
