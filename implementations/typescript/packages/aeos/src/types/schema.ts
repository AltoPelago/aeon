/**
 * @altopelago/aeos-core - Types: Schema
 *
 * AEOS Constraint Model v1 types.
 */

/**
 * Known constraint keys for v1
 */
export interface AttributeConstraintsV1 extends ConstraintsV1 {}

export interface ConstraintsV1 {
    /** Path must exist in AES */
    readonly required?: boolean;

    /** Expected literal kind (StringLiteral, IntegerLiteral, etc.) */
    readonly type?: string;

    /** Accept when any listed constraint branch matches */
    readonly any_of?: readonly ConstraintsV1[];

    /** Allow NullLiteral to satisfy this type constraint */
    readonly nullable?: boolean;

    /** Allow InfinityLiteral to satisfy numeric type constraints */
    readonly allow_infinity?: boolean;

    /** Allow NaNLiteral to satisfy numeric type constraints */
    readonly allow_nan?: boolean;

    /** Required null sentinel value when the accepted value is NullLiteral */
    readonly null_value?: string;

    /** Accepted null sentinel values when the accepted value is NullLiteral */
    readonly null_values?: readonly string[];

    /** Required toggle lexical pair */
    readonly toggle_pair?: 'any' | 'yes_no' | 'on_off';

    /** Reference form policy for the path */
    readonly reference?: 'allow' | 'forbid' | 'require';

    /** Required reference kind when reference='require' */
    readonly reference_kind?: 'clone' | 'pointer' | 'either';

    /** Regex pattern matched against the canonicalized reference target path */
    readonly reference_target_pattern?: string;

    /** Resolve reference chains before applying form/type constraints on this path */
    readonly resolve_reference_form?: boolean;

    /** Core v1 container kind check: list | tuple */
    readonly type_is?: 'list' | 'tuple';

    /** Core v1 exact container arity constraint */
    readonly length_exact?: number;

    /** Core v1 minimum immediate child count constraint */
    readonly min_children?: number;

    /** Core v1 maximum immediate child count constraint */
    readonly max_children?: number;

    /** For integers: 'signed' or 'unsigned' syntax */
    readonly sign?: 'signed' | 'unsigned';

    /** Minimum ASCII digit count (excludes sign) */
    readonly min_digits?: number;

    /** Maximum ASCII digit count (excludes sign) */
    readonly max_digits?: number;

    /** Exact radix/base required for RadixLiteral digit forms */
    readonly radix?: number;

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

    /** Attribute entry constraints keyed by attribute name */
    readonly attributes?: Readonly<Record<string, AttributeConstraintsV1>>;

    /** Reject unknown attribute keys at this attribute-object level */
    readonly closed_attributes?: boolean;
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

    /** Optional schema-wide reference policy */
    readonly reference_policy?: 'allow' | 'forbid';

    /** Optional schema-wide attribute policy */
    readonly attribute_policy?: 'inherit_world' | 'forbid';

    /** Optional datatype-wide constraints keyed by datatype base label */
    readonly datatype_rules?: Readonly<Record<string, ConstraintsV1>>;
}

/**
 * Known constraint keys for validation
 */
export const KNOWN_CONSTRAINT_KEYS: ReadonlySet<string> = new Set([
    'required',
    'type',
    'any_of',
    'nullable',
    'allow_infinity',
    'allow_nan',
    'null_value',
    'null_values',
    'toggle_pair',
    'reference',
    'reference_kind',
    'reference_target_pattern',
    'resolve_reference_form',
    'type_is',
    'length_exact',
    'min_children',
    'max_children',
    'sign',
    'min_digits',
    'max_digits',
    'radix',
    'min_value',
    'max_value',
    'min_length',
    'max_length',
    'pattern',
    'datatype',
    'attributes',
    'closed_attributes',
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
