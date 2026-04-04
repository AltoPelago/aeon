import { tokenize, type LexerError } from '@aeon/lexer';
import { parse, type ParserError, type Document, type Binding, type Value, type TypeAnnotation, type Attribute, type AttributeValue } from '@aeon/parser';
import { formatReferencePath } from './reference-path.js';
import { formatDatatypeAnnotation } from './datatype.js';

export type CanonicalError = LexerError | ParserError;

export interface CanonicalResult {
    readonly text: string;
    readonly errors: readonly CanonicalError[];
}

export interface CanonicalizeOptions {
    /** Maximum number of separator specs in a datatype annotation. Default: 8. */
    readonly maxSeparatorDepth?: number;
    /** Maximum nesting depth for attribute heads. Default: 1. */
    readonly maxAttributeDepth?: number;
    /** Maximum nesting depth for nested generic type annotations. Default: 8. */
    readonly maxGenericDepth?: number;
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
        type: 'NumberLiteral',
        value: '1.0',
        raw: '1.0',
        span: { start: { line: 1, column: 1, offset: 0 }, end: { line: 1, column: 1, offset: 0 } },
    },
};

const CANONICAL_MAX_SEPARATOR_DEPTH = 8;
const CANONICAL_MAX_GENERIC_DEPTH = 8;

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

    const parsed = parse(lex.tokens, {
        maxAttributeDepth: options.maxAttributeDepth ?? 1,
        maxSeparatorDepth: options.maxSeparatorDepth ?? CANONICAL_MAX_SEPARATOR_DEPTH,
        maxGenericDepth: options.maxGenericDepth ?? CANONICAL_MAX_GENERIC_DEPTH,
    });
    if (parsed.errors.length > 0 || !parsed.document) {
        return { text: '', errors: parsed.errors };
    }

    const text = renderDocument(parsed.document);
    return { text, errors: [] };
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

function renderDocument(document: Document): string {
    const lines: string[] = [];
    lines.push(...renderHeader(document));

    const bindings = [...document.bindings].sort((a, b) => compareKeys(a.key, b.key));
    for (const binding of bindings) {
        lines.push(...renderBinding(binding, 0));
    }
    return `${lines.join('\n')}\n`;
}

function renderHeader(document: Document): string[] {
    const bindings = document.header
        ? [...document.header.bindings].sort((a, b) => compareKeys(a.key, b.key))
        : Object.entries(DEFAULT_HEADER)
            .map(([key, value]) => ({
                type: 'Binding' as const,
                key,
                value,
                datatype: null,
                attributes: [],
                span: value.span,
            }))
            .sort((a, b) => compareKeys(a.key, b.key));
    const lines: string[] = [];
    lines.push('aeon:header = {');
    for (const binding of bindings) {
        lines.push(...renderBinding(binding, 2));
    }
    lines.push('}');
    return lines;
}

function renderBinding(binding: Binding, indent: number): string[] {
    const prefix = ' '.repeat(indent);
    const key = `${formatBindingKey(binding.key)}${renderAttributes(binding.attributes)}${renderType(binding.datatype)}`;

    if (binding.value.type === 'ObjectNode') {
        return renderObjectBinding(prefix, key, binding.value, indent);
    }
    if (binding.value.type === 'ListNode') {
        return renderListBinding(prefix, key, binding.value, indent);
    }
    if (binding.value.type === 'TupleLiteral') {
        return renderTupleBinding(prefix, key, binding.value, indent);
    }
    if (binding.value.type === 'NodeLiteral') {
        return renderNodeBinding(prefix, key, binding.value, indent);
    }

    const valueLines = renderValue(binding.value, indent, { inlineOnly: true });
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
    indent: number
): string[] {
    const renderedNode = renderNodeValue(node, indent, { inlineOnly: false });
    if (renderedNode.length === 1) {
        return [`${prefix}${key} = ${(renderedNode[0] ?? '').trimStart()}`];
    }
    const [first, ...rest] = renderedNode;
    return [`${prefix}${key} = ${(first ?? '').trimStart()}`, ...rest];
}

