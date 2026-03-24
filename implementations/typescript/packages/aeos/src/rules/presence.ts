/**
 * @aeos/core - Rules: Presence
 *
 * Phase 4: Presence checks for required fields.
 */

import type { DiagContext } from '../diag/emit.js';
import { createDiag, emitError } from '../diag/emit.js';
import { ErrorCodes } from '../diag/codes.js';
import type { RuleIndex } from './schemaIndex.js';

/**
 * Check presence constraints for all rules in the schema.
 *
 * For each rule with `required: true`, verify the path exists in the AES.
 * If missing, emit `missing_required_field` error with null span
 * (since the path doesn't exist in source).
 *
 * @param ruleIndex - Schema rule index (path → rule)
 * @param boundPaths - Set of paths that exist in the AES
 * @param ctx - Diagnostic context
 */
export function checkPresence(
    ruleIndex: RuleIndex,
    boundPaths: ReadonlySet<string>,
    ctx: DiagContext
): void {
    for (const [path, rule] of ruleIndex) {
        if (rule.constraints.required === true) {
            if (!boundPaths.has(path)) {
                emitError(ctx, createDiag(
                    path,
                    null, // null span for missing paths
                    `Missing required field: ${path}`,
                    ErrorCodes.MISSING_REQUIRED_FIELD
                ));
            }
        }
    }
}
