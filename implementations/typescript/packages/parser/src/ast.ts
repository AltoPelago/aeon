import type { Span } from '@aeon/lexer';
import type { TrimtickMetadata } from './trimticks.js';

/**
 * Base node interface
 */
export interface ASTNode {
    readonly span: Span;
}

/**
 * AEON Document
 */
export interface Document extends ASTNode {
    readonly type: 'Document';
    readonly header: Header | null;
    readonly bindings: readonly Binding[];
    readonly envelope: Envelope | null;
}

/**
 * Document header
 */
export interface Header extends ASTNode {
    readonly type: 'Header';
    readonly form: 'structured' | 'shorthand';
    /** Whether a structured header (aeon:header = {...}) was present */
    readonly hasStructured: boolean;
    /** Whether any shorthand header fields (aeon:mode = ...) were present */
    readonly hasShorthand: boolean;
    /** Full header bindings preserved for canonicalization and structural tooling */
    readonly bindings: readonly Binding[];
    readonly fields: ReadonlyMap<string, Value>;
}

/**
 * Binding (key = value)
 */
export interface Binding extends ASTNode {
    readonly type: 'Binding';
    readonly key: string;
    readonly value: Value;
    readonly datatype: TypeAnnotation | null;
    readonly attributes: readonly Attribute[];
}

/**
 * Type annotation
 */
export interface TypeAnnotation extends ASTNode {
    readonly type: 'TypeAnnotation';
    readonly name: string;
    readonly genericArgs: readonly string[];
    readonly separators: readonly string[];
}

/**
 * Attribute (@{...})
 */
export interface Attribute extends ASTNode {
    readonly type: 'Attribute';
    readonly entries: ReadonlyMap<string, AttributeValue>;
}

/**
 * Attribute value (may have its own type annotation)
 */
export interface AttributeValue {
    readonly value: Value;
    readonly datatype: TypeAnnotation | null;
    readonly attributes: readonly Attribute[];
}

/**
 * Envelope binding metadata
 */
export interface Envelope extends ASTNode {
    readonly type: 'Envelope';
    readonly fields: ReadonlyMap<string, Value>;
}

/**
 * Value union type
 */
export type Value =
    | StringLiteral
    | NumberLiteral
    | InfinityLiteral
    | BooleanLiteral
    | SwitchLiteral
    | HexLiteral
    | RadixLiteral
    | EncodingLiteral
    | SeparatorLiteral
    | DateLiteral
    | DateTimeLiteral
    | TimeLiteral
    | ObjectNode
    | ListNode
    | TupleLiteral
    | NodeLiteral
    | CloneReference
    | PointerReference;

/**
 * String literal
 */
export interface StringLiteral extends ASTNode {
    readonly type: 'StringLiteral';
    readonly value: string;
    readonly raw: string;
    readonly delimiter: '"' | "'" | '`';
    readonly trimticks?: TrimtickMetadata;
}

/**
 * Number literal
 */
export interface NumberLiteral extends ASTNode {
    readonly type: 'NumberLiteral';
    readonly value: string;
    readonly raw: string;
}

/**
 * Infinity literal
 */
export interface InfinityLiteral extends ASTNode {
    readonly type: 'InfinityLiteral';
    readonly value: 'Infinity' | '-Infinity';
    readonly raw: 'Infinity' | '-Infinity';
}

/**
 * Boolean literal
 */
export interface BooleanLiteral extends ASTNode {
    readonly type: 'BooleanLiteral';
    readonly value: boolean;
    readonly raw: string;
}

/**
 * Switch literal (yes/no/on/off)
 */
export interface SwitchLiteral extends ASTNode {
    readonly type: 'SwitchLiteral';
    readonly value: 'yes' | 'no' | 'on' | 'off';
    readonly raw: string;
}

/**
 * Hex literal (#FF00AA)
 */
export interface HexLiteral extends ASTNode {
    readonly type: 'HexLiteral';
    readonly value: string;
    readonly raw: string;
}

/**
 * Radix literal (%1011)
 */
export interface RadixLiteral extends ASTNode {
    readonly type: 'RadixLiteral';
    readonly value: string;
    readonly raw: string;
}

/**
 * Encoding literal ($Base64...)
 */
export interface EncodingLiteral extends ASTNode {
    readonly type: 'EncodingLiteral';
    readonly value: string;
    readonly raw: string;
}

/**
 * Separator literal (^content)
 */
export interface SeparatorLiteral extends ASTNode {
    readonly type: 'SeparatorLiteral';
    readonly value: string;
    readonly raw: string;
}

/**
 * Date literal
 */
export interface DateLiteral extends ASTNode {
    readonly type: 'DateLiteral';
    readonly value: string;
    readonly raw: string;
}

/**
 * DateTime literal (including ZRUT)
 */
export interface DateTimeLiteral extends ASTNode {
    readonly type: 'DateTimeLiteral';
    readonly value: string;
    readonly raw: string;
}

/**
 * Time literal
 */
export interface TimeLiteral extends ASTNode {
    readonly type: 'TimeLiteral';
    readonly value: string;
    readonly raw: string;
}

/**
 * Object node
 */
export interface ObjectNode extends ASTNode {
    readonly type: 'ObjectNode';
    readonly bindings: readonly Binding[];
    readonly attributes: readonly Attribute[];
}

/**
 * List node
 */
export interface ListNode extends ASTNode {
    readonly type: 'ListNode';
    readonly elements: readonly Value[];
    readonly attributes: readonly Attribute[];
}

/**
 * Tuple node
 */
export interface TupleLiteral extends ASTNode {
    readonly type: 'TupleLiteral';
    readonly elements: readonly Value[];
    readonly attributes: readonly Attribute[];
    readonly raw: string;
}

/**
 * Node literal (<tag(...)>)
 */
export interface NodeLiteral extends ASTNode {
    readonly type: 'NodeLiteral';
    readonly tag: string;
    readonly attributes: readonly Attribute[];
    readonly datatype: TypeAnnotation | null;
    readonly children: readonly Value[];
}

/**
 * Clone reference (~path)
 */
export interface CloneReference extends ASTNode {
    readonly type: 'CloneReference';
    readonly path: readonly ReferencePathSegment[];
}

/**
 * Pointer reference (~>path)
 */
export interface PointerReference extends ASTNode {
    readonly type: 'PointerReference';
    readonly path: readonly ReferencePathSegment[];
}

export interface ReferenceAttrSegment {
    readonly type: 'attr';
    readonly key: string;
}

/**
 * Reference path segment (member, index, and attribute segments)
 */
export type ReferencePathSegment = string | number | ReferenceAttrSegment;
