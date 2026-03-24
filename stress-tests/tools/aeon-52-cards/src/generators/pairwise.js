/**
 * AEON 52-Cards Pairwise Generator
 *
 * Generates pairwise feature interaction documents.
 * Uses lightweight all-pairs to keep document count manageable.
 */

import { ALL_FEATURES, CATEGORIES, resetKeyCounter } from '../model/features.js';
import { checkPairConstraints } from '../model/constraints.js';
import { buildPairDocument } from './document-builder.js';

/**
 * Generate pairwise interaction documents.
 *
 * @param {Object} [options]
 * @param {string[]} [options.categories] — filter to these categories only
 * @param {number}   [options.maxDocs]    — cap total documents
 * @param {number}   [options.seed]       — deterministic shuffle seed
 * @returns {Array<{ id: string, source: string, expectPass: boolean, features: string[], maxSepDepth: number, class: string }>}
 */
export function generatePairwise(options = {}) {
    const categoryFilter = options.categories ?? CATEGORIES;
    const maxDocs = options.maxDocs ?? Infinity;
    const seed = options.seed ?? 0;

    const features = ALL_FEATURES.filter((f) => categoryFilter.includes(f.category));
    const documents = [];
    let docId = 0;

    // Generate all valid pairs
    for (let i = 0; i < features.length && documents.length < maxDocs; i++) {
        for (let j = i + 1; j < features.length && documents.length < maxDocs; j++) {
            const a = features[i];
            const b = features[j];

            const constraint = checkPairConstraints(a, b);
            if (!constraint.valid) continue;

            resetKeyCounter();

            const doc = buildPairDocument(a, b, seed + docId);
            const testClass = doc.expectPass ? 'valid-interaction' : 'invalid-interaction';

            documents.push({
                id: `pair-${docId++}`,
                source: doc.source,
                expectPass: doc.expectPass,
                features: [a.id, b.id],
                maxSepDepth: doc.maxSepDepth,
                needsTransport: doc.needsTransport,
                needsCustomDatatypes: doc.needsCustomDatatypes,
                class: testClass,
            });
        }
    }

    // Deterministic ordering based on seed (simple shuffle)
    if (seed > 0) {
        const rng = mulberry32(seed);
        for (let i = documents.length - 1; i > 0; i--) {
            const j = Math.floor(rng() * (i + 1));
            [documents[i], documents[j]] = [documents[j], documents[i]];
        }
    }

    return documents;
}

/**
 * Generate cross-category interaction documents.
 * Specifically targets pairs from DIFFERENT categories.
 *
 * @param {Object} [options]
 * @param {number} [options.maxDocs]
 * @returns {Array}
 */
export function generateCrossCategoryPairs(options = {}) {
    const maxDocs = options.maxDocs ?? Infinity;
    const documents = [];
    let docId = 0;

    // Take high-priority features from each category
    const highPriorityByCategory = {};
    for (const cat of CATEGORIES) {
        highPriorityByCategory[cat] = ALL_FEATURES.filter(
            (f) => f.category === cat && f.priority === 'high',
        );
    }

    const categories = Object.keys(highPriorityByCategory);
    for (let ci = 0; ci < categories.length && documents.length < maxDocs; ci++) {
        for (let cj = ci + 1; cj < categories.length && documents.length < maxDocs; cj++) {
            const catA = highPriorityByCategory[categories[ci]];
            const catB = highPriorityByCategory[categories[cj]];

            for (const a of catA) {
                for (const b of catB) {
                    if (documents.length >= maxDocs) break;

                    const constraint = checkPairConstraints(a, b);
                    if (!constraint.valid) continue;

                    resetKeyCounter();
                    const doc = buildPairDocument(a, b);

                    documents.push({
                        id: `cross-${docId++}`,
                        source: doc.source,
                        expectPass: doc.expectPass,
                        features: [a.id, b.id],
                        maxSepDepth: doc.maxSepDepth,
                        needsTransport: doc.needsTransport,
                        needsCustomDatatypes: doc.needsCustomDatatypes,
                        class: 'cross-category',
                    });
                }
            }
        }
    }

    return documents;
}

// Simple deterministic PRNG (Mulberry32)
function mulberry32(a) {
    return function () {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
