import type { Span } from '@altopelago/aeon-lexer';
import type { Attribute, Binding, Value } from '@altopelago/aeon-parser';
import { formatDatatypeAnnotation } from './datatype.js';
import type { AssignmentEvent, AttributeEntry } from './events.js';
import { formatPath, type CanonicalPath } from './paths.js';
import { sha256Hex } from './sha256.js';
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
    | 'SymbolicLiteral'
    | 'SansaAddressLiteral'
    | 'DateLiteral'
    | 'TimeLiteral'
    | 'DateTimeLiteral'
    | 'WTCDateTimeLiteral'
    | 'ObjectNode'
    | 'ListNode'
    | 'TupleLiteral'
    | 'NodeLiteral'
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
    readonly generics?: readonly AesDatatypeDescriptor[];
    readonly clarifiers?: readonly (AesStringLiteral | AesNumberLiteral)[];
    readonly value?: string;
    readonly tag?: string;
    readonly origin?: string;
    readonly span?: string;
}

export const TYPESCRIPT_ASSIGNMENT_EVENTS_CONTRACT_V0 = 'aeon.typescript.assignment-events.v0' as const;
export const TYPESCRIPT_PORTABLE_AES_ADAPTER_V0 =
    'aeon.typescript.assignment-events.v0-to-aes.events.v1' as const;
export const TYPESCRIPT_PORTABLE_AES_ADAPTER_VERSION_V1 = '1.0.0' as const;

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

export interface PortableAesConversionReportV1 {
    readonly sourceContract: typeof TYPESCRIPT_ASSIGNMENT_EVENTS_CONTRACT_V0;
    readonly targetContract: 'aes.events.v1';
    readonly adapter: typeof TYPESCRIPT_PORTABLE_AES_ADAPTER_V0;
    readonly adapterVersion: typeof TYPESCRIPT_PORTABLE_AES_ADAPTER_VERSION_V1;
    readonly profile: 'aes.complete.v1';
    readonly projection: null | 'aeon.document.v1';
    readonly semanticLossless: boolean;
    readonly recordLossless: boolean;
    readonly provenanceLossless: boolean;
    readonly semanticLossAuthorized: boolean;
    readonly changes: readonly PortableAesConversionChange[];
}

export interface PortableAesCompatibilityEvent extends Omit<PortableAesEvent, 'path'> {
    readonly path?: string;
    readonly header?: string;
}

export interface PortableAesCompatibilityResultV1 {
    readonly events: readonly PortableAesCompatibilityEvent[];
    readonly report: PortableAesConversionReportV1;
}

export interface PortableAesCompatibilityOptions {
    readonly includeHeaders?: boolean;
    /** Exact unprefixed fields from the retained AEON header model. */
    readonly headerFieldNames?: readonly string[] | ReadonlySet<string>;
    /** Exact, unnormalized UTF-8 source artifact used to derive origin and byte spans. */
    readonly sourceBytes?: Uint8Array;
}

export interface PortableAesProjectionOptions {
    /** Exact unprefixed fields from the retained AEON header model. */
    readonly headerFieldNames?: readonly string[] | ReadonlySet<string>;
}

export class PortableAesSourceError extends Error {
    readonly code: string;

    constructor(code: string, message: string) {
        super(message);
        this.name = 'PortableAesSourceError';
        this.code = code;
    }
}

/**
 * Named, report-bearing compatibility adapter for the serialized TypeScript
 * assignment-event contract. Existing projection helpers remain unchanged for
 * same-process callers. Native spans are UTF-16 string indexes. They are
 * omitted unless exact sourceBytes are supplied, in which case this boundary
 * derives the source digest and converts scalar-aligned positions to UTF-8
 * byte offsets.
 */
