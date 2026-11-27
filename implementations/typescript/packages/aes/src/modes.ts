/**
 * Phase 7 — Mode Enforcement
 * 
 * Enforces:
 * - Transport vs Strict mode typing rules
 * - Toggle typing rules (no semantic toggle unless typed)
 * - Header correctness
 * 
 * Non-negotiable constraints:
 * - No coercion, ever
 * - No schema execution
 * - No reference resolution
 * - Fail-closed by default
 */

import type { Span } from '@altopelago/aeon-lexer';
import type { Header, Value, Attribute, ReferencePathSegment } from '@altopelago/aeon-parser';
import type { AssignmentEvent, AttributeEntry } from './events.js';
import { formatDatatypeAnnotation } from './datatype.js';
import { formatPath } from './paths.js';

import { formatReferenceTargetPath, resolveEventSubpath } from './reference-target.js';

/**
 * Document mode
 */
export type Mode = 'transport' | 'strict' | 'custom';
export type DatatypePolicy = 'reserved_only' | 'allow_custom';

/**
 * Mode enforcement error codes
 */
export type ModeEnforcementErrorCode =
    | 'UNTYPED_VALUE_IN_STRICT_MODE'
    | 'UNTYPED_TOGGLE_LITERAL'
    | 'CUSTOM_TOGGLE_ALIAS_NOT_ALLOWED'
    | 'DATATYPE_LITERAL_MISMATCH'
    | 'CUSTOM_DATATYPE_NOT_ALLOWED'
    | 'INVALID_NODE_DATATYPE'
    | 'HEADER_CONFLICT';

/**
 * Mode enforcement error
 */
export class ModeEnforcementError extends Error {
    readonly span: Span;
    readonly code: ModeEnforcementErrorCode;
    readonly path: string;

    constructor(
        message: string,
        span: Span,
        code: ModeEnforcementErrorCode,
        path: string
    ) {
        super(message);
        this.name = 'ModeEnforcementError';
        this.span = span;
        this.code = code;
        this.path = path;
    }
}

/**
 * Error: Untyped value in typed mode
 */
export class UntypedValueInStrictModeError extends ModeEnforcementError {
    constructor(span: Span, path: string) {
        super(
            `Untyped value in typed mode: '${path}' requires explicit type annotation`,
            span,
            'UNTYPED_VALUE_IN_STRICT_MODE',
            path
        );
        this.name = 'UntypedValueInStrictModeError';
    }
}

/**
 * Error: toggle literal requires :toggle in typed mode
 */
export class UntypedToggleLiteralError extends ModeEnforcementError {
    constructor(span: Span, path: string) {
        super(
            `Untyped toggle literal in typed mode: '${path}' requires ':toggle' type annotation`,
            span,
            'UNTYPED_TOGGLE_LITERAL',
            path
        );
        this.name = 'UntypedToggleLiteralError';
    }
}

export class CustomToggleAliasNotAllowedError extends ModeEnforcementError {
    constructor(span: Span, path: string, datatype: string) {
        super(
            `Custom toggle alias not allowed at '${path}': use ':toggle' instead of ':${datatype}'`,
            span,
            'CUSTOM_TOGGLE_ALIAS_NOT_ALLOWED',
            path
        );
        this.name = 'CustomToggleAliasNotAllowedError';
    }
}

/**
 * Error: Structured header and shorthand header used together
 */
export class HeaderConflictError extends ModeEnforcementError {
    constructor(span: Span) {
        super(
            'Header conflict: cannot use both structured header (aeon:header) and shorthand header fields',
            span,
            'HEADER_CONFLICT',
            '$'
        );
        this.name = 'HeaderConflictError';
    }
}

/**
 * Error: Reserved datatype annotation does not match literal/container kind
 */
export class DatatypeLiteralMismatchError extends ModeEnforcementError {
    constructor(span: Span, path: string, datatype: string, actualKind: string, expectedKinds: readonly string[]) {
        super(
            `Datatype/literal mismatch at '${path}': datatype ':${datatype}' expects ${expectedKinds.join(' or ')}, got ${actualKind}`,
            span,
            'DATATYPE_LITERAL_MISMATCH',
            path
        );
        this.name = 'DatatypeLiteralMismatchError';
    }
}

/**
 * Error: Custom datatype is not permitted by typed-mode datatype policy
 */
export class CustomDatatypeNotAllowedError extends ModeEnforcementError {
    constructor(span: Span, path: string, datatype: string) {
        super(
            `Custom datatype not allowed in typed mode at '${path}': ':${datatype}' requires --datatype-policy allow_custom`,
            span,
            'CUSTOM_DATATYPE_NOT_ALLOWED',
            path
        );
        this.name = 'CustomDatatypeNotAllowedError';
    }
}

