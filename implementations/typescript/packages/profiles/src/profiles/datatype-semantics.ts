import type { AssignmentEvent } from '@altopelago/aeon-aes';
import type { CompileCtx, DatatypeSemantics } from '../types.js';

interface ParsedDatatype {
    readonly name: string;
    readonly clarifiers: readonly unknown[];
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
        validateParsedDatatype(parsed, semantics, ctx, event.normalizedPath);
    }
}

function validateParsedDatatype(
    datatype: ParsedDatatype,
    semantics: Readonly<Record<string, DatatypeSemantics>>,
    ctx: Pick<CompileCtx, 'error'>,
    path: string | undefined
): void {
    validateOwnClarifiers(datatype, semantics, ctx, path);
    for (const arg of datatype.args) {
        validateParsedDatatype(arg, semantics, ctx, path);
    }
}

function validateOwnClarifiers(
    datatype: ParsedDatatype,
    semantics: Readonly<Record<string, DatatypeSemantics>>,
    ctx: Pick<CompileCtx, 'error'>,
    path: string | undefined
): void {
    if (datatype.clarifiers.length === 0) return;

    const rule = semantics[datatype.name];
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
            typeof base !== 'number' ||
            !Number.isInteger(base) ||
            base < 2 ||
            base > 64
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

    private parseClarifiers(): readonly unknown[] | null {
        const start = this.pos;
        this.pos++;
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
            if (ch === ']') {
                this.pos++;
                try {
                    return JSON.parse(this.source.slice(start, this.pos)) as unknown[];
                } catch {
                    return null;
                }
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
