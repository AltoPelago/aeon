import { formatPath, type AssignmentEvent, type AttributeEntry } from '@aeon/aes';
import type {
    Diagnostic,
    FinalizeHeader,
    FinalizeJsonResult,
    FinalizeMeta,
    FinalizeOptions,
    JsonObject,
    JsonValue,
} from './types.js';
import { finalizeMap } from './finalize.js';
import { formatReferencePath, type ReferencePathPart } from './reference-path.js';
import { createProjectionState, shouldIncludeProjectedPath } from './projection.js';
import { formatDatatypeAnnotation } from './datatype.js';

type Value = AssignmentEvent['value'];
type ObjectValue = Extract<Value, { type: 'ObjectNode'; bindings: readonly unknown[] }>;
type Binding = ObjectValue['bindings'][number];
type Attribute = Binding['attributes'][number];
type ProjectionState = ReturnType<typeof createProjectionState>;
type FinalizeScope = 'full' | 'header' | 'payload';
type JsonReferenceStrategy = 'tokens' | 'link-pointers';
type JsonContainer = JsonObject | JsonValue[];

type ResolvedCloneTarget = {
    value: Value;
    targetPath: string;
};

function toDiagnostic(level: 'error' | 'warning', message: string, path?: string, span?: unknown): Diagnostic {
    return {
        level,
        message,
        ...(path !== undefined ? { path } : {}),
        ...(span !== undefined ? { span: span as any } : {}),
    };
}

type JsonContext = {
    strict: boolean;
    errors: Diagnostic[];
    warnings: Diagnostic[];
    referenceStrategy: JsonReferenceStrategy;
    aes: readonly AssignmentEvent[];
    pathToIndex: ReadonlyMap<string, number>;
    maxMaterializedWeight?: number;
    materializedWeight: number;
    materializedWeightCache: Map<string, number>;
    activeClonePaths: string[];
};

const RESERVED_OBJECT_KEYS = new Set(['@', '$', '$node', '$children', '__proto__', 'constructor']);
const PROTOTYPE_POLLUTING_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
export function finalizeJson(
    aes: readonly AssignmentEvent[],
    options: FinalizeOptions = {}
): FinalizeJsonResult {
    return finalizeJsonInternal(aes, options, 'tokens');
}

export function finalizeLinkedJson(
    aes: readonly AssignmentEvent[],
    options: FinalizeOptions = {}
): FinalizeJsonResult {
    return finalizeJsonInternal(aes, options, 'link-pointers');
}

function finalizeJsonInternal(
    aes: readonly AssignmentEvent[],
    options: FinalizeOptions,
    referenceStrategy: JsonReferenceStrategy
): FinalizeJsonResult {
    const strict = (options.mode ?? 'strict') === 'strict';
    const scope = options.scope ?? 'payload';
    const errors: Diagnostic[] = [];
    const warnings: Diagnostic[] = [];
    const pathToIndex = new Map<string, number>();

    for (let i = 0; i < aes.length; i++) {
        pathToIndex.set(formatPath(aes[i]!.path), i);
    }

    const mapResult = finalizeMap(aes, options);
    if (mapResult.meta?.errors) errors.push(...mapResult.meta.errors);
    if (mapResult.meta?.warnings) warnings.push(...mapResult.meta.warnings);

    const ctx: JsonContext = {
        strict,
        errors,
        warnings,
        referenceStrategy,
        aes,
        pathToIndex,
        ...(options.maxMaterializedWeight !== undefined ? { maxMaterializedWeight: options.maxMaterializedWeight } : {}),
        materializedWeight: 0,
        materializedWeightCache: new Map<string, number>(),
        activeClonePaths: [],
    };
    const projection = createProjectionState(options.includePaths, options.materialization);
    const payload = payloadToJson(aes, ctx, projection, scope, options.header);
    const header = headerToJson(options.header, ctx, projection, scope);
    const document = scopeToJsonDocument(scope, header, payload);

    if (referenceStrategy === 'link-pointers') {
        linkPointerReferences(document, aes, ctx, projection, scope, options.header);
    }

    const meta: FinalizeMeta = {
        ...(errors.length > 0 ? { errors } : {}),
        ...(warnings.length > 0 ? { warnings } : {}),
    };

    return Object.keys(meta).length > 0 ? { document, meta } : { document };
}

