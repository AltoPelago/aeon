/**
 * Phase 6 — Reference Validation (no evaluation)
 *
 * Validates references (~ and ~>) against the Assignment Event stream.
 *
 * Non-negotiable constraints:
 * - Do NOT resolve/inline references
 * - Do NOT transform values
 * - Fail-closed by default (no events if any reference validation error)
 */

import type { Span } from '@altopelago/aeon-lexer';
import type { AssignmentEvent } from './events.js';
import type { ReferencePathSegment } from '@altopelago/aeon-parser';
import { indexReferenceOrder, isReferenceToSelf } from './reference-order.js';
import { formatReferenceTargetPath } from './reference-target.js';
import { formatPath } from './paths.js';

export type ReferenceValidationErrorCode =
    | 'MISSING_REFERENCE_TARGET'
    | 'FORWARD_REFERENCE'
    | 'SELF_REFERENCE'
    | 'ATTRIBUTE_DEPTH_EXCEEDED';

export class ReferenceValidationError extends Error {
    readonly span: Span;
    readonly code: ReferenceValidationErrorCode;
    /** Path of the binding that contains the reference */
    readonly sourcePath: string;
    /** Target canonical path string (e.g., "$.a.b") */
    readonly targetPath: string;

    constructor(
        message: string,
        span: Span,
        code: ReferenceValidationErrorCode,
        sourcePath: string,
        targetPath: string
    ) {
        super(message);
        this.name = 'ReferenceValidationError';
        this.span = span;
        this.code = code;
        this.sourcePath = sourcePath;
        this.targetPath = targetPath;
    }
}

export class MissingReferenceTargetError extends ReferenceValidationError {
    constructor(span: Span, sourcePath: string, targetPath: string) {
        super(
            `Missing reference target: '${targetPath}'`,
            span,
            'MISSING_REFERENCE_TARGET',
            sourcePath,
            targetPath
        );
        this.name = 'MissingReferenceTargetError';
    }
}

export class ForwardReferenceError extends ReferenceValidationError {
    readonly sourceIndex: number;
    readonly targetIndex: number;

    constructor(span: Span, sourcePath: string, targetPath: string, sourceIndex: number, targetIndex: number) {
        super(
            `Forward reference: '${sourcePath}' references '${targetPath}' defined later`,
            span,
            'FORWARD_REFERENCE',
            sourcePath,
            targetPath
        );
        this.name = 'ForwardReferenceError';
        this.sourceIndex = sourceIndex;
        this.targetIndex = targetIndex;
    }
}

export class SelfReferenceError extends ReferenceValidationError {
    constructor(span: Span, sourcePath: string, targetPath: string) {
        super(
            `Self reference: '${sourcePath}' references itself`,
            span,
            'SELF_REFERENCE',
            sourcePath,
            targetPath
        );
        this.name = 'SelfReferenceError';
    }
}

export class AttributeDepthExceededError extends ReferenceValidationError {
    readonly observedDepth: number;
    readonly limit: number;

    constructor(
        span: Span,
        sourcePath: string,
        targetPath: string,
        observedDepth: number,
        limit: number
    ) {
        super(
            `Attribute depth ${observedDepth} exceeds max_attribute_depth ${limit} for '${targetPath}'`,
            span,
            'ATTRIBUTE_DEPTH_EXCEEDED',
            sourcePath,
            targetPath
        );
        this.name = 'AttributeDepthExceededError';
        this.observedDepth = observedDepth;
        this.limit = limit;
    }
}

export interface ReferenceValidationOptions {
    /**
     * Enable recovery mode: keep returning events even when reference errors exist.
     * Default: false (fail-closed)
     */
    readonly recovery?: boolean;
    /** Maximum number of attribute segments allowed in a reference path (default: 1) */
    readonly maxAttributeDepth?: number;
}

export interface ReferenceValidationResult {
    /** Assignment events (empty if any errors occurred and recovery is false) */
    readonly events: readonly AssignmentEvent[];
    /** Reference validation errors */
    readonly errors: readonly ReferenceValidationError[];
}

export function validateReferences(
    events: readonly AssignmentEvent[],
    options: ReferenceValidationOptions = {}
): ReferenceValidationResult {
    const errors: ReferenceValidationError[] = [];
    const maxAttributeDepth = options.maxAttributeDepth ?? 1;
    const { targets, claims } = indexReferenceOrder(events);
    // Preserve the public diagnostic indices as AssignmentEvent indices. The
    // finer occurrence ordinals above are private validation state only.
    const eventIndices = new Map(events.map((event, index) => [formatPath(event.path), index]));
    const eventIndex = (path: readonly ReferencePathSegment[]): number => {
        for (let length = path.length; length > 0; length -= 1) {
            const index = eventIndices.get(formatReferenceTargetPath(path.slice(0, length)));
            if (index !== undefined) return index;
        }
        return -1;
    };
    for (const { reference, path, ordinal } of claims) {
        const sourcePath = formatReferenceTargetPath(path);
        const targetPath = formatReferenceTargetPath(reference.path);
        const depth = reference.path.filter(segment => typeof segment === 'object').length;
        if (depth > maxAttributeDepth) {
            errors.push(new AttributeDepthExceededError(reference.span, sourcePath, targetPath, depth, maxAttributeDepth));
        } else if (isReferenceToSelf(path, reference.path)) {
            errors.push(new SelfReferenceError(reference.span, sourcePath, targetPath));
        } else {
            const target = targets.get(targetPath);
            if (target === undefined) {
                errors.push(new MissingReferenceTargetError(reference.span, sourcePath, targetPath));
            } else if (target > ordinal) {
                errors.push(new ForwardReferenceError(reference.span, sourcePath, targetPath, eventIndex(path), eventIndex(reference.path)));
            }
        }
    }
    return { events: errors.length > 0 && !options.recovery ? [] : events, errors };
}
