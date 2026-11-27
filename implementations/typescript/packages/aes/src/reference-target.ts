import type { Attribute, AttributeValue, ReferencePathSegment, Value } from '@altopelago/aeon-parser';
import type { AssignmentEvent } from './events.js';
import { formatPath, type CanonicalPath } from './paths.js';

export function canonicalPathFromReferenceSegments(segments: readonly ReferencePathSegment[]): CanonicalPath {
    // CanonicalPath currently models only root/member/index segments.
    // Attribute segments are formatted in formatReferenceTargetPath.
    const pathSegments: Array<CanonicalPath['segments'][number]> = [{ type: 'root' }];
    for (const segment of segments) {
        if (typeof segment === 'number') {
            pathSegments.push({ type: 'index', index: segment });
            continue;
        }
        if (typeof segment === 'string') {
            pathSegments.push({ type: 'member', key: segment });
        }
    }
    return { segments: pathSegments };
}

export function formatReferenceTargetPath(segments: readonly ReferencePathSegment[]): string {
    let out = '';
    let emittedRoot = false;

    for (const segment of segments) {
        if (!emittedRoot) {
            out = '$';
            emittedRoot = true;
        }

        if (typeof segment === 'number') {
            out += `[${segment}]`;
            continue;
        }

        if (typeof segment === 'string') {
            const canonical = formatPath({ segments: [{ type: 'root' }, { type: 'member', key: segment }] });
            out += canonical.slice(1); // remove leading $
            continue;
        }

        const key = segment.key;
        const canonical = formatPath({ segments: [{ type: 'root' }, { type: 'member', key }] });
        out += `.@${canonical.slice(1)}`;
    }

    return emittedRoot ? out : '$';
}


/** Follow a structural suffix from the nearest emitted assignment occurrence. */
export function resolveEventSubpath(event: AssignmentEvent, segments: readonly ReferencePathSegment[]): Value | null {
    let value = event.value;
    let annotations = event.annotations;
    let attributes: readonly Attribute[] | undefined;

    for (const segment of segments) {
        const payload = value.type === 'TypedValue' ? value.value : value;
        if (typeof segment === 'object') {
            if (annotations?.size) {
                const entry = annotations.get(segment.key);
                if (!entry) return null;
                value = entry.value;
                annotations = entry.annotations;
                attributes = undefined;
                continue;
            }
            const blocks = attributes?.length ? attributes
                : value.type === 'TypedValue' && value.attributes.length ? value.attributes
                : 'attributes' in payload ? payload.attributes : [];
            let entry: AttributeValue | undefined;
            for (const block of blocks) {
                const candidate = block.entries.get(segment.key);
                if (candidate) entry = candidate;
            }
            if (!entry) return null;
            value = entry.value;
            annotations = undefined;
            attributes = entry.attributes;
            continue;
        }

        annotations = undefined;
        if (typeof segment === 'string') {
            if (payload.type !== 'ObjectNode') return null;
            const binding = payload.bindings.find(candidate => candidate.key === segment);
            if (!binding) return null;
            value = binding.value;
            attributes = binding.attributes;
        } else {
            const element: Value | undefined = payload.type === 'NodeLiteral' ? payload.children[segment]
                : payload.type === 'ListNode' || payload.type === 'TupleLiteral' ? payload.elements[segment] : undefined;
            if (!element) return null;
            value = element;
            attributes = undefined;
        }
    }
    return value;
}