function renderTupleBinding(prefix: string, key: string, tuple: Value, indent: number): string[] {
    const tupleNode = tuple as Extract<Value, { type: 'TupleLiteral' }>;
    const elements = tupleNode.elements;
    const simple = elements.every(isSimpleValue);
    if (simple) {
        const rendered = elements.map((element) => renderValue(element, indent + 1, { inlineOnly: true })[0]).join(', ');
        return [`${prefix}${key} = (${rendered})`];
    }

    const lines: string[] = [];
    lines.push(`${prefix}${key} = (`);
    elements.forEach((element, index) => {
        const itemLines = renderValue(element, indent + 2, { inlineOnly: false });
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

function renderObjectBinding(prefix: string, key: string, obj: Value, indent: number): string[] {
    const lines: string[] = [];
    lines.push(`${prefix}${key} = {`);
    const objectNode = obj as Extract<Value, { type: 'ObjectNode' }>;
    const sorted = [...objectNode.bindings].sort((a, b) => compareKeys(a.key, b.key));
    for (const binding of sorted) {
        lines.push(...renderBinding(binding, indent + 2));
    }
    lines.push(`${prefix}}`);
    return lines;
}

function renderListBinding(prefix: string, key: string, list: Value, indent: number): string[] {
    const listNode = list as Extract<Value, { type: 'ListNode' }>;
    const elements = listNode.elements;
    const simple = elements.every(isSimpleValue);
    if (simple) {
        const rendered = elements.map((element) => renderValue(element, indent + 1, { inlineOnly: true })[0]).join(', ');
        return [`${prefix}${key} = [${rendered}]`];
    }

    const lines: string[] = [];
    lines.push(`${prefix}${key} = [`);
    elements.forEach((element, index) => {
        const itemLines = renderValue(element, indent + 2, { inlineOnly: false });
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

function renderValue(value: Value, indent: number, opts: { inlineOnly: boolean }): string[] {
    const prefix = ' '.repeat(indent);
    switch (value.type) {
        case 'StringLiteral':
            return formatStringLines(value.value, indent);
        case 'NumberLiteral':
            return [formatNumber(value.raw)];
        case 'InfinityLiteral':
            return [value.raw];
        case 'BooleanLiteral':
            return [formatBoolean(value)];
        case 'SwitchLiteral':
            return [value.value];
        case 'HexLiteral':
            return [`#${value.value.replace(/_/g, '').toLowerCase()}`];
        case 'RadixLiteral':
            return [`%${value.value.replace(/_/g, '')}`];
        case 'EncodingLiteral':
            return [`$${formatEncoding(value.value)}`];
        case 'SeparatorLiteral':
            return [`^${formatSeparator(value.raw)}`];
        case 'DateLiteral':
        case 'DateTimeLiteral':
        case 'TimeLiteral':
            return [value.value];
        case 'CloneReference':
            return [`~${formatReferencePath(value.path)}`];
        case 'PointerReference':
            return [`~>${formatReferencePath(value.path)}`];
        case 'ObjectNode': {
            const lines: string[] = [];
            lines.push(`${prefix}{`.trimEnd());
            const sorted = [...value.bindings].sort((a, b) => compareKeys(a.key, b.key));
            for (const binding of sorted) {
                lines.push(...renderBinding(binding, indent + 2));
            }
            lines.push(`${prefix}}`.trimEnd());
            return lines;
        }
        case 'ListNode': {
            if (opts.inlineOnly && value.elements.every(isSimpleValue)) {
                const rendered = value.elements.map((el) => renderValue(el, indent + 1, { inlineOnly: true })[0]).join(', ');
                return [`[${rendered}]`];
            }
            const lines: string[] = [];
            lines.push(`${prefix}[`.trimEnd());
            value.elements.forEach((element, index) => {
                const itemLines = renderValue(element, indent + 2, { inlineOnly: false });
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
                const rendered = value.elements.map((el) => renderValue(el, indent + 1, { inlineOnly: true })[0]).join(', ');
                return [`(${rendered})`];
            }
            const lines: string[] = [];
            lines.push(`${prefix}(`.trimEnd());
            value.elements.forEach((element, index) => {
                const itemLines = renderValue(element, indent + 2, { inlineOnly: false });
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
            return renderNodeValue(value, indent, opts);
        default:
            return [''];
    }
}

function renderNodeValue(
    value: Extract<Value, { type: 'NodeLiteral' }>,
    indent: number,
    opts: { inlineOnly: boolean }
): string[] {
    const prefix = ' '.repeat(indent);
    const head = `<${value.tag}${renderAttributes(value.attributes)}${renderType(value.datatype)}`;
    const children = value.children;
    const simple = children.every(isSimpleValue);

    if (children.length === 0) {
        return [`${head}>`];
    }

    if (opts.inlineOnly && simple) {
        const rendered = children.map((child) => renderValue(child, indent + 1, { inlineOnly: true })[0]).join(', ');
        return [`${head}(${rendered})>`];
    }

    const lines: string[] = [];
    lines.push(`${prefix}${head}(`.trimEnd());
    children.forEach((child, index) => {
        const itemLines = renderValue(child, indent + 2, { inlineOnly: true });
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

function renderAttributes(attributes: readonly Attribute[]): string {
    if (!attributes || attributes.length === 0) return '';
    const entries = new Map<string, AttributeValue>();
    for (const attr of attributes) {
        for (const [key, value] of attr.entries) {
            entries.set(key, value);
        }
    }
    const sorted = Array.from(entries.entries()).sort(([a], [b]) => compareKeys(a, b));
    const rendered = sorted.map(([key, value]) => {
        const nestedAttributes = renderAttributes(value.attributes);
        const type = value.datatype ? renderType(value.datatype) : '';
        const formatted = renderValueInline(value.value);
        return `${formatBindingKey(key)}${nestedAttributes}${type} = ${formatted}`;
    });
    return `@{${rendered.join(', ')}}`;
}

function renderValueInline(value: Value): string {
    if (value.type === 'StringLiteral' && value.value.includes('\n')) {
        return formatString(value.value);
    }
    return renderCompactInlineValue(value);
}

function renderCompactInlineValue(value: Value): string {
    switch (value.type) {
        case 'StringLiteral':
            return formatString(value.value);
        case 'NumberLiteral':
            return formatNumber(value.raw);
        case 'InfinityLiteral':
            return value.raw;
        case 'BooleanLiteral':
            return formatBoolean(value);
        case 'SwitchLiteral':
            return value.value;
        case 'HexLiteral':
            return `#${value.value.replace(/_/g, '').toLowerCase()}`;
        case 'RadixLiteral':
            return `%${value.value.replace(/_/g, '')}`;
        case 'EncodingLiteral':
            return `$${formatEncoding(value.value)}`;
        case 'SeparatorLiteral':
            return `^${formatSeparator(value.raw)}`;
        case 'DateLiteral':
        case 'DateTimeLiteral':
        case 'TimeLiteral':
            return value.value;
        case 'CloneReference':
            return `~${formatReferencePath(value.path)}`;
        case 'PointerReference':
            return `~>${formatReferencePath(value.path)}`;
        case 'ObjectNode': {
            const sorted = [...value.bindings].sort((a, b) => compareKeys(a.key, b.key));
            const bindings = sorted.map((binding) => {
                const key = `${formatBindingKey(binding.key)}${renderAttributes(binding.attributes)}${renderType(binding.datatype)}`;
                return `${key} = ${renderCompactInlineValue(binding.value)}`;
            });
            return `{ ${bindings.join(', ')} }`;
        }
        case 'ListNode':
            return `[${value.elements.map((element) => renderCompactInlineValue(element)).join(', ')}]`;
        case 'TupleLiteral':
            return `(${value.elements.map((element) => renderCompactInlineValue(element)).join(', ')})`;
        case 'NodeLiteral': {
            const head = `<${value.tag}${renderAttributes(value.attributes)}${renderType(value.datatype)}`;
            if (value.children.length === 0) {
                return `${head}>`;
            }
            return `${head}(${value.children.map((child) => renderCompactInlineValue(child)).join(', ')})>`;
        }
        default:
            return renderValue(value, 0, { inlineOnly: true })[0] ?? '';
    }
}

function formatEncoding(value: string): string {
    return value.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '');
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

function formatStringLines(value: string, indent: number): string[] {
    if (!value.includes('\n')) {
        return [formatString(value)];
    }
    return formatTrimticks(value, indent);
}

function formatTrimticks(value: string, indent: number): string[] {
    const prefix = ' '.repeat(indent);
    const bodyPrefix = ' '.repeat(indent + 2);
    return [
        '>`',
        ...value.split('\n').map((line) => `${bodyPrefix}${line}`),
        `${prefix}\``,
    ];
}

function formatBoolean(value: Extract<Value, { type: 'BooleanLiteral' }>): string {
    return value.raw?.toLowerCase() === 'true' || value.raw?.toLowerCase() === 'false'
        ? value.raw.toLowerCase()
        : value.value ? 'true' : 'false';
}

function formatNumber(raw: string): string {
    let value = raw.replace(/_/g, '');
    value = value.replace(/E/g, 'e');
    if (value.startsWith('.')) value = `0${value}`;
    if (value.startsWith('-.')) value = value.replace('-.', '-0.');
    if (value.startsWith('+.')) value = value.replace('+.', '0.');
    if (value.startsWith('+') && /\d/.test(value[1] ?? '')) value = value.slice(1);
    const parts = value.split('e');
    let mantissa = parts[0] ?? '';
    let exponent = parts[1];

    if (mantissa.includes('.')) {
        const [intPart, fracPartRaw] = mantissa.split('.');
        let fracPart = trimTrailingZeros(fracPartRaw ?? '');
        if (fracPart.length === 0) {
            fracPart = '0';
        }
        if (exponent !== undefined && fracPart === '0') {
            mantissa = intPart ?? '';
        } else {
            mantissa = `${intPart ?? ''}.${fracPart}`;
        }
    }

    if (exponent !== undefined) {
        exponent = exponent.replace(/^\+/, '');
        exponent = exponent.replace(/^(-?)0+(\d)/, '$1$2');
        value = `${mantissa}e${exponent}`;
    } else {
        value = mantissa;
    }
    return value;
}

function trimTrailingZeros(value: string): string {
    let end = value.length;
    while (end > 0 && value[end - 1] === '0') {
        end -= 1;
    }
    return value.slice(0, end);
}

function formatSeparator(raw: string): string {
    const content = raw.startsWith('^') ? raw.slice(1) : raw;
    const parts: string[] = [];
    const seps: string[] = [];
    let current = '';
    let inQuote: string | null = null;

    for (let i = 0; i < content.length; i++) {
        const ch = content[i]!;
        if (ch === '"' || ch === "'") {
            if (inQuote === null) inQuote = ch;
            else if (inQuote === ch) inQuote = null;
            current += ch;
            continue;
        }

        if (inQuote === null && (ch === '|' || ch === ',' || ch === ';')) {
            parts.push(current.trim());
            seps.push(ch);
            current = '';
            continue;
        }

        current += ch;
    }
    parts.push(inQuote ? current : current.trim());

    let result = '';
    for (let i = 0; i < parts.length; i++) {
        result += parts[i]!;
        if (seps[i]) result += seps[i]!;
    }
    return result;
}

function isSimpleValue(value: Value): boolean {
    if (value.type === 'StringLiteral' && value.value.includes('\n')) {
        return false;
    }
    switch (value.type) {
        case 'StringLiteral':
        case 'NumberLiteral':
        case 'InfinityLiteral':
        case 'BooleanLiteral':
        case 'SwitchLiteral':
        case 'HexLiteral':
        case 'RadixLiteral':
        case 'EncodingLiteral':
        case 'SeparatorLiteral':
        case 'DateLiteral':
        case 'DateTimeLiteral':
        case 'CloneReference':
        case 'PointerReference':
            return true;
        default:
            return false;
    }
}
