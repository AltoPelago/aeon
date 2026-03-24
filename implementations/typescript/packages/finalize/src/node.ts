import type { AssignmentEvent } from '@aeon/aes';
import type {
    Diagnostic,
    FinalizeHeader,
    FinalizeMeta,
    FinalizeNodeResult,
    FinalizeOptions,
    FinalizedNode,
    FinalizedObjectNode,
    FinalizedListNode,
    FinalizedScalarNode,
    FinalizedReferenceNode,
} from './types.js';
import { formatReferencePath } from './reference-path.js';
import type { ReferencePathPart } from './reference-path.js';
import { formatDatatypeAnnotation } from './datatype.js';
import { createProjectionState, shouldIncludeProjectedPath } from './projection.js';

type Span = AssignmentEvent['span'];
type Value = AssignmentEvent['value'];
type ObjectValue = Extract<Value, { type: 'ObjectNode'; bindings: readonly unknown[] }>;
type Binding = ObjectValue['bindings'][number];
type Attribute = Binding['attributes'][number];
type AnnotationMap = NonNullable<AssignmentEvent['annotations']>;
type AnnotationEntry = AnnotationMap extends ReadonlyMap<string, infer T>
    ? T
    : { value: Value; datatype?: string };
type ProjectionState = ReturnType<typeof createProjectionState>;
type FinalizeScope = 'full' | 'header' | 'payload';

function toDiagnostic(level: 'error' | 'warning', message: string, path?: string, span?: unknown): Diagnostic {
    return {
        level,
        message,
        ...(path !== undefined ? { path } : {}),
        ...(span !== undefined ? { span: span as any } : {}),
    };
}

type NodeContext = {
    strict: boolean;
    errors: Diagnostic[];
    warnings: Diagnostic[];
};

type NodeMeta = {
    span: Span;
    datatype?: string;
    annotations?: ReadonlyMap<string, AnnotationEntry>;
};

const RESERVED_OBJECT_KEYS = new Set(['@', '$', '$node', '$children']);

export function finalizeNode(
    aes: readonly AssignmentEvent[],
    options: FinalizeOptions = {}
): FinalizeNodeResult {
    const strict = (options.mode ?? 'strict') === 'strict';
    const scope = options.scope ?? 'payload';
    const errors: Diagnostic[] = [];
    const warnings: Diagnostic[] = [];

    const ctx: NodeContext = { strict, errors, warnings };
    const projection = createProjectionState(options.includePaths, options.materialization);
    const rootEntries = new Map<string, FinalizedNode>();

    if (scope !== 'payload') {
        rootEntries.set('header', headerNode(options.header, ctx, projection, scope));
    }
    if (scope !== 'header') {
        const payloadEntries = payloadEntriesToNode(aes, ctx, projection, scope, options.header);
        if (scope === 'full') {
            rootEntries.set('payload', {
                type: 'Object',
                entries: payloadEntries,
                span: payloadEntries.size > 0 ? payloadEntries.values().next().value.span as Span : emptySpan(),
            });
        } else {
            for (const [key, value] of payloadEntries) {
                rootEntries.set(key, value);
            }
        }
    }

    const meta: FinalizeMeta = {
        ...(errors.length > 0 ? { errors } : {}),
        ...(warnings.length > 0 ? { warnings } : {}),
    };

    const root: FinalizedObjectNode = {
        type: 'Object',
        entries: rootEntries,
        span: firstNodeSpan(rootEntries) ?? emptySpan(),
    };

    return Object.keys(meta).length > 0 ? { document: { root }, meta } : { document: { root } };
}

function payloadEntriesToNode(
    aes: readonly AssignmentEvent[],
    ctx: NodeContext,
    projection: ProjectionState,
    scope: FinalizeScope,
    header: FinalizeHeader | undefined
): Map<string, FinalizedNode> {
    const rootEntries = new Map<string, FinalizedNode>();
    for (const event of aes) {
        if (!isTopLevel(event.path)) continue;
        const segment = event.path.segments[1];
        if (!segment || segment.type !== 'member') continue;
        const key = segment.key;
        if (isHeaderEventKey(key, header)) continue;
        const eventPath = scopedTopLevelPath(scope, 'payload', key);
        if (!shouldIncludeProjectedPath(eventPath, projection)) continue;
        if (isReservedObjectKey(key)) {
            ctx.errors.push(toDiagnostic(
                'error',
                `Reserved key: ${key}`,
                eventPath,
                event.span
            ));
            continue;
        }
        if (rootEntries.has(key)) {
            const diag = toDiagnostic(
                ctx.strict ? 'error' : 'warning',
                `Duplicate top-level key during node finalization: ${key}`,
                eventPath,
                event.span
            );
            if (ctx.strict) ctx.errors.push(diag);
            else ctx.warnings.push(diag);
            if (ctx.strict) continue;
        }
        const meta: NodeMeta = {
            span: event.span,
            ...(event.datatype ? { datatype: event.datatype } : {}),
            ...(event.annotations ? { annotations: event.annotations } : {}),
        };
        rootEntries.set(key, valueToNode(event.value, meta, ctx, eventPath, projection));
    }
    return rootEntries;
}

