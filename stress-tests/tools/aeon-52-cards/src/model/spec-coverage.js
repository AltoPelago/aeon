/**
 * AEON 52-Cards Spec Coverage Ledger
 *
 * Maps selected official AEON v1 requirements to the feature and boundary
 * cases that currently exercise them.
 *
 * Status model:
 * - covered: all required feature IDs are present in the generated corpus
 * - partial: some, but not all, required feature IDs are present
 * - uncovered: no required feature IDs are present
 */

import { ALL_FEATURES } from './features.js';

const FEATURE_EXPECT_PASS = new Map(
    ALL_FEATURES.map((feature) => [feature.id, feature.generate({}).expectPass]),
);

export const SPEC_COVERAGE_LEDGER = [
    {
        id: 'keys.forms',
        label: 'Key forms and quoted-key failures',
        source: 'AEON-v1-compliance §3',
        requiredFeatures: [
            'key-bare',
            'key-single-quoted',
            'key-double-quoted',
            'key-backtick-invalid',
            'key-invalid-escape',
        ],
    },
    {
        id: 'values.core-families',
        label: 'Core scalar value families',
        source: 'value-types-v1',
        requiredFeatures: [
            'string-double',
            'string-single',
            'string-backtick',
            'number-integer',
            'number-float',
            'number-scientific',
            'number-underscore',
            'boolean-true',
            'boolean-false',
            'switch-on',
            'switch-off',
            'hex-literal',
            'radix-literal',
            'encoding-literal',
            'date-literal',
            'datetime-literal',
            'zrut-literal',
            'zrut-local-literal',
            'separator-literal',
        ],
    },
    {
        id: 'values.numeric-underscore-negatives',
        label: 'Numeric underscore invalid forms',
        source: 'AEON-v1-compliance §12',
        requiredFeatures: [
            'number-invalid-underscore-leading',
            'number-invalid-underscore-double',
            'number-invalid-underscore-trailing',
        ],
    },
    {
        id: 'references.addressing',
        label: 'Reference and addressing forms',
        source: 'AEON-v1-compliance §4',
        requiredFeatures: [
            'ref-clone-simple',
            'ref-pointer',
            'ref-dotted-path',
            'ref-indexed-path',
            'ref-quoted-segment',
            'ref-root-qualified',
            'ref-mixed-quoted-path',
            'ref-attr-selector',
            'ref-quoted-attr-selector',
            'ref-forward-invalid',
            'ref-self-invalid',
            'ref-missing-invalid',
        ],
    },
    {
        id: 'attributes.attachment-and-order',
        label: 'Attribute syntax, ordering, and attachment scope',
        source: 'AEON-v1-compliance §4, §7',
        requiredFeatures: [
            'attr-single',
            'attr-multi-comma',
            'attr-multi-newline',
            'attr-empty',
            'attr-reversed-order-invalid',
            'attr-on-container',
            'attr-postfix-literal-invalid',
            'nesting-attrs-on-nested',
        ],
    },
    {
        id: 'types.datatype-policy-and-separators',
        label: 'Datatype policy and separator-char negatives',
        source: 'AEON-v1-compliance §7.1, §8',
        requiredFeatures: [
            'type-reserved',
            'type-custom',
            'type-generic-args',
            'type-separator-spec',
            'type-multi-separator-spec',
            'type-switch-custom-invalid',
            'type-transport-mismatch-invalid',
            'type-separator-char-comma-invalid',
            'type-separator-char-semicolon-invalid',
            'type-separator-char-lbracket-invalid',
            'type-separator-char-rbracket-invalid',
        ],
    },
    {
        id: 'comments.channels',
        label: 'Plain, structured, host, and reserved comment channels',
        source: 'comments-annotations-v1',
        requiredFeatures: [
            'comment-plain-line',
            'comment-plain-block',
            'comment-doc-line',
            'comment-doc-block',
            'comment-annotation-line',
            'comment-annotation-block',
            'comment-hint-line',
            'comment-hint-block',
            'comment-host-line',
            'comment-reserved-structure',
            'comment-reserved-profile',
            'comment-reserved-instructions',
            'comment-reserved-structure-line',
            'comment-reserved-profile-line',
            'comment-reserved-instructions-line',
            'comment-trailing-same-line',
            'comment-infix-list',
            'comment-unterminated-block-invalid',
        ],
    },
    {
        id: 'nodes.surface',
        label: 'Node introducer syntax and nesting',
        source: 'AEON-v1-compliance §9',
        requiredFeatures: [
            'node-simple',
            'node-nested',
            'node-with-attrs',
            'nesting-node-in-node',
            'layout-node-mixed-separators',
        ],
    },
    {
        id: 'boundaries.smoke',
        label: 'Current lightweight smoke boundaries',
        source: 'boundary generator',
        requiredFeatures: [
            'deep-nesting-64',
            'long-key-1024',
            'separator-depth-4',
        ],
        optionalFeatures: [
            'deep-nesting-30',
            'long-key-512',
            'large-list-100',
            'large-list-500',
            'many-annotations-50',
            'many-annotations-200',
        ],
    },
    {
        id: 'boundaries.official-floors',
        label: 'Official v1 minimum conformance floors',
        source: 'AEON-v1-compliance §13',
        requiredFeatures: [
            'string-floor-1048576',
            'numeric-lex-floor-1024',
            'list-floor-65536',
            'path-floor-8192',
            'comment-payload-floor-1048576',
        ],
    },
    {
        id: 'implementation.trailing-separators',
        label: 'Implementation-behavior-only trailing separator acceptance',
        source: 'current TS parser behavior',
        implementationOnly: true,
        requiredFeatures: [
            'attr-trailing-comma',
            'layout-list-trailing-comma',
        ],
    },
];

export function evaluateSpecCoverage(featureIds) {
    const seen = new Set(featureIds);

    const items = SPEC_COVERAGE_LEDGER.map((entry) => {
        const required = entry.requiredFeatures ?? [];
        const optional = entry.optionalFeatures ?? [];
        const coveredRequired = required.filter((id) => seen.has(id));
        const coveredOptional = optional.filter((id) => seen.has(id));

        let status = 'uncovered';
        if (required.length === 0 || coveredRequired.length === required.length) {
            status = 'covered';
        } else if (coveredRequired.length > 0 || coveredOptional.length > 0) {
            status = 'partial';
        }

        return {
            id: entry.id,
            label: entry.label,
            source: entry.source,
            implementationOnly: entry.implementationOnly === true,
            status,
            coveredRequired: coveredRequired.length,
            totalRequired: required.length,
            coveredOptional: coveredOptional.length,
            totalOptional: optional.length,
            missingRequired: required.filter((id) => !seen.has(id)),
            missingRequiredValid: required.filter((id) => !seen.has(id) && FEATURE_EXPECT_PASS.get(id) !== false),
            missingRequiredNegative: required.filter((id) => !seen.has(id) && FEATURE_EXPECT_PASS.get(id) === false),
        };
    });

    const summary = {
        covered: items.filter((item) => item.status === 'covered').length,
        partial: items.filter((item) => item.status === 'partial').length,
        uncovered: items.filter((item) => item.status === 'uncovered').length,
    };

    return { items, summary };
}
