/**
 * AEON 52-Cards Constraint Rules
 *
 * Prunes invalid feature combinations before document generation.
 * Each constraint returns { valid, reason } for a proposed pair of features.
 */

/**
 * @param {import('./features.js').Feature} featureA
 * @param {import('./features.js').Feature} featureB
 * @returns {{ valid: boolean, reason?: string }}
 */
export function checkPairConstraints(featureA, featureB) {
    // Identical features — skip self-pairing
    if (featureA.id === featureB.id) {
        return { valid: false, reason: 'self-pair' };
    }

    // Two negative-test features together add little signal
    const aGenerated = featureA.generate({});
    const bGenerated = featureB.generate({});
    if (!aGenerated.expectPass && !bGenerated.expectPass) {
        return { valid: false, reason: 'double-negative' };
    }

    // Reference features that need an existing key can only pair with
    // features that produce bindings (so there is a target to reference)
    if (featureA.category === 'references' && aGenerated.requires) {
        if (!bGenerated.isBinding) {
            return { valid: false, reason: 'reference-needs-binding-target' };
        }
    }
    if (featureB.category === 'references' && bGenerated.requires) {
        if (!aGenerated.isBinding) {
            return { valid: false, reason: 'reference-needs-binding-target' };
        }
    }

    // Features must share at least one allowed context
    const sharedContexts = featureA.contexts.filter((c) => featureB.contexts.includes(c));
    if (sharedContexts.length === 0) {
        return { valid: false, reason: 'no-shared-context' };
    }

    // A negative-test feature that relies on strict-mode rejection must not be
    // paired with a feature that forces transport mode (where the rejection
    // doesn't apply)
    if (featureA.needsTransport && !bGenerated.expectPass) {
        return { valid: false, reason: 'transport-invalidates-negative-test' };
    }
    if (featureB.needsTransport && !aGenerated.expectPass) {
        return { valid: false, reason: 'transport-invalidates-negative-test' };
    }
    if (featureA.needsCustomDatatypes && !bGenerated.expectPass) {
        return { valid: false, reason: 'custom-datatypes-invalidates-negative-test' };
    }
    if (featureB.needsCustomDatatypes && !aGenerated.expectPass) {
        return { valid: false, reason: 'custom-datatypes-invalidates-negative-test' };
    }

    return { valid: true };
}

/**
 * Determine the best structural context for a pair of features.
 * Prefers 'top' for simplicity.
 */
export function bestContext(featureA, featureB) {
    const shared = featureA.contexts.filter((c) => featureB.contexts.includes(c));
    if (shared.includes('top')) return 'top';
    return shared[0] ?? 'top';
}

/**
 * Separator-spec depth constraint.
 * Returns the maxSeparatorDepth needed for a feature fragment.
 */
export function requiredSeparatorDepth(fragment) {
    const matches = fragment.text.match(/:\w+(\[[^\]]\])+/g);
    if (!matches) return 1;
    let maxDepth = 1;
    for (const match of matches) {
        const depth = (match.match(/\[/g) ?? []).length;
        if (depth > maxDepth) maxDepth = depth;
    }
    return maxDepth;
}