/**
 * Error: Inline node datatypes must use :node in strict mode.
 */
export class InvalidNodeDatatypeError extends ModeEnforcementError {
    constructor(span: Span, path: string, datatype: string) {
        super(
            `Invalid node datatype in strict mode at '${path}': expected ':node', got ':${datatype}'`,
            span,
            'INVALID_NODE_DATATYPE',
            path
        );
        this.name = 'InvalidNodeDatatypeError';
    }
}

/**
 * Mode enforcement options
 */
export interface ModeEnforcementOptions {
    /** Enable recovery mode (return events even with errors) */
    readonly recovery?: boolean;
    /**
     * Consumer-selected effective mode. When omitted, enforcement honors the
     * document-declared aeon:mode for backwards-compatible authoring flows.
     */
    readonly mode?: Mode;
    /** Explicit datatype compatibility override for typed modes */
    readonly datatypePolicy?: DatatypePolicy;
    /** Expected literal kinds for annotations using a custom datatype. */
    readonly customDatatypeKinds?: (datatype: string) => readonly string[] | null;
}

/**
 * Mode enforcement result
 */
export interface ModeEnforcementResult {
    /** Events (empty if errors and not in recovery mode) */
    readonly events: readonly AssignmentEvent[];
    /** Mode enforcement errors */
    readonly errors: readonly ModeEnforcementError[];
}

/**
 * Extract mode from header
 */
export function extractMode(header: Pick<Header, 'fields'> | null): Mode {
    if (!header) {
        return 'transport'; // Default
    }

    // Check for mode field
    const modeValue = header.fields.get('mode');
    if (modeValue && modeValue.type === 'StringLiteral') {
        const mode = modeValue.value.toLowerCase();
        if (mode === 'strict') {
            return 'strict';
        }
        if (mode === 'custom') {
            return 'custom';
        }
    }

    return 'transport'; // Default
}

/**
 * Enforce mode constraints on events
 * 
 * In typed modes (`strict` and `custom`):
 * - Every binding must have an explicit type annotation
 *
 * In strict mode only:
 * - Untyped toggle literals (yes/no/on/off) require :toggle type
 *
 * In transport mode:
 * - Untyped values are allowed (stay raw, no semantic interpretation)
 * - Explicit datatype annotations are still validated for compatibility
 * - Custom datatype labels are accepted by default
 */
