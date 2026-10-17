import { tokenize, type LexerError } from '@altopelago/aeon-lexer';
import { normalizeNumberLiteral, parse, type ParserError, type Document, type Binding, type Value, type TypeAnnotation, type Attribute, type AttributeValue } from '@altopelago/aeon-parser';
import { formatReferencePath } from './reference-path.js';
import { formatDatatypeAnnotation } from './datatype.js';
import { emitEvents, resolvePaths, validateReferences, type EventEmissionError, type PathResolutionError, type ReferenceValidationError } from '@altopelago/aeon-aes';
import { CanonicalOrderingError, referenceSafeOrders, reorderDocument } from './ordering.js';

export { CanonicalOrderingError } from './ordering.js';

/** Canonicalize the interoperable Telex wire format; AEON source uses canonicalize(). */
export { canonicalizeTelex } from '@altopelago/aeon-aes';
export type { TelexLimitOptions, TelexRecord } from '@altopelago/aeon-aes';

interface ReferenceFormatter {
    readonly format: (path: Parameters<typeof formatReferencePath>[0]) => string;
    readonly referenceSafe: boolean;
}

export type CanonicalError = LexerError | ParserError | EventEmissionError | PathResolutionError | ReferenceValidationError | CanonicalOrderingError;

export interface CanonicalResult {
    readonly text: string;
    readonly errors: readonly CanonicalError[];
}

export interface CanonicalizeOptions {
    /** Canonical contract. Default: reference-safe-v1; lexical-v1 retains historical bytes. */
    readonly ordering?: 'lexical-v1' | 'reference-safe-v1';
    /** Maximum distinct projected dependency edges for reference-safe-v1. Default: 1,000,000. */
    readonly maxOrderingEdges?: number;
    /** Maximum clarifier values on one datatype descriptor. Default: 1. */
    readonly maxClarifierValues?: number;
    /** @deprecated Use maxClarifierValues. */
    readonly maxSeparatorDepth?: number;
    /** Maximum nesting depth for attribute heads. Default: 1. */
    readonly maxAttributeDepth?: number;
    /** Maximum nesting depth for nested generic type annotations. Default: 1. */
    readonly maxGenericDepth?: number;
    /** Maximum generic arguments on one datatype descriptor. Default: 32. */
    readonly maxGenericArguments?: number;
    /** Maximum aggregate components in one recursive datatype. Default: 64. */
    readonly maxDatatypeComponents?: number;
}

export interface EmitObjectOptions {
    readonly includeHeader?: boolean;
    readonly header?: Readonly<Record<string, string | number | boolean>>;
    readonly sortKeys?: boolean;
}

export interface EmitError {
    readonly code: 'UNSUPPORTED_VALUE' | 'INVALID_NUMBER';
    readonly path: string;
    readonly message: string;
}

export interface EmitResult {
    readonly text: string;
    readonly errors: readonly EmitError[];
}

const DEFAULT_HEADER: Record<string, Value> = {
    encoding: {
        type: 'StringLiteral',
        value: 'utf-8',
        raw: 'utf-8',
        delimiter: '"',
        span: { start: { line: 1, column: 1, offset: 0 }, end: { line: 1, column: 1, offset: 0 } },
    },
    mode: {
        type: 'StringLiteral',
        value: 'transport',
        raw: 'transport',
        delimiter: '"',
        span: { start: { line: 1, column: 1, offset: 0 }, end: { line: 1, column: 1, offset: 0 } },
    },
    profile: {
        type: 'StringLiteral',
        value: 'core',
        raw: 'core',
        delimiter: '"',
        span: { start: { line: 1, column: 1, offset: 0 }, end: { line: 1, column: 1, offset: 0 } },
    },
    version: {
        type: 'StringLiteral',
        value: '1.0',
        raw: '1.0',
        delimiter: '"',
        span: { start: { line: 1, column: 1, offset: 0 }, end: { line: 1, column: 1, offset: 0 } },
    },
};

function stripLeadingBom(input: string): string {
    return input.startsWith('\uFEFF') ? input.slice(1) : input;
}

function compareKeys(a: string, b: string): number {
    return a < b ? -1 : a > b ? 1 : 0;
}

