/**
 * @aeos/core - Types: Envelope
 *
 * Canonical Result Envelope for AEOS validation.
 * This shape is normative and must match the CTS runner expectations.
 */

import type { Span } from './spans.js';

/**
 * Diagnostic entry (error or warning)
 */
export interface Diag {
    /** Canonical path where the issue occurred */
    readonly path: string;
    /** Source span, or null for missing paths */
    readonly span: Span;
    /** Human-readable message (non-normative) */
    readonly message: string;
    /** Phase that produced this diagnostic */
    readonly phase: 'schema_validation';
    /** Error code (standard or vendor:code) */
    readonly code: string;
}

/**
 * Canonical Result Envelope
 *
 * This is the only output shape AEOS produces.
 * The envelope MUST NOT contain the input AES.
 */
export interface ResultEnvelope {
    /** true if validation passed with no errors */
    readonly ok: boolean;
    /** All validation errors */
    readonly errors: readonly Diag[];
    /** All validation warnings */
    readonly warnings: readonly Diag[];
    /** Guarantees keyed by path → array of tags */
    readonly guarantees: Readonly<Record<string, readonly string[]>>;
}

/**
 * Create an empty passing result envelope
 */
export function createPassingEnvelope(
    guarantees: Record<string, readonly string[]> = {},
    warnings: readonly Diag[] = []
): ResultEnvelope {
    return {
        ok: true,
        errors: [],
        warnings,
        guarantees,
    };
}


/**
 * Create a failing result envelope from errors
 */
export function createFailingEnvelope(
    errors: readonly Diag[],
    warnings: readonly Diag[] = [],
    guarantees: Record<string, readonly string[]> = {}
): ResultEnvelope {
    return {
        ok: false,
        errors,
        warnings,
        guarantees,
    };
}