export function enforceMode(
    events: readonly AssignmentEvent[],
    header: Header | null,
    options: ModeEnforcementOptions = {}
): ModeEnforcementResult {
    const mode = options.mode ?? extractMode(header);
    const datatypePolicy = options.datatypePolicy ?? defaultDatatypePolicyForMode(mode);
    const { customDatatypeKinds } = options;
    const allowCustom = mode === 'transport' || datatypePolicy === 'allow_custom';
    const errors: ModeEnforcementError[] = [];
    const pathToIndex = new Map<string, number>();
    const referenceCache: DatatypeReferenceCache = {
        targets: new Map(),
        kinds: new Map(),
        base64Kinds: new Map(),
    };

    for (let i = 0; i < events.length; i++) {
        pathToIndex.set(formatPath(events[i]!.path), i);
    }

    // Header correctness: structured vs shorthand mutual exclusion
    if (header && header.hasStructured && header.hasShorthand) {
        errors.push(new HeaderConflictError(header.span));
    }

    for (const event of events) {
        // Header metadata is control-plane information, not payload.
        // Shorthand and structured header forms should be equivalent here.
        if (shouldSkipHeaderEvent(event, header)) {
            continue;
        }

        const owner = formatPath(event.path);
        validateMetadataDatatypes(event, owner, (value, path, span, datatype, validation) => {
            if (value.type === 'NodeLiteral') {
                const error = validateNodeDatatype(value, path, span, mode, allowCustom, customDatatypeKinds);
                if (error) errors.push(error);
            } else {
                if ((validation === 'node-child' || validation === 'node-member') && datatype) {
                    const error = validateAnonymousDatatype(value, datatype, span, path, events, pathToIndex, mode, datatypePolicy, referenceCache);
                    if (error) {
                        errors.push(error);
                        return;
                    }
                }
                if (validation === 'node-attribute' || validation === 'node-member' && !datatype) {
                    const error = validateAttributeDatatype(value, datatype ?? undefined, path, span,
                        events, pathToIndex, mode, datatypePolicy, referenceCache);
                    if (error) {
                        errors.push(error);
                        return;
                    }
                }
                if (!allowCustom || !datatype || !customDatatypeKinds || expectedKindsForReservedDatatype(datatype)) return;
                const kinds = customDatatypeKinds(datatype);
                if (!kinds) return;
                const kind = resolveDatatypeCheckKind(value, events, pathToIndex, datatype, referenceCache);
                if (kind !== 'CloneReference' && kind !== 'PointerReference' && !kinds.includes(kind)) {
                    errors.push(new DatatypeLiteralMismatchError(span, path, datatype, kind, kinds));
                }
            }
        });

        if (event.value.type === 'NodeLiteral') {
            const error = validateNodeDatatype(event.value, owner, event.span, mode, allowCustom, customDatatypeKinds);
            if (error) errors.push(error);
            errors.push(...validateAnonymousTypedValues(event.value, owner, event.span, events, pathToIndex, mode, datatypePolicy, referenceCache));
            continue;
        }

        // Indexed list/tuple element events are synthetic structural nodes.
        // They still carry explicit annotations on authored anonymous values.
        if (isIndexedElementEvent(event)) {
            const datatype = event.datatype;
            if (datatype && allowCustom && !expectedKindsForReservedDatatype(datatype)) {
                const kinds = customDatatypeKinds?.(datatype);
                if (kinds) {
                    const kind = resolveDatatypeCheckKind(event.value, events, pathToIndex, datatype, referenceCache);
                    if (kind !== 'CloneReference' && kind !== 'PointerReference' && !kinds.includes(kind)) {
                        errors.push(new DatatypeLiteralMismatchError(event.span, owner, datatype, kind, kinds));
                    }
                }
            }
            continue;
        }

        if (!event.datatype) {
            if (mode === 'strict' || mode === 'custom') {
                if (mode === 'strict' && event.value.type === 'ToggleLiteral') {
                    errors.push(new UntypedToggleLiteralError(event.span, owner));
                } else {
                    errors.push(new UntypedValueInStrictModeError(event.span, owner));
                }
            }
            continue;
        }

        const expectedKinds = expectedKindsForReservedDatatype(event.datatype);
        const kinds = expectedKinds ?? customDatatypeKinds?.(event.datatype);
        const isSwitch = datatypeBase(event.datatype) === 'switch';
        const actualKind = kinds || isSwitch || mode === 'strict'
            ? resolveDatatypeCheckKind(event.value, events, pathToIndex, event.datatype, referenceCache)
            : undefined;
        if (isSwitch && actualKind === 'ToggleLiteral') {
            errors.push(new CustomToggleAliasNotAllowedError(event.span, owner, event.datatype));
            continue;
        }
        if (!allowCustom && !expectedKinds) {
            errors.push(new CustomDatatypeNotAllowedError(event.span, owner, event.datatype));
            continue;
        }
        if (mode === 'strict' && !expectedKinds && actualKind === 'ToggleLiteral') {
            errors.push(new CustomToggleAliasNotAllowedError(event.span, owner, event.datatype));
            continue;
        }
        if (kinds && actualKind !== undefined && !kinds.includes(actualKind)) {
            errors.push(new DatatypeLiteralMismatchError(
                event.span,
                owner,
                event.datatype,
                actualKind,
                kinds
            ));
        }
        errors.push(...validateAnnotationEntries(
            event.annotations,
            owner,
            event.span,
            events,
            pathToIndex,
            mode,
            datatypePolicy,
            referenceCache
        ));
        errors.push(...validateAnonymousTypedValues(
            event.value,
            owner,
            event.span,
            events,
            pathToIndex,
            mode,
            datatypePolicy,
            referenceCache
        ));
    }

    // Fail-closed: return empty events if errors exist
    if (errors.length > 0 && !options.recovery) {
        return { events: [], errors };
    }

    return { events, errors };
}

function defaultDatatypePolicyForMode(mode: Mode): DatatypePolicy {
    return mode === 'strict' ? 'reserved_only' : 'allow_custom';
}

function shouldSkipHeaderEvent(event: AssignmentEvent, header: Header | null): boolean {
    if (event.sourcePlane !== undefined) {
        return event.sourcePlane === 'header';
    }
    if (!header) {
        return false;
    }
    const segment = event.path.segments[1];
    return event.path.segments[0]?.type === 'root'
        && segment?.type === 'member'
        && segment.key.startsWith('aeon:')
        && header.fields.has(segment.key.slice('aeon:'.length));
}

// Legacy export for backward compatibility
export function validateMode(_mode: Mode): readonly ModeEnforcementError[] {
    return [];
}

