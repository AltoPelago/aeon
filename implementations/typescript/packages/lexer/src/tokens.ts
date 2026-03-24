/**
 * Position in source code
 */
export interface Position {
    /** 1-indexed line number */
    readonly line: number;
    /** 1-indexed column number */
    readonly column: number;
    /** 0-indexed byte offset from start of input */
    readonly offset: number;
}

/**
 * Span representing a range in source code
 */
export interface Span {
    readonly start: Position;
    readonly end: Position;
}

/**
 * Token types for AEON lexer
 */
export enum TokenType {
    // Structural
    LeftBrace = 'LeftBrace',           // {
    RightBrace = 'RightBrace',         // }
    LeftBracket = 'LeftBracket',       // [
    RightBracket = 'RightBracket',     // ]
    LeftParen = 'LeftParen',           // (
    RightParen = 'RightParen',         // )
    LeftAngle = 'LeftAngle',           // <
    RightAngle = 'RightAngle',         // >

    // Operators
    Equals = 'Equals',                 // =
    Colon = 'Colon',                   // :
    Comma = 'Comma',                   // ,
    Dot = 'Dot',                       // .
    At = 'At',                         // @
    Tilde = 'Tilde',                   // ~
    TildeArrow = 'TildeArrow',         // ~>
    Caret = 'Caret',                   // ^
    Hash = 'Hash',                     // #
    Dollar = 'Dollar',                 // $
    Percent = 'Percent',               // %
    Ampersand = 'Ampersand',           // &
    Semicolon = 'Semicolon',           // ;

    // Literals
    String = 'String',
    Number = 'Number',
    HexLiteral = 'HexLiteral',         // #FF00AA
    RadixLiteral = 'RadixLiteral',     // %1011
    EncodingLiteral = 'EncodingLiteral', // $Base64...
    SeparatorLiteral = 'SeparatorLiteral', // ^content

    // Keywords
    True = 'True',
    False = 'False',
    Yes = 'Yes',
    No = 'No',
    On = 'On',
    Off = 'Off',

    // Identifiers
    Identifier = 'Identifier',
    Symbol = 'Symbol',

    // Date/Time
    Date = 'Date',
    DateTime = 'DateTime',
    Time = 'Time',

    // Comments
    LineComment = 'LineComment',
    BlockComment = 'BlockComment',

    // Whitespace/Control
    Newline = 'Newline',
    EOF = 'EOF',
}

export type CommentChannel = 'plain' | 'doc' | 'annotation' | 'hint' | 'reserved' | 'host';
export type CommentForm = 'line' | 'block';
export type ReservedCommentSubtype = 'structure' | 'profile' | 'instructions';

export interface CommentMetadata {
    readonly channel: CommentChannel;
    readonly form: CommentForm;
    readonly subtype?: ReservedCommentSubtype;
}

/**
 * Token produced by the lexer
 */
export interface Token {
    readonly type: TokenType;
    /** The raw text of the token */
    readonly value: string;
    /** Source location */
    readonly span: Span;
    /** Structured metadata for comment tokens */
    readonly comment?: CommentMetadata;
    /** String quote delimiter for TokenType.String */
    readonly quote?: '"' | "'" | '`';
}

/**
 * Create a position
 */
export function createPosition(line: number, column: number, offset: number): Position {
    return { line, column, offset };
}

/**
 * Create a span
 */
export function createSpan(start: Position, end: Position): Span {
    return { start, end };
}

/**
 * Create a token
 */
export function createToken(type: TokenType, value: string, span: Span, comment?: CommentMetadata): Token {
    if (comment) return { type, value, span, comment };
    return { type, value, span };
}
