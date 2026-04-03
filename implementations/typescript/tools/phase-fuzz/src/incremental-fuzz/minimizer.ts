import { tokenize } from '@aeon/lexer';
import { evaluateSource } from './signatures.js';
import type { IncrementalSeed, SignatureSnapshot } from './types.js';

export interface MinimizationResult {
    readonly source: string;
    readonly changed: boolean;
    readonly passes: number;
}

export function minimizeIncrementalCase(source: string, seed: IncrementalSeed): MinimizationResult {
    const baseline = evaluateSource(source, seed);
    if (baseline.accepted) {
        return { source, changed: false, passes: 0 };
    }

    let current = source;
    let passes = 0;

    while (current.length > 1) {
        const next = minimizeOnce(current, seed, baseline);
        if (next === current) {
            break;
        }
        current = next;
        passes += 1;
    }

    current = rehydrateReadableSkeleton(current, source, seed, baseline);

    return {
        source: current,
        changed: current !== source,
        passes,
    };
}

function minimizeOnce(source: string, seed: IncrementalSeed, baseline: SignatureSnapshot): string {
    const chunkCandidates = buildChunkCandidates(source);
    for (const candidate of chunkCandidates) {
        if (preservesFailureClass(candidate, seed, baseline)) {
            return candidate;
        }
    }

    for (let index = 0; index < source.length; index += 1) {
        const candidate = `${source.slice(0, index)}${source.slice(index + 1)}`;
        if (candidate.length === 0) {
            continue;
        }
        if (preservesFailureClass(candidate, seed, baseline)) {
            return candidate;
        }
    }

    return source;
}

function preservesFailureClass(candidate: string, seed: IncrementalSeed, baseline: SignatureSnapshot): boolean {
    const next = evaluateSource(candidate, seed);
    if (next.accepted) {
        return false;
    }
    return diagnosticsKey(next) === diagnosticsKey(baseline)
        && preservesSeedGroup(candidate, seed.group)
        && next.validPrefix >= Math.min(baseline.validPrefix, 1);
}

function diagnosticsKey(snapshot: SignatureSnapshot): string {
    return JSON.stringify(snapshot.diagnostics);
}

function buildChunkCandidates(source: string): string[] {
    const seen = new Set<string>();
    const candidates: string[] = [];
    buildTokenCandidates(source).forEach((candidate) => pushCandidate(candidate, source, seen, candidates));
    const patterns = [
        /@\{[^}]*\}/g,
        /<[^>]*>/g,
        /\[[^\]]*\]/g,
        /\([^\)]*\)/g,
        /"(?:[^"\\]|\\.)*"/g,
        /\d+(?:\.\d+)?/g,
        /[A-Za-z_][A-Za-z0-9_-]*/g,
        /[,:=@<>{}\[\]\(\)]/g,
    ];

    for (const pattern of patterns) {
        for (const match of source.matchAll(pattern)) {
            if (match.index === undefined) {
                continue;
            }
            const value = match[0];
            const candidate = `${source.slice(0, match.index)}${source.slice(match.index + value.length)}`;
            pushCandidate(candidate, source, seen, candidates);
        }
    }

    const splitPoints = [' = ', ', ', '\n', ' '];
    for (const separator of splitPoints) {
        const parts = source.split(separator);
        if (parts.length <= 1) {
            continue;
        }
        for (let index = 0; index < parts.length; index += 1) {
            const candidateParts = parts.filter((_, currentIndex) => currentIndex !== index);
            const candidate = candidateParts.join(separator);
            pushCandidate(candidate, source, seen, candidates);
        }
    }

    candidates.sort((left, right) => left.length - right.length);
    return candidates;
}

function buildTokenCandidates(source: string): string[] {
    const candidates: string[] = [];
    const spans = tokenize(source, { includeComments: true, includeNewlines: true }).tokens
        .filter((token) => token.type !== 'EOF')
        .map((token) => ({ start: token.span.start.offset, end: token.span.end.offset }))
        .filter((span) => span.end > span.start);

    for (let length = Math.min(4, spans.length); length >= 1; length -= 1) {
        for (let index = 0; index + length <= spans.length; index += 1) {
            const start = spans[index]?.start ?? 0;
            const end = spans[index + length - 1]?.end ?? start;
            candidates.push(removeRange(source, start, end));
        }
    }

    return candidates;
}

function pushCandidate(candidate: string, source: string, seen: Set<string>, candidates: string[]): void {
    const normalized = normalizeCandidate(candidate);
    if (candidate === source || normalized.length === 0 || seen.has(candidate)) {
        return;
    }
    seen.add(candidate);
    candidates.push(normalized);
}

