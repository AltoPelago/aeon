/**
 * AEON 52-Cards Feature Interaction Heatmap
 *
 * Risk model that scores feature pair interactions based on
 * estimated structural danger. Used by the Markov walker to
 * prioritize high-risk, under-explored intersections.
 */

import { CATEGORIES, ALL_FEATURES } from './features.js';

// ── Category × Category Risk Matrix ──────────────────────────────────
//
// Rows and columns correspond to CATEGORIES in order:
//   values, containers, keys, attributes, types, references, comments, layout, nesting
//
// Risk meanings:
//   0.0–0.2  trivial — features are largely orthogonal
//   0.3–0.5  moderate — some structural interaction, modest defect potential
//   0.6–0.8  high — features share parser surface area or structural concerns
//   0.9–1.0  critical — features interact at fundamental grammar level

const CATEGORY_ORDER = [
    'values',
    'containers',
    'keys',
    'attributes',
    'types',
    'references',
    'comments',
    'layout',
    'nesting',
];

// prettier-ignore
const RISK_MATRIX = [
    //  val   cnt   key   attr  type  ref   cmt   lay   nest
    [0.1, 0.3, 0.2, 0.3, 0.6, 0.4, 0.2, 0.3, 0.3], // values
    [0.3, 0.4, 0.3, 0.7, 0.5, 0.6, 0.4, 0.5, 0.9], // containers
    [0.2, 0.3, 0.2, 0.5, 0.4, 0.5, 0.2, 0.2, 0.3], // keys
    [0.3, 0.7, 0.5, 0.4, 0.6, 0.7, 0.5, 0.3, 0.8], // attributes
    [0.6, 0.5, 0.4, 0.6, 0.3, 0.7, 0.3, 0.3, 0.5], // types
    [0.4, 0.6, 0.5, 0.7, 0.7, 0.5, 0.5, 0.4, 0.9], // references
    [0.2, 0.4, 0.2, 0.5, 0.3, 0.5, 0.2, 0.4, 0.6], // comments
    [0.3, 0.5, 0.2, 0.3, 0.3, 0.4, 0.4, 0.3, 0.5], // layout
    [0.3, 0.9, 0.3, 0.8, 0.5, 0.9, 0.6, 0.5, 0.7], // nesting
];

// ── Feature-level risk adjustment ────────────────────────────────────

/**
 * Compute a per-feature complexity factor (0.0–1.0).
 * More complex features get higher scores.
 */
function featureComplexity(feature) {
    let score = 0;

    // Priority weighting: high-priority features are "common" → lower exploration value
    // But they're also more fundamental → higher interaction risk
    if (feature.priority === 'high') score += 0.3;
    else if (feature.priority === 'medium') score += 0.5;
    else score += 0.7; // low-priority = rare = higher exploration value

    // Features requiring transport mode are structurally distinct
    if (feature.needsTransport) score += 0.2;
    if (feature.needsCustomDatatypes) score += 0.1;

    // Features that generate multi-line or nested output
    const frag = feature.generate({});
    const lineCount = frag.text.split('\n').length;
    if (lineCount > 3) score += 0.2;
    if (lineCount > 6) score += 0.1;

    // Negative-test features: high interaction risk
    if (!frag.expectPass) score += 0.3;

    return Math.min(1.0, score);
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Get the category-level risk for a pair of categories.
 *
 * @param {string} categoryA
 * @param {string} categoryB
 * @returns {number} 0.0–1.0
 */
export function getCategoryRisk(categoryA, categoryB) {
    const idxA = CATEGORY_ORDER.indexOf(categoryA);
    const idxB = CATEGORY_ORDER.indexOf(categoryB);
    if (idxA === -1 || idxB === -1) return 0.5; // unknown category → moderate
    return RISK_MATRIX[idxA][idxB];
}

/**
 * Get the combined risk score for a specific feature pair.
 * Combines category-level risk with feature-level complexity.
 *
 * @param {import('./features.js').Feature} featureA
 * @param {import('./features.js').Feature} featureB
 * @returns {number} 0.0–1.0
 */
export function getRiskScore(featureA, featureB) {
    const catRisk = getCategoryRisk(featureA.category, featureB.category);
    const compA = featureComplexity(featureA);
    const compB = featureComplexity(featureB);

    // Weighted combination: category risk dominates, feature complexity adjusts
    return Math.min(1.0, catRisk * 0.6 + ((compA + compB) / 2) * 0.4);
}

/**
 * Get all feature pairs above a given risk threshold,
 * sorted by descending risk.
 *
 * @param {number} threshold — minimum risk score (default 0.5)
 * @returns {Array<{ featureA: string, featureB: string, risk: number, categoryRisk: number }>}
 */
export function getHighRiskPairs(threshold = 0.5) {
    const pairs = [];

    for (let i = 0; i < ALL_FEATURES.length; i++) {
        for (let j = i + 1; j < ALL_FEATURES.length; j++) {
            const a = ALL_FEATURES[i];
            const b = ALL_FEATURES[j];
            const risk = getRiskScore(a, b);
            if (risk >= threshold) {
                pairs.push({
                    featureA: a.id,
                    featureB: b.id,
                    risk,
                    categoryRisk: getCategoryRisk(a.category, b.category),
                });
            }
        }
    }

    pairs.sort((a, b) => b.risk - a.risk);
    return pairs;
}

/**
 * Get the full category × category risk matrix for reporting.
 *
 * @returns {{ categories: string[], matrix: number[][] }}
 */
export function getHeatmapMatrix() {
    return {
        categories: [...CATEGORY_ORDER],
        matrix: RISK_MATRIX.map((row) => [...row]),
    };
}

/**
 * Print the heatmap matrix to console.
 */
export function printHeatmap() {
    const cats = CATEGORY_ORDER.map((c) => c.slice(0, 6).padEnd(6));
    const header = '        ' + cats.join(' ');

    console.log('\n┌─────────────────────────────────────────────────────────────────┐');
    console.log('│              Feature Interaction Heatmap                       │');
    console.log('└─────────────────────────────────────────────────────────────────┘\n');
    console.log(header);
    console.log('        ' + '──────'.repeat(CATEGORY_ORDER.length));

    for (let i = 0; i < CATEGORY_ORDER.length; i++) {
        const label = CATEGORY_ORDER[i].slice(0, 6).padEnd(6);
        const cells = RISK_MATRIX[i].map((v) => {
            const s = v.toFixed(1).padStart(4);
            if (v >= 0.8) return `\x1b[31m${s}\x1b[0m  `;      // red — critical
            if (v >= 0.6) return `\x1b[33m${s}\x1b[0m  `;      // yellow — high
            if (v >= 0.4) return `\x1b[36m${s}\x1b[0m  `;      // cyan — moderate
            return `${s}  `;                                     // dim — low
        });
        console.log(`${label}  ${cells.join('')}`);
    }

    console.log();
}

export { CATEGORY_ORDER };
