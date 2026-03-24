/**
 * AEON 52-Cards Evaluator
 *
 * Evaluates generated AEON documents against all invariants.
 */

import {
    checkCoreParseStability,
    checkSdkFinalizeStability,
    checkCanonicalIdempotency,
    checkAnnotationIsolation,
    checkStructuralIntegrity,
    checkResourceLimits,
} from './invariants.js';

const HEAVY_SOURCE_MAX_CHARS = 250_000;
const HEAVY_SOURCE_MAX_LINES = 20_000;

function makeSkippedInvariant(invariant, reason, details = {}) {
    return {
        passed: true,
        invariant,
        details: { skipped: true, reason, ...details },
    };
}

function getSourceMetrics(source) {
    let lines = 1;
    for (let i = 0; i < source.length; i++) {
        if (source[i] === '\n') {
            lines++;
        }
    }
    return {
        chars: source.length,
        lines,
    };
}

/**
 * Evaluate a single generated document against all applicable invariants.
 *
 * @param {{ id: string, source: string, expectPass: boolean, features: string[], maxSepDepth: number, maxAttrDepth?: number, maxGenericDepth?: number, class: string, needsTransport?: boolean, needsCustomDatatypes?: boolean, skipSdkFinalize?: boolean }} doc
 * @returns {{ id: string, features: string[], class: string, results: Array<{ passed: boolean, invariant: string, details: Object }> }}
 */
export function evaluateDocument(doc) {
    const opts = {
        maxSepDepth: doc.maxSepDepth,
        maxAttrDepth: doc.maxAttrDepth,
        maxGenericDepth: doc.maxGenericDepth,
        needsTransport: doc.needsTransport,
        needsCustomDatatypes: doc.needsCustomDatatypes,
    };
    const results = [];
    const sourceMetrics = getSourceMetrics(doc.source);
    const skipHeavy =
        sourceMetrics.chars > HEAVY_SOURCE_MAX_CHARS ||
        sourceMetrics.lines > HEAVY_SOURCE_MAX_LINES;

    // 1. Core parse stability — always tested
    results.push(checkCoreParseStability(doc.source, doc.expectPass, opts));

    // 2. SDK/finalize stability — only for Core-valid documents
    if (doc.expectPass && !doc.skipSdkFinalize) {
        if (skipHeavy) {
            results.push(makeSkippedInvariant('sdk-finalize-stability', 'oversized-source', sourceMetrics));
        } else {
            results.push(checkSdkFinalizeStability(doc.source, opts));
        }
    }

    // 3. Canonical idempotency — only for valid documents
    if (doc.expectPass) {
        if (skipHeavy) {
            results.push(makeSkippedInvariant('canonical-idempotency', 'oversized-source', sourceMetrics));
        } else {
            results.push(checkCanonicalIdempotency(doc.source, opts));
        }
    }

    // 4. Annotation isolation — only for valid documents
    if (doc.expectPass) {
        if (skipHeavy) {
            results.push(makeSkippedInvariant('annotation-isolation', 'oversized-source', sourceMetrics));
        } else {
            results.push(checkAnnotationIsolation(doc.source, opts));
        }
    }

    // 5. Structural integrity — only for valid documents
    if (doc.expectPass) {
        if (skipHeavy) {
            results.push(makeSkippedInvariant('structural-integrity', 'oversized-source', sourceMetrics));
        } else {
            results.push(checkStructuralIntegrity(doc.source, opts));
        }
    }

    // 6. Resource limits — tested for all documents
    if (skipHeavy) {
        results.push(makeSkippedInvariant('resource-limits', 'oversized-source', sourceMetrics));
    } else {
        results.push(checkResourceLimits(doc.source, opts));
    }

    return {
        id: doc.id,
        features: doc.features,
        class: doc.class,
        results,
    };
}

/**
 * Evaluate a batch of generated documents.
 *
 * @param {Array} docs — array of generated document objects
 * @returns {Array} — array of evaluation results
 */
export function evaluateAll(docs) {
    return docs.map(evaluateDocument);
}
