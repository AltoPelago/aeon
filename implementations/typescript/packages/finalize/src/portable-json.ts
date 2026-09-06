import {
    AEON_DOCUMENT_PROJECTION,
    COMPLETE_AES_PROFILE,
    validateTelexRecords,
    type AesDiagnostic,
    type PortableAesEvent,
    type TelexRecord,
    type TelexValidationOptions,
} from '@altopelago/aeon-aes';
import type { Diagnostic, FinalizeJsonResult, FinalizeMeta, FinalizeScope, JsonObject, JsonValue } from './types.js';

export interface FinalizePortableJsonOptions extends TelexValidationOptions {
    readonly mode?: 'strict' | 'loose';
    readonly scope?: FinalizeScope;
    readonly maxMaterializedWeight?: number;
    readonly maxReferenceDepth?: number;
}

type PortableRecord = TelexRecord | PortableAesEvent;
type AddressField = 'path' | 'header';
type PathSegment =
    | { readonly type: 'member'; readonly key: string }
    | { readonly type: 'attribute'; readonly key: string }
    | { readonly type: 'index'; readonly index: bigint };

interface IndexedRecord {
    readonly record: PortableRecord;
    readonly field: AddressField;
    readonly address: string;
    readonly parent: string;
    readonly segment: PathSegment;
}

interface PlaneIndex {
    readonly byAddress: ReadonlyMap<string, IndexedRecord>;
    readonly byParent: ReadonlyMap<string, readonly IndexedRecord[]>;
}

interface MaterializeContext {
    readonly strict: boolean;
    readonly errors: Diagnostic[];
    readonly warnings: Diagnostic[];
    readonly body: PlaneIndex;
    readonly header: PlaneIndex;
    readonly maxMaterializedWeight?: number;
    readonly maxReferenceDepth?: number;
    readonly activeClonePaths: string[];
    readonly materializedWeightCache: Map<string, number>;
    materializedWeight: number;
}

const RESERVED_OBJECT_KEYS = new Set(['@', '$', '$node', '$children', '__proto__', 'constructor', 'prototype']);
const RESERVED_NULL_SENTINELS = new Set(['none', 'notSet', 'notApplicable', 'tombstone']);
const BARE_MEMBER = /^[A-Za-z_][A-Za-z0-9_]*/u;

/**
 * Materialize a complete, portable AES record stream directly into the JSON
 * output profile. This consumes the flat AES model; it does not reconstruct a
 * parser AST or the implementation-specific AssignmentEvent shape.
 */
export function finalizePortableJson(
    records: readonly PortableRecord[],
    options: FinalizePortableJsonOptions = {},
): FinalizeJsonResult {
    const profile = options.profile ?? COMPLETE_AES_PROFILE;
    const projection = options.projection ?? null;
    const scope = options.scope ?? 'payload';
    const validation = validateTelexRecords(records, options);
    const validationErrors = validation.diagnostics.map(aesDiagnostic);

    if (profile !== COMPLETE_AES_PROFILE) {
        validationErrors.push({
            level: 'error',
            code: 'FINALIZE_PARTIAL_AES_UNSUPPORTED',
            message: `Portable JSON materialization requires '${COMPLETE_AES_PROFILE}', received '${profile}'`,
        });
    }

    if (validationErrors.length > 0) {
        return {
            document: emptyDocument(scope),
            meta: { errors: validationErrors },
        };
    }

    const body = indexPlane(records, 'path');
    const header = indexPlane(records, 'header');
    const ctx: MaterializeContext = {
        strict: (options.mode ?? 'strict') === 'strict',
        errors: [],
        warnings: [],
        body,
        header,
        ...(options.maxMaterializedWeight !== undefined
            ? { maxMaterializedWeight: options.maxMaterializedWeight }
            : {}),
        ...(options.maxReferenceDepth !== undefined
            ? { maxReferenceDepth: options.maxReferenceDepth }
            : {}),
        activeClonePaths: [],
        materializedWeightCache: new Map(),
        materializedWeight: 0,
    };

    const payload = scope === 'header' ? {} : materializeRoot(body, ctx, false);
    const projectedHeader = scope === 'payload' || projection !== AEON_DOCUMENT_PROJECTION
        ? {}
        : materializeRoot(header, ctx, true);
    const document = scope === 'full'
        ? { header: projectedHeader, payload }
        : scope === 'header'
            ? projectedHeader
            : payload;
    const meta: FinalizeMeta = {
        ...(ctx.errors.length > 0 ? { errors: ctx.errors } : {}),
        ...(ctx.warnings.length > 0 ? { warnings: ctx.warnings } : {}),
    };

    return Object.keys(meta).length > 0 ? { document, meta } : { document };
}

