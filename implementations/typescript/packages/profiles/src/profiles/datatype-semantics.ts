import { aeonRadixBaseFromNumber, formatPath, type AesNumberLiteral, type AssignmentEvent, type AttributeEntry, type TypeAnnotation } from '@altopelago/aeon-aes';
import type { Span } from '@altopelago/aeon-lexer';
import type { CompileCtx, DatatypeSemantics } from '../types.js';

interface ParsedDatatype {
    readonly name: string;
    readonly clarifiers: readonly (string | AesNumberLiteral)[];
    readonly args: readonly ParsedDatatype[];
}

export function validateDatatypeSemantics(
    aes: readonly AssignmentEvent[],
    semantics: Readonly<Record<string, DatatypeSemantics>>,
    ctx: Pick<CompileCtx, 'error'>
): void {
    for (const event of aes) {
        if (event.datatype === undefined) continue;
        const parsed = parseDatatype(event.datatype);
        if (!parsed) continue;
        validateParsedDatatype(parsed, semantics, ctx, event.normalizedPath, event.value.type);
    }
    validateMetadata(aes, semantics, ctx);
}

type Value = AssignmentEvent['value'];
type Attributes = Extract<Value, { type: 'TypedValue' }>['attributes'];

function parsedAnnotation(annotation: TypeAnnotation | null): ParsedDatatype | null {
    if (annotation === null) return null;
    return {
        name: annotation.name,
        args: annotation.genericArgs.map(parseDatatype).filter((arg): arg is ParsedDatatype => arg !== null),
        clarifiers: annotation.clarifiers.map(value => typeof value === 'string' ? value
            : { kind: 'NumberLiteral', value: typeof value === 'number' ? String(value) : value.value }),
    };
}

/** Payload descendants already have events; metadata descendants do not.
 * Walk each authored body root once, independently of metadata projection. */
function validateMetadata(aes: readonly AssignmentEvent[], semantics: Readonly<Record<string, DatatypeSemantics>>, ctx: Pick<CompileCtx, 'error'>): void {
    interface Task {
        value: Value;
        path: string;
        metadata: boolean;
        datatype?: ParsedDatatype | null;
        attributes?: Attributes;
        annotations?: ReadonlyMap<string, AttributeEntry> | undefined;
        span?: Span;
    }
    const member = (path: string, key: string) => path + formatPath({ segments: [{ type: 'root' }, { type: 'member', key }] }).slice(1);
    const body = aes.filter(event => event.sourcePlane !== 'header');
    const paths = new Set(body.map(event => formatPath(event.path)));
    const tasks: Task[] = [];
    for (const event of [...body].reverse()) {
        // Core emits every payload ancestor; checking the immediate parent
        // avoids repeatedly formatting all prefixes of a deep path.
        const nested = paths.has(formatPath({ segments: event.path.segments.slice(0, -1) }));
        if (!nested) tasks.push({ value: event.value, path: formatPath(event.path), metadata: false, annotations: event.annotations, span: event.span });
    }
    function check(datatype: ParsedDatatype | null | undefined, value: Value, path: string, span?: Span): void {
        while (value.type === 'TypedValue') value = value.value;
        if (datatype) validateParsedDatatype(datatype, semantics, { error: diagnostic => ctx.error({ ...diagnostic, ...(span ? { span } : {}) }) }, path, value.type);
    }
    function attributes(entries: Attributes | undefined, path: string): void {
        for (const block of [...(entries ?? [])].reverse()) {
            for (const [key, entry] of [...block.entries].reverse()) {
                tasks.push({ value: entry.value, path: member(`${path}.@`, key), metadata: true, datatype: parsedAnnotation(entry.datatype), attributes: entry.attributes, span: entry.span ?? entry.value.span });
            }
        }
    }
    while (tasks.length) {
        const task = tasks.pop()!;
        const { value, path, metadata } = task;
        if (metadata) check(task.datatype, value, path, task.span);
        switch (value.type) {
            case 'TypedValue':
                if (metadata) check(parsedAnnotation(value.datatype), value.value, path, value.span);
                tasks.push({ value: value.value, path, metadata });
                attributes(value.attributes, path);
                break;
            case 'ObjectNode':
                for (const binding of [...value.bindings].reverse()) {
                    tasks.push({ value: binding.value, path: member(path, binding.key), metadata, datatype: metadata ? parsedAnnotation(binding.datatype) : null, attributes: binding.attributes, span: binding.span });
                }
                attributes(value.attributes, path);
                break;
            case 'ListNode':
            case 'TupleLiteral':
                for (let index = value.elements.length - 1; index >= 0; index--) tasks.push({ value: value.elements[index]!, path: `${path}[${index}]`, metadata });
                attributes(value.attributes, path);
                break;
            case 'NodeLiteral': {
                const head = `${path}[0]`;
                if (metadata) check(parsedAnnotation(value.datatype), value, head, value.headSpan ?? value.span);
                for (let index = value.children.length - 1; index >= 0; index--) tasks.push({ value: value.children[index]!, path: `${head}[${index}]`, metadata });
                attributes(value.attributes, head);
                break;
            }
        }
        attributes(task.attributes, path);
        for (const [key, entry] of [...(task.annotations ?? [])].reverse()) {
            tasks.push({ value: entry.value, path: member(`${path}.@`, key), metadata: true, datatype: entry.datatype ? parseDatatype(entry.datatype) : null, annotations: entry.annotations, span: entry.span ?? entry.value.span });
        }
    }
}