export function canonicalize(input: string, options: CanonicalizeOptions = {}): CanonicalResult {
    input = stripLeadingBom(input);
    const lex = tokenize(input);
    if (lex.errors.length > 0) {
        return { text: '', errors: lex.errors };
    }

    const parserOptions = {
        maxAttributeDepth: options.maxAttributeDepth ?? 1,
        maxClarifierValues: options.maxClarifierValues ?? options.maxSeparatorDepth ?? 1,
        maxGenericDepth: options.maxGenericDepth ?? 1,
        maxGenericArguments: options.maxGenericArguments ?? 32,
        maxDatatypeComponents: options.maxDatatypeComponents ?? 64,
    };
    const parsed = parse(lex.tokens, parserOptions);
    if (parsed.errors.length > 0 || !parsed.document) {
        return { text: '', errors: parsed.errors };
    }

    const ordering = options.ordering ?? 'reference-safe-v1';
    if (ordering !== 'lexical-v1' && ordering !== 'reference-safe-v1') {
        return { text: '', errors: [new CanonicalOrderingError('CANONICAL_ORDERING_INVALID_OPTION', 'Unknown canonical ordering contract', parsed.document.span)] };
    }
    if (ordering === 'lexical-v1') {
        return { text: renderDocument(reorderDocument(parsed.document)), errors: [] };
    }
    const maxEdges = options.maxOrderingEdges ?? 1_000_000;
    if (!Number.isSafeInteger(maxEdges) || maxEdges < 0) {
        return { text: '', errors: [new CanonicalOrderingError('CANONICAL_ORDERING_INVALID_OPTION', 'maxOrderingEdges must be a non-negative safe integer', parsed.document.span)] };
    }
    // Core legality only: no reference evaluation, profile/schema approval,
    // or default header insertion before validating the authored document.
    const authoredErrors = referenceErrors(parsed.document, parserOptions.maxAttributeDepth);
    if (authoredErrors.length > 0) return { text: '', errors: authoredErrors };
    let text: string;
    try {
        const orders = referenceSafeOrders(parsed.document, maxEdges);
        text = renderDocument(reorderDocument(parsed.document, orders), {
            format: path => formatReferencePath(path, formatString), referenceSafe: true,
        });
    } catch (error) {
        if (!(error instanceof CanonicalOrderingError)) throw error;
        return { text: '', errors: [error] };
    }
    // Fail closed if rendering introduces any invalid reference or syntax.
    const emittedLex = tokenize(text);
    const emitted = parse(emittedLex.tokens, parserOptions);
    if (emittedLex.errors.length > 0 || emitted.errors.length > 0 || !emitted.document
        || referenceErrors(emitted.document, parserOptions.maxAttributeDepth).length > 0) {
        return { text: '', errors: [new CanonicalOrderingError('CANONICAL_ORDERING_CONFLICT', 'Canonical output failed Core reference validation', parsed.document.span)] };
    }
    return { text, errors: [] };
}

function referenceErrors(document: Document, maxAttributeDepth: number): readonly CanonicalError[] {
    const emitted = emitEvents(resolvePaths(document, { indexedPaths: true }));
    return emitted.errors.length > 0 ? emitted.errors : validateReferences(emitted.events, { maxAttributeDepth }).errors;
}

export function emitFromObject(
    object: Readonly<Record<string, unknown>>,
    options: EmitObjectOptions = {}
): EmitResult {
    const includeHeader = options.includeHeader ?? false;
    const sortKeys = options.sortKeys ?? true;
    const errors: EmitError[] = [];
    const lines: string[] = [];

    if (includeHeader) {
        const fields = options.header ?? {
            encoding: 'utf-8',
            mode: 'strict',
            profile: 'aeon.gp.profile.v1',
            version: 1,
        };
        lines.push(...renderHeaderFromObject(fields, sortKeys, errors));
    }

    lines.push(...renderObjectBindingsFromObject(object, 0, '$', sortKeys, errors));

    if (errors.length > 0) {
        return { text: '', errors };
    }
    return { text: lines.join('\n'), errors: [] };
}

function renderDocument(document: Document, referencePath: ReferenceFormatter = { format: formatReferencePath, referenceSafe: false }): string {
    const lines: string[] = [];
    lines.push(...renderHeader(document, referencePath));

    const bindings = document.bindings;
    for (const binding of bindings) {
        lines.push(...renderBinding(binding, 0, referencePath));
    }
    return `${lines.join('\n')}\n`;
}