export function adaptTypeScriptAssignmentEventsToPortableAes(
    events: readonly AssignmentEvent[],
    options: PortableAesCompatibilityOptions = {},
): PortableAesCompatibilityResultV1 {
    const includeHeaders = options.includeHeaders === true;
    const headerFieldNames = options.headerFieldNames === undefined
        ? undefined
        : new Set(options.headerFieldNames);
    const isHeader = (event: AssignmentEvent): boolean => isLegacyHeaderEvent(event, headerFieldNames);
    const body = events.filter((event) => !isHeader(event));
    const headers = includeHeaders ? events.filter(isHeader) : [];
    const provenance = options.sourceBytes === undefined ? null : createPortableSourceContext(options.sourceBytes);
    const bodyEvents = projectPortableEventsWithLocalSpans(body)
        .map((event) => applyPortableProvenance(event, provenance));
    const headerEvents = projectPortableEventsWithLocalSpans(headers).map((local): PortableAesCompatibilityEvent => {
        const event = applyPortableProvenance(local, provenance);
        const { path, span: _span, ...rest } = event;
        if (path === undefined) {
            throw new PortableAesSourceError(
                'AES_COMPAT_HEADER_PATH_MISSING',
                'A projected legacy header event must retain its source path.',
            );
        }
        return { header: path, ...rest, ...(event.span !== undefined ? { span: event.span } : {}) };
    });
    const projected = [...headerEvents, ...bodyEvents];
    const changes = compatibilityChanges(
        events,
        body,
        projected,
        includeHeaders,
        provenance !== null,
        headerFieldNames,
    );
    const provenanceLossless = events.length === 0 || (
        provenance !== null
        && projected.length > 0
        && projected.every((event) => event.origin !== undefined && event.span !== undefined)
    );
    return {
        events: projected,
        report: {
            sourceContract: TYPESCRIPT_ASSIGNMENT_EVENTS_CONTRACT_V0,
            targetContract: 'aes.events.v1',
            adapter: TYPESCRIPT_PORTABLE_AES_ADAPTER_V0,
            adapterVersion: TYPESCRIPT_PORTABLE_AES_ADAPTER_VERSION_V1,
            profile: 'aes.complete.v1',
            projection: includeHeaders ? 'aeon.document.v1' : null,
            semanticLossless: true,
            recordLossless: events.length === 0,
            provenanceLossless,
            semanticLossAuthorized: false,
            changes,
        },
    };
}

/**
 * Project legacy TypeScript AssignmentEvents into the portable flat shape.
 *
 * Nodes retain their source paths and intrinsic tags. Attributes are emitted
 * beneath their owning path in the `.@` address space. The default portable
 * projection is body-only; use the named compatibility adapter with
 * `includeHeaders: true` to select the explicit document projection.
 */
export function projectPortableEvents(
    events: readonly AssignmentEvent[],
    options: PortableAesProjectionOptions = {},
): readonly PortableAesEvent[] {
    const headerFieldNames = options.headerFieldNames === undefined
        ? undefined
        : new Set(options.headerFieldNames);
    return projectPortableEventsWithLocalSpans(
        events.filter((event) => !isLegacyHeaderEvent(event, headerFieldNames)),
    )
        .map((projected) => projected.event);
}

interface PortableEventWithLocalSpan {
    readonly event: PortableAesEvent;
    readonly sourceSpan?: Span;
}

function projectPortableEventsWithLocalSpans(
    events: readonly AssignmentEvent[],
): readonly PortableEventWithLocalSpan[] {
    const projected: PortableEventWithLocalSpan[] = [];
    for (const event of events) {
        const path = formatPath(event.path);
        const value = unwrapTypedValue(event.value);
        pushProjected(projected, projectEvent(event, event.path, value), event.span);
        if (event.annotations !== undefined) {
            projectMappedAttributes(event.annotations, path, projected);
        } else if (value.type === 'NodeLiteral') {
            projectParserAttributes(value.attributes, path, projected);
        }
    }
    return projected;
}

/** Map native AssignmentEvent paths to their portable AES occurrence paths. */
export function createPortableEventPathMap(events: readonly AssignmentEvent[]): ReadonlyMap<string, string> {
    return new Map(events.map(event => {
        const path = formatPath(event.path);
        return [path, path];
    }));
}

/** Compatibility name retained while downstream callers adopt the complete projection name. */
export const projectPortableNodeEvents = projectPortableEvents;

function projectMappedAttributes(
    attributes: ReadonlyMap<string, AttributeEntry> | undefined,
    ownerPath: string,
    projected: PortableEventWithLocalSpan[],
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
                ...(entry.span !== undefined ? { sourceSpan: entry.span } : {}),
            },
            projected,
        );
    }
}

function projectParserAttributes(
    attributes: readonly Attribute[],
    ownerPath: string,
    projected: PortableEventWithLocalSpan[],
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
                    ...(entry.span !== undefined ? { sourceSpan: entry.span } : {}),
                },
                projected,
            );
        }
    }
}

interface ValueTreeMetadata {
    readonly identity?: string;
    readonly datatype?: string;
    readonly mappedAttributes?: ReadonlyMap<string, AttributeEntry>;
    readonly parserAttributes?: readonly Attribute[];
    readonly sourceSpan?: Span;
}

