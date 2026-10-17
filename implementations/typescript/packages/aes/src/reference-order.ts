import type { Attribute, ReferencePathSegment, Value } from '@altopelago/aeon-parser';
import type { AssignmentEvent, AttributeEntry } from './events.js';
import { formatPath } from './paths.js';
import { formatReferenceTargetPath } from './reference-target.js';

type Path = readonly ReferencePathSegment[];
type Reference = Extract<Value, { type: 'CloneReference' | 'PointerReference' }>;

export interface ReferenceClaim {
    readonly reference: Reference;
    readonly path: Path;
    readonly ordinal: number;
    readonly eventIndex: number;
}

interface ReferenceTarget {
    readonly ordinal: number;
    readonly eventIndex: number;
    readonly value: Value;
}

/** Internal authored-order index. Metadata occurrences are not collapsed to their payload owner. */
export function indexReferenceOrder(events: readonly AssignmentEvent[]): {
    targets: ReadonlyMap<string, ReferenceTarget>;
    claims: readonly ReferenceClaim[];
} {
    const targets = new Map<string, ReferenceTarget>();
    const candidates = new Map<string, { path: Path; plane: string; target: ReferenceTarget }>();
    const payloads = new Map<string, { event: AssignmentEvent; index: number }>();
    const retainedByPlane = new Map<string, Set<Value>>();
    const claims: ReferenceClaim[] = [];
    let ordinal = 0;
    let eventIndex = 0;
    let plane = 'body';

    // Body bindings take precedence over colliding header paths. Within each
    // plane, retain the first occurrence, matching path-resolution recovery.
    for (const [index, event] of events.entries()) {
        const key = formatPath(event.path);
        const previous = payloads.get(key);
        if (!previous || (previous.event.sourcePlane === 'header' && event.sourcePlane !== 'header')) {
            payloads.set(key, { event, index });
        }
    }

    function attributes(entries: ReadonlyMap<string, AttributeEntry> | undefined, path: Path): void {
        for (const [key, entry] of entries ?? []) {
            headed(entry.value, [...path, { type: 'attr', key }], entry.annotations);
        }
    }

    function rawAttributes(entries: readonly Attribute[], path: Path, targetable = true, owner: Path = path): void {
        for (const attribute of entries) {
            for (const [key, entry] of attribute.entries) {
                const child = [...path, { type: 'attr' as const, key }];
                rawAttributes(entry.attributes, child, targetable, targetable ? child : owner);
                headed(entry.value, child, undefined, targetable, targetable ? child : owner);
            }
        }
    }

    function headed(value: Value, path: Path, annotations?: ReadonlyMap<string, AttributeEntry>, targetable = true, owner: Path = path, descend = true): void {
        const targetValue = value;
        attributes(annotations, path);
        while (value.type === 'TypedValue') {
            rawAttributes(value.attributes, path, targetable, owner);
            value = value.value;
        }
        if (value.type === 'ObjectNode' || value.type === 'ListNode'
            || value.type === 'TupleLiteral') {
            rawAttributes(value.attributes, path, targetable, owner);
        } else if (value.type === 'NodeLiteral') {
            // The implicit node head has no AEON v1 source-path spelling. Its
            // attributes must not alias the enclosing binding's attributes.
            rawAttributes(value.attributes, path, false, owner);
        }
        // A reference is checked before its own value becomes available. A
        // container becomes available before walking its members/positions.
        if (value.type === 'CloneReference' || value.type === 'PointerReference') {
            claims.push({ reference: value, path: targetable ? path : owner, ordinal: ordinal++, eventIndex });
        }
        const key = formatReferenceTargetPath(path);
        const candidateKey = `${plane}\0${key}`;
        if (targetable && !candidates.has(candidateKey)) {
            candidates.set(candidateKey, { path, plane, target: { ordinal, eventIndex, value: targetValue } });
        }
        ordinal += 1;
        if (!descend) return;
        if (value.type === 'ObjectNode') {
            const seen = new Set<string>();
            for (const binding of value.bindings) {
                if (seen.has(binding.key)) continue;
                seen.add(binding.key);
                const child = [...path, binding.key];
                rawAttributes(binding.attributes, child, targetable, targetable ? child : owner);
                headed(binding.value, child, undefined, targetable, targetable ? child : owner);
            }
        } else if (value.type === 'ListNode' || value.type === 'TupleLiteral' || value.type === 'NodeLiteral') {
            const children = value.type === 'NodeLiteral' ? value.children : value.elements;
            children.forEach((child, index) => headed(child, [...path, index], undefined, targetable, targetable ? [...path, index] : owner));
        }
    }

    // Payload paths and retained subtrees belong to the resolver. Only metadata
    // needs recursive AST traversal: it has no separate AssignmentEvents.
    const seenEvents = new Set<string>();
    for (const [index, event] of events.entries()) {
        plane = event.sourcePlane ?? 'body';
        eventIndex = index;
        const key = `${plane}\0${formatPath(event.path)}`;
        if (seenEvents.has(key)) continue;
        seenEvents.add(key);
        const retained = retainedByPlane.get(plane) ?? new Set<Value>();
        retained.add(event.value);
        retainedByPlane.set(plane, retained);
        const segments = event.path.segments;
        const path = segments.flatMap<ReferencePathSegment>(segment =>
            segment.type === 'root' ? [] : [segment.type === 'member' ? segment.key : segment.index]);
        headed(event.value, path, event.annotations, true, path, false);
    }
    for (const { path, plane, target } of candidates.values()) {
        for (let length = path.length; length > 0; length -= 1) {
            const payload = payloads.get(formatReferenceTargetPath(path.slice(0, length)));
            if (!payload) continue;
            if ((payload.event.sourcePlane ?? 'body') === plane && payload.index === target.eventIndex) {
                targets.set(formatReferenceTargetPath(path), target);
            }
            break;
        }
    }
    // The legacy resolver also permits subpaths of non-emitted list/tuple
    // values. Preserve that fallback without replacing actual emitted paths
    // or bypassing the precise metadata occurrences indexed above.
    if (!events.some(event => event.path.segments.some(segment => segment.type === 'index'))) {
        for (const { reference } of claims) {
            const key = formatReferenceTargetPath(reference.path);
            if (targets.has(key)) continue;
            for (let length = reference.path.length; length > 0; length -= 1) {
                const prefix = reference.path.slice(0, length);
                if (prefix.some(segment => typeof segment === 'object')) continue;
                const prefixKey = formatReferenceTargetPath(prefix);
                const payload = payloads.get(prefixKey);
                const target = targets.get(prefixKey);
                const value = payload && target ? compatibilitySubpath(
                    payload.event, reference.path.slice(length),
                    retainedByPlane.get(payload.event.sourcePlane ?? 'body')!,
                ) : undefined;
                if (target && value) {
                    targets.set(key, { ...target, value });
                    break;
                }
            }
        }
    }
    return { targets, claims };
}