function renderHeader(document: Document, referencePath: ReferenceFormatter): string[] {
    const bindings = document.header
        ? document.header.bindings
        : Object.entries(DEFAULT_HEADER)
            .map(([key, value]) => ({
                type: 'Binding' as const,
                key,
                structuralId: null,
                value,
                datatype: null,
                attributes: [],
                span: value.span,
            }))
            .sort((a, b) => compareKeys(a.key, b.key));
    const lines: string[] = [];
    lines.push('aeon:header = {');
    for (const binding of bindings) {
        lines.push(...renderBinding(binding, 2, referencePath));
    }
    lines.push('}');
    return lines;
}

function renderBinding(binding: Binding, indent: number, referencePath: ReferenceFormatter): string[] {
    const prefix = ' '.repeat(indent);
    const key = `${formatHeadKey(binding.key, binding, referencePath)}${renderStructuralId(binding.structuralId)}${renderAttributes(binding.attributes, referencePath)}${renderType(binding.datatype)}`;

    if (binding.value.type === 'ObjectNode') {
        return renderObjectBinding(prefix, key, binding.value, indent, referencePath);
    }
    if (binding.value.type === 'ListNode') {
        return renderListBinding(prefix, key, binding.value, indent, referencePath);
    }
    if (binding.value.type === 'TupleLiteral') {
        return renderTupleBinding(prefix, key, binding.value, indent, referencePath);
    }
    if (binding.value.type === 'NodeLiteral') {
        return renderNodeBinding(prefix, key, binding.value, indent, referencePath);
    }

    const valueLines = renderValue(binding.value, indent, { inlineOnly: true }, referencePath);
    if (valueLines.length === 1) {
        return [`${prefix}${key} = ${valueLines[0] ?? ''}`];
    }
    const [first, ...rest] = valueLines;
    return [`${prefix}${key} = ${first ?? ''}`, ...rest];
}

function renderNodeBinding(
    prefix: string,
    key: string,
    node: Extract<Value, { type: 'NodeLiteral' }>,
    indent: number,
    referencePath: ReferenceFormatter
): string[] {
    const renderedNode = renderNodeValue(node, indent, { inlineOnly: false }, referencePath);
    if (renderedNode.length === 1) {
        return [`${prefix}${key} = ${(renderedNode[0] ?? '').trimStart()}`];
    }
    const [first, ...rest] = renderedNode;
    return [`${prefix}${key} = ${(first ?? '').trimStart()}`, ...rest];
}

function renderTupleBinding(prefix: string, key: string, tuple: Value, indent: number, referencePath: ReferenceFormatter): string[] {
    const tupleNode = tuple as Extract<Value, { type: 'TupleLiteral' }>;
    const elements = tupleNode.elements;
    const simple = elements.every(isSimpleValue);
    if (simple) {
        const rendered = elements.map((element) => renderValue(element, indent + 1, { inlineOnly: true }, referencePath)[0]).join(', ');
        return [`${prefix}${key} = (${rendered})`];
    }

    const lines: string[] = [];
    lines.push(`${prefix}${key} = (`);
    elements.forEach((element, index) => {
        const itemLines = renderValue(element, indent + 2, { inlineOnly: false }, referencePath);
        if (itemLines.length > 0 && !(itemLines[0] ?? '').startsWith(' '.repeat(indent + 2))) {
            itemLines[0] = `${' '.repeat(indent + 2)}${itemLines[0] ?? ''}`;
        }
        const lastIndex = itemLines.length - 1;
        if (index < elements.length - 1 && lastIndex >= 0) {
            itemLines[lastIndex] = `${itemLines[lastIndex]},`;
        }
        lines.push(...itemLines);
    });
    lines.push(`${prefix})`);
    return lines;
}

function renderObjectBinding(prefix: string, key: string, obj: Value, indent: number, referencePath: ReferenceFormatter): string[] {
    const lines: string[] = [];
    lines.push(`${prefix}${key} = {`);
    const objectNode = obj as Extract<Value, { type: 'ObjectNode' }>;
    const sorted = objectNode.bindings;
    for (const binding of sorted) {
        lines.push(...renderBinding(binding, indent + 2, referencePath));
    }
    lines.push(`${prefix}}`);
    return lines;
}

