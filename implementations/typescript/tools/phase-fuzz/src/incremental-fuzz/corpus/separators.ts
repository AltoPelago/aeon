import type { IncrementalSeed } from '../types.js';

export const SEPARATOR_SEEDS: IncrementalSeed[] = [
    {
        id: 'sep-array-commas',
        group: 'separators',
        source: 'a = [1, 2, 3]',
        expected: 'valid',
        tags: ['array', 'comma'],
        hotspots: ['[', ',', ']'],
    },
    {
        id: 'sep-node-commas',
        group: 'separators',
        source: 'a = <x(1, 2, 3)>',
        expected: 'valid',
        tags: ['node', 'comma'],
        hotspots: ['<', '(', ',', ')', '>'],
    },
    {
        id: 'sep-newline-bindings',
        group: 'separators',
        source: 'a = 1\nb = 2\nc = 3',
        expected: 'valid',
        tags: ['bindings', 'newline'],
        hotspots: ['=', '\n'],
    },
    {
        id: 'sep-trailing-array',
        group: 'separators',
        source: 'a = [1, 2, ]',
        expected: 'either',
        tags: ['array', 'trailing'],
        hotspots: ['[', ',', ']'],
    },
];

