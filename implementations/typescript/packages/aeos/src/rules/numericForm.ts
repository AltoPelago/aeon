/**
 * @aeos/core - Rules: Numeric Form
 *
 * Phase 6: Numeric form constraints (sign, digit count).
 */

import type { DiagContext } from '../diag/emit.js';
import { createDiag, emitError } from '../diag/emit.js';
import { ErrorCodes } from '../diag/codes.js';
import type { Span } from '../types/spans.js';
import type { RuleIndex } from './schemaIndex.js';
import { countIntegerDigits, isNegative } from '../util/digits.js';

/**
 * Event value with type, raw representation, and span
 */
interface NumericValue {
    type: string;
    raw: string;
    span: Span;
}

/**
 * Check numeric form constraints for events matching schema rules.
 *
 * For each event with numeric form constraints (sign, min_digits, max_digits),
 * verify the literal's lexical representation satisfies the constraints.
 *
 * @param ruleIndex - Schema rule index (path → rule)
 * @param events - Map of path → numeric value info
 * @param ctx - Diagnostic context
 */
export function checkNumericForm(
    ruleIndex: RuleIndex,
    events: ReadonlyMap<string, NumericValue>,
    ctx: DiagContext
): void {
    for (const [path, rule] of ruleIndex) {
        const { sign, min_digits, max_digits, min_value, max_value } = rule.constraints;

        // Skip if no numeric form constraints
        if (sign === undefined && min_digits === undefined && max_digits === undefined && min_value === undefined && max_value === undefined) {
            continue;
        }

        const event = events.get(path);
        if (!event) continue; // Missing path handled by presence check

        // Only apply to numeric types
        if (event.type !== 'NumberLiteral' && event.type !== 'IntegerLiteral' && event.type !== 'FloatLiteral') {
            continue;
        }

        const raw = event.raw;

        // Sign constraint
        if (sign !== undefined) {
            if (sign === 'unsigned' && isNegative(raw)) {
                emitError(ctx, createDiag(
                    path,
                    event.span,
                    `Numeric form violation: expected unsigned, got negative`,
                    ErrorCodes.NUMERIC_FORM_VIOLATION
                ));
                continue; // Only report first violation per path
            }
            // 'signed' constraint allows both positive and negative
        }

        // Digit count constraints
        const digitCount = countIntegerDigits(raw);

        if (min_digits !== undefined && digitCount < min_digits) {
            emitError(ctx, createDiag(
                path,
                event.span,
                `Numeric form violation: expected min ${min_digits} digits, got ${digitCount}`,
                ErrorCodes.NUMERIC_FORM_VIOLATION
            ));
            continue;
        }

        if (max_digits !== undefined && digitCount > max_digits) {
            emitError(ctx, createDiag(
                path,
                event.span,
                `Numeric form violation: expected max ${max_digits} digits, got ${digitCount}`,
                ErrorCodes.NUMERIC_FORM_VIOLATION
            ));
            continue;
        }

        if (min_value !== undefined || max_value !== undefined) {
            const normalized = normalizeIntegerLiteral(raw);
            if (!normalized) {
                emitError(ctx, createDiag(
                    path,
                    event.span,
                    `Numeric form violation: exact integer range constraints require integer literal form`,
                    ErrorCodes.NUMERIC_FORM_VIOLATION
                ));
                continue;
            }

            const numeric = BigInt(normalized);

            if (min_value !== undefined && numeric < BigInt(min_value)) {
                emitError(ctx, createDiag(
                    path,
                    event.span,
                    `Numeric form violation: expected value >= ${min_value}, got ${normalized}`,
                    ErrorCodes.NUMERIC_FORM_VIOLATION
                ));
                continue;
            }

            if (max_value !== undefined && numeric > BigInt(max_value)) {
                emitError(ctx, createDiag(
                    path,
                    event.span,
                    `Numeric form violation: expected value <= ${max_value}, got ${normalized}`,
                    ErrorCodes.NUMERIC_FORM_VIOLATION
                ));
            }
        }
    }
}

function normalizeIntegerLiteral(raw: string): string | null {
    if (!/^[+-]?\d[\d_]*$/.test(raw)) return null;
    return raw.replace(/_/g, '');
}