function renderListBinding(prefix: string, key: string, list: Value, indent: number, referencePath: ReferenceFormatter): string[] {
    const listNode = list as Extract<Value, { type: 'ListNode' }>;
    const elements = listNode.elements;
    const simple = elements.every(isSimpleValue);
    if (simple) {
        const rendered = elements.map((element) => renderValue(element, indent + 1, { inlineOnly: true }, referencePath)[0]).join(', ');
        return [`${prefix}${key} = [${rendered}]`];
    }

    const lines: string[] = [];
    lines.push(`${prefix}${key} = [`);
    elements.forEach((element, index) => {
        const itemLines = renderValue(element, indent + 2, { inlineOnly: false }, referencePath);
        if (itemLines.length > 0 && !(itemLines[0] ?? '').startsWith(' '.repeat(indent + 2))) {
            itemLines[0] = `${' '.repeat(indent + 2)}${itemLines[0] ?? ''}`;
        }
        const lastIndex = itemLines.length - 1;
        if (index < elements.length - 1 && lastIndex >= 0) {
            itemLines[lastIndex] = `${itemLines[lastIndex]},`;
        }
        lines.push(...itemLines);
    });
    lines.push(`${prefix}]`);
    return lines;
}

function renderValue(value: Value, indent: number, opts: { inlineOnly: boolean }, referencePath: ReferenceFormatter): string[] {
    const prefix = ' '.repeat(indent);
    switch (value.type) {
        case 'TypedValue': {
            const rendered = renderValue(value.value, indent, opts, referencePath);
            const head = `${renderStructuralId(value.structuralId)}${renderAttributes(value.attributes, referencePath)}${renderType(value.datatype)}`;
            if (referencePath.referenceSafe && head === '') return rendered;
            if (rendered.length === 0) {
                return [`${head} = `];
            }
            // An attributed container already includes its layout indentation;
            // the enclosing sequence supplies the head's indentation. Keep
            // historical bytes unchanged outside the explicit new contract.
            const first = referencePath.referenceSafe ? (rendered[0] ?? '').trimStart() : (rendered[0] ?? '');
            return [`${head} = ${first}`, ...rendered.slice(1)];
        }
        case 'StringLiteral':
            return value.trimticks
                ? formatTrimticks(value.value, indent)
                : [formatString(value.value)];
        case 'NumberLiteral':
            return [formatNumber(value.raw)];
        case 'InfinityLiteral':
        case 'NaNLiteral':
            return [value.raw];
        case 'NullLiteral':
            return [formatNullLiteral(value)];
        case 'BooleanLiteral':
            return [formatBoolean(value)];
        case 'ToggleLiteral':
            return [value.value];
        case 'HexLiteral':
            return [`#${value.value.replace(/_/g, '').toLowerCase()}`];
        case 'RadixLiteral':
            return [`%${value.value.replace(/_/g, '')}`];
        case 'EncodingLiteral':
            return [`&${formatEncoding(value.value)}`];
        case 'SeparatorLiteral':
            return [`^${formatSeparator(value.raw)}`];
        case 'SymbolicLiteral':
            return [`|${formatSymbolic(value.value)}|`];
        case 'SansaAddressLiteral':
            return [value.canonical];
        case 'DateLiteral':
        case 'DateTimeLiteral':
        case 'TimeLiteral':
            return [value.value];
        case 'CloneReference':
            return [`~${referencePath.format(value.path)}`];
        case 'PointerReference':
            return [`~>${referencePath.format(value.path)}`];
        case 'ObjectNode': {
            const lines: string[] = [];
            lines.push(`${prefix}{`.trimEnd());
            const sorted = value.bindings;
            for (const binding of sorted) {
                lines.push(...renderBinding(binding, indent + 2, referencePath));
            }
            lines.push(`${prefix}}`.trimEnd());
            return lines;
        }
        case 'ListNode': {
            if (opts.inlineOnly && value.elements.every(isSimpleValue)) {
                const rendered = value.elements.map((el) => renderValue(el, indent + 1, { inlineOnly: true }, referencePath)[0]).join(', ');
                return [`[${rendered}]`];
            }
            const lines: string[] = [];
            lines.push(`${prefix}[`.trimEnd());
            value.elements.forEach((element, index) => {
                const itemLines = renderValue(element, indent + 2, { inlineOnly: false }, referencePath);
                if (itemLines.length > 0 && !(itemLines[0] ?? '').startsWith(' '.repeat(indent + 2))) {
                    itemLines[0] = `${' '.repeat(indent + 2)}${itemLines[0] ?? ''}`;
                }
                const lastIndex = itemLines.length - 1;
                if (index < value.elements.length - 1 && lastIndex >= 0) {
                    itemLines[lastIndex] = `${itemLines[lastIndex]},`;
                }
                lines.push(...itemLines);
            });
            lines.push(`${prefix}]`.trimEnd());
            return lines;
        }
        case 'TupleLiteral': {
            if (opts.inlineOnly && value.elements.every(isSimpleValue)) {
                const rendered = value.elements.map((el) => renderValue(el, indent + 1, { inlineOnly: true }, referencePath)[0]).join(', ');
                return [`(${rendered})`];
            }
            const lines: string[] = [];
            lines.push(`${prefix}(`.trimEnd());
            value.elements.forEach((element, index) => {
                const itemLines = renderValue(element, indent + 2, { inlineOnly: false }, referencePath);
                if (itemLines.length > 0 && !(itemLines[0] ?? '').startsWith(' '.repeat(indent + 2))) {
                    itemLines[0] = `${' '.repeat(indent + 2)}${itemLines[0] ?? ''}`;
                }
                const lastIndex = itemLines.length - 1;
                if (index < value.elements.length - 1 && lastIndex >= 0) {
                    itemLines[lastIndex] = `${itemLines[lastIndex]},`;
                }
                lines.push(...itemLines);
            });
            lines.push(`${prefix})`.trimEnd());
            return lines;
        }
        case 'NodeLiteral':
            return renderNodeValue(value, indent, opts, referencePath);
        default:
            return [''];
    }
}