function isIndexedElementEvent(event: AssignmentEvent): boolean {
    const lastSegment = event.path.segments[event.path.segments.length - 1];
    return lastSegment?.type === 'index';
}

interface DatatypeReferenceCache {
    readonly targets: Map<Value, Value>;
    readonly kinds: Map<Value, string>;
    readonly base64Kinds: Map<Value, string>;
}

function resolveDatatypeCheckKind(
    value: Value,
    events: readonly AssignmentEvent[],
    pathToIndex: ReadonlyMap<string, number>,
    datatype: string,
    referenceCache: DatatypeReferenceCache
): string {
    let current = unwrapTypedValue(value);
    if (current.type !== 'CloneReference' && current.type !== 'PointerReference') {
        return resolvedValueKind(current, datatype);
    }

    let seen: Set<Value> | undefined;
    while (current.type === 'CloneReference' || current.type === 'PointerReference') {
        const cached = referenceCache.targets.get(current);
        if (cached) {
            current = cached;
            break;
        }
        seen ??= new Set();
        if (seen.has(current)) {
            // Keep the entry point of a cycle for references leading into it.
            let inCycle = false;
            for (const reference of seen) {
                inCycle ||= reference === current;
                referenceCache.targets.set(reference, inCycle ? reference : current);
            }
            return resolvedValueKind(current, datatype);
        }
        seen.add(current);
        const target = resolveReferenceValue(current, events, pathToIndex);
        if (!target) break;
        current = unwrapTypedValue(target);
    }
    if (seen) {
        for (const reference of seen) referenceCache.targets.set(reference, current);
    }
    // A shared encoding value may be checked both as general encoding and as base64url.
    const kinds = current.type === 'EncodingLiteral' && datatypeBase(datatype) === 'base64'
        ? referenceCache.base64Kinds : referenceCache.kinds;
    const cachedKind = kinds.get(current);
    if (cachedKind !== undefined) return cachedKind;
    const kind = resolvedValueKind(current, datatype);
    kinds.set(current, kind);
    return kind;
}

function resolvedValueKind(value: Value, datatype?: string): string {
    if (value.type === 'TypedValue') {
        return resolvedValueKind(value.value, datatype);
    }
    if (value.type === 'StringLiteral') {
        return value.trimticks ? 'TrimtickStringLiteral' : 'StringLiteral';
    }
    if (value.type === 'DateTimeLiteral') {
        return value.raw.includes('&') ? 'WTCDateTimeLiteral' : 'DateTimeLiteral';
    }
    if (value.type === 'SeparatorLiteral') {
        return 'SeparatorLiteral';
    }
    if (value.type === 'HexLiteral') {
        return hasValidLiteralUnderscores(value.raw) ? 'HexLiteral' : 'InvalidHexLiteral';
    }
    if (value.type === 'RadixLiteral') {
        return hasValidRadixLiteral(value.raw) ? 'RadixLiteral' : 'InvalidRadixLiteral';
    }
    if (value.type === 'EncodingLiteral') {
        const valid = datatype && datatypeBase(datatype) === 'base64'
            ? hasValidBase64UrlLiteral(value.raw)
            : hasValidEncodingLiteral(value.raw);
        return valid ? 'EncodingLiteral' : 'InvalidEncodingLiteral';
    }
    return value.type;
}

function appendModeMemberPath(path: string, key: string): string {
    return path + formatPath({ segments: [{ type: 'root' }, { type: 'member', key }] }).slice(1);
}

function validateAnonymousTypedValues(
    value: Value,
    ownerPath: string,
    span: Span,
    events: readonly AssignmentEvent[],
    pathToIndex: ReadonlyMap<string, number>,
    mode: Mode,
    datatypePolicy: DatatypePolicy,
    referenceCache: DatatypeReferenceCache,
    descendant = false,
): readonly ModeEnforcementError[] {
    // Each projected node validates its own children. Skip a second walk of the
    // same subtree while retaining validation for inputs without indexed events.
    if (descendant && value.type === 'NodeLiteral' && pathToIndex.has(ownerPath)) return [];
    const errors: ModeEnforcementError[] = [];

    if (value.type === 'TypedValue') {
        if (value.datatype) {
            const datatype = formatDatatypeAnnotation(value.datatype);
            const error = validateAnonymousDatatype(value.value, datatype, value.span, ownerPath,
                events, pathToIndex, mode, datatypePolicy, referenceCache);
            if (error) errors.push(error);
        }

        errors.push(...validateAnonymousTypedValues(value.value, ownerPath, span, events, pathToIndex, mode, datatypePolicy, referenceCache, true));
        return errors;
    }

    if (value.type === 'ObjectNode') {
        for (const binding of value.bindings) {
            errors.push(...validateAnonymousTypedValues(binding.value, appendModeMemberPath(ownerPath, binding.key), span, events, pathToIndex, mode, datatypePolicy, referenceCache, true));
        }
        return errors;
    }

    if (value.type === 'ListNode' || value.type === 'TupleLiteral') {
        for (let i = 0; i < value.elements.length; i++) {
            errors.push(...validateAnonymousTypedValues(value.elements[i]!, `${ownerPath}[${i}]`, span, events, pathToIndex, mode, datatypePolicy, referenceCache, true));
        }
        return errors;
    }

    if (value.type === 'NodeLiteral') {
        for (let i = 0; i < value.children.length; i++) {
            errors.push(...validateAnonymousTypedValues(value.children[i]!, `${ownerPath}[${i}]`, span, events, pathToIndex, mode, datatypePolicy, referenceCache, true));
        }
    }

    return errors;
}

