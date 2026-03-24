import type { Span } from './tokens.js';

/**
 * Base class for all lexer errors
 */
export class LexerError extends Error {
    readonly span: Span;
    readonly code: string;

    constructor(message: string, span: Span, code: string = 'LEXER_ERROR') {
        super(message);
        this.name = 'LexerError';
        this.span = span;
        this.code = code;
    }
}

/**
 * Unexpected character encountered
 */
export class UnexpectedCharacterError extends LexerError {
    readonly character: string;

    constructor(character: string, span: Span) {
        super(`Unexpected character: '${character}'`, span, 'UNEXPECTED_CHARACTER');
        this.name = 'UnexpectedCharacterError';
        this.character = character;
    }
}

/**
 * Unterminated string literal
 */
export class UnterminatedStringError extends LexerError {
    readonly delimiter: string;

    constructor(delimiter: string, span: Span) {
        super(`Unterminated string literal (started with ${delimiter})`, span, 'UNTERMINATED_STRING');
        this.name = 'UnterminatedStringError';
        this.delimiter = delimiter;
    }
}

/**
 * Invalid escape sequence
 */
export class InvalidEscapeSequenceError extends LexerError {
    readonly sequence: string;

    constructor(sequence: string, span: Span) {
        super(`Invalid escape sequence: '${sequence}'`, span, 'INVALID_ESCAPE');
        this.name = 'InvalidEscapeSequenceError';
        this.sequence = sequence;
    }
}

/**
 * Invalid number literal
 */
export class InvalidNumberError extends LexerError {
    readonly raw: string;

    constructor(raw: string, span: Span) {
        super(`Invalid number literal: '${raw}'`, span, 'INVALID_NUMBER');
        this.name = 'InvalidNumberError';
        this.raw = raw;
    }
}

export class InvalidTimeError extends LexerError {
    readonly raw: string;

    constructor(raw: string, span: Span) {
        super(`Invalid time literal: '${raw}'`, span, 'INVALID_TIME');
        this.name = 'InvalidTimeError';
        this.raw = raw;
    }
}

export class InvalidDateError extends LexerError {
    readonly raw: string;

    constructor(raw: string, span: Span) {
        super(`Invalid date literal: '${raw}'`, span, 'INVALID_DATE');
        this.name = 'InvalidDateError';
        this.raw = raw;
    }
}

export class InvalidDateTimeError extends LexerError {
    readonly raw: string;

    constructor(raw: string, span: Span) {
        super(`Invalid datetime literal: '${raw}'`, span, 'INVALID_DATETIME');
        this.name = 'InvalidDateTimeError';
        this.raw = raw;
    }
}

/**
 * Unterminated block comment
 */
export class UnterminatedBlockCommentError extends LexerError {
    constructor(span: Span) {
        super('Unterminated block comment', span, 'UNTERMINATED_BLOCK_COMMENT');
        this.name = 'UnterminatedBlockCommentError';
    }
}
