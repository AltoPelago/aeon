import type { Span } from '@altopelago/aeon-lexer';
import type { Attribute, Binding, Value } from '@altopelago/aeon-parser';
import { formatDatatypeAnnotation } from './datatype.js';
import type { AssignmentEvent, AttributeEntry } from './events.js';
import { formatPath, type CanonicalPath, type PathSegment } from './paths.js';

export type PortableAesKind =
    | 'StringLiteral'
    | 'NumberLiteral'
    | 'InfinityLiteral'
    | 'NaNLiteral'
    | 'NullLiteral'
    | 'BooleanLiteral'
    | 'ToggleLiteral'
    | 'HexLiteral'
    | 'RadixLiteral'
    | 'EncodingLiteral'
    | 'SeparatorLiteral'
    | 'SansaAddressLiteral'
    | 'DateLiteral'
    | 'TimeLiteral'
    | 'DateTimeLiteral'
    | 'WTCDateTimeLiteral'
    | 'ObjectNode'
    | 'ListNode'
    | 'TupleLiteral'
    | 'NodeLiteral'
    | 'NodeHead'
    | 'CloneReference'
    | 'PointerReference';

/**
 * Encoding-neutral AES event shape used by the portable projection work.
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
 * Project legacy TypeScript AssignmentEvents into the portable flat shape.
 *
 * Every NodeLiteral becomes a value-less `NodeLiteral` event followed by one
 * synthetic `NodeHead` event. Source child paths gain the NodeHead index,
 * recursively, while ordinary member/list/tuple paths remain unchanged.
 * Binding, anonymous-head, and node-head attributes are emitted as ordinary
 * events beneath their owning path's `.@` address space.
 */
export function projectPortableEvents(events: readonly AssignmentEvent[]): readonly PortableAesEvent[] {
    const nodeSourcePaths = new Set(
        events
            .filter((event) => unwrapTypedValue(event.value).type === 'NodeLiteral')
            .map((event) => formatPath(event.path)),
    );
    const projected: PortableAesEvent[] = [];

    for (const event of events) {
        const translatedPath = translateNodePath(event.path, nodeSourcePaths);
        const translatedPathText = formatPath(translatedPath);
        const value = unwrapTypedValue(event.value);
        projected.push(projectEvent(event, translatedPath, value, nodeSourcePaths));
        projectMappedAttributes(event.annotations, translatedPathText, projected, nodeSourcePaths);

        if (value.type === 'NodeLiteral') {
            const headPath = `${translatedPathText}[0]`;
            projected.push({
                path: headPath,
                kind: 'NodeHead',
                ...(value.structuralId !== null ? { identity: value.structuralId } : {}),
                ...(value.datatype !== null ? { datatype: formatDatatypeAnnotation(value.datatype) } : {}),
                value: value.tag,
            });
            projectParserAttributes(value.attributes, headPath, projected, nodeSourcePaths);
        }
    }

    return projected;
}

/** Compatibility name retained while downstream callers adopt the complete projection name. */
export const projectPortableNodeEvents = projectPortableEvents;

function projectMappedAttributes(
    attributes: ReadonlyMap<string, AttributeEntry> | undefined,
    ownerPath: string,
    projected: PortableAesEvent[],
    nodeSourcePaths: ReadonlySet<string>,
): void {
    if (!attributes) return;
    for (const [key, entry] of attributes) {
        projectValueTree(
            appendAttribute(ownerPath, key),
            entry.value,
            {
                ...(entry.structuralId != null ? { identity: entry.structuralId } : {}),
                ...(entry.datatype !== undefined ? { datatype: entry.datatype } : {}),
                ...(entry.annotations !== undefined ? { mappedAttributes: entry.annotations } : {}),
            },
            projected,
            nodeSourcePaths,
        );
    }
}

function projectParserAttributes(
    attributes: readonly Attribute[],
    ownerPath: string,
    projected: PortableAesEvent[],
    nodeSourcePaths: ReadonlySet<string>,
): void {
    for (const attribute of attributes) {
        for (const [key, entry] of attribute.entries) {
            projectValueTree(
                appendAttribute(ownerPath, key),
                entry.value,
                {
                    ...(entry.structuralId !== null ? { identity: entry.structuralId } : {}),
                    ...(entry.datatype !== null ? { datatype: formatDatatypeAnnotation(entry.datatype) } : {}),
                    parserAttributes: entry.attributes,
                },
                projected,
                nodeSourcePaths,
            );
        }
    }
}

interface ValueTreeMetadata {
    readonly identity?: string;
    readonly datatype?: string;
    readonly span?: Span;
    readonly mappedAttributes?: ReadonlyMap<string, AttributeEntry>;
    readonly parserAttributes?: readonly Attribute[];
}