function compatibilitySubpath(event: AssignmentEvent, path: Path, retained: ReadonlySet<Value>): Value | undefined {
    let requiresResolvedBinding = true;
    let value = event.value;
    let annotations = event.annotations;
    let attributes: readonly Attribute[] = [];
    for (const segment of path) {
        while (value.type === 'TypedValue') {
            if (attributes.length === 0) attributes = value.attributes;
            value = value.value;
        }
        if (typeof segment === 'object') {
            requiresResolvedBinding = false;
            const annotated = annotations?.get(segment.key);
            if (annotated) {
                value = annotated.value;
                annotations = annotated.annotations;
                attributes = [];
                continue;
            }
            if (attributes.length === 0 && (value.type === 'ObjectNode' || value.type === 'ListNode' || value.type === 'TupleLiteral')) {
                attributes = value.attributes;
            }
            const entry = attributes.flatMap(attribute => [...attribute.entries])
                .find(([key]) => key === segment.key)?.[1];
            if (!entry) return undefined;
            value = entry.value;
            attributes = entry.attributes;
        } else if (typeof segment === 'string') {
            if (value.type !== 'ObjectNode') return undefined;
            const binding = value.bindings.find(binding => binding.key === segment);
            if (!binding) return undefined;
            if (requiresResolvedBinding && !retained.has(binding.value)) return undefined;
            value = binding.value;
            attributes = binding.attributes;
        } else {
            if (!Number.isInteger(segment) || segment < 0) return undefined;
            if (value.type === 'TupleLiteral' || value.type === 'NodeLiteral') requiresResolvedBinding = false;
            const child: Value | undefined = value.type === 'NodeLiteral' ? value.children[segment]
                : value.type === 'ListNode' || value.type === 'TupleLiteral' ? value.elements[segment] : undefined;
            if (!child) return undefined;
            value = child;
            attributes = [];
        }
        annotations = undefined;
    }
    return value;
}

/** Exact structural checks, never substring tests on quoted path text. */
export function isReferenceToSelf(source: Path, target: Path): boolean {
    const equal = (left: Path, right: Path): boolean => formatReferenceTargetPath(left) === formatReferenceTargetPath(right);
    if (equal(source, target)) return true;
    const firstAttribute = source.findIndex(segment => typeof segment === 'object');
    for (let index = 0; index < source.length; index += 1) {
        if (typeof source[index] === 'object' && equal(source.slice(0, index), target)) return true;
    }
    const payload = firstAttribute < 0 ? source : source.slice(0, firstAttribute);
    if (firstAttribute >= 0 && equal(payload, target)) return true;
    let ownerLength = payload.length;
    while (ownerLength > 0 && typeof payload[ownerLength - 1] === 'number') ownerLength -= 1;
    return ownerLength < payload.length && equal(payload.slice(0, ownerLength), target);
}