function validateAnonymousDatatype(
    value: Value, datatype: string, span: Span, path: string,
    events: readonly AssignmentEvent[], pathToIndex: ReadonlyMap<string, number>,
    mode: Mode, datatypePolicy: DatatypePolicy, referenceCache: DatatypeReferenceCache,
): ModeEnforcementError | undefined {
    const expectedKinds = expectedKindsForReservedDatatype(datatype);
    const actualKind = resolveDatatypeCheckKind(value, events, pathToIndex, datatype, referenceCache);
    if (datatypeBase(datatype) === 'switch' && actualKind === 'ToggleLiteral') {
        return new CustomToggleAliasNotAllowedError(span, path, datatype);
    }
    if ((mode === 'strict' || mode === 'custom') && !expectedKinds && datatypePolicy === 'reserved_only') {
        return new CustomDatatypeNotAllowedError(span, path, datatype);
    }
    if (mode === 'strict' && !expectedKinds && actualKind === 'ToggleLiteral') {
        return new CustomToggleAliasNotAllowedError(span, path, datatype);
    }
    if (expectedKinds && !expectedKinds.includes(actualKind)) {
        return new DatatypeLiteralMismatchError(span, path, datatype, actualKind, expectedKinds);
    }
    return undefined;
}

function hasValidLiteralUnderscores(raw: string): boolean {
    const body = raw.slice(1);
    return body.length > 0 && !body.startsWith('_') && !body.endsWith('_') && !body.includes('__');
}

function isValidRadixDigit(c: string): boolean {
    return /[0-9A-Za-z&!]/.test(c);
}

function hasValidRadixLiteral(raw: string): boolean {
    const body = raw.slice(1);
    if (body.length === 0) return false;

    let index = 0;
    if (body[index] === '+' || body[index] === '-') index += 1;
    if (index >= body.length) return false;

    let sawDigit = false;
    let sawDecimal = false;
    let prevWasDigit = false;
    let sawDigitBeforeDecimal = false;

    for (; index < body.length; index += 1) {
        const c = body[index]!;
        if (isValidRadixDigit(c)) {
            sawDigit = true;
            prevWasDigit = true;
            if (!sawDecimal) sawDigitBeforeDecimal = true;
            continue;
        }
        if (c === '_') {
            if (!prevWasDigit || index + 1 >= body.length || !isValidRadixDigit(body[index + 1]!)) return false;
            prevWasDigit = false;
            continue;
        }
        if (c === '.') {
            if (sawDecimal || index + 1 >= body.length || !isValidRadixDigit(body[index + 1]!)) return false;
            if (!prevWasDigit && sawDigitBeforeDecimal) return false;
            sawDecimal = true;
            prevWasDigit = false;
            continue;
        }
        return false;
    }

    return sawDigit && prevWasDigit;
}

function hasValidEncodingLiteral(raw: string): boolean {
    if (!raw.startsWith('&')) return false;
    const body = raw.slice(1);
    if (body.length === 0) return false;
    if (!/^[A-Za-z0-9_-]+={0,2}$/.test(body)) return false;
    const firstPadding = body.indexOf('=');
    if (firstPadding === -1) return true;
    return /^=+$/.test(body.slice(firstPadding));
}

