/**
 * AEON 52-Cards Known Findings
 *
 * Tracks issues discovered by the harness that represent genuine
 * language-level or tooling-level bugs. These are tracked rather than
 * masked, so the harness can still report them without failing.
 */

/**
 * Known canonicalization issues. Each entry defines a set of feature IDs
 * whose interaction produces a known canonicalization problem.
 */
export const KNOWN_CANON_ISSUES = [
    // Intentionally empty at present.
];

/**
 * Check if a failure matches a known issue.
 *
 * @param {{ id: string, features: string[], results: Array }} evaluation
 * @returns {{ isKnown: boolean, knownIssueId?: string }}
 */
export function matchKnownIssue(evaluation) {
    for (const result of evaluation.results) {
        if (result.passed || result.details?.skipped) continue;

        for (const known of KNOWN_CANON_ISSUES) {
            if (result.invariant !== known.invariant) continue;

            const matchesFeature = known.featurePatterns.some((pattern) =>
                evaluation.features.some((f) => f === pattern),
            );

            if (matchesFeature) {
                return { isKnown: true, knownIssueId: known.id };
            }
        }
    }

    return { isKnown: false };
}
