import type { Attribute, Binding, Value } from '@altopelago/aeon-parser';
import { formatDatatypeAnnotation } from './datatype.js';
import type { AssignmentEvent, AttributeEntry } from './events.js';
import { formatPath, type CanonicalPath, type PathSegment } from './paths.js';
import {
    parseDatatypeDescriptor,
    type AesDatatypeDescriptor,
    type AesNumberLiteral,
    type AesStringLiteral,
} from './telex.js';

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
    readonly generics?: readonly (AesDatatypeDescriptor | AesNumberLiteral)[];
    readonly clarifiers?: readonly (AesStringLiteral | AesNumberLiteral)[];
    readonly value?: string;
    readonly origin?: string;
    readonly span?: string;
}

export const TYPESCRIPT_ASSIGNMENT_EVENTS_CONTRACT_V0 = 'aeon.typescript.assignment-events.v0' as const;
export const TYPESCRIPT_PORTABLE_AES_ADAPTER_V0 =
    'aeon.typescript.assignment-events.v0-to-aes.events.v0' as const;
export const TYPESCRIPT_PORTABLE_AES_ADAPTER_VERSION_V0 = '0.1.0-candidate' as const;

export type PortableAesConversionChangeKind = 'transformed' | 'synthesized' | 'omitted' | 'semantic-loss';

export interface PortableAesConversionChange {
    readonly kind: PortableAesConversionChangeKind;
    readonly code: string;
    readonly field: string;
    readonly message: string;
    readonly sourcePath?: string;
    readonly targetPath?: string;
    readonly requiresAuthorization: boolean;
}

export interface PortableAesConversionReportV0 {
    readonly sourceContract: typeof TYPESCRIPT_ASSIGNMENT_EVENTS_CONTRACT_V0;
    readonly targetContract: 'aes.events.v0';
    readonly adapter: typeof TYPESCRIPT_PORTABLE_AES_ADAPTER_V0;
    readonly adapterVersion: typeof TYPESCRIPT_PORTABLE_AES_ADAPTER_VERSION_V0;
    readonly profile: 'aes.complete.v0';
    readonly projection: null | 'aeon.document.v0';
    readonly semanticLossless: boolean;
    readonly recordLossless: boolean;
    readonly provenanceLossless: boolean;
    readonly semanticLossAuthorized: boolean;
    readonly changes: readonly PortableAesConversionChange[];
}

export interface PortableAesCompatibilityEvent extends Omit<PortableAesEvent, 'path' | 'span'> {
    readonly path?: string;
    readonly header?: string;
}

export interface PortableAesCompatibilityResultV0 {
    readonly events: readonly PortableAesCompatibilityEvent[];
    readonly report: PortableAesConversionReportV0;
}

export interface PortableAesCompatibilityOptions {
    readonly includeHeaders?: boolean;
}

/**
 * Named, report-bearing compatibility adapter for the serialized TypeScript
 * assignment-event contract. Existing projection helpers remain unchanged for
 * same-process callers. Local source spans are omitted because the source
 * contract does not bind them to an immutable portable origin.
 */
