/**
 * Phase 11 — Reference Resolution (Resolved AES)
 *
 * Resolves clone references (~) into terminal values while preserving
 * pointer references (~>) as alias tokens. Output remains AES.
 */

import type { AssignmentEvent } from './events.js';
import type { Value, Attribute, AttributeValue, Binding, ReferencePathSegment } from '@aeon/parser';
import type { Span } from '@aeon/lexer';
import { formatPath, type CanonicalPath } from './paths.js';
import { formatReferenceTargetPath } from './reference-target.js';

export interface ResolveDiagnostic {
    readonly message: string;
    readonly code?: string;
    readonly span?: Span;
    readonly path?: string;
}

export interface ResolveMeta {
    readonly warnings?: readonly ResolveDiagnostic[];
    readonly errors?: readonly ResolveDiagnostic[];
    readonly resolutionMap?: Record<string, string>;
    readonly cycles?: readonly { path: readonly ReferencePathSegment[] }[];
}

export interface ResolveOptions {
    readonly mode?: 'strict' | 'loose';
}

export interface ResolveResult {
    readonly aes: readonly AssignmentEvent[];
    readonly meta?: ResolveMeta;
}

export function resolveRefs(
    aes: readonly AssignmentEvent[],
    options: ResolveOptions = {}
): ResolveResult {
    const strict = (options.mode ?? 'strict') === 'strict';
    const errors: ResolveDiagnostic[] = [];
    const warnings: ResolveDiagnostic[] = [];
    const resolutionMap: Record<string, string> = {};
    const cycles: { path: readonly ReferencePathSegment[] }[] = [];

    const pathToIndex = new Map<string, number>();
    for (let i = 0; i < aes.length; i++) {
        const pathStr = formatPath(aes[i]!.path);
        pathToIndex.set(pathStr, i);
    }

    const resolvedCache = new Map<string, Value>();

    function addDiag(
        target: 'error' | 'warning',
        message: string,
        code: string,
        span: Span | undefined,
        path: string | undefined
    ): void {
        const diag: ResolveDiagnostic = {
            message,
            code,
            ...(span !== undefined ? { span } : {}),
            ...(path !== undefined ? { path } : {}),
        };
        if (target === 'error') errors.push(diag);
        else warnings.push(diag);
    }

    function getPathMembers(path: CanonicalPath): Array<string | number> {
        const members: Array<string | number> = [];
        for (const segment of path.segments) {
            if (segment.type === 'member') members.push(segment.key);
            if (segment.type === 'index') members.push(segment.index);
        }
        return members;
    }

    function resolveValueAtSubpath(value: Value, segments: readonly ReferencePathSegment[]): Value | null {
        if (segments.length === 0) return value;
        const [head, ...rest] = segments;
        if (typeof head === 'object' && head !== null && head.type === 'attr') {
            return null;
        }
        if (value.type === 'ObjectNode' && typeof head === 'string') {
            const binding = value.bindings.find((b) => b.key === head);
            if (!binding) return null;
            return resolveValueAtSubpath(binding.value, rest);
        }
        if ((value.type === 'ListNode' || value.type === 'TupleLiteral') && typeof head === 'number') {
            const element = value.elements[head];
            if (!element) return null;
            return resolveValueAtSubpath(element, rest);
        }
        return null;
    }

    function resolveClone(
        ref: { path: readonly ReferencePathSegment[]; span: Span },
        sourcePath: string,
        sourceIndex: number,
        stack: readonly string[]
    ): Value {
        const targetPath = formatReferenceTargetPath(ref.path);

        if (targetPath === sourcePath) {
            addDiag(
                strict ? 'error' : 'warning',
                `Self reference: '${sourcePath}' references itself`,
                'RESOLVE_SELF_REFERENCE',
                ref.span,
                sourcePath
            );
            return { ...ref, type: 'CloneReference' } as Value;
        }

        const targetIndex = pathToIndex.get(targetPath);
        if (targetIndex === undefined) {
            addDiag(
                strict ? 'error' : 'warning',
                `Missing reference target: '${targetPath}'`,
                'RESOLVE_MISSING_TARGET',
                ref.span,
                sourcePath
            );
            return { ...ref, type: 'CloneReference' } as Value;
        }

        if (targetIndex > sourceIndex) {
            addDiag(
                strict ? 'error' : 'warning',
                `Forward reference: '${sourcePath}' references '${targetPath}' defined later`,
                'RESOLVE_FORWARD_REFERENCE',
                ref.span,
                sourcePath
            );
            return { ...ref, type: 'CloneReference' } as Value;
        }

        if (stack.includes(targetPath)) {
            cycles.push({ path: [...ref.path] });
            addDiag(
                strict ? 'error' : 'warning',
                `Reference cycle detected at '${targetPath}'`,
                'RESOLVE_CYCLE',
                ref.span,
                sourcePath
            );
            return { ...ref, type: 'CloneReference' } as Value;
        }

        if (resolvedCache.has(targetPath)) {
            resolutionMap[`${sourcePath}::${targetPath}`] = targetPath;
            return resolvedCache.get(targetPath)!;
        }

        const targetEvent = aes[targetIndex]!;
        const targetMembers = getPathMembers(targetEvent.path);
        const remainder = ref.path.slice(targetMembers.length);
        const targetValue = resolveValueAtSubpath(targetEvent.value, remainder);
        if (!targetValue) {
            addDiag(
                strict ? 'error' : 'warning',
                `Missing reference target: '${targetPath}'`,
                'RESOLVE_MISSING_TARGET',
                ref.span,
                sourcePath
            );
            return { ...ref, type: 'CloneReference' } as Value;
        }
        const resolved = resolveValue(targetValue, targetPath, targetIndex, [...stack, targetPath]);
        resolvedCache.set(targetPath, resolved);
        resolutionMap[`${sourcePath}::${targetPath}`] = targetPath;
        return resolved;
    }

    function resolveValue(value: Value, sourcePath: string, sourceIndex: number, stack: readonly string[]): Value {
        switch (value.type) {
            case 'CloneReference':
                return resolveClone(value, sourcePath, sourceIndex, stack);
            case 'PointerReference':
                return value;
            case 'ObjectNode': {
                let changed = false;
                const bindings = value.bindings.map((binding) => {
                    const next = resolveBinding(binding, sourcePath, sourceIndex, stack);
                    changed ||= next !== binding;
                    return next;
                });
                const attributes = value.attributes.map((attr) => {
                    const next = resolveAttribute(attr, sourcePath, sourceIndex, stack);
                    changed ||= next !== attr;
                    return next;
                });
                return changed ? { ...value, bindings, attributes } : value;
            }
            case 'ListNode': {
                let changed = false;
                const elements = value.elements.map((element) => {
                    const next = resolveValue(element, sourcePath, sourceIndex, stack);
                    changed ||= next !== element;
                    return next;
                });
                const attributes = value.attributes.map((attr) => {
                    const next = resolveAttribute(attr, sourcePath, sourceIndex, stack);
                    changed ||= next !== attr;
                    return next;
                });
                return changed ? { ...value, elements, attributes } : value;
            }
            case 'TupleLiteral': {
                let changed = false;
                const elements = value.elements.map((element) => {
                    const next = resolveValue(element, sourcePath, sourceIndex, stack);
                    changed ||= next !== element;
                    return next;
                });
                const attributes = value.attributes.map((attr) => {
                    const next = resolveAttribute(attr, sourcePath, sourceIndex, stack);
                    changed ||= next !== attr;
                    return next;
                });
                return changed ? { ...value, elements, attributes } : value;
            }
            case 'NodeLiteral': {
                let changed = false;
                const attributes = value.attributes.map((attr) => {
                    const next = resolveAttribute(attr, sourcePath, sourceIndex, stack);
                    changed ||= next !== attr;
                    return next;
                });
                const children = value.children.map((child) => {
                    const next = resolveValue(child, sourcePath, sourceIndex, stack);
                    changed ||= next !== child;
                    return next;
                });
                return changed ? { ...value, attributes, children } : value;
            }
            default:
                return value;
        }
    }

    function resolveBinding(
        binding: Binding,
        sourcePath: string,
        sourceIndex: number,
        stack: readonly string[]
    ): Binding {
        const nextValue = resolveValue(binding.value, sourcePath, sourceIndex, stack);
        let changed = nextValue !== binding.value;
        const attributes = binding.attributes.map((attr) => {
            const next = resolveAttribute(attr, sourcePath, sourceIndex, stack);
            changed ||= next !== attr;
            return next;
        });
        return changed ? { ...binding, value: nextValue, attributes } : binding;
    }

    function resolveAttribute(
        attr: Attribute,
        sourcePath: string,
        sourceIndex: number,
        stack: readonly string[]
    ): Attribute {
        let changed = false;
        const entries = new Map<string, AttributeValue>();
        for (const [key, entry] of attr.entries) {
            const nextValue = resolveValue(entry.value, sourcePath, sourceIndex, stack);
            const nextAttributes = entry.attributes.map((nested) => {
                const next = resolveAttribute(nested, sourcePath, sourceIndex, stack);
                changed ||= next !== nested;
                return next;
            });
            const nextEntry = nextValue === entry.value && nextAttributes.every((item, index) => item === entry.attributes[index])
                ? entry
                : { ...entry, value: nextValue, attributes: nextAttributes };
            if (nextEntry !== entry) changed = true;
            entries.set(key, nextEntry);
        }
        return changed ? { ...attr, entries } : attr;
    }

    const resolvedEvents: AssignmentEvent[] = [];
    for (let i = 0; i < aes.length; i++) {
        const event = aes[i]!;
        const sourcePath = formatPath(event.path);
        const nextValue = resolveValue(event.value, sourcePath, i, [sourcePath]);

        const resolveAnnotationEntries = (
            entries: ReadonlyMap<string, { value: Value; datatype?: string; annotations?: ReadonlyMap<string, { value: Value; datatype?: string }> }>
        ): ReadonlyMap<string, { value: Value; datatype?: string; annotations?: ReadonlyMap<string, { value: Value; datatype?: string }> }> => {
            const updated = new Map<string, { value: Value; datatype?: string; annotations?: ReadonlyMap<string, { value: Value; datatype?: string }> }>();
            for (const [key, entry] of entries) {
                const nextValueEntry = resolveValue(entry.value, sourcePath, i, [sourcePath]);
                const nextAnnotationsEntry = entry.annotations
                    ? resolveAnnotationEntries(entry.annotations)
                    : entry.annotations;
                const nextEntry = nextValueEntry === entry.value && nextAnnotationsEntry === entry.annotations
                    ? entry
                    : { ...entry, value: nextValueEntry, ...(nextAnnotationsEntry ? { annotations: nextAnnotationsEntry } : {}) };
                updated.set(key, nextEntry);
            }
            return updated;
        };

        let annotationsChanged = false;
        let nextAnnotations = event.annotations;
        if (event.annotations) {
            const updated = resolveAnnotationEntries(event.annotations);
            annotationsChanged = updated !== event.annotations && Array.from(updated.entries()).some(([key, entry]) => event.annotations?.get(key) !== entry);
            nextAnnotations = annotationsChanged ? updated : event.annotations;
        }

        const changed = nextValue !== event.value || annotationsChanged;
        if (!changed) {
            resolvedEvents.push(event);
            continue;
        }

        const nextEvent: AssignmentEvent = {
            ...event,
            value: nextValue,
        };

        if (nextAnnotations) {
            (nextEvent as { annotations: ReadonlyMap<string, { value: Value; datatype?: string; annotations?: ReadonlyMap<string, { value: Value; datatype?: string }> }> }).annotations =
                nextAnnotations;
        }

        resolvedEvents.push(nextEvent);
    }

    const hasErrors = errors.length > 0;
    const meta: ResolveMeta = {
        ...(warnings.length > 0 ? { warnings } : {}),
        ...(errors.length > 0 ? { errors } : {}),
        ...(Object.keys(resolutionMap).length > 0 ? { resolutionMap } : {}),
        ...(cycles.length > 0 ? { cycles } : {}),
    };
    const hasMeta = Object.keys(meta).length > 0;

    if (strict && hasErrors) {
        return hasMeta ? { aes: [], meta } : { aes: [] };
    }

    return hasMeta ? { aes: resolvedEvents, meta } : { aes: resolvedEvents };
}
