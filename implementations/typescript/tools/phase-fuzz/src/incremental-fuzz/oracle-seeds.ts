import { UnifiedOracle } from '@aeon/oracle';
import { createPrng } from '../prng.js';
import { evaluateSource } from './signatures.js';
import type { IncrementalSeed, SyntaxGroup } from './types.js';

interface OracleSeedOptions {
    readonly seed: number;
    readonly count: number;
    readonly maxLength: number;
    readonly group: SyntaxGroup | 'all';
}

interface OracleProfile {
    readonly group: SyntaxGroup;
    readonly prefixes: readonly string[];
    readonly preferredChars: readonly string[];
    readonly minLength: number;
}

const ORACLE_PROFILES: Record<SyntaxGroup, OracleProfile> = {
    attributes: {
        group: 'attributes',
        prefixes: [
            'a@{x = 1} = 1\n',
            'item@{priority = 2} = "ok"\n',
            'root@{class = "hero"} = 1\n',
        ],
        preferredChars: ['a', 'b', 'c', '@', '{', '[', '"', '1', '2', 't', 'f', ',', '}'],
        minLength: 14,
    },
    nodes: {
        group: 'nodes',
        prefixes: [
            'a = <x()>\n',
            'root = <node(1)>\n',
            'view = <panel@{class = "hero"}()>\n',
        ],
        preferredChars: ['a', 'b', 'c', '<', '>', '(', ')', '"', '1', '2', ',', '@'],
        minLength: 14,
    },
    separators: {
        group: 'separators',
        prefixes: [
            'a = [1, 2, 3]\n',
            'pair = (1, 2)\n',
            'list = [true, false]\n',
        ],
        preferredChars: ['a', 'b', ',', '1', '2', '3', '"', 't', 'f', ']', ')'],
        minLength: 12,
    },
    numbers: {
        group: 'numbers',
        prefixes: [
            'a = 1.25\n',
            'count = 42\n',
            'ratio = .5\n',
        ],
        preferredChars: ['a', 'b', '1', '2', '3', '.', '-', '+', 'e', 'E'],
        minLength: 8,
    },
    interactions: {
        group: 'interactions',
        prefixes: [
            'a@{x = 1} = <x(1, 2)>\n',
            'a = [<x@{n = 1}()>, 2]\n',
            'root:number@{step = .5} = <x(1, <y()>)>\n',
        ],
        preferredChars: ['a', 'b', 'c', '<', '>', '@', '{', '}', '(', ')', '[', ']', ',', '"', '1', '2'],
        minLength: 20,
    },
};

export function createOracleSeeds(options: OracleSeedOptions): IncrementalSeed[] {
    if (options.count <= 0) {
        return [];
    }

    const prng = createPrng(options.seed ^ 0x0bad5eed);
    const oracle = new UnifiedOracle();
    const targetGroups = resolveTargetGroups(options.group);
    const seeds: IncrementalSeed[] = [];
    const seen = new Set<string>();
    const maxAttempts = Math.max(options.count * 20, 40);

    for (let attempt = 0; attempt < maxAttempts && seeds.length < options.count; attempt += 1) {
        const group = targetGroups[attempt % targetGroups.length] ?? 'interactions';
        const profile = ORACLE_PROFILES[group];
        const source = growOracleSeed(profile, oracle, prng, Math.min(options.maxLength, 120));
        if (source === null || seen.has(source)) {
            continue;
        }

        const snapshot = evaluateSource(source, { id: 'oracle-check', group, source, origin: 'oracle', expected: 'valid' });
        if (!snapshot.accepted) {
            continue;
        }
        if (!matchesTargetGroup(source, group)) {
            continue;
        }

        seen.add(source);
        seeds.push({
            id: `oracle-${group}-${seeds.length + 1}`,
            group,
            source,
            origin: 'oracle',
            expected: 'valid',
            tags: ['oracle', 'generated', group],
            hotspots: collectHotspots(source),
        });
    }

    return seeds;
}