function hasValidBase64UrlLiteral(raw: string): boolean {
    if (!hasValidEncodingLiteral(raw)) return false;
    const body = raw.slice(1);
    const paddingLength = body.endsWith('==') ? 2 : body.endsWith('=') ? 1 : 0;
    const data = body.slice(0, body.length - paddingLength);
    const remainder = data.length % 4;
    if (remainder === 1) return false;
    if (paddingLength > 0 && body.length % 4 !== 0) return false;
    if (paddingLength === 1 && remainder !== 3) return false;
    if (paddingLength === 2 && remainder !== 2) return false;

    const last = base64UrlSextet(data[data.length - 1]!);
    if (remainder === 2 && (last & 0x0f) !== 0) return false;
    if (remainder === 3 && (last & 0x03) !== 0) return false;
    return true;
}

function base64UrlSextet(char: string): number {
    if (char >= 'A' && char <= 'Z') return char.charCodeAt(0) - 65;
    if (char >= 'a' && char <= 'z') return char.charCodeAt(0) - 71;
    if (char >= '0' && char <= '9') return char.charCodeAt(0) + 4;
    return char === '-' ? 62 : 63;
}

function validateNodeDatatype(
    node: Extract<Value, { type: 'NodeLiteral' }>,
    path: string,
    span: Span,
    mode: Mode,
    allowCustom: boolean,
    customKinds?: ModeEnforcementOptions['customDatatypeKinds'],
): ModeEnforcementError | undefined {
    if (!node.datatype) return undefined;
    const datatype = formatDatatypeAnnotation(node.datatype);
    if (mode === 'strict' && datatypeBase(datatype) !== 'node') {
        return new InvalidNodeDatatypeError(span, path, datatype);
    }
    const reserved = expectedKindsForReservedDatatype(datatype);
    if (!allowCustom && !reserved) return new CustomDatatypeNotAllowedError(span, path, datatype);
    const kinds = reserved ?? customKinds?.(datatype);
    if (kinds && !kinds.includes('NodeLiteral')) {
        return new DatatypeLiteralMismatchError(span, path, datatype, 'NodeLiteral', kinds);
    }
    return undefined;
}

function validateMetadataDatatypes(
    event: AssignmentEvent,
    owner: string,
    check: (value: Value, path: string, span: Span, datatype: string | null | undefined, validation?: 'node-attribute' | 'node-child' | 'node-member') => void,
): void {
    interface Claim {
        readonly value: Value;
        readonly path: string;
        readonly datatype?: string | null;
        readonly span: Span;
        readonly projectedNodeAttributes?: boolean;
        readonly validation?: 'node-attribute' | 'node-child' | 'node-member';
        readonly nodePayload?: boolean;
    }

    const tasks: Claim[] = [];
    function attributes(blocks: readonly Attribute[] | undefined, owner: string, isNodeAttribute = false): void {
        for (const block of [...(blocks ?? [])].reverse()) {
            for (const [key, entry] of [...block.entries].reverse()) {
                const path = appendModeMemberPath(`${owner}.@`, key);
                attributes(entry.attributes, path, isNodeAttribute);
                tasks.push({
                    value: entry.value, path, span: entry.span ?? entry.value.span,
                    datatype: entry.datatype && formatDatatypeAnnotation(entry.datatype),
                    ...(isNodeAttribute ? { validation: 'node-attribute' } : {}),
                });
            }
        }
    }
    function projected(entries: ReadonlyMap<string, AttributeEntry> | undefined, owner: string, inNode = false): void {
        for (const [key, entry] of [...(entries ?? [])].reverse()) {
            const path = appendModeMemberPath(`${owner}.@`, key);
            projected(entry.annotations, path, inNode || entry.value.type === 'NodeLiteral');
            tasks.push({
                value: entry.value, path, span: entry.span ?? entry.value.span,
                datatype: entry.datatype ?? null, projectedNodeAttributes: entry.annotations !== undefined,
                ...(inNode ? { validation: 'node-attribute' } : {}),
            });
        }
    }

    let root = event.value;
    while (root.type === 'TypedValue') {
        attributes(root.attributes, owner);
        root = root.value;
    }
    if ('attributes' in root && (root.type !== 'NodeLiteral' || event.annotations === undefined)) {
        attributes(root.attributes, owner, root.type === 'NodeLiteral');
    }
    projected(event.annotations, owner, root.type === 'NodeLiteral');

    while (tasks.length > 0) {
        const { value, path, datatype, span, projectedNodeAttributes, validation, nodePayload } = tasks.pop()!;
        check(value, path, span, datatype, validation);

        switch (value.type) {
            case 'TypedValue':
                tasks.push({
                    value: value.value, path, span: value.span,
                    datatype: value.datatype && formatDatatypeAnnotation(value.datatype),
                    ...(nodePayload ? { nodePayload, validation: 'node-child' } : {}),
                });
                attributes(value.attributes, path);
                break;
            case 'ObjectNode':
                for (const binding of [...value.bindings].reverse()) {
                    const child = appendModeMemberPath(path, binding.key);
                    tasks.push({
                        value: binding.value, path: child, span: binding.span,
                        datatype: binding.datatype && formatDatatypeAnnotation(binding.datatype),
                        ...(nodePayload ? { nodePayload, validation: 'node-member' } : {}),
                    });
                    attributes(binding.attributes, child, nodePayload);
                }
                attributes(value.attributes, path);
                break;
            case 'ListNode':
            case 'TupleLiteral':
                for (let index = value.elements.length - 1; index >= 0; index--) {
                    const child = value.elements[index]!;
                    tasks.push({ value: child, path: `${path}[${index}]`, span: child.span, ...(nodePayload ? { nodePayload } : {}) });
                }
                attributes(value.attributes, path);
                break;
            case 'NodeLiteral': {
                for (let index = value.children.length - 1; index >= 0; index--) {
                    const child = value.children[index]!;
                    tasks.push({ value: child, path: `${path}[${index}]`, span: child.span, nodePayload: true });
                }
                if (!projectedNodeAttributes) attributes(value.attributes, path, true);
                break;
            }
        }
    }
}

