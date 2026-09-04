import type { Span } from '@altopelago/aeon-lexer';
import type { Value } from '@altopelago/aeon-parser';
import { formatDatatypeAnnotation } from './datatype.js';
import type { AssignmentEvent } from './events.js';
import { formatPath, type CanonicalPath, type PathSegment } from './paths.js';

export type PortableAesKind =
    | 'string'
    | 'number'
    | 'infinity'
    | 'nan'
    | 'null'
    | 'boolean'
    | 'toggle'
    | 'hex'
    | 'radix'
    | 'encoding'
    | 'separator'
    | 'sansa-address'
    | 'date'
    | 'time'
    | 'datetime'
    | 'object'
    | 'list'
    | 'tuple'
    | 'node'
    | 'node-head'
    | 'clone-reference'
    | 'pointer-reference';

/**
 * Encoding-neutral AES event shape used by the portable projection work.
 * Attribute expansion is intentionally a separate projection step.
 */
export interface PortableAesEvent {
    readonly path: string;
    readonly kind: PortableAesKind;
    readonly identity?: string;
    readonly datatype?: string;
    readonly value?: string;
    readonly span?: Span;
}

/**
 * Project legacy TypeScript AssignmentEvents into the portable node shape.
 *
 * Every NodeLiteral becomes a value-less `node` event followed by one
 * synthetic `node-head` event. Source child paths gain the node-head index,
 * recursively, while ordinary member/list/tuple paths remain unchanged.
 * Binding and node-head attributes are deliberately left for the flat-
 * attribute projection stage and are not embedded in the result.
 */
export function projectPortableNodeEvents(events: readonly AssignmentEvent[]): readonly PortableAesEvent[] {
    const nodeSourcePaths = new Set(
        events
            .filter((event) => unwrapTypedValue(event.value).type === 'NodeLiteral')
            .map((event) => formatPath(event.path)),
    );
    const projected: PortableAesEvent[] = [];

    for (const event of events) {
        const translatedPath = translateNodePath(event.path, nodeSourcePaths);
        const value = unwrapTypedValue(event.value);
        projected.push(projectEvent(event, translatedPath, value, nodeSourcePaths));

        if (value.type === 'NodeLiteral') {
            projected.push({
                path: formatPath({
                    segments: [...translatedPath.segments, { type: 'index', index: 0 }],
                }),
                kind: 'node-head',
                ...(value.structuralId !== null ? { identity: value.structuralId } : {}),
                ...(value.datatype !== null ? { datatype: formatDatatypeAnnotation(value.datatype) } : {}),
                value: value.tag,
            });
        }
    }

    return projected;
}

function translateNodePath(path: CanonicalPath, nodeSourcePaths: ReadonlySet<string>): CanonicalPath {
    const sourceSegments: PathSegment[] = [];
    const targetSegments: PathSegment[] = [];

    for (const segment of path.segments) {
        if (
            segment.type === 'index'
            && sourceSegments.length > 0
            && nodeSourcePaths.has(formatPath({ segments: sourceSegments }))
        ) {
            targetSegments.push({ type: 'index', index: 0 });
        }
        sourceSegments.push(segment);
        targetSegments.push(segment);
    }

    return { segments: targetSegments };
}

function projectEvent(
    event: AssignmentEvent,
    path: CanonicalPath,
    value: Value,
    nodeSourcePaths: ReadonlySet<string>,
): PortableAesEvent {
    const projectedValue = projectValue(value, nodeSourcePaths);
    return {
        path: formatPath(path),
        kind: projectedValue.kind,
        ...(event.structuralId != null ? { identity: event.structuralId } : {}),
        ...(event.datatype !== undefined ? { datatype: event.datatype } : {}),
        ...(projectedValue.value !== undefined ? { value: projectedValue.value } : {}),
        span: event.span,
    };
}

function projectValue(
    value: Value,
    nodeSourcePaths: ReadonlySet<string>,
): { readonly kind: PortableAesKind; readonly value?: string } {
    switch (value.type) {
        case 'TypedValue':
            return projectValue(value.value, nodeSourcePaths);
        case 'StringLiteral':
            return { kind: 'string', value: value.value };
        case 'NumberLiteral':
            return { kind: 'number', value: value.value };
        case 'InfinityLiteral':
            return { kind: 'infinity', value: value.value };
        case 'NaNLiteral':
            return { kind: 'nan', value: value.value };
        case 'NullLiteral':
            return { kind: 'null', value: value.value };
        case 'BooleanLiteral':
            return { kind: 'boolean', value: String(value.value) };
        case 'ToggleLiteral':
            return { kind: 'toggle', value: value.value };
        case 'HexLiteral':
            return { kind: 'hex', value: value.value };
        case 'RadixLiteral':
            return { kind: 'radix', value: value.value };
        case 'EncodingLiteral':
            return { kind: 'encoding', value: value.value };
        case 'SeparatorLiteral':
            return { kind: 'separator', value: value.value };
        case 'SansaAddressLiteral':
            return { kind: 'sansa-address', value: value.canonical };
        case 'DateLiteral':
            return { kind: 'date', value: value.value };
        case 'TimeLiteral':
            return { kind: 'time', value: value.value };
        case 'DateTimeLiteral':
            return { kind: 'datetime', value: value.value };
        case 'ObjectNode':
            return { kind: 'object' };
        case 'ListNode':
            return { kind: 'list' };
        case 'TupleLiteral':
            return { kind: 'tuple' };
        case 'NodeLiteral':
            return { kind: 'node' };
        case 'CloneReference':
            return { kind: 'clone-reference', value: translateReferenceTarget(value.path, nodeSourcePaths) };
        case 'PointerReference':
            return { kind: 'pointer-reference', value: translateReferenceTarget(value.path, nodeSourcePaths) };
    }
}

function translateReferenceTarget(
    segments: Extract<Value, { type: 'CloneReference' | 'PointerReference' }>['path'],
    nodeSourcePaths: ReadonlySet<string>,
): string {
    const sourceSegments: PathSegment[] = [{ type: 'root' }];
    let sourcePathIsTrackable = true;
    let out = '$';

    for (const segment of segments) {
        if (typeof segment === 'number') {
            if (sourcePathIsTrackable && nodeSourcePaths.has(formatPath({ segments: sourceSegments }))) {
                out += '[0]';
            }
            out += `[${segment}]`;
            if (sourcePathIsTrackable) sourceSegments.push({ type: 'index', index: segment });
            continue;
        }

        const key = typeof segment === 'string' ? segment : segment.key;
        const member = formatPath({ segments: [{ type: 'root' }, { type: 'member', key }] }).slice(1);
        if (typeof segment === 'string') {
            out += member;
            if (sourcePathIsTrackable) sourceSegments.push({ type: 'member', key: segment });
        } else {
            out += `.@${member}`;
            sourcePathIsTrackable = false;
        }
    }

    return out;
}

function unwrapTypedValue(value: Value): Value {
    return value.type === 'TypedValue' ? unwrapTypedValue(value.value) : value;
}