function projectValueTree(
    path: string,
    rawValue: Value,
    metadata: ValueTreeMetadata,
    projected: PortableAesEvent[],
    nodeSourcePaths: ReadonlySet<string>,
): void {
    const value = unwrapTypedValue(rawValue);
    const portableValue = projectValue(value, nodeSourcePaths);
    projected.push({
        path,
        kind: portableValue.kind,
        ...(metadata.identity !== undefined ? { identity: metadata.identity } : {}),
        ...(metadata.datatype !== undefined ? { datatype: metadata.datatype } : {}),
        ...(portableValue.value !== undefined ? { value: portableValue.value } : {}),
        ...(metadata.span !== undefined ? { span: metadata.span } : {}),
    });
    projectMappedAttributes(metadata.mappedAttributes, path, projected, nodeSourcePaths);
    projectParserAttributes(metadata.parserAttributes ?? [], path, projected, nodeSourcePaths);

    switch (value.type) {
        case 'ObjectNode':
            for (const binding of value.bindings) {
                projectBindingTree(appendMember(path, binding.key), binding, projected, nodeSourcePaths);
            }
            return;
        case 'ListNode':
        case 'TupleLiteral':
            for (let index = 0; index < value.elements.length; index += 1) {
                projectAnonymousTree(`${path}[${index}]`, value.elements[index]!, projected, nodeSourcePaths);
            }
            return;
        case 'NodeLiteral': {
            const headPath = `${path}[0]`;
            projected.push({
                path: headPath,
                kind: 'NodeHead',
                ...(value.structuralId !== null ? { identity: value.structuralId } : {}),
                ...(value.datatype !== null ? { datatype: formatDatatypeAnnotation(value.datatype) } : {}),
                value: value.tag,
            });
            projectParserAttributes(value.attributes, headPath, projected, nodeSourcePaths);
            for (let index = 0; index < value.children.length; index += 1) {
                projectAnonymousTree(`${headPath}[${index}]`, value.children[index]!, projected, nodeSourcePaths);
            }
            return;
        }
        default:
            return;
    }
}

function projectBindingTree(
    path: string,
    binding: Binding,
    projected: PortableAesEvent[],
    nodeSourcePaths: ReadonlySet<string>,
): void {
    projectValueTree(
        path,
        binding.value,
        {
            ...(binding.structuralId !== null ? { identity: binding.structuralId } : {}),
            ...(binding.datatype !== null ? { datatype: formatDatatypeAnnotation(binding.datatype) } : {}),
            span: binding.span,
            parserAttributes: binding.attributes,
        },
        projected,
        nodeSourcePaths,
    );
}

function projectAnonymousTree(
    path: string,
    rawValue: Value,
    projected: PortableAesEvent[],
    nodeSourcePaths: ReadonlySet<string>,
): void {
    if (rawValue.type !== 'TypedValue') {
        projectValueTree(path, rawValue, { span: rawValue.span }, projected, nodeSourcePaths);
        return;
    }
    projectValueTree(
        path,
        rawValue.value,
        {
            ...(rawValue.structuralId !== null ? { identity: rawValue.structuralId } : {}),
            ...(rawValue.datatype !== null ? { datatype: formatDatatypeAnnotation(rawValue.datatype) } : {}),
            span: rawValue.span,
            parserAttributes: rawValue.attributes,
        },
        projected,
        nodeSourcePaths,
    );
}

function appendMember(ownerPath: string, key: string): string {
    return `${ownerPath}${formatPath({ segments: [{ type: 'root' }, { type: 'member', key }] }).slice(1)}`;
}

function appendAttribute(ownerPath: string, key: string): string {
    return `${ownerPath}.@${formatPath({ segments: [{ type: 'root' }, { type: 'member', key }] }).slice(1)}`;
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
            return { kind: 'StringLiteral', value: value.value };
        case 'NumberLiteral':
            return { kind: 'NumberLiteral', value: value.value };
        case 'InfinityLiteral':
            return { kind: 'InfinityLiteral', value: value.value };
        case 'NaNLiteral':
            return { kind: 'NaNLiteral', value: value.value };
        case 'NullLiteral':
            return { kind: 'NullLiteral', value: value.value };
        case 'BooleanLiteral':
            return { kind: 'BooleanLiteral', value: String(value.value) };
        case 'ToggleLiteral':
            return { kind: 'ToggleLiteral', value: value.value };
        case 'HexLiteral':
            return { kind: 'HexLiteral', value: value.value };
        case 'RadixLiteral':
            return { kind: 'RadixLiteral', value: value.value };
        case 'EncodingLiteral':
            return { kind: 'EncodingLiteral', value: value.value };
        case 'SeparatorLiteral':
            return { kind: 'SeparatorLiteral', value: value.value };
        case 'SansaAddressLiteral':
            return { kind: 'SansaAddressLiteral', value: value.canonical };
        case 'DateLiteral':
            return { kind: 'DateLiteral', value: value.value };
        case 'TimeLiteral':
            return { kind: 'TimeLiteral', value: value.value };
        case 'DateTimeLiteral':
            return { kind: value.raw.includes('&') ? 'WTCDateTimeLiteral' : 'DateTimeLiteral', value: value.value };
        case 'ObjectNode':
            return { kind: 'ObjectNode' };
        case 'ListNode':
            return { kind: 'ListNode' };
        case 'TupleLiteral':
            return { kind: 'TupleLiteral' };
        case 'NodeLiteral':
            return { kind: 'NodeLiteral' };
        case 'CloneReference':
            return { kind: 'CloneReference', value: translateReferenceTarget(value.path, nodeSourcePaths) };
        case 'PointerReference':
            return { kind: 'PointerReference', value: translateReferenceTarget(value.path, nodeSourcePaths) };
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