function projectValueTree(
    path: string,
    rawValue: Value,
    metadata: ValueTreeMetadata,
    projected: PortableEventWithLocalSpan[],
): void {
    const value = unwrapTypedValue(rawValue);
    const portableValue = projectValue(value);
    pushProjected(projected, {
        path,
        ...portableValue,
        ...projectNodeMetadata(value, metadata.identity, metadata.datatype),
    }, metadata.sourceSpan ?? rawValue.span);
    projectMappedAttributes(metadata.mappedAttributes, path, projected);
    if (value.type === 'NodeLiteral' && metadata.mappedAttributes === undefined) {
        projectParserAttributes(value.attributes, path, projected);
    } else {
        projectParserAttributes(metadata.parserAttributes ?? [], path, projected);
    }

    switch (value.type) {
        case 'ObjectNode':
            for (const binding of value.bindings) {
                projectBindingTree(appendMember(path, binding.key), binding, projected);
            }
            return;
        case 'ListNode':
        case 'TupleLiteral':
            for (let index = 0; index < value.elements.length; index += 1) {
                projectAnonymousTree(`${path}[${index}]`, value.elements[index]!, projected);
            }
            return;
        case 'NodeLiteral':
            for (let index = 0; index < value.children.length; index += 1) {
                projectAnonymousTree(`${path}[${index}]`, value.children[index]!, projected);
            }
            return;
        default:
            return;
    }
}

function projectBindingTree(
    path: string,
    binding: Binding,
    projected: PortableEventWithLocalSpan[],
): void {
    projectValueTree(
        path,
        binding.value,
        {
            ...(binding.structuralId !== null ? { identity: binding.structuralId } : {}),
            ...(binding.datatype !== null ? { datatype: formatDatatypeAnnotation(binding.datatype) } : {}),
            parserAttributes: binding.attributes,
            sourceSpan: binding.span,
        },
        projected,
    );
}

function projectAnonymousTree(
    path: string,
    rawValue: Value,
    projected: PortableEventWithLocalSpan[],
): void {
    if (rawValue.type !== 'TypedValue') {
        projectValueTree(path, rawValue, { sourceSpan: rawValue.span }, projected);
        return;
    }
    projectValueTree(
        path,
        rawValue.value,
        {
            ...(rawValue.structuralId !== null ? { identity: rawValue.structuralId } : {}),
            ...(rawValue.datatype !== null ? { datatype: formatDatatypeAnnotation(rawValue.datatype) } : {}),
            parserAttributes: rawValue.attributes,
            sourceSpan: rawValue.span,
        },
        projected,
    );
}

function appendMember(ownerPath: string, key: string): string {
    return `${ownerPath}${formatPath({ segments: [{ type: 'root' }, { type: 'member', key }] }).slice(1)}`;
}

function appendAttribute(ownerPath: string, key: string): string {
    return `${ownerPath}.@${formatPath({ segments: [{ type: 'root' }, { type: 'member', key }] }).slice(1)}`;
}

function projectEvent(
    event: AssignmentEvent,
    path: CanonicalPath,
    value: Value,
): PortableAesEvent {
    const projectedValue = projectValue(value);
    return {
        path: formatPath(path),
        ...projectedValue,
        ...projectNodeMetadata(value, event.structuralId ?? undefined, event.datatype),
    };
}

function projectNodeMetadata(value: Value, identity?: string, datatype?: string): Partial<PortableAesEvent> {
    if (value.type === 'NodeLiteral') {
        identity = value.structuralId ?? undefined;
        datatype = value.datatype ? formatDatatypeAnnotation(value.datatype) : undefined;
    }
    return { ...(identity !== undefined ? { identity } : {}), ...projectDatatype(datatype) };
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
): Pick<PortableAesEvent, 'kind' | 'value' | 'tag'> {
    switch (value.type) {
        case 'TypedValue':
            return projectValue(value.value);
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
        case 'SymbolicLiteral':
            return { kind: 'SymbolicLiteral', value: value.value };
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
            return { kind: 'NodeLiteral', tag: value.tag };
        case 'CloneReference':
        case 'PointerReference':
            if ((value as unknown as { selection?: unknown }).selection !== undefined) {
                throw new PortableAesSourceError('AES_UNSUPPORTED_REFERENCE_SELECTION', 'Structural references cannot contain semantic selections.');
            }
            return { kind: value.type, value: formatReferenceTarget(value.path) };
    }
}

function formatReferenceTarget(
    segments: Extract<Value, { type: 'CloneReference' | 'PointerReference' }>['path'],
): string {
    let path = '$';
    for (const segment of segments) {
        if (typeof segment === 'number') path += `[${segment}]`;
        else if (typeof segment === 'string') path = appendMember(path, segment);
        else path = appendAttribute(path, segment.key);
    }
    return path;
}

function isLegacyHeaderEvent(
    event: AssignmentEvent,
    headerFieldNames?: ReadonlySet<string>,
): boolean {
    if (event.sourcePlane !== undefined) return event.sourcePlane === 'header';
    const segment = event.path.segments[1];
    if (segment?.type !== 'member' || !segment.key.startsWith('aeon:')) return false;
    return headerFieldNames === undefined || headerFieldNames.has(segment.key.slice('aeon:'.length));
}

