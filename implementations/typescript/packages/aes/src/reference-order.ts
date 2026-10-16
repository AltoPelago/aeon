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
}

/** Internal authored-order index. Metadata occurrences are not collapsed to their payload owner. */
export function indexReferenceOrder(events: readonly AssignmentEvent[]): {
    targets: ReadonlyMap<string, number>;
    claims: readonly ReferenceClaim[];
} {
    const targets = new Map<string, number>();
    const claims: ReferenceClaim[] = [];
    let ordinal = 0;

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

    function headed(value: Value, path: Path, annotations?: ReadonlyMap<string, AttributeEntry>, targetable = true, owner: Path = path): void {
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
            claims.push({ reference: value, path: targetable ? path : owner, ordinal: ordinal++ });
        }
        const key = formatReferenceTargetPath(path);
        if (targetable && !targets.has(key)) targets.set(key, ordinal);
        ordinal += 1;
        if (value.type === 'ObjectNode') {
            for (const binding of value.bindings) {
                const child = [...path, binding.key];
                rawAttributes(binding.attributes, child, targetable, targetable ? child : owner);
                headed(binding.value, child, undefined, targetable, targetable ? child : owner);
            }
        } else if (value.type === 'ListNode' || value.type === 'TupleLiteral' || value.type === 'NodeLiteral') {
            const children = value.type === 'NodeLiteral' ? value.children : value.elements;
            children.forEach((child, index) => headed(child, [...path, index], undefined, targetable, targetable ? [...path, index] : owner));
        }
    }

    // Events retain full value trees. Traverse only their structural roots so
    // node/list children and their metadata are checked exactly once.
    const paths = new Set(events.map(event => `${event.sourcePlane ?? 'body'}\0${formatPath(event.path)}`));
    for (const event of events) {
        const segments = event.path.segments;
        let nested = false;
        for (let length = segments.length - 1; length > 1; length -= 1) {
            if (paths.has(`${event.sourcePlane ?? 'body'}\0${formatPath({ segments: segments.slice(0, length) })}`)) {
                nested = true;
                break;
            }
        }
        if (nested) continue;
        const path = segments.flatMap<ReferencePathSegment>(segment =>
            segment.type === 'root' ? [] : [segment.type === 'member' ? segment.key : segment.index]);
        headed(event.value, path, event.annotations);
    }
    return { targets, claims };
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
