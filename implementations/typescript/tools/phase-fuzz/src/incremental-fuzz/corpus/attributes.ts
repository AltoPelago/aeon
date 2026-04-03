import type { IncrementalSeed } from '../types.js';

export const ATTRIBUTE_SEEDS: IncrementalSeed[] = [
    {
        id: 'attr-empty-bag',
        group: 'attributes',
        source: 'a@{} = 1',
        expected: 'valid',
        tags: ['empty', 'attribute-bag'],
        hotspots: ['@', '{', '}', '='],
    },
    {
        id: 'attr-single-number',
        group: 'attributes',
        source: 'a@{x = 1} = 1',
        expected: 'valid',
        tags: ['single', 'number'],
        hotspots: ['@', '{', '=', '1'],
    },
    {
        id: 'attr-node-value',
        group: 'attributes',
        source: 'a@{hero = <tag()>} = 1',
        expected: 'valid',
        tags: ['node-value', 'interaction'],
        hotspots: ['@', '{', '<', '>', '='],
    },
    {
        id: 'attr-unclosed-bag',
        group: 'attributes',
        source: 'a@{x = 1 = 1',
        expected: 'invalid',
        tags: ['boundary', 'unterminated'],
        hotspots: ['@', '{', '=', '1'],
    },
];