export function adaptTypeScriptAssignmentEventsToPortableAes(
    events: readonly AssignmentEvent[],
    options: PortableAesCompatibilityOptions = {},
): PortableAesCompatibilityResultV0 {
    const includeHeaders = options.includeHeaders === true;
    const body = events.filter((event) => !isLegacyHeaderEvent(event));
    const headers = includeHeaders ? events.filter(isLegacyHeaderEvent) : [];
    const bodyEvents = projectPortableEvents(body).map(stripLocalSpan);
    const headerEvents = projectPortableEvents(headers).map((event): PortableAesCompatibilityEvent => {
        const { path, span: _span, ...rest } = event;
        return { header: path, ...rest };
    });
    const projected = [...headerEvents, ...bodyEvents];
    const changes = compatibilityChanges(events, body, projected, includeHeaders);
    return {
        events: projected,
        report: {
            sourceContract: TYPESCRIPT_ASSIGNMENT_EVENTS_CONTRACT_V0,
            targetContract: 'aes.events.v0',
            adapter: TYPESCRIPT_PORTABLE_AES_ADAPTER_V0,
            adapterVersion: TYPESCRIPT_PORTABLE_AES_ADAPTER_VERSION_V0,
            profile: 'aes.complete.v0',
            projection: includeHeaders ? 'aeon.document.v0' : null,
            semanticLossless: true,
            recordLossless: events.length === 0,
            provenanceLossless: events.length === 0,
            semanticLossAuthorized: false,
            changes,
        },
    };
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
                ...projectDatatype(value.datatype === null ? undefined : formatDatatypeAnnotation(value.datatype)),
                value: value.tag,
            });
            projectParserAttributes(value.attributes, headPath, projected, nodeSourcePaths);
        }
    }

    return projected;
}

/**
 * Map native AssignmentEvent paths to their portable AES occurrence paths.
 *
 * The map is structure-aware: every indexed source segment beneath a node
 * gains the synthetic NodeHead index. Synthetic NodeHead paths themselves do
 * not have a native AssignmentEvent counterpart and are therefore absent.
 */
export function createPortableEventPathMap(events: readonly AssignmentEvent[]): ReadonlyMap<string, string> {
    const nodeSourcePaths = new Set(
        events
            .filter((event) => unwrapTypedValue(event.value).type === 'NodeLiteral')
            .map((event) => formatPath(event.path)),
    );
    return new Map(events.map((event) => [
        formatPath(event.path),
        formatPath(translateNodePath(event.path, nodeSourcePaths)),
    ]));
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
        ...projectDatatype(metadata.datatype),
        ...(portableValue.value !== undefined ? { value: portableValue.value } : {}),
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
                ...projectDatatype(value.datatype === null ? undefined : formatDatatypeAnnotation(value.datatype)),
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
        projectValueTree(path, rawValue, {}, projected, nodeSourcePaths);
        return;
    }
    projectValueTree(
        path,
        rawValue.value,
        {
            ...(rawValue.structuralId !== null ? { identity: rawValue.structuralId } : {}),
            ...(rawValue.datatype !== null ? { datatype: formatDatatypeAnnotation(rawValue.datatype) } : {}),
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
        ...projectDatatype(event.datatype),
        ...(projectedValue.value !== undefined ? { value: projectedValue.value } : {}),
    };
}