function renderNodeValue(
    value: Extract<Value, { type: 'NodeLiteral' }>,
    indent: number,
    opts: { inlineOnly: boolean },
    referencePath: ReferenceFormatter
): string[] {
    const prefix = ' '.repeat(indent);
    const head = `<${formatHeadKey(value.tag, value, referencePath)}${renderStructuralId(value.structuralId)}${renderAttributes(value.attributes, referencePath)}${renderType(value.datatype)}`;
    const children = value.children;
    const simple = children.every(isSimpleValue);

    if (children.length === 0) {
        return [`${head}>`];
    }

    if (opts.inlineOnly && simple) {
        const rendered = children.map((child) => renderValue(child, indent + 1, { inlineOnly: true }, referencePath)[0]).join(', ');
        return [`${head}(${rendered})>`];
    }

    const lines: string[] = [];
    lines.push(`${prefix}${head}(`.trimEnd());
    children.forEach((child, index) => {
        const itemLines = renderValue(child, indent + 2, { inlineOnly: true }, referencePath);
        if (itemLines.length > 0 && !(itemLines[0] ?? '').startsWith(' '.repeat(indent + 2))) {
            itemLines[0] = `${' '.repeat(indent + 2)}${itemLines[0] ?? ''}`;
        }
        const lastIndex = itemLines.length - 1;
        if (index < children.length - 1 && lastIndex >= 0) {
            itemLines[lastIndex] = `${itemLines[lastIndex]},`;
        }
        lines.push(...itemLines);
    });
    lines.push(`${prefix})>`.trimEnd());
    return lines;
}

function renderType(datatype: TypeAnnotation | null): string {
    if (!datatype) return '';
    return formatDatatypeAnnotation(datatype);
}

function renderStructuralId(structuralId: string | null | undefined): string {
    return structuralId ? `\\${structuralId}\\` : '';
}

function renderAttributes(attributes: readonly Attribute[], referencePath: ReferenceFormatter): string {
    if (!attributes || attributes.length === 0) return '';
    const entries = new Map<string, AttributeValue>();
    for (const attr of attributes) {
        for (const [key, value] of attr.entries) {
            entries.set(key, value);
        }
    }
    const sorted = Array.from(entries.entries());
    // Empty heads carry no metadata and native Core does not retain their
    // presence. Normalize them away only for the experimental contract.
    if (referencePath.referenceSafe && sorted.length === 0) return '';
    const rendered = sorted.map(([key, value]) => {
        const nestedAttributes = renderAttributes(value.attributes, referencePath);
        const type = value.datatype ? renderType(value.datatype) : '';
        const formatted = renderValueInline(value.value, referencePath);
        return `${formatHeadKey(key, value, referencePath)}${renderStructuralId(value.structuralId)}${nestedAttributes}${type} = ${formatted}`;
    });
    return `@{${rendered.join(', ')}}`;
}

function renderValueInline(value: Value, referencePath: ReferenceFormatter): string {
    return renderCompactInlineValue(value, referencePath);
}