function validateParsedDatatype(
    datatype: ParsedDatatype,
    semantics: Readonly<Record<string, DatatypeSemantics>>,
    ctx: Pick<CompileCtx, 'error'>,
    path: string | undefined,
    literalFamily?: string
): void {
    validateOwnClarifiers(datatype, semantics, ctx, path, literalFamily);
    for (const arg of datatype.args) {
        validateParsedDatatype(arg, semantics, ctx, path);
    }
}

function validateOwnClarifiers(
    datatype: ParsedDatatype,
    semantics: Readonly<Record<string, DatatypeSemantics>>,
    ctx: Pick<CompileCtx, 'error'>,
    path: string | undefined,
    literalFamily: string | undefined
): void {
    if (datatype.clarifiers.length === 0) return;

    const rule = semantics[datatype.name];
    if (!rule && (literalFamily === 'SeparatorLiteral' || literalFamily === 'RadixLiteral')) {
        return;
    }
    if (!rule || rule.clarifiers === 'none') {
        ctx.error({
            code: 'PROFILE_DATATYPE_CLARIFIER_NOT_ALLOWED',
            message: `Profile does not allow clarifiers on datatype ':${datatype.name}'`,
            ...(path !== undefined ? { path } : {}),
        });
        return;
    }

    if (rule.clarifiers === 'radix_base') {
        const [base] = datatype.clarifiers;
        if (
            datatype.clarifiers.length !== 1 ||
            typeof base !== 'object' ||
            base === null ||
            aeonRadixBaseFromNumber(base.value) === undefined
        ) {
            ctx.error({
                code: 'PROFILE_DATATYPE_CLARIFIER_INVALID',
                message: `Profile datatype ':${datatype.name}' expects exactly one integral radix-base clarifier from 2 to 64`,
                ...(path !== undefined ? { path } : {}),
            });
        }
        return;
    }

    if (rule.clarifiers === 'separator_chars') {
        if (!datatype.clarifiers.every((value) => typeof value === 'string')) {
            ctx.error({
                code: 'PROFILE_DATATYPE_CLARIFIER_INVALID',
                message: `Profile datatype ':${datatype.name}' expects string separator-character clarifiers`,
                ...(path !== undefined ? { path } : {}),
            });
        }
        return;
    }

    if (rule.clarifiers === 'encoding_name') {
        const [encodingName] = datatype.clarifiers;
        if (datatype.clarifiers.length !== 1 || typeof encodingName !== 'string') {
            ctx.error({
                code: 'PROFILE_DATATYPE_CLARIFIER_INVALID',
                message: `Profile datatype ':${datatype.name}' expects exactly one string encoding-name clarifier`,
                ...(path !== undefined ? { path } : {}),
            });
        }
    }
}