function removeRange(source: string, start: number, end: number): string {
    return normalizeCandidate(`${source.slice(0, start)}${source.slice(end)}`);
}

function normalizeCandidate(source: string): string {
    return source
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .replace(/[ \t]{2,}/g, ' ')
        .trim();
}

function rehydrateReadableSkeleton(current: string, original: string, seed: IncrementalSeed, baseline: SignatureSnapshot): string {
    const candidates = buildReadableSkeletons(original, current, seed.group);
    let best = current;

    for (const candidate of candidates) {
        if (candidate.length > Math.max(best.length + 8, 20)) {
            continue;
        }
        if (!preservesFailureClass(candidate, seed, baseline)) {
            continue;
        }
        if (readabilityScore(candidate) > readabilityScore(best)) {
            best = candidate;
        }
    }

    return best;
}

function buildReadableSkeletons(source: string, minimized: string, group: IncrementalSeed['group']): string[] {
    const identifiers = allMatches(source, /[A-Za-z_][A-Za-z0-9_-]*/g);
    const identifier = identifiers[0] ?? 'x';
    const attrKey = identifiers.find((value) => value !== identifier && value !== 'aeon') ?? 'a';
    const number = firstMatch(source, /\d+(?:\.\d+)?/g) ?? '2';
    const keepNode = minimized.includes('<') || minimized.includes('>');
    const keepAttr = minimized.includes('@{');
    const keepSep = minimized.includes(',') || minimized.includes('\n');
    const keepEq = minimized.includes('=');

    switch (group) {
        case 'attributes':
            return [
                `${identifier}@{${attrKey}=${number}}`,
                `${identifier}@{${attrKey}=${number},}`,
                `${identifier}@{${number}}`,
            ];
        case 'nodes':
            return [
                `<${identifier}>`,
                `<${identifier}()>`,
                `<${identifier}(`,
            ];
        case 'separators':
            return [
                `${identifier},${number}`,
                `${identifier}\n${number}`,
                `${identifier},`,
            ];
        case 'numbers':
            return [
                `${identifier}=${number}`,
                `${identifier}${number}`,
            ];
        case 'interactions':
            return [
                `${keepNode ? '<' : ''}${identifier}${keepAttr ? `@{${keepEq ? `${attrKey}=${number}` : number}` : ''}${keepSep ? ',' : ''}${keepNode ? '>' : ''}`,
                `<${identifier}@{${attrKey}=${number},>`,
                `<${identifier}@{${attrKey}=${number}}>`,
                `${identifier}@{${attrKey}=${number},>`,
                `<${identifier}@{${number},>`,
            ];
        default:
            return [];
    }
}

function firstMatch(source: string, pattern: RegExp): string | null {
    const match = source.match(pattern);
    return match?.[0] ?? null;
}

function allMatches(source: string, pattern: RegExp): string[] {
    return Array.from(source.matchAll(pattern), (match) => match[0]).filter((value) => value.length > 0);
}

function readabilityScore(source: string): number {
    let score = 0;
    if (/[A-Za-z]/.test(source)) {
        score += 2;
    }
    if (/\d/.test(source)) {
        score += 1;
    }
    if (source.includes('@{')) {
        score += 2;
    }
    if (source.includes('<') || source.includes('>')) {
        score += 2;
    }
    if (source.includes(',') || source.includes('\n')) {
        score += 1;
    }
    if (source.includes('=')) {
        score += 1;
    }
    return score;
}

function preservesSeedGroup(source: string, group: IncrementalSeed['group']): boolean {
    switch (group) {
        case 'attributes':
            return source.includes('@{') && /[A-Za-z]/.test(source);
        case 'nodes':
            return (source.includes('<') || source.includes('>')) && /[A-Za-z]/.test(source);
        case 'separators':
            return (source.includes(',') || source.includes('\n')) && /[A-Za-z0-9]/.test(source);
        case 'numbers':
            return /\d|\.\d/.test(source) && /[A-Za-z]/.test(source);
        case 'interactions':
            // Keep one representative fragment from each target family so minimized
            // cases stay legible and still communicate the interaction being tested.
            return source.includes('@{')
                && (source.includes('<') || source.includes('>'))
                && (source.includes(',') || source.includes('\n'))
                && /\d|\.\d/.test(source)
                && /[A-Za-z]/.test(source);
        default:
            return false;
    }
}