function renderCompactInlineValue(value: Value, referencePath: ReferenceFormatter): string {
    switch (value.type) {
        case 'TypedValue': {
            const head = `${renderStructuralId(value.structuralId)}${renderAttributes(value.attributes, referencePath)}${renderType(value.datatype)}`;
            const rendered = renderCompactInlineValue(value.value, referencePath);
            return referencePath.referenceSafe && head === '' ? rendered : `${head} = ${rendered}`;
        }
        case 'StringLiteral':
            return value.trimticks
                ? formatCompactTrimtick(value.value)
                : formatString(value.value);
        case 'NumberLiteral':
            return formatNumber(value.raw);
        case 'InfinityLiteral':
        case 'NaNLiteral':
            return value.raw;
        case 'NullLiteral':
            return formatNullLiteral(value);
        case 'BooleanLiteral':
            return formatBoolean(value);
        case 'ToggleLiteral':
            return value.value;
        case 'HexLiteral':
            return `#${value.value.replace(/_/g, '').toLowerCase()}`;
        case 'RadixLiteral':
            return `%${value.value.replace(/_/g, '')}`;
        case 'EncodingLiteral':
            return `&${formatEncoding(value.value)}`;
        case 'SeparatorLiteral':
            return `^${formatSeparator(value.raw)}`;
        case 'SymbolicLiteral':
            return `|${formatSymbolic(value.value)}|`;
        case 'SansaAddressLiteral':
            return value.canonical;
        case 'DateLiteral':
        case 'DateTimeLiteral':
        case 'TimeLiteral':
            return value.value;
        case 'CloneReference':
            return `~${referencePath.format(value.path)}`;
        case 'PointerReference':
            return `~>${referencePath.format(value.path)}`;
        case 'ObjectNode': {
            const sorted = value.bindings;
            const bindings = sorted.map((binding) => {
                const key = `${formatHeadKey(binding.key, binding, referencePath)}${renderStructuralId(binding.structuralId)}${renderAttributes(binding.attributes, referencePath)}${renderType(binding.datatype)}`;
                return `${key} = ${renderCompactInlineValue(binding.value, referencePath)}`;
            });
            return `{ ${bindings.join(', ')} }`;
        }
        case 'ListNode':
            return `[${value.elements.map((element) => renderCompactInlineValue(element, referencePath)).join(', ')}]`;
        case 'TupleLiteral':
            return `(${value.elements.map((element) => renderCompactInlineValue(element, referencePath)).join(', ')})`;
        case 'NodeLiteral': {
            const head = `<${formatHeadKey(value.tag, value, referencePath)}${renderStructuralId(value.structuralId)}${renderAttributes(value.attributes, referencePath)}${renderType(value.datatype)}`;
            if (value.children.length === 0) {
                return `${head}>`;
            }
            return `${head}(${value.children.map((child) => renderCompactInlineValue(child, referencePath)).join(', ')})>`;
        }
        default:
            return renderValue(value, 0, { inlineOnly: true }, referencePath)[0] ?? '';
    }
}

function formatEncoding(value: string): string {
    return value;
}

function renderHeaderFromObject(
    header: Readonly<Record<string, string | number | boolean>>,
    sortKeys: boolean,
    errors: EmitError[]
): string[] {
    const keys = Object.keys(header);
    if (sortKeys) {
        keys.sort(compareKeys);
    }
    const lines: string[] = [];
    lines.push('aeon:header = {');
    for (const key of keys) {
        const value = header[key];
        const rendered = renderScalarFromObject(value, `$.aeon:header.${key}`, errors);
        if (rendered === null) {
            continue;
        }
        lines.push(`  ${formatBindingKey(key)} = ${rendered}`);
    }
    lines.push('}');
    return lines;
}

function renderObjectBindingsFromObject(
    object: Readonly<Record<string, unknown>>,
    indent: number,
    path: string,
    sortKeys: boolean,
    errors: EmitError[]
): string[] {
    const keys = Object.keys(object);
    if (sortKeys) {
        keys.sort(compareKeys);
    }
    const lines: string[] = [];
    for (const key of keys) {
        const value = object[key];
        if (value === undefined) {
            errors.push({
                code: 'UNSUPPORTED_VALUE',
                path: `${path}.${key}`,
                message: `Unsupported value type for key "${key}": undefined`,
            });
            continue;
        }
        const rendered = renderObjectValue(value, indent, `${path}.${key}`, sortKeys, errors);
        if (rendered === null) {
            continue;
        }
        const prefix = ' '.repeat(indent);
        if (rendered.length === 1) {
            lines.push(`${prefix}${formatBindingKey(key)} = ${rendered[0] ?? ''}`);
            continue;
        }
        lines.push(`${prefix}${formatBindingKey(key)} = ${rendered[0] ?? ''}`);
        lines.push(...rendered.slice(1));
    }
    return lines;
}