function payloadToJson(
    aes: readonly AssignmentEvent[],
    ctx: JsonContext,
    projection: ProjectionState,
    scope: FinalizeScope,
    header: FinalizeHeader | undefined
): JsonObject {
    if (scope === 'header') return {};

    const document: JsonObject = {};
    const documentAttrs: JsonObject = {};

    for (const event of aes) {
        if (!isTopLevel(event.path)) continue;
        const segment = event.path.segments[1];
        if (!segment || segment.type !== 'member') continue;
        const key = segment.key;
        if (isHeaderEventKey(key, header)) {
            continue;
        }
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
        if (Object.prototype.hasOwnProperty.call(document, key)) {
            const diag = toDiagnostic(
                ctx.strict ? 'error' : 'warning',
                `Duplicate top-level key during JSON finalization: ${key}`,
                eventPath,
                event.span
            );
            if (ctx.strict) ctx.errors.push(diag);
            else ctx.warnings.push(diag);
            if (ctx.strict) continue;
        }
        document[key] = valueToJson(event.value, ctx, eventPath, projection, event.datatype);
        const attrJson = annotationsToJson(event.annotations, ctx, eventPath, projection);
        if (attrJson) {
            documentAttrs[key] = attrJson;
        }
    }

    if (Object.keys(documentAttrs).length > 0) {
        document['@'] = documentAttrs;
    }

    return document;
}

function headerToJson(
    header: FinalizeHeader | undefined,
    ctx: JsonContext,
    projection: ProjectionState,
    scope: FinalizeScope
): JsonObject {
    if (scope === 'payload' || !header) return {};

    const document: JsonObject = {};
    for (const [key, value] of header.fields) {
        const fieldPath = scopedTopLevelPath(scope, 'header', key);
        if (!shouldIncludeProjectedPath(fieldPath, projection)) continue;
        document[key] = valueToJson(value, ctx, fieldPath, projection);
    }
    return document;
}

function scopeToJsonDocument(scope: FinalizeScope, header: JsonObject, payload: JsonObject): JsonObject {
    if (scope === 'header') return header;
    if (scope === 'full') {
        return {
            header,
            payload,
        };
    }
    return payload;
}

function isTopLevel(path: AssignmentEvent['path']): boolean {
    return path.segments.length === 2 && path.segments[0]?.type === 'root';
}

