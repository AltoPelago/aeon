/**
 * @aeos/core - Rules: String Form
 *
 * Phase 7: String form constraints (min_length, max_length, pattern).
 */

import type { DiagContext } from '../diag/emit.js';
import { createDiag, emitError } from '../diag/emit.js';
import { ErrorCodes } from '../diag/codes.js';
import type { Span } from '../types/spans.js';
import type { RuleIndex } from './schemaIndex.js';

/**
 * Event value with type, processed value string, and span
 */
interface StringValue {
    type: string;
    value: string;
    span: Span;
}

/**
 * Check string form constraints for events matching schema rules.
 *
 * For each event with string form constraints (min_length, max_length),
 * verify the string value's length satisfies the constraints.
 *
 * AEOS v1 Decision: Length is measured in UTF-16 code units (JavaScript
 * string.length). This means surrogate pairs (emoji, etc.) count as 2.
 * This is intentional for v1 simplicity and JavaScript compatibility.
 *
 * @param ruleIndex - Schema rule index (path → rule)
 * @param events - Map of path → string value info
 * @param ctx - Diagnostic context
 */
export function checkStringForm(
    ruleIndex: RuleIndex,
    events: ReadonlyMap<string, StringValue>,
    ctx: DiagContext
): void {
    for (const [path, rule] of ruleIndex) {
        const { min_length, max_length, pattern } = rule.constraints as any;

        // Skip if no string length or pattern constraints
        if (min_length === undefined && max_length === undefined && pattern === undefined) {
            continue;
        }

        const event = events.get(path);
        if (!event) continue; // Missing path handled by presence check

        // Only apply to string types
        if (event.type !== 'StringLiteral') {
            continue;
        }

        const length = event.value.length;

        if (min_length !== undefined && length < min_length) {
            emitError(ctx, createDiag(
                path,
                event.span,
                `String form violation: expected min length ${min_length}, got ${length}`,
                ErrorCodes.STRING_LENGTH_VIOLATION
            ));
            continue; // Only report first violation per path
        }

        if (max_length !== undefined && length > max_length) {
            emitError(ctx, createDiag(
                path,
                event.span,
                `String form violation: expected max length ${max_length}, got ${length}`,
                ErrorCodes.STRING_LENGTH_VIOLATION
            ));
        }

        // Note: pattern enforcement is handled separately in `checkPatterns()`.
    }
}

/**
 * Check pattern constraints for events matching schema rules.
 *
 * For each event with a pattern constraint, verify the string value
 * matches the regex pattern.
 *
 * AEOS v1 Decision: Patterns are ECMAScript regex strings. The pattern
 * must match the entire string (anchored with ^...$). If the pattern
 * does not include anchors, they are added automatically.
 *
 * @param ruleIndex - Schema rule index (path → rule)
 * @param events - Map of path → string value info
 * @param ctx - Diagnostic context
 */
export function checkPatterns(
    ruleIndex: RuleIndex,
    events: ReadonlyMap<string, StringValue>,
    ctx: DiagContext
): void {
    for (const [path, rule] of ruleIndex) {
        const { pattern } = rule.constraints;

        if (pattern === undefined) {
            continue;
        }

        const event = events.get(path);
        if (!event) continue; // Missing path handled by presence check

        // Only apply to string types
        if (event.type !== 'StringLiteral') {
            continue;
        }

        // Compile pattern (add anchors if not present for full-match semantics)
        let regexPattern = pattern;
        if (!regexPattern.startsWith('^')) {
            regexPattern = '^' + regexPattern;
        }
        if (!regexPattern.endsWith('$')) {
            regexPattern = regexPattern + '$';
        }

        let regex: RegExp;
        try {
            regex = new RegExp(regexPattern);
        } catch {
            // Invalid regex is a schema error, not a data error
            // This should have been caught during schema validation
            continue;
        }

        if (!regex.test(event.value)) {
            emitError(ctx, createDiag(
                path,
                event.span,
                `Pattern mismatch: value does not match pattern "${pattern}"`,
                ErrorCodes.PATTERN_MISMATCH
            ));
        }
    }
}

