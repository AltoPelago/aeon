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
        const { sign, min_digits, max_digits, min_value, max_value, radix } = rule.constraints;

        // Skip if no numeric form constraints
        if (sign === undefined && min_digits === undefined && max_digits === undefined && min_value === undefined && max_value === undefined && radix === undefined) {
            continue;
        }

        const event = events.get(path);
        if (!event) continue; // Missing path handled by presence check

        // Only apply to numeric and digit-bearing symbolic literal forms.
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
            const range = normalizeRangeLiteral(event.type, raw);
            if (!range) {
                emitError(ctx, createDiag(
                    path,
                    event.span,
                    `Numeric form violation: range constraints require numeric literal form`,
                    ErrorCodes.NUMERIC_FORM_VIOLATION
                ));
                continue;
            }

            if (min_value !== undefined && isBelowRange(range, min_value)) {
                emitError(ctx, createDiag(
                    path,
                    event.span,
                    `Numeric form violation: expected value >= ${min_value}, got ${range.raw}`,
                    ErrorCodes.NUMERIC_FORM_VIOLATION
                ));
                continue;
            }

            if (max_value !== undefined && isAboveRange(range, max_value)) {
                emitError(ctx, createDiag(
                    path,
                    event.span,
                    `Numeric form violation: expected value <= ${max_value}, got ${range.raw}`,
                    ErrorCodes.NUMERIC_FORM_VIOLATION
                ));
            }
        }
    }
}

function isDigitFormLiteral(type: string): boolean {
    return type === 'NumberLiteral' || type === 'IntegerLiteral' || type === 'FloatLiteral' || type === 'HexLiteral' || type === 'RadixLiteral' || type === 'SeparatorLiteral';
}

function countFormDigits(type: string, raw: string): number {
    if (type === 'NumberLiteral' || type === 'IntegerLiteral' || type === 'FloatLiteral') return countIntegerDigits(raw);
    const body = raw
        .replace(/^[#%^]/, '')
        .replace(/^[+-]/, '')
        .replace(/_/g, '');
    let count = 0;
    for (const char of body) {
        if ((char >= '0' && char <= '9') || (type !== 'SeparatorLiteral' && ((char >= 'A' && char <= 'Z') || (char >= 'a' && char <= 'z') || char === '&' || char === '!'))) {
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

type NormalizedRange = { kind: 'integer'; raw: string; value: bigint } | { kind: 'float'; raw: string; value: number };

function normalizeRangeLiteral(type: string, raw: string): NormalizedRange | null {
    const normalized = raw.replace(/_/g, '');
    if (type === 'FloatLiteral' || /[.eE]/.test(normalized)) {
        if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(normalized)) return null;
        const value = Number(normalized);
        return Number.isFinite(value) ? { kind: 'float', raw: normalized, value } : null;
    }
    if (!/^[+-]?\d+$/.test(normalized)) return null;
    return { kind: 'integer', raw: normalized, value: BigInt(normalized) };
}

function isBelowRange(range: NormalizedRange, bound: string): boolean {
    if (range.kind === 'integer' && /^[-+]?\d+$/.test(bound)) {
        return range.value < BigInt(bound);
    }
    return rangeAsNumber(range) < Number(bound);
}

function isAboveRange(range: NormalizedRange, bound: string): boolean {
    if (range.kind === 'integer' && /^[-+]?\d+$/.test(bound)) {
        return range.value > BigInt(bound);
    }
    return rangeAsNumber(range) > Number(bound);
}

function rangeAsNumber(range: NormalizedRange): number {
    return range.kind === 'integer' ? Number(range.value) : range.value;
}