function growOracleSeed(profile: OracleProfile, oracle: UnifiedOracle, prng: ReturnType<typeof createPrng>, maxLength: number): string | null {
    const prefix = profile.prefixes[prng.int(profile.prefixes.length)] ?? profile.prefixes[0] ?? '';
    let current = prefix;
    let lastAccepted: string | null = null;
    const budget = Math.max(24, maxLength - prefix.length);

    if (hasGroupShape(current, profile.group)) {
        const initialSnapshot = evaluateSource(prefix, { id: 'oracle-preview', group: profile.group, source: prefix, origin: 'oracle', expected: 'valid' });
        if (initialSnapshot.accepted) {
            lastAccepted = prefix.trim();
        }
    }

    for (let step = 0; step < budget && current.length < maxLength; step += 1) {
        const suggestion = oracle.suggest(current);
        const next = chooseNextChar(suggestion.chars, suggestion.continuationChars, profile.preferredChars, prng);
        if (next === null) {
            break;
        }
        current += next;

        if (current.length >= profile.minLength && hasGroupShape(current, profile.group)) {
            const snapshot = evaluateSource(current, { id: 'oracle-preview', group: profile.group, source: current, origin: 'oracle', expected: 'valid' });
            if (snapshot.accepted) {
                lastAccepted = current.trim();
                if (isStableStoppingPoint(current, profile.group) && prng.bool(0.6)) {
                    break;
                }
            }
        }
    }

    return lastAccepted;
}

function chooseNextChar(
    chars: readonly string[],
    continuationChars: readonly string[],
    preferredChars: readonly string[],
    prng: ReturnType<typeof createPrng>,
): string | null {
    if (chars.length === 0) {
        return null;
    }

    const preferred = chars.filter((char) => preferredChars.includes(char));
    const preferredContinuation = continuationChars.filter((char) => preferredChars.includes(char));

    if (preferredContinuation.length > 0 && prng.bool(0.75)) {
        return preferredContinuation[prng.int(preferredContinuation.length)] ?? null;
    }
    if (preferred.length > 0 && prng.bool(0.8)) {
        return preferred[prng.int(preferred.length)] ?? null;
    }
    if (continuationChars.length > 0 && prng.bool(0.65)) {
        return continuationChars[prng.int(continuationChars.length)] ?? null;
    }
    return chars[prng.int(chars.length)] ?? null;
}

function resolveTargetGroups(group: SyntaxGroup | 'all'): SyntaxGroup[] {
    if (group === 'all') {
        return ['attributes', 'nodes', 'separators', 'numbers', 'interactions'];
    }
    return [group];
}

function hasGroupShape(source: string, group: SyntaxGroup): boolean {
    switch (group) {
        case 'attributes':
            return source.includes('@{') && source.includes('}');
        case 'nodes':
            return source.includes('<') && source.includes('>');
        case 'separators':
            return source.includes(',');
        case 'numbers':
            return /\d/.test(source);
        case 'interactions':
            return source.includes('@{') && source.includes('<') && source.includes('>') && /\d/.test(source) && source.includes(',');
    }
}

function isStableStoppingPoint(source: string, group: SyntaxGroup): boolean {
    if (/\n\s*$/.test(source)) {
        return true;
    }
    switch (group) {
        case 'attributes':
            return source.includes('}') && source.includes('=');
        case 'nodes':
            return source.includes('>') && source.includes(')');
        case 'separators':
            return source.includes(']') || source.includes(')');
        case 'numbers':
            return /\d$/.test(source);
        case 'interactions':
            return source.includes('>') && source.includes('}') && source.includes(')');
    }
}

function matchesTargetGroup(source: string, group: SyntaxGroup): boolean {
    switch (group) {
        case 'attributes':
            return source.includes('@{') && source.includes('}');
        case 'nodes':
            return source.includes('<') && source.includes('>');
        case 'separators':
            return source.includes(',') || source.includes('\n');
        case 'numbers':
            return /\d/.test(source);
        case 'interactions':
            return source.includes('@{') && source.includes('<') && source.includes('>') && /\d/.test(source) && source.includes(',');
    }
}

function collectHotspots(source: string): string[] {
    const hotspots = new Set<string>();
    for (const char of source) {
        if (char === '@' || char === '{' || char === '}' || char === '<' || char === '>' || char === ',' || char === '=' || /\d/.test(char)) {
            hotspots.add(char);
        }
    }
    return Array.from(hotspots);
}
