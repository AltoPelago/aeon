/**
 * @aeos/core - Diagnostics: Emit
 *
 * Helper functions for creating diagnostic entries.
 */

import type { Diag, Span } from '../types/index.js';

/**
 * Create a diagnostic entry
 */
export function createDiag(
    path: string,
    span: Span,
    message: string,
    code: string
): Diag {
    return {
        path,
        span,
        message,
        phase: 'schema_validation',
        code,
    };
}

/**
 * Diagnostic collector context
 */
export interface DiagContext {
    readonly errors: Diag[];
    readonly warnings: Diag[];
}

/**
 * Create a new diagnostic context
 */
export function createDiagContext(): DiagContext {
    return {
        errors: [],
        warnings: [],
    };
}

/**
 * Emit an error to the context
 */
export function emitError(ctx: DiagContext, diag: Diag): void {
    ctx.errors.push(diag);
}

/**
 * Emit a warning to the context
 */
export function emitWarning(ctx: DiagContext, diag: Diag): void {
    ctx.warnings.push(diag);
}

/**
 * Check if context has any errors for a specific path
 */
export function hasErrorForPath(errors: readonly Diag[], path: string): boolean {
    return errors.some(e => e.path === path);
}