function valueToJson(
    value: Value,
    ctx: JsonContext,
    path: string,
    projection: ProjectionState,
    datatype?: string
): JsonValue {
    switch (value.type) {
        case 'StringLiteral':
            return value.value;
        case 'NumberLiteral': {
            const normalized = value.value.replace(/_/g, '');
            const numeric = Number(normalized);
            if (Number.isNaN(numeric)) {
                const diag = toDiagnostic(
                    ctx.strict ? 'error' : 'warning',
                    `Invalid numeric literal for JSON output: ${value.value}`,
                    path,
                    value.span
                );
                if (ctx.strict) ctx.errors.push(diag);
                else ctx.warnings.push(diag);
                return value.value;
            }
            if (!Number.isFinite(numeric) || Math.abs(numeric) > Number.MAX_SAFE_INTEGER) {
                const diag = toDiagnostic(
                    ctx.strict ? 'error' : 'warning',
                    `Numeric literal exceeds JSON safe range: ${value.value}`,
                    path,
                    value.span
                );
                if (ctx.strict) ctx.errors.push(diag);
                else ctx.warnings.push(diag);
                return value.value;
            }
            return numeric;
        }
        case 'InfinityLiteral':
            return value.value;
        case 'BooleanLiteral':
            return value.value;
        case 'SwitchLiteral':
            return value.value === 'yes' || value.value === 'on';
        case 'HexLiteral':
            return value.value.replace(/_/g, '').toLowerCase();
        case 'RadixLiteral': {
            const normalized = value.value.replace(/_/g, '');
            const radixBase = declaredRadixBase(datatype ?? datatypeForPath(path, ctx));
            if (radixBase != null && exceedsDeclaredRadix(normalized, radixBase)) {
                const diag = toDiagnostic(
                    ctx.strict ? 'error' : 'warning',
                    `Radix literal exceeds declared radix ${radixBase}: %${value.value}`,
                    path,
                    value.span
                );
                if (ctx.strict) ctx.errors.push(diag);
                else ctx.warnings.push(diag);
            }
            return normalized;
        }
        case 'EncodingLiteral':
        case 'SeparatorLiteral':
        case 'DateLiteral':
        case 'DateTimeLiteral':
        case 'TimeLiteral':
            return value.value;
        case 'ObjectNode':
            return objectToJson(value.bindings, ctx, path, projection);
        case 'ListNode':
            return value.elements.flatMap((element, index) => {
                const elementPath = `${path}[${index}]`;
                return shouldIncludeProjectedPath(elementPath, projection)
                    ? [valueToJson(element, ctx, elementPath, projection)]
                    : [];
            });
        case 'TupleLiteral':
            return value.elements.flatMap((element, index) => {
                const elementPath = `${path}[${index}]`;
                return shouldIncludeProjectedPath(elementPath, projection)
                    ? [valueToJson(element, ctx, elementPath, projection)]
                    : [];
            });
        case 'NodeLiteral': {
            const nodeAttrs = attributesToJson(value.attributes, ctx, `${path}@`, projection);
            return {
                $node: value.tag,
                ...(nodeAttrs ? { '@': nodeAttrs } : {}),
                $children: value.children.map((child, index) => valueToJson(child, ctx, `${path}<${index}>`, projection)),
            };
        }
        case 'CloneReference': {
            const resolved = resolveCloneReference(value.path, ctx);
            if (resolved) {
                if (ctx.activeClonePaths.includes(resolved.targetPath)) {
                    pushReferenceDiagnostic(
                        ctx,
                        `Reference cycle detected during JSON finalization: '${resolved.targetPath}'`,
                        'REFERENCE_CYCLE',
                        path,
                        value.span
                    );
                    return referenceToJson('~', value.path, ctx, path, value.span, false);
                }

                if (!consumeCloneBudget(resolved.targetPath, resolved.value, ctx, path, value.span)) {
                    return referenceToJson('~', value.path, ctx, path, value.span, false);
                }

                ctx.activeClonePaths.push(resolved.targetPath);
                try {
                    return valueToJson(resolved.value, ctx, path, projection, datatype);
                } finally {
                    ctx.activeClonePaths.pop();
                }
            }
            return referenceToJson('~', value.path, ctx, path, value.span);
        }
        case 'PointerReference':
            return referenceToJson('~>', value.path, ctx, path, value.span, ctx.referenceStrategy === 'tokens');
        default:
            return null;
    }
}

function objectToJson(bindings: readonly Binding[], ctx: JsonContext, basePath: string, projection: ProjectionState): JsonObject {
    const obj: JsonObject = {};
    const attrEntries: JsonObject = {};
    for (const binding of bindings) {
        const key = binding.key;
        const entryPath = `${basePath}.${key}`;
        if (!shouldIncludeProjectedPath(entryPath, projection)) {
            continue;
        }
        if (isReservedObjectKey(key)) {
            ctx.errors.push(toDiagnostic(
                'error',
                `Reserved key: ${key}`,
                entryPath,
                binding.span
            ));
            continue;
        }
        if (Object.prototype.hasOwnProperty.call(obj, key)) {
            const diag = toDiagnostic(
                ctx.strict ? 'error' : 'warning',
                `Duplicate object key during JSON finalization: ${key}`,
                entryPath,
                binding.span
            );
            if (ctx.strict) ctx.errors.push(diag);
            else ctx.warnings.push(diag);
            if (ctx.strict) continue;
        }
        obj[key] = valueToJson(binding.value, ctx, entryPath, projection);
        const attrJson = attributesToJson(binding.attributes, ctx, entryPath, projection);
        if (attrJson) {
            attrEntries[key] = attrJson;
        }
    }
    if (Object.keys(attrEntries).length > 0) {
        obj['@'] = attrEntries;
    }
    return obj;
}

function isReservedObjectKey(key: string): boolean {
    return RESERVED_OBJECT_KEYS.has(key);
}

function referenceToJson(
    prefix: '~' | '~>',
    pathParts: readonly ReferencePathPart[],
    ctx: JsonContext,
    path: string,
    span: unknown,
    emitDiagnostic: boolean = true
): JsonValue {
    const token = `${prefix}${formatReferencePath(pathParts)}`;
    if (!emitDiagnostic) {
        return token;
    }
    const diag = toDiagnostic(
        ctx.strict ? 'error' : 'warning',
        `Reference left unresolved during JSON finalization: ${token}`,
        path,
        span
    );
    if (ctx.strict) ctx.errors.push(diag);
    else ctx.warnings.push(diag);
    return token;
}