function headerNode(
    header: FinalizeHeader | undefined,
    ctx: NodeContext,
    projection: ProjectionState,
    scope: FinalizeScope
): FinalizedObjectNode {
    const entries = new Map<string, FinalizedNode>();
    if (header) {
        for (const [key, value] of header.fields) {
            const path = scopedTopLevelPath(scope, 'header', key);
            if (!shouldIncludeProjectedPath(path, projection)) continue;
            entries.set(key, valueToNode(value, { span: value.span }, ctx, path, projection));
        }
    }

    return {
        type: 'Object',
        entries,
        span: header?.span ?? firstNodeSpan(entries) ?? emptySpan(),
    };
}

function isTopLevel(path: AssignmentEvent['path']): boolean {
    return path.segments.length === 2 && path.segments[0]?.type === 'root';
}

function valueToNode(value: Value, meta: NodeMeta, ctx: NodeContext, path: string, projection: ProjectionState): FinalizedNode {
    switch (value.type) {
        case 'StringLiteral':
            return scalarNode('String', value.value, value.raw, meta);
        case 'NumberLiteral':
            return scalarNode('Number', value.value, value.raw, meta);
        case 'InfinityLiteral':
            return scalarNode('String', value.value, value.raw, meta);
        case 'BooleanLiteral':
            return scalarNode('Boolean', value.value, value.raw, meta);
        case 'SwitchLiteral':
            return scalarNode('Switch', value.value, value.raw, meta);
        case 'HexLiteral':
            return scalarNode('Hex', value.value, value.raw, meta);
        case 'RadixLiteral':
            return scalarNode('Radix', value.value, value.raw, meta);
        case 'EncodingLiteral':
            return scalarNode('Encoding', value.value, value.raw, meta);
        case 'SeparatorLiteral':
            return scalarNode('Separator', value.value, value.raw, meta);
        case 'DateLiteral':
            return scalarNode('Date', value.value, value.raw, meta);
        case 'DateTimeLiteral':
            return scalarNode('DateTime', value.value, value.raw, meta);
        case 'TimeLiteral':
            return scalarNode('Time', value.value, value.raw, meta);
        case 'CloneReference':
            return referenceNode('clone', value.path, meta, path, ctx);
        case 'PointerReference':
            return referenceNode('pointer', value.path, meta, path, ctx);
        case 'ObjectNode':
            return objectNode(value.bindings, meta, ctx, path, projection);
        case 'ListNode':
            return listNode(value.elements, meta, ctx, path, projection);
        case 'TupleLiteral':
            return listNode(value.elements, meta, ctx, path, projection);
        case 'NodeLiteral':
            return objectNode([
                {
                    type: 'Binding',
                    key: '$node',
                    value: {
                        type: 'StringLiteral',
                        value: value.tag,
                        raw: value.tag,
                        delimiter: '"',
                        span: value.span,
                    },
                    datatype: null,
                    attributes: [],
                    span: value.span,
                },
                ...(value.attributes.length > 0
                    ? [{
                        type: 'Binding' as const,
                        key: '@',
                        value: {
                            type: 'ObjectNode' as const,
                            bindings: value.attributes.flatMap((attribute) =>
                                Array.from(attribute.entries.entries()).map(([key, entry]) => ({
                                    type: 'Binding' as const,
                                    key,
                                    value: entry.value,
                                    datatype: entry.datatype,
                                    attributes: [],
                                    span: entry.value.span,
                                }))
                            ),
                            attributes: [],
                            span: value.span,
                        },
                        datatype: null,
                        attributes: [],
                        span: value.span,
                    }]
                    : []),
                {
                    type: 'Binding',
                    key: '$children',
                    value: {
                        type: 'ListNode',
                        elements: value.children,
                        attributes: [],
                        span: value.span,
                    },
                    datatype: null,
                    attributes: [],
                    span: value.span,
                },
            ], meta, ctx, path, projection, { allowReservedKeys: true });
        default:
            return scalarNode('String', '', '', meta);
    }
}

function scalarNode(
    type: FinalizedScalarNode['type'],
    value: string | number | boolean,
    raw: string,
    meta: NodeMeta
): FinalizedScalarNode {
    return {
        type,
        value,
        raw,
        span: meta.span,
        ...(meta.datatype ? { datatype: meta.datatype } : {}),
        ...(meta.annotations ? { annotations: meta.annotations } : {}),
    };
}

