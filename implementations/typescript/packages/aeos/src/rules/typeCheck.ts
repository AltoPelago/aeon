/**
 * @aeos/core - Rules: Type Check
 *
 * Phase 5: Literal kind validation.
 */

import type { DiagContext } from '../diag/emit.js';
import { createDiag, emitError } from '../diag/emit.js';
import { ErrorCodes } from '../diag/codes.js';
import type { Span } from '../types/spans.js';
import type { RuleIndex } from './schemaIndex.js';

/**
 * Mapping from AEON parser type to AEOS constraint type.
 *
 * The parser emits "NumberLiteral" for all numeric literals.
 * AEOS schema uses "IntegerLiteral" / "FloatLiteral" for specificity.
 * We refine those using the literal's raw lexical form.
 */
const TYPE_ALIASES: Record<string, string[]> = {
    // Parser type → Constraint types it satisfies
    'NumberLiteral': ['NumberLiteral'],
    'StringLiteral': ['StringLiteral'],
    'BooleanLiteral': ['BooleanLiteral'],
    'NullLiteral': ['NullLiteral'],
    'ObjectNode': ['ObjectNode'],
    'ListNode': ['ListNode'],
    'ListLiteral': ['ListNode', 'ListLiteral'],
    'TupleLiteral': ['TupleLiteral'],
    'CloneReference': ['CloneReference'],
    'PointerReference': ['PointerReference'],
};

/**
 * Event value with type and span
 */
interface TypedValue {
    type: string;
    raw?: string;
    span: Span;
}

/**
 * Check type constraints for events matching schema rules.
 *
 * For each event whose path has a `type` constraint in the schema,
 * verify the value's literal kind matches the constraint.
 *
 * @param ruleIndex - Schema rule index (path → rule)
 * @param events - Map of path → event value info
 * @param ctx - Diagnostic context
 */
export function checkTypes(
    ruleIndex: RuleIndex,
    events: ReadonlyMap<string, TypedValue>,
    ctx: DiagContext
): void {
    for (const [path, rule] of ruleIndex) {
        const expectedType = rule.constraints.type;
        const expectedContainer = (rule.constraints as any).type_is as 'list' | 'tuple' | undefined;

        if (expectedType === undefined && expectedContainer === undefined) continue;

        const event = events.get(path);
        if (!event) continue; // Missing path handled by presence check

        const actualType = event.type;

        if (expectedContainer !== undefined) {
            const containerOk = expectedContainer === 'list'
                ? (actualType === 'ListLiteral' || actualType === 'ListNode')
                : actualType === 'TupleLiteral';
            if (!containerOk) {
                emitError(ctx, createDiag(
                    path,
                    event.span,
                    `Container kind mismatch: expected ${expectedContainer}, got ${actualType}`,
                    ErrorCodes.WRONG_CONTAINER_KIND
                ));
            }
        }

        if (expectedType === undefined) continue;

        // Check if actual type satisfies expected type
        if (!typeMatches(actualType, expectedType, event.raw)) {
            emitError(ctx, createDiag(
                path,
                event.span,
                `Type mismatch: expected ${expectedType}, got ${actualType}`,
                /\[\d+\]$/.test(path)
                    ? ErrorCodes.TUPLE_ELEMENT_TYPE_MISMATCH
                    : ErrorCodes.TYPE_MISMATCH
            ));
        }
    }
}

/**
 * Check if an actual type satisfies an expected type constraint.
 */
function typeMatches(actualType: string, expectedType: string, raw?: string): boolean {
    // Direct match
    if (actualType === expectedType) return true;

    if (actualType === 'NumberLiteral') {
        if (expectedType === 'IntegerLiteral') {
            return isIntegerNumber(raw);
        }
        if (expectedType === 'FloatLiteral') {
            return isFloatNumber(raw);
        }
    }

    // Check aliases (e.g., NumberLiteral satisfies IntegerLiteral)
    const satisfies = TYPE_ALIASES[actualType];
    if (satisfies && satisfies.includes(expectedType)) return true;

    return false;
}

function isIntegerNumber(raw?: string): boolean {
    if (typeof raw !== 'string') return false;
    return /^[+-]?\d[\d_]*$/.test(raw);
}

function isFloatNumber(raw?: string): boolean {
    if (typeof raw !== 'string') return false;
    return /^[+-]?(?:\d[\d_]*\.\d[\d_]*|\d[\d_]*\.|\.\d[\d_]*|\d[\d_]*[eE][+-]?\d[\d_]*)$/.test(raw);
}
