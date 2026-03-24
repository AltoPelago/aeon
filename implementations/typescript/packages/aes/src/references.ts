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

import type { Span } from '@aeon/lexer';
import type { Value, Attribute, AttributeValue, ReferencePathSegment } from '@aeon/parser';
import type { AssignmentEvent, AttributeEntry } from './events.js';
import { formatPath } from './paths.js';
import { formatReferenceTargetPath } from './reference-target.js';

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

type ReferenceNode =
    | { readonly type: 'CloneReference'; readonly path: readonly ReferencePathSegment[]; readonly span: Span }
    | { readonly type: 'PointerReference'; readonly path: readonly ReferencePathSegment[]; readonly span: Span };

export function validateReferences(
    events: readonly AssignmentEvent[],
    options: ReferenceValidationOptions = {}
): ReferenceValidationResult {
    const errors: ReferenceValidationError[] = [];
    const maxAttributeDepth = options.maxAttributeDepth ?? 1;
    const pathToIndex = new Map<string, number>();

    for (let i = 0; i < events.length; i++) {
        const event = events[i]!;
        const pathStr = formatPath(event.path);
        pathToIndex.set(pathStr, i);
    }

    for (let i = 0; i < events.length; i++) {
        const event = events[i]!;
        const sourcePath = formatPath(event.path);

        for (const ref of findOwnedReferences(event.value)) {
            validateOneReference(ref, sourcePath, i, events, pathToIndex, errors, maxAttributeDepth);
        }

        if (event.annotations) {
            for (const [, entry] of event.annotations) {
                for (const ref of findReferencesInAttributeEntry(entry)) {
                    validateOneReference(ref, sourcePath, i, events, pathToIndex, errors, maxAttributeDepth);
                }
            }
        }
    }

    if (errors.length > 0 && !options.recovery) {
        return { events: [], errors };
    }

    return { events, errors };
}

function* findReferences(value: Value): Generator<ReferenceNode> {
    switch (value.type) {
        case 'CloneReference':
        case 'PointerReference':
            yield value;
            return;

        case 'ObjectNode':
            for (const binding of value.bindings) {
                yield* findReferences(binding.value);
                for (const attr of binding.attributes) {
                    yield* findReferencesInAttribute(attr);
                }
            }
            for (const attr of value.attributes) {
                yield* findReferencesInAttribute(attr);
            }
            return;

        case 'ListNode':
            for (const element of value.elements) {
                yield* findReferences(element);
            }
            for (const attr of value.attributes) {
                yield* findReferencesInAttribute(attr);
            }
            return;

        case 'TupleLiteral':
            for (const element of value.elements) {
                yield* findReferences(element);
            }
            for (const attr of value.attributes) {
                yield* findReferencesInAttribute(attr);
            }
            return;

        case 'NodeLiteral':
            for (const attr of value.attributes) {
                yield* findReferencesInAttribute(attr);
            }
            for (const child of value.children) {
                yield* findReferences(child);
            }
            return;

        default:
            return;
    }
}

function* findOwnedReferences(value: Value): Generator<ReferenceNode> {
    switch (value.type) {
        case 'CloneReference':
        case 'PointerReference':
            yield value;
            return;

        case 'ObjectNode':
        case 'ListNode':
        case 'TupleLiteral':
        case 'NodeLiteral':
            for (const attr of value.attributes) {
                yield* findReferencesInAttribute(attr);
            }
            if (value.type === 'NodeLiteral') {
                for (const child of value.children) {
                    yield* findReferences(child);
                }
            }
            return;

        default:
            return;
    }
}

function* findReferencesInAttribute(attr: Attribute): Generator<ReferenceNode> {
    for (const [, entry] of attr.entries) {
        yield* findReferencesInAttributeEntry(entry);
    }
}

function* findReferencesInAttributeEntry(entry: AttributeEntry | AttributeValue): Generator<ReferenceNode> {
    if (hasAnnotationEntries(entry)) {
        for (const [, nestedEntry] of entry.annotations) {
            yield* findReferencesInAttributeEntry(nestedEntry);
        }
    }
    yield* findReferences(entry.value);
    if (hasNestedAttributes(entry)) {
        for (const nestedAttribute of entry.attributes) {
            yield* findReferencesInAttribute(nestedAttribute);
        }
    }
}

function hasAnnotationEntries(entry: AttributeEntry | AttributeValue): entry is AttributeEntry & {
    readonly annotations: ReadonlyMap<string, AttributeEntry>;
} {
    return 'annotations' in entry && entry.annotations !== undefined;
}

function hasNestedAttributes(entry: AttributeEntry | AttributeValue): entry is AttributeValue {
    return 'attributes' in entry;
}