function validateAnnotationEntries(
    annotations: ReadonlyMap<string, AttributeEntry> | undefined,
    ownerPath: string,
    span: Span,
    events: readonly AssignmentEvent[],
    pathToIndex: ReadonlyMap<string, number>,
    mode: Mode,
    datatypePolicy: DatatypePolicy,
    referenceCache: DatatypeReferenceCache
): readonly ModeEnforcementError[] {
    if (!annotations || annotations.size === 0) {
        return [];
    }

    const errors: ModeEnforcementError[] = [];
    for (const [key, entry] of annotations) {
        const attrPath = appendModeMemberPath(`${ownerPath}.@`, key);
        if (entry.value.type === 'NodeLiteral') continue;
        const error = validateAttributeDatatype(entry.value, entry.datatype, attrPath, entry.span ?? span,
            events, pathToIndex, mode, datatypePolicy, referenceCache);
        if (error) errors.push(error);
        errors.push(...validateAnnotationEntries(
            entry.annotations,
            attrPath,
            span,
            events,
            pathToIndex,
            mode,
            datatypePolicy,
            referenceCache
        ));
    }
    return errors;
}

function validateAttributeDatatype(
    value: Value, datatype: string | undefined, path: string, span: Span,
    events: readonly AssignmentEvent[], pathToIndex: ReadonlyMap<string, number>,
    mode: Mode, datatypePolicy: DatatypePolicy, referenceCache: DatatypeReferenceCache,
): ModeEnforcementError | undefined {
    const typedMode = mode === 'strict' || mode === 'custom';
    if (!datatype) {
        if (!typedMode) return undefined;
        const resolved = resolveReferenceValue(value, events, pathToIndex) ?? value;
        return mode === 'strict' && resolvedValueKind(resolved) === 'ToggleLiteral'
            ? new UntypedToggleLiteralError(span, path)
            : new UntypedValueInStrictModeError(span, path);
    }
    const expected = expectedKindsForReservedDatatype(datatype);
    if (typedMode && !expected && datatypePolicy === 'reserved_only') {
        return new CustomDatatypeNotAllowedError(span, path, datatype);
    }
    if (expected) {
        const actual = resolveDatatypeCheckKind(value, events, pathToIndex, datatype, referenceCache);
        if (!expected.includes(actual)) return new DatatypeLiteralMismatchError(span, path, datatype, actual, expected);
    }
    return undefined;
}

function resolveReferenceValue(
    value: Value,
    events: readonly AssignmentEvent[],
    pathToIndex: ReadonlyMap<string, number>
): Value | null {
    if (value.type !== 'CloneReference' && value.type !== 'PointerReference') {
        return unwrapTypedValue(value);
    }

    const resolution = resolveReferenceTarget(value.path, events, pathToIndex);
    if (!resolution) {
        return null;
    }
    return resolveEventSubpath(resolution.event, resolution.remainder);
}