function emptyDocument(scope: FinalizeScope): JsonObject {
    return scope === 'full' ? { header: {}, payload: {} } : {};
}

function aesDiagnostic(diagnostic: AesDiagnostic): Diagnostic {
    return {
        level: 'error',
        code: diagnostic.code,
        message: diagnostic.message,
        ...(diagnostic.path !== undefined ? { path: diagnostic.path } : {}),
    };
}

function indexPlane(records: readonly PortableRecord[], field: AddressField): PlaneIndex {
    const byAddress = new Map<string, IndexedRecord>();
    const byParent = new Map<string, IndexedRecord[]>();

    for (const record of records) {
        const address = field === 'path'
            ? record.path
            : 'header' in record ? record.header : undefined;
        if (typeof address !== 'string') continue;
        const parsed = parsePath(address);
        const indexed: IndexedRecord = {
            record,
            field,
            address,
            parent: parsed.parent,
            segment: parsed.segment,
        };
        byAddress.set(address, indexed);
        const children = byParent.get(parsed.parent) ?? [];
        children.push(indexed);
        byParent.set(parsed.parent, children);
    }

    return { byAddress, byParent };
}

function materializeRoot(index: PlaneIndex, ctx: MaterializeContext, header: boolean): JsonObject {
    const object: JsonObject = {};
    const attributes: JsonObject = {};

    for (const child of structuralChildren(index, '$')) {
        if (child.segment.type !== 'member') continue;
        const key = header && child.segment.key.startsWith('aeon:')
            ? child.segment.key.slice('aeon:'.length)
            : child.segment.key;
        if (!safeMember(key, child.address, ctx)) continue;
        object[key] = materializeRecord(child, ctx);
        const metadata = recordMetadata(child, ctx);
        if (metadata !== null) attributes[key] = metadata;
    }

    if (Object.keys(attributes).length > 0) object['@'] = attributes;
    return object;
}

function materializeRecord(indexed: IndexedRecord, ctx: MaterializeContext): JsonValue {
    const { record, address } = indexed;
    switch (record.kind) {
        case 'StringLiteral':
            return record.value ?? '';
        case 'NumberLiteral':
            return numberValue(record.value ?? '', address, ctx);
        case 'InfinityLiteral':
        case 'NaNLiteral':
            report(ctx, `The ${record.kind} value '${record.value}' is not representable in strict JSON`, `FINALIZE_JSON_PROFILE_${record.kind === 'NaNLiteral' ? 'NAN' : 'INFINITY'}`, address);
            return record.value ?? '';
        case 'NullLiteral':
            return nullValue(record.value ?? '', address, ctx);
        case 'BooleanLiteral':
            return record.value === 'true';
        case 'ToggleLiteral':
            return record.value === 'yes' || record.value === 'on';
        case 'HexLiteral':
        case 'EncodingLiteral':
        case 'SeparatorLiteral':
        case 'SansaAddressLiteral':
        case 'DateLiteral':
        case 'TimeLiteral':
        case 'DateTimeLiteral':
        case 'WTCDateTimeLiteral':
            return record.value ?? '';
        case 'RadixLiteral':
            return radixValue(record, address, ctx);
        case 'ObjectNode':
            return materializeObject(indexed, ctx);
        case 'ListNode':
        case 'TupleLiteral':
            return materializeIndexed(indexed, ctx);
        case 'NodeLiteral':
            return materializeNode(indexed, ctx);
        case 'CloneReference':
            return materializeClone(indexed, ctx);
        case 'PointerReference':
            report(ctx, `Pointer reference remains symbolic during JSON materialization: ${referenceToken('~>', record.value ?? '')}`, 'FINALIZE_UNRESOLVED_REFERENCE', address);
            return referenceToken('~>', record.value ?? '');
        case 'NodeHead':
            report(ctx, 'NodeHead can only be materialized through its owning NodeLiteral', 'FINALIZE_ORPHAN_NODE_HEAD', address, true);
            return record.value ?? '';
        default:
            report(ctx, `Unsupported portable AES kind '${String(record.kind)}'`, 'FINALIZE_UNSUPPORTED_AES_KIND', address, true);
            return null;
    }
}