function renderObjectValue(
    value: unknown,
    indent: number,
    path: string,
    sortKeys: boolean,
    errors: EmitError[]
): string[] | null {
    const scalar = renderScalarFromObject(value, path, errors);
    if (scalar !== null) {
        return [scalar];
    }

    if (Array.isArray(value)) {
        if (value.every((item) => isScalarObjectValue(item))) {
            const renderedItems: string[] = [];
            for (let i = 0; i < value.length; i++) {
                const rendered = renderScalarFromObject(value[i], `${path}[${i}]`, errors);
                if (rendered === null) {
                    return null;
                }
                renderedItems.push(rendered);
            }
            return [`[${renderedItems.join(', ')}]`];
        }

        const prefix = ' '.repeat(indent);
        const lines: string[] = [];
        lines.push('[');
        for (let i = 0; i < value.length; i++) {
            const itemLines = renderObjectValue(value[i], indent + 2, `${path}[${i}]`, sortKeys, errors);
            if (itemLines === null) {
                return null;
            }
            if (itemLines.length === 1) {
                const suffix = i < value.length - 1 ? ',' : '';
                lines.push(`${' '.repeat(indent + 2)}${itemLines[0] ?? ''}${suffix}`);
                continue;
            }
            lines.push(`${' '.repeat(indent + 2)}${itemLines[0] ?? ''}`);
            for (let j = 1; j < itemLines.length; j++) {
                lines.push(itemLines[j] ?? '');
            }
            if (i < value.length - 1) {
                const idx = lines.length - 1;
                lines[idx] = `${lines[idx] ?? ''},`;
            }
        }
        lines.push(`${prefix}]`);
        return lines;
    }

    if (isPlainObject(value)) {
        const keys = Object.keys(value);
        if (sortKeys) {
            keys.sort(compareKeys);
        }
        const prefix = ' '.repeat(indent);
        const lines: string[] = [];
        lines.push('{');
        for (const key of keys) {
            const child = value[key];
            if (child === undefined) {
                errors.push({
                    code: 'UNSUPPORTED_VALUE',
                    path: `${path}.${key}`,
                    message: `Unsupported value type for key "${key}": undefined`,
                });
                return null;
            }
            const childLines = renderObjectValue(child, indent + 2, `${path}.${key}`, sortKeys, errors);
            if (childLines === null) {
                return null;
            }
            const entryPrefix = `${' '.repeat(indent + 2)}${formatBindingKey(key)} = `;
            if (childLines.length === 1) {
                lines.push(`${entryPrefix}${childLines[0] ?? ''}`);
                continue;
            }
            lines.push(`${entryPrefix}${childLines[0] ?? ''}`);
            lines.push(...childLines.slice(1));
        }
        lines.push(`${prefix}}`);
        return lines;
    }

    return null;
}

function renderScalarFromObject(value: unknown, path: string, errors: EmitError[]): string | null {
    if (typeof value === 'string') {
        return formatString(value);
    }
    if (typeof value === 'boolean') {
        return value ? 'true' : 'false';
    }
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) {
            errors.push({
                code: 'INVALID_NUMBER',
                path,
                message: `Invalid number at ${path}: only finite numbers can be emitted to AEON`,
            });
            return null;
        }
        return formatNumber(String(value));
    }
    if (value === null) {
        errors.push({
            code: 'UNSUPPORTED_VALUE',
            path,
            message: `Unsupported value type at ${path}: null`,
        });
        return null;
    }
    return null;
}

function formatBindingKey(key: string): string {
    return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key) ? key : formatString(key);
}

function formatHeadKey(key: string, head: Pick<Binding, 'structuralId' | 'attributes' | 'datatype'>, contract: ReferenceFormatter): string {
    // `aeon:` is lexed as a namespace token, not a key followed by a type.
    // Only emitted head components can separate it; empty attributes vanish.
    const hasAttributes = head.attributes.some(attribute => attribute.entries.size > 0);
    return contract.referenceSafe && key === 'aeon' && head.datatype !== null && !head.structuralId && !hasAttributes
        ? formatString(key) : formatBindingKey(key);
}

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}

function isScalarObjectValue(value: unknown): boolean {
    return typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number';
}