function pushReferenceDiagnostic(
    ctx: JsonContext,
    message: string,
    code: string,
    path: string,
    span: unknown
): void {
    ctx.errors.push({
        ...toDiagnostic('error', message, path, span),
        code,
    });
}

function resolveCloneReference(
    pathParts: readonly ReferencePathPart[],
    ctx: JsonContext
): ResolvedCloneTarget | null {
    const targetPath = formatCloneTargetPath(pathParts);

    for (let split = pathParts.length; split >= 1; split--) {
        const prefix = pathParts.slice(0, split);
        if (prefix.some((part) => typeof part === 'object' && part !== null && 'type' in part && part.type === 'attr')) {
            continue;
        }

        const prefixPath = formatCloneTargetPath(prefix);
        const targetIndex = ctx.pathToIndex.get(prefixPath);
        if (targetIndex === undefined) continue;

        const target = ctx.aes[targetIndex];
        if (!target) return null;

        const remainder = pathParts.slice(split);
        if (remainder.length === 0) {
            return { value: target.value, targetPath };
        }

        const resolved = resolveReferenceSubpath(target, remainder);
        if (resolved) {
            return { value: resolved, targetPath };
        }
    }

    return null;
}

function consumeCloneBudget(
    targetPath: string,
    value: Value,
    ctx: JsonContext,
    path: string,
    span: unknown
): boolean {
    if (ctx.maxMaterializedWeight === undefined) {
        return true;
    }

    const weight = measureMaterializedWeight(value, ctx, targetPath, new Set<string>());
    const nextWeight = ctx.materializedWeight + weight;
    if (nextWeight <= ctx.maxMaterializedWeight) {
        ctx.materializedWeight = nextWeight;
        return true;
    }

    pushReferenceDiagnostic(
        ctx,
        `Reference materialization budget exceeded for '${targetPath}' (budget=maxMaterializedWeight, observed=${nextWeight}, limit=${ctx.maxMaterializedWeight})`,
        'REFERENCE_BUDGET_EXCEEDED',
        path,
        span
    );
    return false;
}

function measureMaterializedWeight(
    value: Value,
    ctx: JsonContext,
    currentPath: string,
    stack: Set<string>
): number {
    if (stack.has(currentPath)) {
        return 1;
    }

    switch (value.type) {
        case 'StringLiteral':
        case 'NumberLiteral':
        case 'InfinityLiteral':
        case 'BooleanLiteral':
        case 'SwitchLiteral':
        case 'HexLiteral':
        case 'RadixLiteral':
        case 'EncodingLiteral':
        case 'SeparatorLiteral':
        case 'DateLiteral':
        case 'DateTimeLiteral':
        case 'TimeLiteral':
        case 'PointerReference':
            return 1;
        case 'CloneReference': {
            const resolved = resolveCloneReference(value.path, ctx);
            if (!resolved) {
                return 1;
            }
            if (ctx.materializedWeightCache.has(resolved.targetPath)) {
                return ctx.materializedWeightCache.get(resolved.targetPath)!;
            }
            const nextStack = new Set(stack);
            nextStack.add(currentPath);
            const weight = measureMaterializedWeight(resolved.value, ctx, resolved.targetPath, nextStack);
            ctx.materializedWeightCache.set(resolved.targetPath, weight);
            return weight;
        }
        case 'ObjectNode':
            return value.bindings.reduce((sum, binding) => {
                const childPath = `${currentPath}.${binding.key}`;
                return sum
                    + measureMaterializedWeight(binding.value, ctx, childPath, stack)
                    + measureAttributeWeight(binding.attributes, ctx, `${childPath}@`, stack);
            }, 0);
        case 'ListNode':
        case 'TupleLiteral':
            return value.elements.reduce((sum, element, index) => {
                const childPath = `${currentPath}[${index}]`;
                return sum + measureMaterializedWeight(element, ctx, childPath, stack);
            }, 0) + measureAttributeWeight(value.attributes, ctx, `${currentPath}@`, stack);
        case 'NodeLiteral':
            return 1
                + measureAttributeWeight(value.attributes, ctx, `${currentPath}@`, stack)
                + value.children.reduce((sum, child, index) => {
                    const childPath = `${currentPath}<${index}>`;
                    return sum + measureMaterializedWeight(child, ctx, childPath, stack);
                }, 0);
        default:
            return 1;
    }
}