function materializeObject(indexed: IndexedRecord, ctx: MaterializeContext): JsonObject {
    const index = planeFor(indexed, ctx);
    const object: JsonObject = {};
    const attributes: JsonObject = {};

    for (const child of structuralChildren(index, indexed.address)) {
        if (child.segment.type !== 'member') continue;
        const key = child.segment.key;
        if (!safeMember(key, child.address, ctx)) continue;
        object[key] = materializeRecord(child, ctx);
        const metadata = recordMetadata(child, ctx);
        if (metadata !== null) attributes[key] = metadata;
    }

    if (Object.keys(attributes).length > 0) object['@'] = attributes;
    return object;
}

function materializeIndexed(indexed: IndexedRecord, ctx: MaterializeContext): JsonValue[] {
    const index = planeFor(indexed, ctx);
    const children = structuralChildren(index, indexed.address)
        .filter((child): child is IndexedRecord & { segment: { type: 'index'; index: bigint } } => child.segment.type === 'index')
        .sort((left, right) => left.segment.index < right.segment.index ? -1 : left.segment.index > right.segment.index ? 1 : 0);
    const values: JsonValue[] = [];
    for (const child of children) {
        if (child.segment.index !== BigInt(values.length)) {
            report(ctx, `Indexed AES container cannot materialize non-contiguous index ${child.segment.index}`, 'FINALIZE_NON_CONTIGUOUS_INDEX', indexed.address, true);
            continue;
        }
        values.push(materializeRecord(child, ctx));
    }
    return values;
}

function materializeNode(indexed: IndexedRecord, ctx: MaterializeContext): JsonValue {
    const index = planeFor(indexed, ctx);
    const heads = structuralChildren(index, indexed.address)
        .filter((child): child is IndexedRecord & { segment: { type: 'index'; index: bigint } } => child.segment.type === 'index')
        .sort((left, right) => left.segment.index < right.segment.index ? -1 : left.segment.index > right.segment.index ? 1 : 0);

    if (heads.length !== 1 || heads[0]!.segment.index !== 0n || heads[0]!.record.kind !== 'NodeHead') {
        report(
            ctx,
            'The JSON output profile requires exactly one NodeHead at index 0',
            'FINALIZE_UNREPRESENTABLE_NODE_HEADS',
            indexed.address,
            true,
        );
        return null;
    }

    const head = heads[0]!;
    const headAttributes = attributesToJson(head, ctx);
    return {
        $node: head.record.value ?? '',
        ...(headAttributes !== null ? { '@': headAttributes } : {}),
        $children: materializeIndexed(head, ctx),
    };
}

function materializeClone(indexed: IndexedRecord, ctx: MaterializeContext): JsonValue {
    const targetPath = indexed.record.value ?? '';
    const target = ctx.body.byAddress.get(targetPath);
    if (target === undefined) {
        report(ctx, `Clone reference target is unavailable: ${referenceToken('~', targetPath)}`, 'FINALIZE_UNRESOLVED_REFERENCE', indexed.address);
        return referenceToken('~', targetPath);
    }
    if (ctx.activeClonePaths.includes(targetPath)) {
        report(ctx, `Reference cycle detected during JSON materialization: '${targetPath}'`, 'REFERENCE_CYCLE', indexed.address, true);
        return referenceToken('~', targetPath);
    }

    const observedDepth = ctx.activeClonePaths.length + 1;
    if (ctx.maxReferenceDepth !== undefined && observedDepth > ctx.maxReferenceDepth) {
        report(ctx, `Reference materialization depth ${observedDepth} exceeds maxReferenceDepth ${ctx.maxReferenceDepth}`, 'FINALIZE_REFERENCE_DEPTH_EXCEEDED', indexed.address, true);
        return referenceToken('~', targetPath);
    }

    if (ctx.maxMaterializedWeight !== undefined) {
        const weight = measureWeight(target, ctx, new Set());
        const observed = ctx.materializedWeight + weight;
        if (observed > ctx.maxMaterializedWeight) {
            report(ctx, `Reference materialization budget exceeded for '${targetPath}' (budget=maxMaterializedWeight, observed=${observed}, limit=${ctx.maxMaterializedWeight})`, 'FINALIZE_REFERENCE_BUDGET_EXCEEDED', indexed.address, true);
            return referenceToken('~', targetPath);
        }
        ctx.materializedWeight = observed;
    }

    ctx.activeClonePaths.push(targetPath);
    try {
        return materializeRecord(target, ctx);
    } finally {
        ctx.activeClonePaths.pop();
    }
}