function compatibilityChanges(
    sourceEvents: readonly AssignmentEvent[],
    bodyEvents: readonly AssignmentEvent[],
    projected: readonly PortableAesCompatibilityEvent[],
    includeHeaders: boolean,
    sourceBacked: boolean,
    headerFieldNames?: ReadonlySet<string>,
): readonly PortableAesConversionChange[] {
    const changes: PortableAesConversionChange[] = [];
    const pathMap = createPortableEventPathMap(bodyEvents);

    for (const event of sourceEvents) {
        const sourcePath = formatPath(event.path);
        const header = isLegacyHeaderEvent(event, headerFieldNames);
        const targetPath = header && includeHeaders ? sourcePath : pathMap.get(sourcePath);
        if (!sourceBacked) {
            changes.push({
                kind: 'omitted',
                code: 'AES_COMPAT_PROVENANCE_OMITTED',
                field: 'span',
                message: 'The local source span is omitted because it is not bound to an immutable portable origin.',
                sourcePath,
                ...(targetPath !== undefined ? { targetPath } : {}),
                requiresAuthorization: false,
            });
        }
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
        }
    }

    for (const event of projected) {
        const targetPath = event.path ?? event.header;
        if (sourceBacked) {
            changes.push(event.span === undefined ? {
                kind: 'omitted',
                code: 'AES_COMPAT_PROVENANCE_RANGE_OMITTED',
                field: 'span',
                message: 'The exact source is identified, but this occurrence has no independently retained source range.',
                ...(targetPath !== undefined ? { targetPath } : {}),
                requiresAuthorization: false,
            } : {
                kind: 'transformed',
                code: 'AES_COMPAT_UTF8_SPAN_CONVERTED',
                field: 'span',
                message: 'The native UTF-16 source range is converted to an exact UTF-8 byte range.',
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

interface PortableSourceContext {
    readonly origin: string;
    readonly byteOffsets: readonly (number | null)[];
}

function createPortableSourceContext(sourceBytes: Uint8Array): PortableSourceContext {
    if (!(sourceBytes instanceof Uint8Array)) {
        throw new PortableAesSourceError(
            'AES_COMPAT_SOURCE_REQUIRED',
            'Portable source provenance requires exact UTF-8 bytes.',
        );
    }
    const bytes = Uint8Array.from(sourceBytes);
    let source: string;
    try {
        source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
        throw new PortableAesSourceError(
            'AES_SOURCE_INVALID_UTF8',
            'Portable source provenance requires a valid UTF-8 artifact.',
        );
    }
    const byteOffsets: Array<number | null> = new Array(source.length + 1).fill(null);
    let utf16Offset = 0;
    let byteOffset = 0;
    byteOffsets[0] = 0;
    while (utf16Offset < source.length) {
        const codePoint = source.codePointAt(utf16Offset)!;
        const codeUnitWidth = codePoint > 0xFFFF ? 2 : 1;
        byteOffset += utf8CodePointWidth(codePoint);
        utf16Offset += codeUnitWidth;
        byteOffsets[utf16Offset] = byteOffset;
    }
    return {
        origin: `sha256:${sha256Hex(bytes)}`,
        byteOffsets,
    };
}

function utf8CodePointWidth(codePoint: number): number {
    if (codePoint <= 0x7F) return 1;
    if (codePoint <= 0x7FF) return 2;
    if (codePoint <= 0xFFFF) return 3;
    return 4;
}

function applyPortableProvenance(
    projected: PortableEventWithLocalSpan,
    source: PortableSourceContext | null,
): PortableAesCompatibilityEvent {
    if (source === null) return projected.event;
    if (projected.sourceSpan === undefined) return { ...projected.event, origin: source.origin };
    const start = source.byteOffsets[projected.sourceSpan.start.offset];
    const end = source.byteOffsets[projected.sourceSpan.end.offset];
    if (start === undefined || end === undefined || start === null || end === null || start >= end) {
        throw new PortableAesSourceError(
            'AES_COMPAT_SOURCE_RANGE_INVALID',
            `Native source span ${projected.sourceSpan.start.offset}:${projected.sourceSpan.end.offset} is outside the exact UTF-8 artifact or splits a Unicode scalar.`,
        );
    }
    return { ...projected.event, origin: source.origin, span: `${start}:${end}` };
}

function pushProjected(
    projected: PortableEventWithLocalSpan[],
    event: PortableAesEvent,
    sourceSpan?: Span,
): void {
    projected.push({ event, ...(sourceSpan !== undefined ? { sourceSpan } : {}) });
}

function unwrapTypedValue(value: Value): Value {
    return value.type === 'TypedValue' ? unwrapTypedValue(value.value) : value;
}
