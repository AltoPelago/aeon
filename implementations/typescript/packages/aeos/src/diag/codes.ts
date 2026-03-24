/**
 * @aeos/core - Diagnostics: Error Codes
 *
 * Centralized error code registry.
 *
 * Standard codes are lowercase with underscores.
 * Vendor-prefixed codes use format: vendor:code (e.g., mycompany:custom_check)
 */

/**
 * Standard AEOS v1 error codes
 */
export const ErrorCodes = {
    // Baseline invariants (Phase 2)
    DUPLICATE_BINDING: 'duplicate_binding',
    INVALID_FORWARD_REFERENCE: 'invalid_forward_reference',

    // Reference errors (Phase 2)
    MISSING_REFERENCE_TARGET: 'missing_reference_target',

    // Schema errors (Phase 3)
    RULE_MISSING_PATH: 'rule_missing_path',
    DUPLICATE_RULE_PATH: 'duplicate_rule_path',
    UNKNOWN_CONSTRAINT_KEY: 'unknown_constraint_key',

    // Presence checks (Phase 4)
    MISSING_REQUIRED_FIELD: 'missing_required_field',
    UNEXPECTED_BINDING: 'unexpected_binding',

    // Type checks (Phase 5)
    TYPE_MISMATCH: 'type_mismatch',
    WRONG_CONTAINER_KIND: 'WRONG_CONTAINER_KIND',
    TUPLE_ARITY_MISMATCH: 'TUPLE_ARITY_MISMATCH',
    TUPLE_ELEMENT_TYPE_MISMATCH: 'TUPLE_ELEMENT_TYPE_MISMATCH',

    // Core v1 indexed addressing checks
    VERSION_GATE_MISSING: 'version_gate_missing',
    INVALID_INDEX_FORMAT: 'invalid_index_format',

    // Numeric form (Phase 6)
    NUMERIC_FORM_VIOLATION: 'numeric_form_violation',

    // String form (Phase 7)
    STRING_LENGTH_VIOLATION: 'string_length_violation',
    PATTERN_MISMATCH: 'pattern_mismatch',

    // Datatype allow-list enforcement (Phase 8)
    DATATYPE_ALLOWLIST_REJECT: 'datatype_allowlist_reject',
    TRAILING_SEPARATOR_DELIMITER: 'trailing_separator_delimiter',

    // General
    CONSTRAINT_INAPPLICABLE: 'constraint_inapplicable',
} as const;

/**
 * Error code type
 */
export type ErrorCode = typeof ErrorCodes[keyof typeof ErrorCodes];

/**
 * Check if a code is a vendor-prefixed code
 */
export function isVendorCode(code: string): boolean {
    return code.includes(':');
}

/**
 * Parse a vendor code into namespace and code
 */
export function parseVendorCode(code: string): { namespace: string; code: string } | null {
    const colonIndex = code.indexOf(':');
    if (colonIndex === -1) {
        return null;
    }
    return {
        namespace: code.slice(0, colonIndex),
        code: code.slice(colonIndex + 1),
    };
}