function formatString(value: string): string {
    let out = '';
    for (let i = 0; i < value.length; i++) {
        const ch = value[i]!;
        switch (ch) {
            case '"':
                out += '\\"';
                break;
            case '\\':
                out += '\\\\';
                break;
            case '\n':
                out += '\\n';
                break;
            case '\r':
                out += '\\r';
                break;
            case '\t':
                out += '\\t';
                break;
            default: {
                const code = ch.charCodeAt(0);
                if (code < 0x20) {
                    out += `\\u${code.toString(16).padStart(4, '0')}`;
                } else {
                    out += ch;
                }
                break;
            }
        }
    }
    return `"${out}"`;
}

function formatTrimticks(value: string, indent: number): string[] {
    if (!value.includes('\n')) {
        return [formatCompactTrimtick(value)];
    }
    const nonblank = value.split('\n').filter((line) => line.length > 0);
    if (nonblank.length > 0 && nonblank.every((line) => line.startsWith(' '))) {
        return [formatCompactTrimtick(value)];
    }
    const prefix = ' '.repeat(indent);
    const bodyPrefix = ' '.repeat(indent + 2);
    return [
        '>`',
        ...value.split('\n').map((line) => `${bodyPrefix}${formatTrimtickLine(line)}`),
        `${prefix}\``,
    ];
}

function formatCompactTrimtick(value: string): string {
    if (!value.includes('\n')) {
        return `>\`${formatTrimtickLine(value)}\``;
    }
    const firstNonblank = value.split('\n').find((line) => line.length > 0) ?? '';
    const gutter = firstNonblank.startsWith(' ') ? '\t' : ' ';
    let protectedValue = value
        .split('\n')
        .map((line) => line.length === 0 ? '' : `${gutter}${line}`)
        .join('\n');
    if (value.startsWith('\n')) protectedValue = `\n${protectedValue}`;
    return `>\`${formatTrimtickLine(protectedValue)}\``;
}

function formatTrimtickLine(value: string): string {
    let out = '';
    for (const ch of value) {
        switch (ch) {
            case '\\': out += '\\\\'; break;
            case '`': out += '\\`'; break;
            case '\n': out += '\\n'; break;
            case '\r': out += '\\r'; break;
            case '\t': out += '\\t'; break;
            default: {
                const code = ch.codePointAt(0)!;
                out += code < 0x20 ? `\\u${code.toString(16).padStart(4, '0')}` : ch;
                break;
            }
        }
    }
    return out;
}

function formatBoolean(value: Extract<Value, { type: 'BooleanLiteral' }>): string {
    return value.raw?.toLowerCase() === 'true' || value.raw?.toLowerCase() === 'false'
        ? value.raw.toLowerCase()
        : value.value ? 'true' : 'false';
}

function formatNullLiteral(value: Extract<Value, { type: 'NullLiteral' }>): string {
    return value.mode === 'reserved' ? `!${value.value}` : `!${formatString(value.value)}`;
}

function formatNumber(raw: string): string {
    return normalizeNumberLiteral(raw);
}

function formatSeparator(raw: string): string {
    return raw.startsWith('^') ? raw.slice(1) : raw;
}

function formatSymbolic(value: string): string {
    let out = '';
    for (const ch of value) {
        switch (ch) {
            case '|': out += '\\|'; break;
            case '\\': out += '\\\\'; break;
            case '\n': out += '\\n'; break;
            case '\r': out += '\\r'; break;
            case '\t': out += '\\t'; break;
            default: {
                const code = ch.charCodeAt(0);
                out += code < 0x20 ? `\\u${code.toString(16).padStart(4, '0')}` : ch;
            }
        }
    }
    return out;
}

function isSimpleValue(value: Value): boolean {
    if (value.type === 'StringLiteral' && value.trimticks && value.value.includes('\n')) {
        return false;
    }
    if (value.type === 'TypedValue') {
        return isSimpleValue(value.value);
    }
    switch (value.type) {
        case 'StringLiteral':
        case 'NumberLiteral':
        case 'InfinityLiteral':
        case 'NaNLiteral':
        case 'NullLiteral':
        case 'BooleanLiteral':
        case 'ToggleLiteral':
        case 'HexLiteral':
        case 'RadixLiteral':
        case 'EncodingLiteral':
        case 'SeparatorLiteral':
        case 'SymbolicLiteral':
        case 'SansaAddressLiteral':
        case 'DateLiteral':
        case 'DateTimeLiteral':
        case 'TimeLiteral':
        case 'CloneReference':
        case 'PointerReference':
            return true;
        default:
            return false;
    }
}