function referenceNode(
    kind: FinalizedReferenceNode['kind'],
    refPath: readonly ReferencePathPart[],
    meta: NodeMeta,
    path: string,
    ctx: NodeContext
): FinalizedReferenceNode {
    const token = `${kind === 'clone' ? '~' : '~>'}${formatReferencePath(refPath)}`;
    const diag = toDiagnostic(
        ctx.strict ? 'error' : 'warning',
        `Reference left unresolved during node finalization: ${token}`,
        path,
        meta.span
    );
    if (ctx.strict) ctx.errors.push(diag);
    else ctx.warnings.push(diag);

    return {
        type: 'Reference',
        kind,
        path: refPath,
        token,
        span: meta.span,
        ...(meta.datatype ? { datatype: meta.datatype } : {}),
        ...(meta.annotations ? { annotations: meta.annotations } : {}),
    };
}

function objectNode(
    bindings: readonly Binding[],
    meta: NodeMeta,
    ctx: NodeContext,
    basePath: string,
    projection: ProjectionState,
    options: { allowReservedKeys?: boolean } = {}
): FinalizedObjectNode {
    const entries = new Map<string, FinalizedNode>();
    for (const binding of bindings) {
        const key = binding.key;
        const entryPath = `${basePath}.${key}`;
        if (!shouldIncludeProjectedPath(entryPath, projection)) {
            continue;
        }
        if (!options.allowReservedKeys && isReservedObjectKey(key)) {
            ctx.errors.push(toDiagnostic(
                'error',
                `Reserved key: ${key}`,
                entryPath,
                binding.span
            ));
            continue;
        }
        if (entries.has(key)) {
            const diag = toDiagnostic(
                ctx.strict ? 'error' : 'warning',
                `Duplicate object key during node finalization: ${key}`,
                entryPath,
                binding.span
            );
            if (ctx.strict) ctx.errors.push(diag);
            else ctx.warnings.push(diag);
            if (ctx.strict) continue;
        }
        const bindingAnnotations = buildAnnotations(binding.attributes);
        const bindingMeta: NodeMeta = {
            span: binding.span,
            ...(binding.datatype ? { datatype: formatDatatypeAnnotation(binding.datatype) } : {}),
            ...(bindingAnnotations.size > 0 ? { annotations: bindingAnnotations } : {}),
        };
        entries.set(key, valueToNode(binding.value, bindingMeta, ctx, entryPath, projection));
    }
    return {
        type: 'Object',
        entries,
        span: meta.span,
        ...(meta.datatype ? { datatype: meta.datatype } : {}),
        ...(meta.annotations ? { annotations: meta.annotations } : {}),
    };
}

function isReservedObjectKey(key: string): boolean {
    return RESERVED_OBJECT_KEYS.has(key);
}

function listNode(
    elements: readonly Value[],
    meta: NodeMeta,
    ctx: NodeContext,
    basePath: string,
    projection: ProjectionState
): FinalizedListNode {
    const items = elements.flatMap((element, index) => {
        const elementPath = `${basePath}[${index}]`;
        if (!shouldIncludeProjectedPath(elementPath, projection)) {
            return [];
        }
        return [valueToNode(element, { span: element.span }, ctx, elementPath, projection)];
    });
    return {
        type: 'List',
        items,
        span: meta.span,
        ...(meta.datatype ? { datatype: meta.datatype } : {}),
        ...(meta.annotations ? { annotations: meta.annotations } : {}),
    };
}

function buildAnnotations(attributes: readonly Attribute[]): ReadonlyMap<string, AnnotationEntry> {
    const result = new Map<string, AnnotationEntry>();
    for (const attr of attributes) {
        for (const [key, entry] of attr.entries) {
            result.set(key, {
                value: entry.value,
                ...(entry.datatype ? { datatype: formatDatatypeAnnotation(entry.datatype) } : {}),
            });
        }
    }
    return result;
}

function scopedTopLevelPath(scope: FinalizeScope, branch: 'header' | 'payload', key: string): string {
    if (scope === 'full') return `$.${branch}.${key}`;
    return `$.${key}`;
}

function isHeaderEventKey(key: string, header: FinalizeHeader | undefined): boolean {
    if (key === 'aeon:header') return true;
    if (!header || !key.startsWith('aeon:')) return false;
    return header.fields.has(key.slice('aeon:'.length));
}

function emptySpan(): Span {
    return {
        start: { line: 1, column: 1, offset: 0 },
        end: { line: 1, column: 1, offset: 0 },
    };
}

function firstNodeSpan(entries: ReadonlyMap<string, FinalizedNode>): Span | undefined {
    const first = entries.values().next().value as FinalizedNode | undefined;
    return first?.span;
}
