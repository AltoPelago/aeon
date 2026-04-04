import type { ReferencePathSegment } from '@aeon/parser';
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
        if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) {
            out += `@${key}`;
        } else {
            out += `@[${JSON.stringify(key)}]`;
        }
    }

    return emittedRoot ? out : '$';
}
