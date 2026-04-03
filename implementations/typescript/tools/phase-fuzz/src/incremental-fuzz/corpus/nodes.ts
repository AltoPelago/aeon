import type { IncrementalSeed } from '../types.js';

export const NODE_SEEDS: IncrementalSeed[] = [
    {
        id: 'node-empty',
        group: 'nodes',
        source: 'a = <x()>',
        expected: 'valid',
        tags: ['empty', 'node'],
        hotspots: ['<', '>', '(', ')'],
    },
    {
        id: 'node-text-child',
        group: 'nodes',
        source: 'a = <x("y")>',
        expected: 'valid',
        tags: ['text-child'],
        hotspots: ['<', '(', '"', ')', '>'],
    },
    {
        id: 'node-with-attrs',
        group: 'nodes',
        source: 'a = <x@{class = "hero"}()>',
        expected: 'valid',
        tags: ['attributes', 'node'],
        hotspots: ['<', '@', '{', '}', '(', ')', '>'],
    },
    {
        id: 'node-unclosed',
        group: 'nodes',
        source: 'a = <x(',
        expected: 'invalid',
        tags: ['boundary', 'unterminated'],
        hotspots: ['<', '(', ')', '>'],
    },
];