function resolveReferenceTarget(
    path: readonly ReferencePathSegment[],
    events: readonly AssignmentEvent[],
    pathToIndex: ReadonlyMap<string, number>
): { readonly targetPath: string; readonly event: AssignmentEvent; readonly remainder: readonly ReferencePathSegment[] } | null {
    for (let split = path.length; split >= 1; split--) {
        const prefix = path.slice(0, split);
        if (prefix.some((segment) => typeof segment === 'object' && segment.type === 'attr')) {
            continue;
        }

        const prefixPath = formatReferenceTargetPath(prefix);
        const targetIndex = pathToIndex.get(prefixPath);
        if (targetIndex === undefined) {
            continue;
        }
        const event = events[targetIndex];
        if (!event) {
            return null;
        }

        const remainder = path.slice(split);
        if (remainder.length === 0) {
            return { targetPath: prefixPath, event, remainder };
        }

        if (resolveEventSubpath(event, remainder)) {
            return { targetPath: prefixPath, event, remainder };
        }
    }

    return null;
}

function unwrapTypedValue(value: Value): Value {
    return value.type === 'TypedValue' ? value.value : value;
}

function expectedKindsForReservedDatatype(datatype: string): readonly string[] | null {
    const base = datatypeBase(datatype);

    // Reserved scalar and container names validated by strict mode.
    // Custom datatypes intentionally remain unconstrained.
    if (NUMERIC_TYPES.has(base)) return ['NumberLiteral'];
    if (base === 'infinity') return ['InfinityLiteral'];
    if (base === 'nan') return ['NaNLiteral'];
    if (base === 'string') return ['StringLiteral'];
    if (base === 'trimtick' || base === 'prose') return ['TrimtickStringLiteral'];
    if (base === 'boolean' || base === 'bool') return ['BooleanLiteral'];
    if (base === 'toggle') return ['ToggleLiteral'];
    if (base === 'symbol') return ['SymbolicLiteral'];
    if (base === 'hex') return ['HexLiteral'];
    if (RADIX_TYPES.has(base)) return ['RadixLiteral'];
    if (ENCODING_TYPES.has(base)) return ['EncodingLiteral'];
    if (base === 'date') return ['DateLiteral'];
    if (base === 'time') return ['TimeLiteral'];
    if (base === 'datetime') return ['DateTimeLiteral'];
    if (base === 'wtc') return ['WTCDateTimeLiteral'];
    if (SEPARATOR_TYPES.has(base)) return ['SeparatorLiteral'];
    if (base === 'sansa') return ['SansaAddressLiteral'];
    if (base === 'tuple' || base === 'triple') return ['TupleLiteral'];
    if (base === 'list') return ['ListNode'];
    if (OBJECT_TYPES.has(base)) return ['ObjectNode'];
    if (base === 'node') return ['NodeLiteral'];
    if (base === 'null') return ['NullLiteral'];
    return null;
}

function datatypeBase(datatype: string): string {
    const genericIdx = datatype.indexOf('<');
    const separatorIdx = datatype.indexOf('[');
    const endIdx = [genericIdx, separatorIdx]
        .filter((idx) => idx >= 0)
        .reduce((min, idx) => Math.min(min, idx), datatype.length);
    return datatype.slice(0, endIdx);
}

export function datatypeHasGenericArgs(datatype: string): boolean {
    let bracketDepth = 0;
    let genericStart = -1;

    let quote: string | undefined;
    let escaped = false;
    for (let index = 0; index < datatype.length; index += 1) {
        const char = datatype[index]!;
        if (quote !== undefined) {
            if (escaped) {
                escaped = false;
            } else if (char === '\\') {
                escaped = true;
            } else if (char === quote) {
                quote = undefined;
            }
            continue;
        }
        if (char === '"' || char === "'") {
            quote = char;
            continue;
        }
        if (char === '[') {
            bracketDepth += 1;
            continue;
        }
        if (char === ']') {
            bracketDepth = Math.max(0, bracketDepth - 1);
            continue;
        }
        if (bracketDepth > 0) {
            continue;
        }
        if (char === '<') {
            genericStart = index;
            continue;
        }
        if (char === '>' && genericStart >= 0) {
            return true;
        }
    }

    return false;
}

const NUMERIC_TYPES = new Set([
    'number',
    'n',
    'int',
    'int8',
    'int16',
    'int32',
    'int64',
    'uint',
    'uint8',
    'uint16',
    'uint32',
    'uint64',
    'float',
    'float32',
    'float64',
]);

const RADIX_TYPES = new Set([
    'radix',
    'decimal',
    'radix2',
    'radix6',
    'radix8',
    'radix12',
    'radix16',
]);

const ENCODING_TYPES = new Set([
    'encoding',
    'base64',
    'embed',
    'inline',
]);

const SEPARATOR_TYPES = new Set([
    'sep',
    'kadot',
]);

const OBJECT_TYPES = new Set([
    'object',
    'obj',
    'envelope',
    'o',
]);
