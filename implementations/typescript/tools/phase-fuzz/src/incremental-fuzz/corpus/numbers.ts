import type { IncrementalSeed } from '../types.js';

export const NUMBER_SEEDS: IncrementalSeed[] = [
    {
        id: 'num-int',
        group: 'numbers',
        source: 'a = 1',
        expected: 'valid',
        tags: ['integer'],
        hotspots: ['=', '1'],
    },
    {
        id: 'num-decimal',
        group: 'numbers',
        source: 'a = 1.25',
        expected: 'valid',
        tags: ['decimal'],
        hotspots: ['=', '.', '1', '2', '5'],
    },
    {
        id: 'num-leading-dot',
        group: 'numbers',
        source: 'a = .5',
        expected: 'valid',
        tags: ['leading-dot'],
        hotspots: ['=', '.', '5'],
    },
    {
        id: 'num-double-dot',
        group: 'numbers',
        source: 'a = 1..2',
        expected: 'invalid',
        tags: ['boundary', 'malformed'],
        hotspots: ['=', '.', '1', '2'],
    },
];