function measureAttributeWeight(
    attributes: readonly Attribute[] | AssignmentEvent['annotations'] | undefined,
    ctx: JsonContext,
    currentPath: string,
    stack: Set<string>
): number {
    if (!attributes) return 0;

    if (Array.isArray(attributes)) {
        let total = 0;
        for (const attr of attributes) {
            for (const [key, entry] of attr.entries) {
                const entryPath = `${currentPath}${key}`;
                total += measureMaterializedWeight(entry.value, ctx, entryPath, stack);
                total += measureAttributeWeight(entry.attributes, ctx, `${entryPath}@`, stack);
            }
        }
        return total;
    }

    let total = 0;
    for (const [key, entry] of attributes.entries() as IterableIterator<[string, AttributeEntry]>) {
        const entryPath = `${currentPath}${key}`;
        total += measureMaterializedWeight(entry.value, ctx, entryPath, stack);
        total += measureAttributeWeight(entry.annotations, ctx, `${entryPath}@`, stack);
    }
    return total;
}

function resolveReferenceSubpath(
    event: AssignmentEvent,
    remainder: readonly ReferencePathPart[]
): Value | null {
    let currentValue: Value = event.value;
    let currentAnnotations = event.annotations;

    for (const part of remainder) {
        if (typeof part === 'object' && part !== null && 'type' in part && part.type === 'attr') {
            const entry = currentAnnotations?.get(part.key);
            if (!entry) return null;
            currentValue = entry.value;
            currentAnnotations = entry.annotations;
            continue;
        }

        if (typeof part === 'string') {
            if (currentValue.type !== 'ObjectNode') return null;
            const binding = currentValue.bindings.find((candidate) => candidate.key === part);
            if (!binding) return null;
            currentValue = binding.value;
            currentAnnotations = buildAnnotationEntries(binding.attributes);
            continue;
        }

        if (typeof part === 'number') {
            if (currentValue.type !== 'ListNode' && currentValue.type !== 'TupleLiteral') return null;
            const element = currentValue.elements[part];
            if (!element) return null;
            currentValue = element;
            currentAnnotations = undefined;
            continue;
        }

        return null;
    }

    return currentValue;
}

function formatCloneTargetPath(pathParts: readonly ReferencePathPart[]): string {
    if (pathParts.length === 0) return '$';

    return '$' + pathParts.map((part) => {
        if (typeof part === 'number') {
            return `[${part}]`;
        }
        if (typeof part === 'string') {
            return /^[A-Za-z_][A-Za-z0-9_:-]*$/.test(part)
                ? `.${part}`
                : `.[${JSON.stringify(part)}]`;
        }
        return /^[A-Za-z_][A-Za-z0-9_:-]*$/.test(part.key)
            ? `@${part.key}`
            : `@[${JSON.stringify(part.key)}]`;
    }).join('');
}

function buildAnnotationEntries(
    attributes: readonly Attribute[]
): ReadonlyMap<string, AttributeEntry> | undefined {
    if (!attributes || attributes.length === 0) return undefined;
    const result = new Map<string, AttributeEntry>();
    for (const attribute of attributes) {
        for (const [key, entry] of attribute.entries) {
            const mapped: AttributeEntry = { value: entry.value };
            const nested = buildAnnotationEntries(entry.attributes);
            if (nested) {
                (mapped as { annotations: ReadonlyMap<string, AttributeEntry> }).annotations = nested;
            }
            result.set(key, mapped);
        }
    }
    return result;
}

function attributesToJson(
    attributes: readonly Attribute[],
    ctx: JsonContext,
    path: string,
    projection: ProjectionState
): JsonObject | null {
    if (!attributes || attributes.length === 0) return null;
    const obj: JsonObject = {};
    const nestedAttrEntries: JsonObject = {};
    for (const attr of attributes) {
        for (const [key, entry] of attr.entries) {
            obj[key] = valueToJson(
                entry.value,
                ctx,
                `${path}@${key}`,
                projection,
                entry.datatype ? formatDatatypeAnnotation(entry.datatype) : undefined
            );
            const nested = attributesToJson(entry.attributes, ctx, `${path}@${key}`, projection);
            if (nested) {
                nestedAttrEntries[key] = nested;
            }
        }
    }
    if (Object.keys(nestedAttrEntries).length > 0) {
        obj['@'] = nestedAttrEntries;
    }
    return Object.keys(obj).length > 0 ? obj : null;
}

