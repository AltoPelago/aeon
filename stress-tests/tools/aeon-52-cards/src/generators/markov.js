/**
 * AEON 52-Cards Markov Walker
 *
 * Generates multi-feature AEON documents by walking the syntax graph
 * with survivorship-bias-inverted probability weights.
 *
 * The inversion strategy deprioritizes common/safe paths and boosts
 * rare, high-risk, structurally deep combinations.
 */

import { ALL_FEATURES, resetKeyCounter } from '../model/features.js';
import { getTransitions, applyFeature, INITIAL_STATE, depthScore, rarityScore } from '../model/syntax-graph.js';
import { getRiskScore } from '../model/heatmap.js';
import { checkPairConstraints } from '../model/constraints.js';
import { buildDocument } from './document-builder.js';

// ── Mulberry32 PRNG ──────────────────────────────────────────────────

function mulberry32(a) {
    return function () {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// ── Walk Configuration ───────────────────────────────────────────────

/**
 * @typedef {Object} MarkovConfig
 * @property {number} numWalks          — total walks to generate (default 200)
 * @property {number} maxSteps          — max features per walk (default 5)
 * @property {number} minSteps          — min features per walk (default 3)
 * @property {number} seed              — PRNG seed (default 42)
 * @property {number} inversionStrength — how aggressively to penalize common paths (0–1, default 0.7)
 * @property {number} riskThreshold     — minimum heatmap risk to include transition (default 0.3)
 */

const DEFAULT_CONFIG = {
    numWalks: 200,
    maxSteps: 5,
    minSteps: 3,
    seed: 42,
    inversionStrength: 0.7,
    riskThreshold: 0.0, // 0 = include all; raise to filter low-risk transitions
};

// ── Frequency Map ────────────────────────────────────────────────────

/**
 * Build a frequency map from existing pairwise documents.
 * Counts how many times each feature appears across all documents.
 *
 * @param {Array<{ features: string[] }>} existingDocs
 * @returns {{ frequencyMap: Map<string, number>, maxFrequency: number }}
 */
export function buildFrequencyMap(existingDocs) {
    const frequencyMap = new Map();
    for (const doc of existingDocs) {
        for (const f of doc.features) {
            frequencyMap.set(f, (frequencyMap.get(f) ?? 0) + 1);
        }
    }
    const maxFrequency = Math.max(1, ...frequencyMap.values());
    return { frequencyMap, maxFrequency };
}

// ── Weight Computation ───────────────────────────────────────────────

/**
 * Compute the inverted weight for selecting a candidate feature.
 *
 * Higher weight = more likely to be selected.
 * The inversion strategy boosts rare, risky, deep features.
 *
 * @param {import('../model/features.js').Feature} candidate
 * @param {import('../model/features.js').Feature[]} walkFeatures — features already in this walk
 * @param {Map<string, number>} frequencyMap
 * @param {number} maxFrequency
 * @param {number} inversionStrength
 * @returns {number}
 */
function computeWeight(candidate, walkFeatures, frequencyMap, maxFrequency, inversionStrength) {
    // 1. Rarity bonus: features rarely seen in pairwise get boosted
    const rarity = rarityScore(candidate.id, frequencyMap, maxFrequency);
    const rarityWeight = rarity * inversionStrength + (1 - inversionStrength) * 0.5;

    // 2. Heatmap risk: average risk against all features already in the walk
    let avgRisk = 0.5;
    if (walkFeatures.length > 0) {
        const risks = walkFeatures.map((wf) => getRiskScore(wf, candidate));
        avgRisk = risks.reduce((a, b) => a + b, 0) / risks.length;
    }

    // 3. Depth bonus: structurally complex features get boosted
    const depth = depthScore(candidate);

    // 4. Cross-category bonus: features from a category not yet in the walk
    const walkedCategories = new Set(walkFeatures.map((f) => f.category));
    const crossCategoryBonus = walkedCategories.has(candidate.category) ? 0.0 : 0.3;

    // Combined weight
    const weight = rarityWeight * 0.3 + avgRisk * 0.35 + depth * 0.15 + crossCategoryBonus * 0.2;

    return Math.max(0.01, weight); // ensure non-zero
}

// ── Weighted Sampling ────────────────────────────────────────────────

/**
 * Sample an index from a weighted distribution.
 *
 * @param {number[]} weights
 * @param {function(): number} rng
 * @returns {number}
 */
function weightedSample(weights, rng) {
    const total = weights.reduce((a, b) => a + b, 0);
    let r = rng() * total;
    for (let i = 0; i < weights.length; i++) {
        r -= weights[i];
        if (r <= 0) return i;
    }
    return weights.length - 1;
}

// ── Walk Generator ───────────────────────────────────────────────────

/**
 * Generate Markov-walk documents.
 *
 * @param {Array<{ features: string[] }>} existingDocs — pairwise docs for frequency analysis
 * @param {Partial<MarkovConfig>} config
 * @returns {Array<{ id: string, source: string, expectPass: boolean, features: string[], maxSepDepth: number, class: string, walkDepth: number, avgRisk: number, needsTransport?: boolean, needsCustomDatatypes?: boolean }>}
 */
export function generateMarkovWalks(existingDocs, config = {}) {
    const cfg = { ...DEFAULT_CONFIG, ...config };
    const rng = mulberry32(cfg.seed);
    const { frequencyMap, maxFrequency } = buildFrequencyMap(existingDocs);

    const documents = [];
    let docId = 0;

    for (let walk = 0; walk < cfg.numWalks; walk++) {
        resetKeyCounter();

        let state = INITIAL_STATE;
        const walkFeatures = [];
        const walkSteps = cfg.minSteps + Math.floor(rng() * (cfg.maxSteps - cfg.minSteps + 1));

        for (let step = 0; step < walkSteps; step++) {
            let candidates = getTransitions(state, walkFeatures);
            if (candidates.length === 0) break;

            // Exclude negative-test features from Markov walks:
            // they are well-tested by pairwise, and in multi-feature walks
            // broken syntax (e.g. unterminated comments) consumes subsequent
            // fragments, producing misleading pass/fail results.
            candidates = candidates.filter((c) => c.generate({}).expectPass);
            if (candidates.length === 0) break;

            // Enforce mode compatibility across the entire walk:
            // - If any feature needs transport, exclude negative-test features
            // - If any feature is a strict-only negative test, exclude transport features
            const walkNeedsTransport = walkFeatures.some((f) => f.needsTransport);
            const walkNeedsCustomDatatypes = walkFeatures.some((f) => f.needsCustomDatatypes);
            const walkHasNegativeTest = walkFeatures.some((f) => !f.generate({}).expectPass);

            candidates = candidates.filter((c) => {
                const cFrag = c.generate({});
                if (walkNeedsTransport && !cFrag.expectPass) return false;
                if (walkNeedsCustomDatatypes && !cFrag.expectPass) return false;
                if (walkHasNegativeTest && c.needsTransport) return false;
                if (walkHasNegativeTest && c.needsCustomDatatypes) return false;
                return true;
            });
            if (candidates.length === 0) break;

            // Compute weights for each candidate
            const weights = candidates.map((c) =>
                computeWeight(c, walkFeatures, frequencyMap, maxFrequency, cfg.inversionStrength),
            );

            // Filter by risk threshold if configured
            if (cfg.riskThreshold > 0 && walkFeatures.length > 0) {
                for (let i = 0; i < candidates.length; i++) {
                    const avgRisk = walkFeatures.reduce(
                        (sum, wf) => sum + getRiskScore(wf, candidates[i]),
                        0,
                    ) / walkFeatures.length;
                    if (avgRisk < cfg.riskThreshold) {
                        weights[i] *= 0.1; // heavily penalize low-risk
                    }
                }
            }

            // Sample next feature
            const idx = weightedSample(weights, rng);
            const selected = candidates[idx];
            walkFeatures.push(selected);

            // Advance state
            state = applyFeature(state, selected);
        }

        if (walkFeatures.length < 2) continue; // need at least 2 features for meaningful interaction

        // Build document from walk
        const fragments = walkFeatures.map((f) => {
            const frag = f.generate({});
            frag.metadata = { ...frag.metadata, featureId: f.id };
            return frag;
        });

        const needsTransport = walkFeatures.some((f) => f.needsTransport);
        const needsCustomDatatypes = walkFeatures.some((f) => f.needsCustomDatatypes);

        const doc = buildDocument(fragments, {
            mode: needsTransport ? 'transport' : 'strict',
        });

        // Compute average risk across all feature pairs in the walk
        let totalRisk = 0;
        let riskCount = 0;
        for (let i = 0; i < walkFeatures.length; i++) {
            for (let j = i + 1; j < walkFeatures.length; j++) {
                totalRisk += getRiskScore(walkFeatures[i], walkFeatures[j]);
                riskCount++;
            }
        }
        const avgRisk = riskCount > 0 ? totalRisk / riskCount : 0;

        documents.push({
            id: `markov-${docId++}`,
            source: doc.source,
            expectPass: doc.expectPass,
            features: doc.features,
            maxSepDepth: doc.maxSepDepth,
            needsTransport,
            needsCustomDatatypes,
            class: 'markov-walk',
            walkDepth: walkFeatures.length,
            avgRisk: Math.round(avgRisk * 100) / 100,
        });
    }

    return documents;
}

/**
 * Get statistics about the generated Markov walks.
 */
export function getMarkovStats(documents) {
    const walkDocs = documents.filter((d) => d.class === 'markov-walk');
    if (walkDocs.length === 0) return null;

    const depths = walkDocs.map((d) => d.walkDepth);
    const risks = walkDocs.map((d) => d.avgRisk);

    const depthHistogram = {};
    for (const d of depths) {
        depthHistogram[d] = (depthHistogram[d] ?? 0) + 1;
    }

    // Category coverage
    const categoriesSeen = new Set();
    for (const d of walkDocs) {
        for (const f of d.features) {
            const feature = ALL_FEATURES.find((af) => af.id === f);
            if (feature) categoriesSeen.add(feature.category);
        }
    }

    // Feature coverage
    const featuresSeen = new Set();
    for (const d of walkDocs) {
        for (const f of d.features) featuresSeen.add(f);
    }

    return {
        totalWalks: walkDocs.length,
        avgDepth: (depths.reduce((a, b) => a + b, 0) / depths.length).toFixed(1),
        maxDepth: Math.max(...depths),
        minDepth: Math.min(...depths),
        avgRisk: (risks.reduce((a, b) => a + b, 0) / risks.length).toFixed(2),
        maxRisk: Math.max(...risks).toFixed(2),
        depthHistogram,
        categoriesCovered: categoriesSeen.size,
        featuresCovered: featuresSeen.size,
    };
}
