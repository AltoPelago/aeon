import type { IncrementalMutation } from './types.js';

const STRUCTURAL_CHARS = ['@', '{', '}', '<', '>', '(', ')', '[', ']', ',', ':', '=', '.', '\n', ' ', '"'];
const NUMERIC_CHARS = ['0', '1', '2', '5', '7', '9', '.', '-', '+'];

export function createIncrementalMutations(): IncrementalMutation[] {
    return [
        {
            type: 'append-char',
            detail: 'append a weighted structural or numeric character',
            apply(source, prng) {
                const pool = prng.bool(0.7) ? STRUCTURAL_CHARS : NUMERIC_CHARS;
                return `${source}${pool[prng.int(pool.length)] ?? '1'}`;
            },
        },
        {
            type: 'replace-last-char',
            detail: 'repair or destabilize the tail character',
            apply(source, prng) {
                if (source.length === 0) {
                    return '@';
                }
                const pool = [...STRUCTURAL_CHARS, ...NUMERIC_CHARS];
                const next = pool[prng.int(pool.length)] ?? '}';
                return `${source.slice(0, -1)}${next}`;
            },
        },
        {
            type: 'insert-hotspot-char',
            detail: 'insert a weighted character near a structural hotspot',
            apply(source, prng) {
                const hotspots = collectHotspotIndexes(source);
                const index = hotspots.length > 0 ? hotspots[prng.int(hotspots.length)] : prng.int(source.length + 1);
                const pool = prng.bool(0.75) ? STRUCTURAL_CHARS : NUMERIC_CHARS;
                const next = pool[prng.int(pool.length)] ?? ',';
                return `${source.slice(0, index)}${next}${source.slice(index)}`;
            },
        },
        {
            type: 'wrap-region',
            detail: 'wrap the current source in a structural pair',
            apply(source, prng) {
                const wrappers: Array<[string, string]> = [
                    ['@{', '}'],
                    ['<x(', ')>'],
                    ['[', ']'],
                    ['(', ')'],
                ];
                const [left, right] = wrappers[prng.int(wrappers.length)] ?? ['(', ')'];
                return `${left}${source}${right}`;
            },
        },
        {
            type: 'flip-separator',
            detail: 'toggle a nearby separator class',
            apply(source, prng) {
                const commaIndex = source.indexOf(',');
                if (commaIndex !== -1 && prng.bool(0.5)) {
                    return `${source.slice(0, commaIndex)}\n${source.slice(commaIndex + 1)}`;
                }
                const newlineIndex = source.indexOf('\n');
                if (newlineIndex !== -1) {
                    return `${source.slice(0, newlineIndex)},${source.slice(newlineIndex + 1)}`;
                }
                return `${source},`;
            },
        },
        {
            type: 'numeric-perturbation',
            detail: 'push a numeric literal toward a nearby boundary shape',
            apply(source, prng) {
                const digitMatch = source.match(/\d+(?:\.\d+)?/);
                if (!digitMatch || digitMatch.index === undefined) {
                    return `${source}${prng.bool(0.5) ? '.5' : '1.0'}`;
                }
                const value = digitMatch[0];
                const replacement = [
                    `${value}.`,
                    `.${value}`,
                    `${value}${prng.bool(0.5) ? '.' : 'e'}`,
                    `${value}${prng.bool(0.5) ? '0' : '9'}`,
                ][prng.int(4)] ?? `${value}.`;
                const start = digitMatch.index;
                return `${source.slice(0, start)}${replacement}${source.slice(start + value.length)}`;
            },
        },
    ];
}

function collectHotspotIndexes(source: string): number[] {
    const indexes: number[] = [];
    for (let index = 0; index < source.length; index += 1) {
        if (STRUCTURAL_CHARS.includes(source[index] ?? '')) {
            indexes.push(index);
            indexes.push(index + 1);
        }
    }
    return indexes;
}