function datatypeForPath(path: string, ctx: JsonContext): string | undefined {
    const canonicalPath = canonicalFinalizePath(path);
    const index = ctx.pathToIndex.get(canonicalPath);
    return index === undefined ? undefined : ctx.aes[index]?.datatype;
}

function canonicalFinalizePath(path: string): string {
    if (path === '$.payload' || path === '$.header') return '$';
    if (path.startsWith('$.payload.')) return `$.${path.slice('$.payload.'.length)}`;
    if (path.startsWith('$.payload@')) return `$.${path.slice('$.payload'.length)}`;
    if (path.startsWith('$.header.')) return `$.${path.slice('$.header.'.length)}`;
    if (path.startsWith('$.header@')) return `$.${path.slice('$.header'.length)}`;
    return path;
}

function declaredRadixBase(datatype: string | undefined): number | null {
    if (!datatype) return null;

    const trimmed = datatype.trim();
    if (trimmed === 'radix2') return 2;
    if (trimmed === 'radix6') return 6;
    if (trimmed === 'radix8') return 8;
    if (trimmed === 'radix12') return 12;

    const match = /^radix\[(\d+)\]$/.exec(trimmed);
    if (!match) return null;

    const base = Number(match[1]);
    return Number.isInteger(base) && base >= 2 && base <= 64 ? base : null;
}

function exceedsDeclaredRadix(value: string, base: number): boolean {
    for (const ch of value) {
        if (ch === '+' || ch === '-' || ch === '.') continue;
        const digit = radixDigitValue(ch);
        if (digit == null || digit >= base) {
            return true;
        }
    }
    return false;
}

function radixDigitValue(ch: string): number | null {
    if (ch >= '0' && ch <= '9') return ch.charCodeAt(0) - 48;
    if (ch >= 'A' && ch <= 'Z') return ch.charCodeAt(0) - 55;
    if (ch >= 'a' && ch <= 'z') return ch.charCodeAt(0) - 61;
    if (ch === '&') return 62;
    if (ch === '!') return 63;
    return null;
}

