/**
 * @aeos/core - Rules: Schema Index
 *
 * Build a fast lookup index from schema rules.
 */

import type { SchemaV1, SchemaRule } from '../types/schema.js';
import { hasUnknownConstraintKeys } from '../types/schema.js';
import type { DiagContext } from '../diag/emit.js';
import { createDiag, emitError } from '../diag/emit.js';
import { ErrorCodes } from '../diag/codes.js';

function isReferenceType(type: string | undefined): boolean {
    return type === 'CloneReference' || type === 'PointerReference';
}

function validateReferenceConstraints(
    schema: SchemaV1,
    rule: SchemaRule,
    ctx: DiagContext
): boolean {
    const reference = rule.constraints.reference;
    const referenceKind = rule.constraints.reference_kind;
    const expectedType = typeof rule.constraints.type === 'string' ? rule.constraints.type : undefined;
    const schemaReferencePolicy = schema.reference_policy;

    if (reference !== undefined && !['allow', 'forbid', 'require'].includes(reference)) {
        emitError(ctx, createDiag(
            rule.path,
            null,
            `Invalid reference constraint for path ${rule.path}: ${String(reference)}`,
            ErrorCodes.INVALID_REFERENCE_CONSTRAINT
        ));
        return false;
    }

    if (referenceKind !== undefined && !['clone', 'pointer', 'either'].includes(referenceKind)) {
        emitError(ctx, createDiag(
            rule.path,
            null,
            `Invalid reference_kind constraint for path ${rule.path}: ${String(referenceKind)}`,
            ErrorCodes.INVALID_REFERENCE_CONSTRAINT
        ));
        return false;
    }

    if (referenceKind !== undefined && reference !== 'require') {
        emitError(ctx, createDiag(
            rule.path,
            null,
            `reference_kind requires reference='require' for path ${rule.path}`,
            ErrorCodes.INVALID_REFERENCE_CONSTRAINT
        ));
        return false;
    }

    if (reference === 'forbid' && isReferenceType(expectedType)) {
        emitError(ctx, createDiag(
            rule.path,
            null,
            `reference='forbid' conflicts with type='${expectedType}' for path ${rule.path}`,
            ErrorCodes.INVALID_REFERENCE_CONSTRAINT
        ));
        return false;
    }

    if (reference === 'require' && expectedType !== undefined && !isReferenceType(expectedType)) {
        emitError(ctx, createDiag(
            rule.path,
            null,
            `reference='require' conflicts with non-reference type='${expectedType}' for path ${rule.path}`,
            ErrorCodes.INVALID_REFERENCE_CONSTRAINT
        ));
        return false;
    }

    if (referenceKind === 'clone' && expectedType === 'PointerReference') {
        emitError(ctx, createDiag(
            rule.path,
            null,
            `reference_kind='clone' conflicts with type='PointerReference' for path ${rule.path}`,
            ErrorCodes.INVALID_REFERENCE_CONSTRAINT
        ));
        return false;
    }

    if (referenceKind === 'pointer' && expectedType === 'CloneReference') {
        emitError(ctx, createDiag(
            rule.path,
            null,
            `reference_kind='pointer' conflicts with type='CloneReference' for path ${rule.path}`,
            ErrorCodes.INVALID_REFERENCE_CONSTRAINT
        ));
        return false;
    }

    if (schemaReferencePolicy === 'forbid' && (reference === 'require' || isReferenceType(expectedType))) {
        emitError(ctx, createDiag(
            rule.path,
            null,
            `schema reference_policy='forbid' conflicts with rule for path ${rule.path}`,
            ErrorCodes.INVALID_REFERENCE_CONSTRAINT
        ));
        return false;
    }

    return true;
}

/**
 * Rule index: Map from canonical path to rule
 */
export type RuleIndex = ReadonlyMap<string, SchemaRule>;

/**
 * Build a rule index from a schema.
 *
 * This preprocesses schema.rules into a Map<path, Rule> for O(1) lookup.
 * Emits errors for:
 * - Missing path in rule
 * - Duplicate rule paths
 * - Unknown constraint keys
 *
 * @param schema - AEOS Schema v1
 * @param ctx - Diagnostic context for errors
 * @returns Rule index map
 */
export function buildRuleIndex(schema: SchemaV1, ctx: DiagContext): RuleIndex {
    const index = new Map<string, SchemaRule>();
    // Schema-level allowlist for datatype identifiers (optional)
    const datatypeAllowlist: readonly string[] | undefined = (schema as any).datatype_allowlist;

    if (schema.reference_policy !== undefined && !['allow', 'forbid'].includes(schema.reference_policy)) {
        emitError(ctx, createDiag(
            '$',
            null,
            `Invalid schema reference_policy: ${String(schema.reference_policy)}`,
            ErrorCodes.INVALID_REFERENCE_CONSTRAINT
        ));
    }

    for (const rule of schema.rules) {
        // Check for missing path
        if (!rule.path || typeof rule.path !== 'string') {
            emitError(ctx, createDiag(
                '<unknown>',
                null,
                'Rule missing required "path" field',
                ErrorCodes.RULE_MISSING_PATH
            ));
            continue;
        }

        // Check for duplicate rule paths
        if (index.has(rule.path)) {
            emitError(ctx, createDiag(
                rule.path,
                null,
                `Duplicate rule for path: ${rule.path}`,
                ErrorCodes.DUPLICATE_RULE_PATH
            ));
            continue;
        }

        // Check for unknown constraint keys
        if (hasUnknownConstraintKeys(rule.constraints as Record<string, unknown>)) {
            emitError(ctx, createDiag(
                rule.path,
                null,
                `Unknown constraint key in rule for path: ${rule.path}`,
                ErrorCodes.UNKNOWN_CONSTRAINT_KEY
            ));
            continue;
        }

        if (!validateReferenceConstraints(schema, rule, ctx)) {
            continue;
        }

        // Enforce datatype allow-list if provided at schema level.
        // This is a form-only membership check: the `datatype` string
        // must be present in the schema.datatype_allowlist array when
        // that array is provided. Emit a value-level diagnostic code
        // to indicate the identifier is not allowed.
        if (datatypeAllowlist && rule.constraints && typeof (rule.constraints as any).datatype === 'string') {
            const dt = (rule.constraints as any).datatype as string;
            if (!datatypeAllowlist.includes(dt)) {
                emitError(ctx, createDiag(
                    rule.path,
                    null,
                    `Datatype '${dt}' not allowed by schema datatype_allowlist`,
                    ErrorCodes.DATATYPE_ALLOWLIST_REJECT
                ));
                // continue; still index the rule so other checks can run
            }
        }

        index.set(rule.path, rule);
    }

    return index;
}

/**
 * Check if a rule has numeric form constraints
 */
export function hasNumericFormConstraints(constraints: SchemaRule['constraints']): boolean {
    return (
        constraints.sign !== undefined ||
        constraints.min_digits !== undefined ||
        constraints.max_digits !== undefined
    );
}

/**
 * Check if a rule has string form constraints
 */
export function hasStringFormConstraints(constraints: SchemaRule['constraints']): boolean {
    return (
        constraints.pattern !== undefined ||
        constraints.min_length !== undefined ||
        constraints.max_length !== undefined
    );
}
