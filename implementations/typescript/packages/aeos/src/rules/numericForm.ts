/**
 * @altopelago/aeos-core - Rules: Numeric Form
 *
 * Phase 6: Numeric form constraints (sign, digit count).
 */

import type { DiagContext } from '../diag/emit.js';
import { createDiag, emitError } from '../diag/emit.js';
import { ErrorCodes } from '../diag/codes.js';
import type { Span } from '../types/spans.js';
import type { RuleIndex } from './schemaIndex.js';
import { countIntegerDigits, isNegative } from '../util/digits.js';
import { declaredRadixFromDatatype } from '../util/datatypes.js';
import { compareNumericValues } from '../util/numericBounds.js';

/**
 * Event value with type, raw representation, and span
 */
interface NumericValue {
    type: string;
    raw: string;
    datatype?: string;
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
        const { sign, min_digits, max_digits, min_value, max_value, radix } = rule.constraints;

        // Skip if no numeric form constraints
        if (sign === undefined && min_digits === undefined && max_digits === undefined && min_value === undefined && max_value === undefined && radix === undefined) {
            continue;
        }

        const event = events.get(path);
        if (!event) continue; // Missing path handled by presence check

        // Only apply to numeric and radix-like symbolic literal forms.
        if (!isDigitFormLiteral(event.type)) {
            continue;
        }

        const raw = event.raw;

        // Sign constraint
        if (sign !== undefined && (event.type === 'NumberLiteral' || event.type === 'IntegerLiteral' || event.type === 'FloatLiteral' || event.type === 'RadixLiteral')) {
            if (sign === 'unsigned' && isFormNegative(raw)) {
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
        const digitCount = countFormDigits(event.type, raw);

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

        if (event.type === 'RadixLiteral' && radix !== undefined) {
            const declaredRadix = declaredRadixFromDatatype(event.datatype);
            if (declaredRadix === null && rule.constraints.allow_unspecified_radix !== true) {
                emitError(ctx, createDiag(
                    path,
                    event.span,
                    `Numeric form violation: radix literal requires declared radix ${radix}`,
                    ErrorCodes.NUMERIC_FORM_VIOLATION
                ));
                continue;
            }
            if (declaredRadix !== null && declaredRadix !== radix) {
                emitError(ctx, createDiag(
                    path,
                    event.span,
                    `Numeric form violation: expected radix ${radix}, got declared radix ${declaredRadix}`,
                    ErrorCodes.NUMERIC_FORM_VIOLATION
                ));
                continue;
            }
            const invalidDigit = firstInvalidRadixDigit(raw, radix);
            if (invalidDigit !== null) {
                emitError(ctx, createDiag(
                    path,
                    event.span,
                    `Numeric form violation: radix literal digit '${invalidDigit}' is outside radix ${radix}`,
                    ErrorCodes.NUMERIC_FORM_VIOLATION
                ));
                continue;
            }
        }

        if (min_value !== undefined || max_value !== undefined) {
            const normalized = normalizeRangeLiteral(event.type, raw);
            if (!normalized) {
                emitError(ctx, createDiag(
                    path,
                    event.span,
                    `Numeric form violation: range constraints require numeric literal form`,
                    ErrorCodes.NUMERIC_FORM_VIOLATION
                ));
                continue;
            }

            if (min_value !== undefined && compareNumericValues(normalized, min_value) === -1) {
                emitError(ctx, createDiag(
                    path,
                    event.span,
                    `Numeric form violation: expected value >= ${min_value}, got ${normalized}`,
                    ErrorCodes.NUMERIC_FORM_VIOLATION
                ));
                continue;
            }

            if (max_value !== undefined && compareNumericValues(normalized, max_value) === 1) {
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

function isDigitFormLiteral(type: string): boolean {
    return type === 'NumberLiteral' || type === 'IntegerLiteral' || type === 'FloatLiteral' || type === 'HexLiteral' || type === 'RadixLiteral';
}

function countFormDigits(type: string, raw: string): number {
    if (type === 'NumberLiteral' || type === 'IntegerLiteral' || type === 'FloatLiteral') return countIntegerDigits(raw);
    const body = raw
        .replace(/^[#%^]/, '')
        .replace(/^[+-]/, '')
        .replace(/_/g, '');
    let count = 0;
    for (const char of body) {
        if ((char >= '0' && char <= '9') || ((char >= 'A' && char <= 'Z') || (char >= 'a' && char <= 'z') || char === '&' || char === '!')) {
            count++;
        }
    }
    return count;
}

function isFormNegative(raw: string): boolean {
    return /^[$#%^]?-/.test(raw) || isNegative(raw);
}

function firstInvalidRadixDigit(raw: string, radix: number): string | null {
    const body = raw.replace(/^%/, '').replace(/^[+-]/, '').replace(/_/g, '');
    for (const char of body) {
        const value = radixDigitValue(char);
        if (value !== null && value >= radix) return char;
    }
    return null;
}

function radixDigitValue(char: string): number | null {
    if (char >= '0' && char <= '9') return char.charCodeAt(0) - 48;
    const lower = char.toLowerCase();
    if (lower >= 'a' && lower <= 'z') return lower.charCodeAt(0) - 87;
    if (char === '&') return 36;
    if (char === '!') return 37;
    return null;
}

function normalizeRangeLiteral(type: string, raw: string): string | null {
    const normalized = raw.replace(/_/g, '');
    if (type !== 'FloatLiteral' && type !== 'NumberLiteral' && type !== 'IntegerLiteral') return null;
    return compareNumericValues(normalized, normalized) === null ? null : normalized;
}
