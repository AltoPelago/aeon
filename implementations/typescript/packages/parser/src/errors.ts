import type { Span } from '@altopelago/aeon-lexer';

/**
 * Base class for parser errors
 */
export class ParserError extends Error {
    readonly span: Span;
    readonly code: string;

    constructor(message: string, span: Span, code: string = 'PARSER_ERROR') {
        super(message);
        this.name = 'ParserError';
        this.span = span;
        this.code = code;
    }
}

/**
 * Syntax error - unexpected token or missing expected token
 */
export class SyntaxError extends ParserError {
    readonly expected: string | null;
    readonly found: string;

    constructor(message: string, span: Span, expected: string | null, found: string) {
        super(message, span, 'SYNTAX_ERROR');
        this.name = 'SyntaxError';
        this.expected = expected;
        this.found = found;
    }
}

export class InvalidSeparatorCharError extends ParserError {
    readonly value: string;

    constructor(value: string, span: Span) {
        super(`Invalid separator character '${value}'`, span, 'INVALID_SEPARATOR_CHAR');
        this.name = 'InvalidSeparatorCharError';
        this.value = value;
    }
}

export class ClarifierValuesExceededError extends ParserError {
    readonly observedValues: number;
    readonly limit: number;

    constructor(observedValues: number, limit: number, span: Span) {
        super(
            `Clarifier value count ${observedValues} exceeds max_clarifier_values ${limit}`,
            span,
            'CLARIFIER_VALUES_EXCEEDED'
        );
        this.name = 'ClarifierValuesExceededError';
        this.observedValues = observedValues;
        this.limit = limit;
    }
}

/** @deprecated Use ClarifierValuesExceededError. */
export { ClarifierValuesExceededError as SeparatorDepthExceededError };

export class GenericDepthExceededError extends ParserError {
    readonly observedDepth: number;
    readonly limit: number;

    constructor(observedDepth: number, limit: number, span: Span) {
        super(
            `Generic depth ${observedDepth} exceeds max_generic_depth ${limit}`,
            span,
            'GENERIC_DEPTH_EXCEEDED'
        );
        this.name = 'GenericDepthExceededError';
        this.observedDepth = observedDepth;
        this.limit = limit;
    }
}

export class GenericArgumentsExceededError extends ParserError {
    readonly observedArguments: number;
    readonly limit: number;

    constructor(observedArguments: number, limit: number, span: Span) {
        super(
            `Generic argument count ${observedArguments} exceeds max_generic_arguments ${limit}`,
            span,
            'GENERIC_ARGUMENTS_EXCEEDED'
        );
        this.name = 'GenericArgumentsExceededError';
        this.observedArguments = observedArguments;
        this.limit = limit;
    }
}

export class DatatypeComponentsExceededError extends ParserError {
    readonly observedComponents: number;
    readonly limit: number;

    constructor(observedComponents: number, limit: number, span: Span) {
        super(
            `Datatype component count ${observedComponents} exceeds max_datatype_components ${limit}`,
            span,
            'DATATYPE_COMPONENTS_EXCEEDED'
        );
        this.name = 'DatatypeComponentsExceededError';
        this.observedComponents = observedComponents;
        this.limit = limit;
    }
}

export class AttributeDepthExceededError extends ParserError {
    readonly observedDepth: number;
    readonly limit: number;

    constructor(observedDepth: number, limit: number, span: Span) {
        super(
            `Attribute depth ${observedDepth} exceeds max_attribute_depth ${limit}`,
            span,
            'ATTRIBUTE_DEPTH_EXCEEDED'
        );
        this.name = 'AttributeDepthExceededError';
        this.observedDepth = observedDepth;
        this.limit = limit;
    }
}

export class NestingDepthExceededError extends ParserError {
    readonly observedDepth: number;
    readonly limit: number;

    constructor(observedDepth: number, limit: number, span: Span) {
        super(
            `Value nesting depth ${observedDepth} exceeds max_value_nesting_depth ${limit}`,
            span,
            'NESTING_DEPTH_EXCEEDED'
        );
        this.name = 'NestingDepthExceededError';
        this.observedDepth = observedDepth;
        this.limit = limit;
    }
}

/**
 * Duplicate key error
 */
export class DuplicateKeyError extends ParserError {
    readonly key: string;
    readonly path?: string;

    constructor(key: string, span: Span, path?: string) {
        super(`Duplicate key: '${key}'`, span, 'DUPLICATE_KEY');
        this.name = 'DuplicateKeyError';
        this.key = key;
        if (path !== undefined) {
            this.path = path;
        }
    }
}

export class DuplicateStructuralIdentityError extends ParserError {
    readonly structuralId: string;

    constructor(structuralId: string, span: Span) {
        super(`Duplicate structural identity: '${structuralId}'`, span, 'DUPLICATE_STRUCTURAL_IDENTITY');
        this.name = 'DuplicateStructuralIdentityError';
        this.structuralId = structuralId;
    }
}

/**
 * Profile error - feature requires profile that is not enabled
 */
export class ProfileError extends ParserError {
    readonly feature: string;

    constructor(feature: string, span: Span) {
        super(`Feature '${feature}' requires a profile that is not enabled`, span, 'PROFILE_ERROR');
        this.name = 'ProfileError';
        this.feature = feature;
    }
}

/**
 * Reference error - invalid reference
 */
export class ReferenceError extends ParserError {
    readonly path: string;

    constructor(message: string, path: string, span: Span) {
        super(message, span, 'REFERENCE_ERROR');
        this.name = 'ReferenceError';
        this.path = path;
    }
}

/**
 * Type error - type mismatch
 */
export class TypeError extends ParserError {
    constructor(message: string, span: Span) {
        super(message, span, 'TYPE_ERROR');
        this.name = 'TypeError';
    }
}