function parseDatatype(source: string): ParsedDatatype | null {
    const parser = new DatatypeSurfaceParser(source);
    const parsed = parser.parseType();
    parser.skipWhitespace();
    return parsed && parser.isDone() ? parsed : null;
}

class DatatypeSurfaceParser {
    private pos = 0;

    constructor(private readonly source: string) { }

    parseType(): ParsedDatatype | null {
        this.skipWhitespace();
        const name = this.parseName();
        if (!name) return null;

        const args: ParsedDatatype[] = [];
        this.skipWhitespace();
        if (this.peek() === '<') {
            this.pos++;
            while (true) {
                this.skipWhitespace();
                if (this.peek() === '>') return null;
                if (isNumberStart(this.peek())) {
                    this.parseGenericNumber();
                } else {
                    const arg = this.parseType();
                    if (!arg) return null;
                    args.push(arg);
                }
                this.skipWhitespace();
                if (this.peek() === '>') {
                    this.pos++;
                    break;
                }
                if (this.peek() !== ',') return null;
                this.pos++;
            }
        }

        this.skipWhitespace();
        const clarifiers = this.peek() === '[' ? this.parseClarifiers() : [];
        if (!clarifiers) return null;

        return { name, args, clarifiers };
    }

    skipWhitespace(): void {
        while (/\s/.test(this.peek())) this.pos++;
    }

    isDone(): boolean {
        return this.pos >= this.source.length;
    }

    private parseName(): string | null {
        const match = /^[A-Za-z_][A-Za-z0-9_-]*/.exec(this.source.slice(this.pos));
        if (!match) return null;
        this.pos += match[0]!.length;
        return match[0]!;
    }

    private parseGenericNumber(): void {
        const match = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(this.source.slice(this.pos));
        if (match) {
            this.pos += match[0]!.length;
        }
    }

    private parseClarifiers(): readonly (string | AesNumberLiteral)[] | null {
        this.pos++;
        let start = this.pos;
        const values: (string | AesNumberLiteral)[] = [];
        let quote: '"' | null = null;
        let escaped = false;
        while (this.pos < this.source.length) {
            const ch = this.source[this.pos]!;
            if (quote) {
                if (escaped) {
                    escaped = false;
                } else if (ch === '\\') {
                    escaped = true;
                } else if (ch === quote) {
                    quote = null;
                }
                this.pos++;
                continue;
            }
            if (ch === '"') {
                quote = ch;
                this.pos++;
                continue;
            }
            if (ch === ',' || ch === ']') {
                const raw = this.source.slice(start, this.pos).trim();
                try {
                    if (raw.startsWith('"')) {
                        const value: unknown = JSON.parse(raw);
                        if (typeof value !== 'string') return null;
                        values.push(value);
                    } else if (raw.length > 0) {
                        // Core already validated number syntax. Never round the
                        // preserved token through JSON.parse or native Number.
                        values.push({ kind: 'NumberLiteral', value: raw });
                    } else if (ch !== ']' || values.length > 0) {
                        return null;
                    }
                } catch {
                    return null;
                }
                this.pos++;
                if (ch === ']') return values;
                start = this.pos;
                continue;
            }
            this.pos++;
        }
        return null;
    }

    private peek(): string {
        return this.source[this.pos] ?? '';
    }
}

function isNumberStart(value: string): boolean {
    return value === '+' || value === '-' || value === '.' || /\d/.test(value);
}
