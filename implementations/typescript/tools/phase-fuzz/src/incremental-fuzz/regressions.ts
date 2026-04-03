import type { IncrementalSeed } from './types.js';

export const INCREMENTAL_REGRESSION_CASES: readonly IncrementalSeed[] = [
    {
        id: 'incremental-node-attr-cutoff',
        group: 'interactions',
        source: 'a = <x@{class = "hero"}(1, [2, 3)>',
        expected: 'invalid',
        tags: ['regression', 'node', 'attribute', 'separator'],
        hotspots: ['<', '@', '{', '}', '(', '[', ',', ']', ')', '>'],
    },
];

export function getIncrementalRegressionCases(group: IncrementalSeed['group'] | 'all'): IncrementalSeed[] {
    if (group === 'all') {
        return [...INCREMENTAL_REGRESSION_CASES];
    }
    return INCREMENTAL_REGRESSION_CASES.filter((seed) => seed.group === group);
}