function projectDatatype(datatype: string | undefined): Partial<PortableAesEvent> {
    if (datatype === undefined) return {};
    const descriptor = parseDatatypeDescriptor(datatype);
    return {
        datatype: descriptor.datatype,
        generics: descriptor.generics,
        clarifiers: descriptor.clarifiers,
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

function isLegacyHeaderEvent(event: AssignmentEvent): boolean {
    const segment = event.path.segments[1];
    return segment?.type === 'member' && segment.key.startsWith('aeon:');
}

function stripLocalSpan(event: PortableAesEvent): PortableAesCompatibilityEvent {
    const { span: _span, ...portable } = event;
    return portable;
}

function compatibilityChanges(
    sourceEvents: readonly AssignmentEvent[],
    bodyEvents: readonly AssignmentEvent[],
    projected: readonly PortableAesCompatibilityEvent[],
    includeHeaders: boolean,
): readonly PortableAesConversionChange[] {
    const changes: PortableAesConversionChange[] = [];
    const pathMap = createPortableEventPathMap(bodyEvents);

    for (const event of sourceEvents) {
        const sourcePath = formatPath(event.path);
        const header = isLegacyHeaderEvent(event);
        const targetPath = header && includeHeaders ? sourcePath : pathMap.get(sourcePath);
        changes.push({
            kind: 'omitted',
            code: 'AES_COMPAT_PROVENANCE_OMITTED',
            field: 'span',
            message: 'The local source span is omitted because it is not bound to an immutable portable origin.',
            sourcePath,
            ...(targetPath !== undefined ? { targetPath } : {}),
            requiresAuthorization: false,
        });
        changes.push({
            kind: 'transformed',
            code: 'AES_COMPAT_SOURCE_REPRESENTATION_REDUCED',
            field: 'key,normalizedPath,value',
            message: 'Implementation-specific navigation fields and AST representation are reduced to portable AES fields.',
            sourcePath,
            ...(targetPath !== undefined ? { targetPath } : {}),
            requiresAuthorization: false,
        });
        if (header && !includeHeaders) {
            changes.push({
                kind: 'omitted',
                code: 'AES_COMPAT_HEADER_EXCLUDED',
                field: 'event',
                message: 'The synthetic AEON header event is excluded by the default body-only projection.',
                sourcePath,
                requiresAuthorization: false,
            });
            continue;
        }
        if (header) {
            changes.push({
                kind: 'transformed',
                code: 'AES_COMPAT_HEADER_PROJECTED',
                field: 'path',
                message: 'The recognized synthetic AEON header event is moved to the header address plane.',
                sourcePath,
                targetPath: sourcePath,
                requiresAuthorization: false,
            });
        } else if (targetPath !== undefined && targetPath !== sourcePath) {
            changes.push({
                kind: 'transformed',
                code: 'AES_COMPAT_PATH_TRANSLATED',
                field: 'path',
                message: 'The source occurrence path is translated through the explicit portable node-head level.',
                sourcePath,
                targetPath,
                requiresAuthorization: false,
            });
        }

        const value = unwrapTypedValue(event.value);
        if (value.type === 'CloneReference' || value.type === 'PointerReference') {
            const sourceTarget = translateReferenceTarget(value.path, new Set());
            const nodePaths = new Set(bodyEvents
                .filter((candidate) => unwrapTypedValue(candidate.value).type === 'NodeLiteral')
                .map((candidate) => formatPath(candidate.path)));
            const portableTarget = translateReferenceTarget(value.path, nodePaths);
            if (sourceTarget !== portableTarget) {
                changes.push({
                    kind: 'transformed',
                    code: 'AES_COMPAT_REFERENCE_TRANSLATED',
                    field: 'value.path',
                    message: `The reference target is translated from ${sourceTarget} to ${portableTarget}.`,
                    sourcePath,
                    ...(targetPath !== undefined ? { targetPath } : {}),
                    requiresAuthorization: false,
                });
            }
        }
    }

    for (const event of projected) {
        const targetPath = event.path ?? event.header;
        if (event.kind === 'NodeHead') {
            changes.push({
                kind: 'synthesized',
                code: 'AES_COMPAT_NODE_HEAD_SYNTHESIZED',
                field: 'NodeHead',
                message: 'The implicit implementation node tag is emitted as an explicit portable NodeHead event.',
                ...(targetPath !== undefined ? { targetPath } : {}),
                requiresAuthorization: false,
            });
        }
        if (targetPath?.includes('.@')) {
            changes.push({
                kind: 'transformed',
                code: 'AES_COMPAT_ATTRIBUTE_FLATTENED',
                field: 'attributes',
                message: 'The nested implementation attribute entry is emitted as an ordinary flat AES event.',
                targetPath,
                requiresAuthorization: false,
            });
        }
        if (event.datatype !== undefined) {
            changes.push({
                kind: 'transformed',
                code: 'AES_COMPAT_DATATYPE_EXPANDED',
                field: 'datatype',
                message: 'The combined datatype descriptor is expanded into datatype, generics, and clarifiers.',
                ...(targetPath !== undefined ? { targetPath } : {}),
                requiresAuthorization: false,
            });
        }
    }

    return changes;
}

function unwrapTypedValue(value: Value): Value {
    return value.type === 'TypedValue' ? unwrapTypedValue(value.value) : value;
}