function annotationsToJson(
    annotations: AssignmentEvent['annotations'],
    ctx: JsonContext,
    path: string,
    projection: ProjectionState
): JsonObject | null {
    if (!annotations || annotations.size === 0) return null;
    const obj: JsonObject = {};
    const nestedAttrEntries: JsonObject = {};
    for (const [key, entry] of annotations.entries() as IterableIterator<[string, AttributeEntry]>) {
        obj[key] = valueToJson(entry.value, ctx, `${path}@${key}`, projection);
        const nested = annotationsToJson(entry.annotations, ctx, `${path}@${key}`, projection);
        if (nested) {
            nestedAttrEntries[key] = nested;
        }
    }
    if (Object.keys(nestedAttrEntries).length > 0) {
        obj['@'] = nestedAttrEntries;
    }
    return Object.keys(obj).length > 0 ? obj : null;
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

function linkPointerReferences(
    document: JsonObject,
    aes: readonly AssignmentEvent[],
    ctx: JsonContext,
    projection: ProjectionState,
    scope: FinalizeScope,
    header: FinalizeHeader | undefined
): void {
    if (scope === 'header') {
        return;
    }

    const payloadRoot = scope === 'full' ? document.payload : document;
    if (!isContainer(payloadRoot)) {
        return;
    }

    for (const event of aes) {
        if (event.value.type !== 'PointerReference') continue;

        const topLevelKey = topLevelPayloadMemberKey(event);
        if (topLevelKey && isHeaderEventKey(topLevelKey, header)) {
            continue;
        }

        const sourcePath = scope === 'full'
            ? `$.payload${formatPath(event.path).slice(1)}`
            : formatPath(event.path);
        if (!shouldIncludeProjectedPath(sourcePath, projection)) {
            continue;
        }

        const sourceEndpoint = endpointFromCanonicalPath(payloadRoot, event.path.segments.slice(1));
        if (!sourceEndpoint) {
            pushLinkDiagnostic(
                ctx,
                `Pointer source path could not be materialized: ${sourcePath}`,
                'POINTER_SOURCE_NOT_MATERIALIZED',
                sourcePath,
                event.span
            );
            continue;
        }

        const targetEndpoint = endpointFromReferencePath(payloadRoot, event.value.path);
        if (!targetEndpoint) {
            pushLinkDiagnostic(
                ctx,
                `Pointer target could not be materialized: ~>${formatReferencePath(event.value.path)}`,
                'POINTER_TARGET_NOT_MATERIALIZED',
                sourcePath,
                event.span
            );
            continue;
        }

        Object.defineProperty(sourceEndpoint.owner, sourceEndpoint.key, {
            enumerable: true,
            configurable: true,
            get() {
                return readContainerValue(targetEndpoint.owner, targetEndpoint.key);
            },
            set(next: JsonValue) {
                writeContainerValue(targetEndpoint.owner, targetEndpoint.key, next);
            },
        });
    }
}

function pushLinkDiagnostic(
    ctx: JsonContext,
    message: string,
    code: string,
    path: string,
    span: unknown
): void {
    const diag = {
        ...toDiagnostic(ctx.strict ? 'error' : 'warning', message, path, span),
        code,
    };
    if (ctx.strict) ctx.errors.push(diag);
    else ctx.warnings.push(diag);
}

function topLevelPayloadMemberKey(event: AssignmentEvent): string | null {
    const segment = event.path.segments[1];
    if (!segment || segment.type !== 'member') return null;
    return segment.key;
}

function endpointFromCanonicalPath(
    root: JsonValue,
    segments: readonly AssignmentEvent['path']['segments'][number][]
): { owner: JsonContainer; key: string | number } | null {
    if (segments.length === 0) return null;
    const parentSegments = segments.slice(0, -1);
    const last = segments[segments.length - 1];
    if (!last || last.type === 'root') return null;
    const owner = traverseCanonicalSegments(root, parentSegments);
    if (!owner) return null;
    return last.type === 'member'
        ? { owner, key: last.key }
        : { owner, key: last.index };
}

function endpointFromReferencePath(
    root: JsonValue,
    pathParts: readonly ReferencePathPart[]
): { owner: JsonContainer; key: string | number } | null {
    if (pathParts.length === 0) return null;
    const parentParts = pathParts.slice(0, -1);
    const last = pathParts[pathParts.length - 1];
    if (last === undefined || typeof last === 'object') {
        return null;
    }
    const owner = traverseReferenceParts(root, parentParts);
    if (!owner) return null;
    return { owner, key: last };
}

function traverseCanonicalSegments(
    current: JsonValue,
    segments: readonly AssignmentEvent['path']['segments'][number][]
): JsonContainer | null {
    let node: JsonValue = current;
    for (const segment of segments) {
        if (segment.type === 'root') continue;
        if (!isContainer(node)) return null;
        const next: JsonValue | undefined = segment.type === 'member'
            ? (node as JsonObject)[segment.key]
            : (node as JsonValue[])[segment.index];
        if (next === undefined) return null;
        node = next;
    }
    return isContainer(node) ? node : null;
}

function traverseReferenceParts(
    current: JsonValue,
    parts: readonly ReferencePathPart[]
): JsonContainer | null {
    let node: JsonValue = current;
    for (const part of parts) {
        if (typeof part === 'object') {
            return null;
        }
        if (!isContainer(node)) return null;
        const next: JsonValue | undefined = typeof part === 'number'
            ? (node as JsonValue[])[part]
            : (node as JsonObject)[part];
        if (next === undefined) return null;
        node = next;
    }
    return isContainer(node) ? node : null;
}

function isContainer(value: JsonValue | undefined): value is JsonContainer {
    return Array.isArray(value) || (!!value && typeof value === 'object');
}

function readContainerValue(container: JsonContainer, key: string | number): JsonValue | undefined {
    if (typeof key === 'string' && PROTOTYPE_POLLUTING_KEYS.has(key)) {
        return undefined;
    }
    return typeof key === 'number'
        ? (container as JsonValue[])[key]
        : (container as JsonObject)[key];
}

function writeContainerValue(container: JsonContainer, key: string | number, value: JsonValue): void {
    if (typeof key === 'number') {
        (container as JsonValue[])[key] = value;
        return;
    }
    if (PROTOTYPE_POLLUTING_KEYS.has(key)) {
        return;
    }
    (container as JsonObject)[key] = value;
}