function validateOneReference(
    ref: ReferenceNode,
    sourcePath: string,
    sourceIndex: number,
    events: readonly AssignmentEvent[],
    pathToIndex: ReadonlyMap<string, number>,
    errors: ReferenceValidationError[],
    maxAttributeDepth: number
): void {
    const targetPath = formatReferenceTargetPath(ref.path);
    const observedDepth = ref.path.filter((segment) => typeof segment === 'object' && segment.type === 'attr').length;

    if (observedDepth > maxAttributeDepth) {
        errors.push(new AttributeDepthExceededError(ref.span, sourcePath, targetPath, observedDepth, maxAttributeDepth));
        return;
    }

    if (targetPath === sourcePath) {
        errors.push(new SelfReferenceError(ref.span, sourcePath, targetPath));
        return;
    }

    const target = resolveReferenceTarget(ref.path, events, pathToIndex);
    if (!target) {
        errors.push(new MissingReferenceTargetError(ref.span, sourcePath, targetPath));
        return;
    }

    if (target.index > sourceIndex) {
        errors.push(new ForwardReferenceError(ref.span, sourcePath, targetPath, sourceIndex, target.index));
    }
}

type ResolutionContext = {
    readonly value: Value;
    readonly annotations: ReadonlyMap<string, AttributeEntry> | undefined;
};

function isAttrSegment(segment: ReferencePathSegment): segment is Extract<ReferencePathSegment, { readonly type: 'attr' }> {
    return typeof segment === 'object' && segment !== null && segment.type === 'attr';
}

function resolveReferenceTarget(
    path: readonly ReferencePathSegment[],
    events: readonly AssignmentEvent[],
    pathToIndex: ReadonlyMap<string, number>
): { readonly index: number } | null {
    // Find the longest member/index-only prefix that maps to a known binding path.
    for (let split = path.length; split >= 1; split--) {
        const prefix = path.slice(0, split);
        if (prefix.some((segment) => typeof segment === 'object' && segment.type === 'attr')) {
            continue;
        }

        const prefixPath = formatReferenceTargetPath(prefix);
        const targetIndex = pathToIndex.get(prefixPath);
        if (targetIndex === undefined) {
            continue;
        }

        const remainder = path.slice(split);
        if (remainder.length === 0) {
            return { index: targetIndex };
        }

        const event = events[targetIndex];
        if (!event) {
            return null;
        }

        if (resolveSubpath(event, remainder)) {
            return { index: targetIndex };
        }
    }

    return null;
}

function resolveSubpath(event: AssignmentEvent, remainder: readonly ReferencePathSegment[]): boolean {
    let context: ResolutionContext = {
        value: event.value,
        annotations: selectAnnotations(event.annotations, event.value),
    };

    for (const segment of remainder) {
        if (isAttrSegment(segment)) {
            const attrEntry = context.annotations?.get(segment.key);
            if (!attrEntry) return false;
            context = {
                value: attrEntry.value,
                annotations: selectAnnotations(attrEntry.annotations, attrEntry.value),
            };
            continue;
        } else if (typeof segment === 'string') {
            if (context.value.type !== 'ObjectNode') return false;
            const binding = context.value.bindings.find((candidate) => candidate.key === segment);
            if (!binding) return false;
            const bindingAnnotations = buildAnnotationMap(binding.attributes);
            context = {
                value: binding.value,
                annotations: selectAnnotations(bindingAnnotations, binding.value),
            };
            continue;
        } else if (typeof segment === 'number') {
            if (segment < 0 || !Number.isInteger(segment)) return false;
            if (context.value.type !== 'ListNode' && context.value.type !== 'TupleLiteral') return false;
            const element = context.value.elements[segment];
            if (!element) return false;
            context = {
                value: element,
                annotations: selectAnnotations(undefined, element),
            };
        } else {
            return false;
        }
    }

    return true;
}

function selectAnnotations(
    preferred: ReadonlyMap<string, AttributeEntry> | undefined,
    value: Value
): ReadonlyMap<string, AttributeEntry> | undefined {
    if (preferred && preferred.size > 0) return preferred;
    return buildValueAnnotationMap(value);
}

function buildValueAnnotationMap(value: Value): ReadonlyMap<string, AttributeEntry> | undefined {
    if (
        value.type !== 'ObjectNode'
        && value.type !== 'ListNode'
        && value.type !== 'TupleLiteral'
        && value.type !== 'NodeLiteral'
    ) {
        return undefined;
    }
    return buildAnnotationMap(value.attributes);
}

function buildAnnotationMap(attributes: readonly Attribute[]): ReadonlyMap<string, AttributeEntry> | undefined {
    if (!attributes || attributes.length === 0) return undefined;

    const result = new Map<string, AttributeEntry>();
    for (const attribute of attributes) {
        for (const [key, entry] of attribute.entries) {
            const mapped: AttributeEntry = { value: entry.value };
            const nested = buildAnnotationMap(entry.attributes);
            if (nested) {
                (mapped as { annotations: ReadonlyMap<string, AttributeEntry> }).annotations = nested;
            }
            result.set(key, mapped);
        }
    }
    return result;
}
