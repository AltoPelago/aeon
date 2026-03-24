/**
 * AEON 52-Cards Document Builder
 *
 * Assembles complete AEON documents from feature fragments.
 * Adds the standard aeon:header preamble and manages key uniqueness.
 */

import { resetKeyCounter } from '../model/features.js';
import { requiredSeparatorDepth } from '../model/constraints.js';

/**
 * Build a strict-mode AEON document from one or more feature fragments.
 *
 * @param {import('../model/features.js').FeatureFragment[]} fragments
 * @param {Object} [options]
 * @param {string} [options.mode='strict'] — 'strict' or 'transport'
 * @returns {{ source: string, expectPass: boolean, features: string[] }}
 */
export function buildDocument(fragments, options = {}) {
    const mode = options.mode ?? 'strict';

    // Compute max separator depth needed
    let maxSepDepth = 1;
    for (const f of fragments) {
        const d = requiredSeparatorDepth(f);
        if (d > maxSepDepth) maxSepDepth = d;
    }

    const header = [
        'aeon:header = {',
        `  encoding:string = "utf-8"`,
        `  mode:string = "${mode}"`,
        '}',
    ].join('\n');

    const body = fragments.map((f) => f.text).join('\n');

    // Document passes only if ALL fragments expect to pass
    const expectPass = fragments.every((f) => f.expectPass);
    const features = fragments.map((f) => f.metadata?.featureId ?? 'unknown');

    return {
        source: `${header}\n${body}\n`,
        expectPass,
        features,
        maxSepDepth,
    };
}

/**
 * Build a document from a pair of features, resetting the key counter
 * so generated keys are predictable.
 */
export function buildPairDocument(featureA, featureB, seed = 0) {
    resetKeyCounter();

    const fragA = featureA.generate({});
    const fragB = featureB.generate({});

    fragA.metadata = { ...fragA.metadata, featureId: featureA.id };
    fragB.metadata = { ...fragB.metadata, featureId: featureB.id };

    const needsTransport = featureA.needsTransport || featureB.needsTransport;
    const needsCustomDatatypes = featureA.needsCustomDatatypes || featureB.needsCustomDatatypes;

    const doc = buildDocument([fragA, fragB], {
        mode: needsTransport ? 'transport' : 'strict',
    });
    doc.needsCustomDatatypes = needsCustomDatatypes;
    doc.needsTransport = needsTransport;
    return doc;
}

/**
 * Build a single-feature document (used for boundary testing).
 */
export function buildSingleDocument(feature, options = {}) {
    resetKeyCounter();
    const frag = feature.generate({});
    frag.metadata = { ...frag.metadata, featureId: feature.id };
    return buildDocument([frag], options);
}

/**
 * Extract the key name from a binding text line.
 */
function extractKey(text) {
    const firstLine = text.split('\n')[0];
    // Match: key@{...}:type = value  or  key:type = value  or  key = value
    // Also handle quoted keys
    const match = firstLine.match(/^(?:"[^"]+"|'[^']+'|[\w]+)/);
    if (match) {
        // Strip surrounding quotes if present
        let key = match[0];
        if ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))) {
            return key; // Keep quotes for quoted keys
        }
        return key;
    }
    return 'unknown';
}
