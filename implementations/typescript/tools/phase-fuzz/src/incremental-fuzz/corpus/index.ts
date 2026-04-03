import { ATTRIBUTE_SEEDS } from './attributes.js';
import { INTERACTION_SEEDS } from './interactions.js';
import { NODE_SEEDS } from './nodes.js';
import { NUMBER_SEEDS } from './numbers.js';
import { SEPARATOR_SEEDS } from './separators.js';
import type { IncrementalSeed, SyntaxGroup } from '../types.js';

const ALL_SEEDS = [
    ...ATTRIBUTE_SEEDS,
    ...NODE_SEEDS,
    ...SEPARATOR_SEEDS,
    ...NUMBER_SEEDS,
    ...INTERACTION_SEEDS,
];

export function getIncrementalSeeds(group: SyntaxGroup | 'all'): IncrementalSeed[] {
    if (group === 'all') {
        return ALL_SEEDS.slice();
    }
    return ALL_SEEDS.filter((seed) => seed.group === group);
}