function measureWeight(indexed: IndexedRecord, ctx: MaterializeContext, stack: Set<string>): number {
    const cached = ctx.materializedWeightCache.get(indexed.address);
    if (cached !== undefined) return cached;
    if (stack.has(indexed.address)) return 1;
    const nextStack = new Set(stack);
    nextStack.add(indexed.address);
    const index = planeFor(indexed, ctx);
    let weight: number;

    switch (indexed.record.kind) {
        case 'ObjectNode':
        case 'ListNode':
        case 'TupleLiteral':
            weight = structuralChildren(index, indexed.address).reduce((sum, child) => sum + measureWeight(child, ctx, nextStack), 0)
                + attributeChildren(index, indexed.address).reduce((sum, child) => sum + measureWeight(child, ctx, nextStack), 0);
            break;
        case 'NodeLiteral': {
            const heads = structuralChildren(index, indexed.address);
            weight = heads.reduce((sum, head) => sum
                + 1
                + structuralChildren(index, head.address).reduce((childSum, child) => childSum + measureWeight(child, ctx, nextStack), 0)
                + attributeChildren(index, head.address).reduce((attrSum, child) => attrSum + measureWeight(child, ctx, nextStack), 0), 0);
            break;
        }
        case 'CloneReference': {
            const target = ctx.body.byAddress.get(indexed.record.value ?? '');
            weight = target === undefined ? 1 : measureWeight(target, ctx, nextStack);
            break;
        }
        default:
            weight = 1;
    }
    ctx.materializedWeightCache.set(indexed.address, weight);
    return weight;
}

function recordMetadata(indexed: IndexedRecord, ctx: MaterializeContext): JsonObject | null {
    const own = attributesToJson(indexed, ctx);
    const itemAttributes = indexedItemAttributes(indexed, ctx);
    if (own !== null && itemAttributes !== null) return { ...own, '@items': itemAttributes };
    if (own !== null) return own;
    if (itemAttributes !== null) return { '@items': itemAttributes };
    return null;
}

function attributesToJson(indexed: IndexedRecord, ctx: MaterializeContext): JsonObject | null {
    const index = planeFor(indexed, ctx);
    const object: JsonObject = {};
    const nested: JsonObject = {};
    for (const child of attributeChildren(index, indexed.address)) {
        const key = child.segment.type === 'attribute' ? child.segment.key : '';
        if (!safeMember(key, child.address, ctx)) continue;
        object[key] = materializeRecord(child, ctx);
        const childMetadata = recordMetadata(child, ctx);
        if (childMetadata !== null) nested[key] = childMetadata;
    }
    if (Object.keys(nested).length > 0) object['@'] = nested;
    return Object.keys(object).length > 0 ? object : null;
}

function indexedItemAttributes(indexed: IndexedRecord, ctx: MaterializeContext): JsonObject | null {
    const index = planeFor(indexed, ctx);
    const owners = indexed.record.kind === 'NodeLiteral'
        ? structuralChildren(index, indexed.address).flatMap((head) => structuralChildren(index, head.address))
        : indexed.record.kind === 'ListNode' || indexed.record.kind === 'TupleLiteral'
            ? structuralChildren(index, indexed.address)
            : [];
    const object: JsonObject = {};
    for (const owner of owners) {
        if (owner.segment.type !== 'index') continue;
        const attributes = attributesToJson(owner, ctx);
        if (attributes !== null) object[String(owner.segment.index)] = attributes;
    }
    return Object.keys(object).length > 0 ? object : null;
}

function structuralChildren(index: PlaneIndex, parent: string): readonly IndexedRecord[] {
    return (index.byParent.get(parent) ?? []).filter((child) => child.segment.type !== 'attribute');
}

function attributeChildren(index: PlaneIndex, parent: string): readonly IndexedRecord[] {
    return (index.byParent.get(parent) ?? []).filter((child) => child.segment.type === 'attribute');
}

function planeFor(indexed: IndexedRecord, ctx: MaterializeContext): PlaneIndex {
    return indexed.field === 'header' ? ctx.header : ctx.body;
}

function numberValue(value: string, path: string, ctx: MaterializeContext): JsonValue {
    const numeric = Number(value.replaceAll('_', ''));
    if (Number.isNaN(numeric) || !Number.isFinite(numeric) || Math.abs(numeric) > Number.MAX_SAFE_INTEGER) {
        report(ctx, `Numeric literal is not safely representable in JSON: ${value}`, 'FINALIZE_UNSAFE_NUMBER', path);
        return value;
    }
    return numeric;
}

function nullValue(value: string, path: string, ctx: MaterializeContext): JsonValue {
    if (value === 'none') return null;
    report(ctx, `Null literal is not losslessly representable in strict JSON: ${value}`, 'FINALIZE_JSON_PROFILE_NULL', path);
    return RESERVED_NULL_SENTINELS.has(value) ? `!${value}` : `!${JSON.stringify(value)}`;
}

