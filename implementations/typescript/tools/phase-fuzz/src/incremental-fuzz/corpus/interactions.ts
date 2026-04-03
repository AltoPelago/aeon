import type { IncrementalSeed } from '../types.js';

export const INTERACTION_SEEDS: IncrementalSeed[] = [
    {
        id: 'mix-attrs-node-number',
        group: 'interactions',
        source: 'a@{x = 1} = <x(1, 2)>',
        expected: 'valid',
        tags: ['attributes', 'nodes', 'numbers', 'separators'],
        hotspots: ['@', '{', '<', '(', ',', ')', '>'],
    },
    {
        id: 'mix-array-node-attr',
        group: 'interactions',
        source: 'a = [<x@{n = 1}()>, 2]',
        expected: 'valid',
        tags: ['array', 'node', 'attribute'],
        hotspots: ['[', '<', '@', '{', '}', '(', ')', ',', ']'],
    },
    {
        id: 'mix-root-typed',
        group: 'interactions',
        source: 'root:number@{step = .5} = <x(1, <y()>)>',
        expected: 'valid',
        tags: ['datatype', 'attributes', 'numbers', 'nodes'],
        hotspots: [':', '@', '{', '.', '<', '(', ')', '>'],
    },
    {
        id: 'mix-broken-nesting',
        group: 'interactions',
        source: 'root = <x@{n = .5}(1, [2, 3)>',
        expected: 'invalid',
        tags: ['broken', 'nesting'],
        hotspots: ['<', '@', '{', '(', '[', ',', ']', ')', '>'],
    },
];

