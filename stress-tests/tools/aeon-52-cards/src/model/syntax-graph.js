/**
 * AEON 52-Cards Syntax Graph
 *
 * Models the AEON document as a state machine for Markov-style exploration.
 * Each state represents a structural position; transitions represent
 * legal feature placements.
 */

import { ALL_FEATURES } from './features.js';
import { checkPairConstraints } from './constraints.js';

// ── States ───────────────────────────────────────────────────────────

/**
 * @typedef {'top-level' | 'inside-object' | 'inside-list' | 'inside-tuple' | 'inside-node' | 'after-comment'} SyntaxState
 */

/**
 * Map context strings (from features) to syntax states.
 */
const CONTEXT_TO_STATE = {
    top: 'top-level',
    object: 'inside-object',
    list: 'inside-list',
    tuple: 'inside-tuple',
    node: 'inside-node',
};

const STATE_TO_CONTEXT = {
    'top-level': 'top',
    'inside-object': 'object',
    'inside-list': 'list',
    'inside-tuple': 'tuple',
    'inside-node': 'node',
    'after-comment': 'top', // comments return to parent context
};

// ── Syntax Graph ─────────────────────────────────────────────────────

/**
 * Get all features that are legal in a given syntax state.
 *
 * @param {SyntaxState} state
 * @returns {import('./features.js').Feature[]}
 */
export function getLegalFeatures(state) {
    const context = STATE_TO_CONTEXT[state] ?? 'top';
    return ALL_FEATURES.filter((f) => f.contexts.includes(context));
}

/**
 * Get legal transitions from a state, filtered against previously
 * placed features (via constraint checker).
 *
 * @param {SyntaxState} state
 * @param {import('./features.js').Feature[]} existingFeatures — features already in the walk
 * @returns {import('./features.js').Feature[]}
 */
export function getTransitions(state, existingFeatures = []) {
    const candidates = getLegalFeatures(state);

    // Filter out features that conflict with any existing feature
    return candidates.filter((candidate) => {
        // Don't repeat the same feature in one walk
        if (existingFeatures.some((e) => e.id === candidate.id)) return false;

        // Check constraints against the most recently placed feature
        if (existingFeatures.length > 0) {
            const last = existingFeatures[existingFeatures.length - 1];
            const constraint = checkPairConstraints(last, candidate);
            if (!constraint.valid) return false;
        }

        return true;
    });
}

/**
 * Determine the next state after placing a feature.
 *
 * @param {SyntaxState} currentState
 * @param {import('./features.js').Feature} feature
 * @returns {SyntaxState}
 */
export function applyFeature(currentState, feature) {
    // Comments leave us in the same structural state
    if (feature.category === 'comments') {
        return currentState;
    }

    // Container features might change nesting level conceptually,
    // but since each feature is self-contained, we stay at top-level
    // for the walk. The nesting risk comes from the combination.
    if (feature.category === 'nesting') {
        return currentState; // nesting features are self-contained
    }

    // Most features are top-level bindings
    return currentState;
}

/**
 * Compute a structural depth score for a feature.
 * Deeper/more complex features get higher scores.
 *
 * @param {import('./features.js').Feature} feature
 * @returns {number} 0.0–1.0
 */
export function depthScore(feature) {
    const frag = feature.generate({});
    const lines = frag.text.split('\n');
    const maxIndent = Math.max(...lines.map((l) => l.match(/^(\s*)/)[1].length));
    const braces = (frag.text.match(/[{[(]/g) ?? []).length;

    let score = 0;
    score += Math.min(0.4, maxIndent / 20); // indent depth (max 0.4)
    score += Math.min(0.3, braces / 10);    // structural complexity (max 0.3)
    score += Math.min(0.3, lines.length / 15); // line count (max 0.3)

    return Math.min(1.0, score);
}

/**
 * Compute a rarity score for a feature based on how often it appears
 * in the existing pairwise test set.
 *
 * @param {string} featureId
 * @param {Map<string, number>} frequencyMap — featureId → count
 * @param {number} maxFrequency — highest frequency in the map
 * @returns {number} 0.0–1.0 (1.0 = very rare, 0.0 = very common)
 */
export function rarityScore(featureId, frequencyMap, maxFrequency) {
    const freq = frequencyMap.get(featureId) ?? 0;
    if (maxFrequency === 0) return 1.0;
    return 1.0 - freq / maxFrequency;
}

export const INITIAL_STATE = 'top-level';