function radixValue(record: PortableRecord, path: string, ctx: MaterializeContext): string {
    const value = (record.value ?? '').replaceAll('_', '');
    const base = declaredRadixBase(record);
    if (base !== null && exceedsDeclaredRadix(value, base)) {
        report(ctx, `Radix literal exceeds declared radix ${base}: %${value}`, 'FINALIZE_INVALID_RADIX_BASE', path);
    }
    return value;
}

function declaredRadixBase(record: PortableRecord): number | null {
    if (record.datatype === 'decimal') return 10;
    if (record.datatype === 'radix2') return 2;
    if (record.datatype === 'radix6') return 6;
    if (record.datatype === 'radix8') return 8;
    if (record.datatype === 'radix12') return 12;
    if (record.datatype !== 'radix' || record.clarifiers?.length !== 1) return null;
    const clarifier = record.clarifiers[0];
    if (clarifier?.kind !== 'NumberLiteral') return null;
    const base = Number(clarifier.value);
    return Number.isInteger(base) && base >= 2 && base <= 64 ? base : null;
}

function exceedsDeclaredRadix(value: string, base: number): boolean {
    for (const character of value) {
        if (character === '+' || character === '-' || character === '.') continue;
        const digit = radixDigitValue(character);
        if (digit === null || digit >= base) return true;
    }
    return false;
}

function radixDigitValue(character: string): number | null {
    if (character >= '0' && character <= '9') return character.charCodeAt(0) - 48;
    if (character >= 'A' && character <= 'Z') return character.charCodeAt(0) - 55;
    if (character >= 'a' && character <= 'z') return character.charCodeAt(0) - 61;
    if (character === '&') return 62;
    if (character === '!') return 63;
    return null;
}

function referenceToken(prefix: '~' | '~>', target: string): string {
    if (target.startsWith('$.')) return `${prefix}${target.slice(2)}`;
    return `${prefix}${target}`;
}

function report(
    ctx: MaterializeContext,
    message: string,
    code: string,
    path: string,
    alwaysError = false,
): void {
    const diagnostic: Diagnostic = {
        level: alwaysError || ctx.strict ? 'error' : 'warning',
        code,
        message,
        path,
    };
    if (diagnostic.level === 'error') ctx.errors.push(diagnostic);
    else ctx.warnings.push(diagnostic);
}

function safeMember(key: string, path: string, ctx: MaterializeContext): boolean {
    if (!RESERVED_OBJECT_KEYS.has(key)) return true;
    report(ctx, `Reserved key: ${key}`, 'FINALIZE_RESERVED_KEY', path, true);
    return false;
}

function parsePath(path: string): { readonly parent: string; readonly segment: PathSegment } {
    let cursor = 1;
    let parent = '$';
    let segment: PathSegment | undefined;
    while (cursor < path.length) {
        parent = path.slice(0, cursor);
        if (path.startsWith('.@.', cursor)) {
            const member = readMember(path, cursor + 3);
            segment = { type: 'attribute', key: member.key };
            cursor = member.end;
        } else if (path[cursor] === '.') {
            const member = readMember(path, cursor + 1);
            segment = { type: 'member', key: member.key };
            cursor = member.end;
        } else {
            const match = path.slice(cursor).match(/^\[(0|[1-9][0-9]*)\]/u);
            if (match === null) throw new TypeError(`Invalid portable AES path: ${path}`);
            segment = { type: 'index', index: BigInt(match[1]!) };
            cursor += match[0].length;
        }
    }
    if (segment === undefined) throw new TypeError(`The root is not a portable AES event path: ${path}`);
    return { parent, segment };
}

function readMember(path: string, cursor: number): { readonly key: string; readonly end: number } {
    if (path[cursor] === '[') {
        let end = cursor + 2;
        let escaped = false;
        for (; end < path.length; end += 1) {
            const character = path[end];
            if (escaped) escaped = false;
            else if (character === '\\') escaped = true;
            else if (character === '"') break;
        }
        const encoded = path.slice(cursor + 1, end + 1);
        const key = JSON.parse(encoded) as unknown;
        if (typeof key !== 'string' || path[end + 1] !== ']') throw new TypeError(`Invalid portable AES member: ${path}`);
        return { key, end: end + 2 };
    }
    const match = path.slice(cursor).match(BARE_MEMBER);
    if (match === null) throw new TypeError(`Invalid portable AES member: ${path}`);
    return { key: match[0], end: cursor + match[0].length };
}
