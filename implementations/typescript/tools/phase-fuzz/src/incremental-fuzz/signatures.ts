import { tokenize } from '@aeon/lexer';
import { parse } from '@aeon/parser';
import type { IncrementalSeed, SignatureSnapshot, SyntaxGroup } from './types.js';

export function evaluateSource(source: string, seed: IncrementalSeed): SignatureSnapshot {
    const lexed = tokenize(source, { includeComments: true, includeNewlines: true });
    const parserTokens = lexed.tokens.filter((token) => token.type !== 'LineComment' && token.type !== 'BlockComment' && token.type !== 'Newline');
    const parsed = parse(parserTokens);
    const accepted = parsed.errors.length === 0 && parsed.document !== null;
    const nodeTypes = parsed.document ? Array.from(collectNodeTypes(parsed.document, new Set<string>())).sort() : [];
    const nodeCount = parsed.document ? countNodes(parsed.document) : 0;
    const maxDepth = parsed.document ? computeDepth(parsed.document) : 0;

    return {
        accepted,
        lexer: JSON.stringify({
            tokenTypes: lexed.tokens.map((token) => token.type),
            errorCodes: lexed.errors.map((error) => error.code),
        }),
        parser: JSON.stringify({
            accepted,
            nodeTypes,
            diagnostics: parsed.errors.map((error) => error.code),
            depth: maxDepth,
        }),
        diagnostics: parsed.errors.map((error) => error.code),
        structures: inferStructures(source, seed.group),
        validPrefix: parsed.errors.length === 0
            ? source.length
            : Math.max(0, ...parsed.errors.map((error) => error.span.start.offset)),
        tokenCount: parserTokens.length,
        nodeCount,
        maxDepth,
        expectationMatch: matchesExpectation(seed.expected ?? 'either', accepted),
    };
}

export function createDedupKey(snapshot: SignatureSnapshot, source: string): string {
    return JSON.stringify({
        accepted: snapshot.accepted,
        lexer: snapshot.lexer,
        parser: snapshot.parser,
        length: source.length,
    });
}

function collectNodeTypes(value: unknown, output: Set<string> = new Set<string>()): Set<string> {
    if (!value || typeof value !== 'object') {
        return output;
    }

    if ('type' in value && typeof value.type === 'string') {
        output.add(value.type);
    }

    if (Array.isArray(value)) {
        value.forEach((entry) => collectNodeTypes(entry, output));
        return output;
    }

    Object.values(value).forEach((entry) => {
        if (entry instanceof Map) {
            Array.from(entry.entries()).forEach(([key, child]) => {
                output.add(`MapField:${String(key)}`);
                collectNodeTypes(child, output);
            });
            return;
        }
        collectNodeTypes(entry, output);
    });

    return output;
}

function computeDepth(value: unknown): number {
    if (!value || typeof value !== 'object') {
        return 0;
    }
    if (Array.isArray(value)) {
        return 1 + Math.max(0, ...value.map(computeDepth));
    }
    const childDepths = Object.values(value).map((entry) => {
        if (entry instanceof Map) {
            return 1 + Math.max(0, ...Array.from(entry.values()).map(computeDepth));
        }
        return computeDepth(entry);
    });
    return 1 + Math.max(0, ...childDepths);
}

function countNodes(value: unknown): number {
    if (!value || typeof value !== 'object') {
        return 0;
    }
    if (Array.isArray(value)) {
        return value.reduce((total, entry) => total + countNodes(entry), 0);
    }

    let total = 'type' in value && typeof value.type === 'string' ? 1 : 0;
    Object.values(value).forEach((entry) => {
        if (entry instanceof Map) {
            total += Array.from(entry.values()).reduce((sum, child) => sum + countNodes(child), 0);
            return;
        }
        total += countNodes(entry);
    });
    return total;
}

function matchesExpectation(expectation: IncrementalSeed['expected'], accepted: boolean): boolean {
    if (expectation === 'either' || expectation === undefined) {
        return true;
    }
    return expectation === 'valid' ? accepted : !accepted;
}

function inferStructures(source: string, seedGroup: SyntaxGroup): string[] {
    const groups = new Set<string>([seedGroup]);

    if (source.includes('@{')) {
        groups.add('attributes');
    }
    if (source.includes('<') || source.includes('>')) {
        groups.add('nodes');
    }
    if (source.includes(',') || source.includes('\n')) {
        groups.add('separators');
    }
    if (/\d|\.\d/.test(source)) {
        groups.add('numbers');
    }

    const combos = new Set<string>();
    const present = Array.from(groups).sort();
    for (let index = 0; index < present.length; index += 1) {
        for (let offset = index + 1; offset < present.length; offset += 1) {
            combos.add(`${present[index]}+${present[offset]}`);
        }
    }

    return [...present, ...Array.from(combos).sort()];
}
