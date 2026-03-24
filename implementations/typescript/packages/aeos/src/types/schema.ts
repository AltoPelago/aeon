/**
 * @aeos/core - Types: Schema
 *
 * AEOS Constraint Model v1 types.
 */

/**
 * Known constraint keys for v1
 */
export interface ConstraintsV1 {
    /** Path must exist in AES */
    readonly required?: boolean;

    /** Expected literal kind (StringLiteral, IntegerLiteral, etc.) */
    readonly type?: string;

    /** Core v1 container kind check: list | tuple */
    readonly type_is?: 'list' | 'tuple';

    /** Core v1 exact container arity constraint */
    readonly length_exact?: number;

    /** For integers: 'signed' or 'unsigned' syntax */
    readonly sign?: 'signed' | 'unsigned';

    /** Minimum ASCII digit count (excludes sign) */
    readonly min_digits?: number;

    /** Maximum ASCII digit count (excludes sign) */
    readonly max_digits?: number;

    /** Minimum integer value (inclusive), encoded as base-10 string for exactness */
    readonly min_value?: string;

    /** Maximum integer value (inclusive), encoded as base-10 string for exactness */
    readonly max_value?: string;

    /** Minimum string length in UTF-16 code units (JavaScript string.length) */
    readonly min_length?: number;

    /** Maximum string length in UTF-16 code units (JavaScript string.length) */
    readonly max_length?: number;

    /** Regex pattern for string matching */
    readonly pattern?: string;

    /** Datatype label (presence check only, no capacity) */
    readonly datatype?: string;
}

/**
 * Schema rule for a canonical path
 */
export interface SchemaRule {
    /** Canonical path this rule applies to */
    readonly path: string;

    /** Constraints to apply */
    readonly constraints: ConstraintsV1;
}

/**
 * AEOS Schema v1
 */
export interface SchemaV1 {
    /** Array of rules */
    readonly rules: readonly SchemaRule[];

    /** Open-world or closed-world validation policy */
    readonly world?: 'open' | 'closed';

    /** Optional datatype-wide constraints keyed by datatype base label */
    readonly datatype_rules?: Readonly<Record<string, ConstraintsV1>>;
}

/**
 * Known constraint keys for validation
 */
export const KNOWN_CONSTRAINT_KEYS: ReadonlySet<string> = new Set([
    'required',
    'type',
    'type_is',
    'length_exact',
    'sign',
    'min_digits',
    'max_digits',
    'min_value',
    'max_value',
    'min_length',
    'max_length',
    'pattern',
    'datatype',
]);

/**
 * Check if a constraints object has any unknown keys
 */
export function hasUnknownConstraintKeys(constraints: Record<string, unknown>): boolean {
    for (const key of Object.keys(constraints)) {
        if (!KNOWN_CONSTRAINT_KEYS.has(key)) {
            return true;
        }
    }
    return false;
}
