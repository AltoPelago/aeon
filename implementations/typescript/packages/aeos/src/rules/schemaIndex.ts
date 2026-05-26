/**
 * @altopelago/aeos-core - Rules: Schema Index
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
    rulePath: string,
    constraints: Record<string, unknown>,
    ctx: DiagContext
): boolean {
    const reference = constraints.reference;
    const referenceKind = constraints.reference_kind;
    const referenceTargetPattern = constraints.reference_target_pattern;
    const resolveReferenceForm = constraints.resolve_reference_form;
    const expectedType = typeof constraints.type === 'string' ? constraints.type : undefined;
    const schemaReferencePolicy = schema.reference_policy;

    if (reference !== undefined && (typeof reference !== 'string' || !['allow', 'forbid', 'require'].includes(reference))) {
        emitError(ctx, createDiag(
            rulePath,
            null,
            `Invalid reference constraint for path ${rulePath}: ${String(reference)}`,
            ErrorCodes.INVALID_REFERENCE_CONSTRAINT
        ));
        return false;
    }

    if (referenceKind !== undefined && (typeof referenceKind !== 'string' || !['clone', 'pointer', 'either'].includes(referenceKind))) {
        emitError(ctx, createDiag(
            rulePath,
            null,
            `Invalid reference_kind constraint for path ${rulePath}: ${String(referenceKind)}`,
            ErrorCodes.INVALID_REFERENCE_CONSTRAINT
        ));
        return false;
    }

    if (referenceKind !== undefined && reference !== 'require') {
        emitError(ctx, createDiag(
            rulePath,
            null,
            `reference_kind requires reference='require' for path ${rulePath}`,
            ErrorCodes.INVALID_REFERENCE_CONSTRAINT
        ));
        return false;
    }

    if (referenceTargetPattern !== undefined) {
        if (typeof referenceTargetPattern !== 'string') {
            emitError(ctx, createDiag(
                rulePath,
                null,
                `Invalid reference_target_pattern constraint for path ${rulePath}: ${String(referenceTargetPattern)}`,
                ErrorCodes.INVALID_REFERENCE_CONSTRAINT
            ));
            return false;
        }
        try {
            new RegExp(referenceTargetPattern);
        } catch {
            emitError(ctx, createDiag(
                rulePath,
                null,
                `Invalid reference_target_pattern regex for path ${rulePath}: ${referenceTargetPattern}`,
                ErrorCodes.INVALID_REFERENCE_CONSTRAINT
            ));
            return false;
        }
        if (reference === 'forbid') {
            emitError(ctx, createDiag(
                rulePath,
                null,
                `reference_target_pattern conflicts with reference='forbid' for path ${rulePath}`,
                ErrorCodes.INVALID_REFERENCE_CONSTRAINT
            ));
            return false;
        }
    }

    if (resolveReferenceForm !== undefined && typeof resolveReferenceForm !== 'boolean') {
        emitError(ctx, createDiag(
            rulePath,
            null,
            `resolve_reference_form must be boolean for path ${rulePath}`,
            ErrorCodes.INVALID_REFERENCE_CONSTRAINT
        ));
        return false;
    }

    if (reference === 'forbid' && expectedType !== undefined && isReferenceType(expectedType)) {
        emitError(ctx, createDiag(
            rulePath,
            null,
            `reference='forbid' conflicts with type='${expectedType}' for path ${rulePath}`,
            ErrorCodes.INVALID_REFERENCE_CONSTRAINT
        ));
        return false;
    }

    if (reference === 'require' && expectedType !== undefined && !isReferenceType(expectedType)) {
        emitError(ctx, createDiag(
            rulePath,
            null,
            `reference='require' conflicts with non-reference type='${expectedType}' for path ${rulePath}`,
            ErrorCodes.INVALID_REFERENCE_CONSTRAINT
        ));
        return false;
    }

    if (referenceKind === 'clone' && expectedType === 'PointerReference') {
        emitError(ctx, createDiag(
            rulePath,
            null,
            `reference_kind='clone' conflicts with type='PointerReference' for path ${rulePath}`,
            ErrorCodes.INVALID_REFERENCE_CONSTRAINT
        ));
        return false;
    }

    if (referenceKind === 'pointer' && expectedType === 'CloneReference') {
        emitError(ctx, createDiag(
            rulePath,
            null,
            `reference_kind='pointer' conflicts with type='CloneReference' for path ${rulePath}`,
            ErrorCodes.INVALID_REFERENCE_CONSTRAINT
        ));
        return false;
    }

    if (schemaReferencePolicy === 'forbid' && (reference === 'require' || (expectedType !== undefined && isReferenceType(expectedType)))) {
        emitError(ctx, createDiag(
            rulePath,
            null,
            `schema reference_policy='forbid' conflicts with rule for path ${rulePath}`,
            ErrorCodes.INVALID_REFERENCE_CONSTRAINT
        ));
        return false;
    }

    return true;
}

function validateConstraintTree(
    schema: SchemaV1,
    rulePath: string,
    constraints: Record<string, unknown>,
    ctx: DiagContext
): boolean {
    if (hasUnknownConstraintKeys(constraints)) {
        emitError(ctx, createDiag(
            rulePath,
            null,
            `Unknown constraint key in rule for path: ${rulePath}`,
            ErrorCodes.UNKNOWN_CONSTRAINT_KEY
        ));
        return false;
    }

    if (!validateReferenceConstraints(schema, rulePath, constraints, ctx)) {
        return false;
    }

    if (constraints.toggle_pair !== undefined && !['any', 'yes_no', 'on_off'].includes(String(constraints.toggle_pair))) {
        emitError(ctx, createDiag(
            rulePath,
            null,
            `Invalid toggle_pair constraint for path ${rulePath}`,
            ErrorCodes.UNKNOWN_CONSTRAINT_KEY
        ));
        return false;
    }

    if (constraints.null_values !== undefined && (!Array.isArray(constraints.null_values) || !constraints.null_values.every((value) => typeof value === 'string'))) {
        emitError(ctx, createDiag(
            rulePath,
            null,
            `Invalid null_values constraint for path ${rulePath}`,
            ErrorCodes.UNKNOWN_CONSTRAINT_KEY
        ));
        return false;
    }

    if (constraints.any_of !== undefined) {
        if (!Array.isArray(constraints.any_of) || constraints.any_of.length === 0) {
            emitError(ctx, createDiag(
                rulePath,
                null,
                `Invalid any_of constraint for path ${rulePath}`,
                ErrorCodes.UNKNOWN_CONSTRAINT_KEY
            ));
            return false;
        }
        for (const [index, branch] of constraints.any_of.entries()) {
            if (branch === null || typeof branch !== 'object' || Array.isArray(branch)) {
                emitError(ctx, createDiag(
                    `${rulePath}.any_of[${index}]`,
                    null,
                    `Invalid any_of branch for path ${rulePath}`,
                    ErrorCodes.UNKNOWN_CONSTRAINT_KEY
                ));
                return false;
            }
            if (!validateConstraintTree(schema, `${rulePath}.any_of[${index}]`, branch as Record<string, unknown>, ctx)) {
                return false;
            }
        }
    }

    for (const key of ['min_children', 'max_children', 'length_exact', 'radix'] as const) {
        const value = constraints[key];
        if (value !== undefined && (typeof value !== 'number' || !Number.isInteger(value) || value < 0)) {
            emitError(ctx, createDiag(
                rulePath,
                null,
                `Invalid ${key} constraint for path ${rulePath}`,
                ErrorCodes.UNKNOWN_CONSTRAINT_KEY
            ));
            return false;
        }
    }

    const nestedAttributes = constraints.attributes;
    if (nestedAttributes === undefined) {
        return true;
    }
    if (nestedAttributes === null || typeof nestedAttributes !== 'object' || Array.isArray(nestedAttributes)) {
        emitError(ctx, createDiag(
            rulePath,
            null,
            `Invalid attributes constraint for path ${rulePath}`,
            ErrorCodes.UNKNOWN_CONSTRAINT_KEY
        ));
        return false;
    }

    for (const [key, childConstraints] of Object.entries(nestedAttributes)) {
        if (childConstraints === null || typeof childConstraints !== 'object' || Array.isArray(childConstraints)) {
            emitError(ctx, createDiag(
                `${rulePath}@${key}`,
                null,
                `Invalid attribute constraint for path ${rulePath}@${key}`,
                ErrorCodes.UNKNOWN_CONSTRAINT_KEY
            ));
            return false;
        }
        if (!validateConstraintTree(schema, `${rulePath}@${key}`, childConstraints as Record<string, unknown>, ctx)) {
            return false;
        }
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
    if (schema.attribute_policy !== undefined && !['inherit_world', 'forbid'].includes(schema.attribute_policy)) {
        emitError(ctx, createDiag(
            '$',
            null,
            `Invalid schema attribute_policy: ${String(schema.attribute_policy)}`,
            ErrorCodes.INVALID_SCHEMA_POLICY
        ));
    }

    for (const rule of schema.rules) {
        const hasPath = typeof rule.path === 'string' && rule.path.length > 0;
        const hasSelector = typeof rule.selector === 'string' && rule.selector.length > 0;
        const ruleKey = hasPath ? rule.path! : hasSelector ? rule.selector! : '<unknown>';

        // Check for missing path/selector
        if (!hasPath && !hasSelector) {
            emitError(ctx, createDiag(
                '<unknown>',
                null,
                'Rule missing required "path" or "selector" field',
                ErrorCodes.RULE_MISSING_PATH
            ));
            continue;
        }

        if (hasPath && hasSelector) {
            emitError(ctx, createDiag(
                ruleKey,
                null,
                `Rule must use either "path" or "selector", not both: ${ruleKey}`,
                ErrorCodes.RULE_MISSING_PATH
            ));
            continue;
        }

        // Check for duplicate rule paths
        if (hasPath && index.has(rule.path!)) {
            emitError(ctx, createDiag(
                rule.path!,
                null,
                `Duplicate rule for path: ${rule.path!}`,
                ErrorCodes.DUPLICATE_RULE_PATH
            ));
            continue;
        }

        if (!validateConstraintTree(schema, ruleKey, rule.constraints as Record<string, unknown>, ctx)) {
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
                    ruleKey,
                    null,
                    `Datatype '${dt}' not allowed by schema datatype_allowlist`,
                    ErrorCodes.DATATYPE_ALLOWLIST_REJECT
                ));
                // continue; still index the rule so other checks can run
            }
        }

        if (hasPath) {
            index.set(rule.path!, rule);
        }
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
