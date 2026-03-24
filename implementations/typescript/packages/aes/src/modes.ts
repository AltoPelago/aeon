/**
 * Phase 7 — Mode Enforcement
 * 
 * Enforces:
 * - Transport vs Strict mode typing rules
 * - Switch typing rules (no semantic switch unless typed)
 * - Header correctness
 * 
 * Non-negotiable constraints:
 * - No coercion, ever
 * - No schema execution
 * - No reference resolution
 * - Fail-closed by default
 */

import type { Span } from '@aeon/lexer';
import type { Header, Value, Attribute, ReferencePathSegment } from '@aeon/parser';
import type { AssignmentEvent, AttributeEntry } from './events.js';
import { formatPath } from './paths.js';
import { formatReferenceTargetPath } from './reference-target.js';

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
    | 'UNTYPED_SWITCH_LITERAL'
    | 'DATATYPE_LITERAL_MISMATCH'
    | 'CUSTOM_DATATYPE_NOT_ALLOWED'
    | 'INVALID_NODE_HEAD_DATATYPE'
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
 * Error: Switch literal requires :switch in typed mode
 */
export class UntypedSwitchLiteralError extends ModeEnforcementError {
    constructor(span: Span, path: string) {
        super(
            `Untyped switch literal in typed mode: '${path}' requires ':switch' type annotation`,
            span,
            'UNTYPED_SWITCH_LITERAL',
            path
        );
        this.name = 'UntypedSwitchLiteralError';
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
 * Error: Node head datatype must remain :node in strict mode
 */
export class InvalidNodeHeadDatatypeError extends ModeEnforcementError {
    constructor(span: Span, path: string, datatype: string) {
        super(
            `Invalid node head datatype in strict mode at '${path}': node heads must use ':node', got ':${datatype}'`,
            span,
            'INVALID_NODE_HEAD_DATATYPE',
            path
        );
        this.name = 'InvalidNodeHeadDatatypeError';
    }
}

/**
 * Mode enforcement options
 */
export interface ModeEnforcementOptions {
    /** Enable recovery mode (return events even with errors) */
    readonly recovery?: boolean;
    /** Explicit datatype compatibility override for typed modes */
    readonly datatypePolicy?: DatatypePolicy;
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
export function extractMode(header: Header | null): Mode {
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
 * - Untyped switch literals (yes/no/on/off) require :switch type
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
    const mode = extractMode(header);
    const datatypePolicy = options.datatypePolicy ?? defaultDatatypePolicyForMode(mode);
    const errors: ModeEnforcementError[] = [];
    const pathToIndex = new Map<string, number>();

    for (let i = 0; i < events.length; i++) {
        pathToIndex.set(formatPath(events[i]!.path), i);
    }

    // Header correctness: structured vs shorthand mutual exclusion
    if (header && header.hasStructured && header.hasShorthand) {
        errors.push(new HeaderConflictError(header.span));
    }

    for (const event of events) {
        // Shorthand header metadata is control-plane information, not payload.
        // Structured header payload bindings still follow normal typing rules,
        // except for the mode selector itself so strict mode can be declared.
        if (shouldSkipHeaderEvent(event, header)) {
            continue;
        }

        // Indexed list/tuple element events are synthetic structural nodes.
        // Strict typing is enforced on declared bindings and nested members.
        if (isIndexedElementEvent(event)) {
            continue;
        }

        if (!event.datatype) {
            if (mode === 'strict' || mode === 'custom') {
                if (event.value.type === 'SwitchLiteral') {
                    errors.push(new UntypedSwitchLiteralError(event.span, formatPath(event.path)));
                } else {
                    errors.push(new UntypedValueInStrictModeError(event.span, formatPath(event.path)));
                }
            }
            continue;
        }

        const expectedKinds = expectedKindsForReservedDatatype(event.datatype);
        if ((mode === 'strict' || mode === 'custom') && !expectedKinds && datatypePolicy === 'reserved_only') {
            errors.push(new CustomDatatypeNotAllowedError(event.span, formatPath(event.path), event.datatype));
            continue;
        }
        const actualKind = resolveDatatypeCheckKind(event, events, pathToIndex) ?? event.value.type;
        if (expectedKinds && !expectedKinds.includes(actualKind)) {
            errors.push(new DatatypeLiteralMismatchError(
                event.span,
                formatPath(event.path),
                event.datatype,
                actualKind,
                expectedKinds
            ));
        }
        errors.push(...validateAnnotationEntries(
            event.annotations,
            formatPath(event.path),
            event.span,
            events,
            pathToIndex,
            mode,
            datatypePolicy
        ));
        errors.push(...validateNodeHeadDatatypes(event.value, formatPath(event.path), event.span, mode));
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

function isModeSelectorHeaderEvent(event: AssignmentEvent): boolean {
    return event.path.segments.length === 2
        && event.path.segments[0]?.type === 'root'
        && event.path.segments[1]?.type === 'member'
        && event.path.segments[1].key === 'aeon:mode';
}

function shouldSkipHeaderEvent(event: AssignmentEvent, header: Header | null): boolean {
    if (!header) {
        return false;
    }
    if (header.hasShorthand && isTopLevelHeaderEvent(event)) {
        return true;
    }
    return isModeSelectorHeaderEvent(event);
}

function isTopLevelHeaderEvent(event: AssignmentEvent): boolean {
    return event.path.segments.length === 2
        && event.path.segments[0]?.type === 'root'
        && event.path.segments[1]?.type === 'member'
        && event.path.segments[1].key.startsWith('aeon:');
}

// Legacy export for backward compatibility
export function validateMode(_mode: Mode): readonly ModeEnforcementError[] {
    return [];
}

function isIndexedElementEvent(event: AssignmentEvent): boolean {
    const lastSegment = event.path.segments[event.path.segments.length - 1];
    return lastSegment?.type === 'index';
}

function resolveDatatypeCheckKind(
    event: AssignmentEvent,
    events: readonly AssignmentEvent[],
    pathToIndex: ReadonlyMap<string, number>,
    stack: readonly string[] = []
): string | null {
    const resolved = resolveReferenceValue(event.value, events, pathToIndex);
    if (!resolved) {
        return null;
    }

    if ((resolved.type === 'CloneReference' || resolved.type === 'PointerReference')) {
        const resolution = resolveReferenceTarget(resolved.path, events, pathToIndex);
        if (!resolution || stack.includes(resolution.targetPath)) {
            return resolved.type;
        }
        if (!resolution.event) {
            return resolved.type;
        }
        return resolveDatatypeCheckKind(resolution.event, events, pathToIndex, [...stack, resolution.targetPath]) ?? resolved.type;
    }

    return resolvedValueKind(resolved);
}

function resolvedValueKind(value: Value): string {
    if (value.type === 'StringLiteral') {
        return value.trimticks ? 'TrimtickStringLiteral' : 'StringLiteral';
    }
    if (value.type === 'DateTimeLiteral') {
        return value.raw.includes('&') ? 'ZRUTDateTimeLiteral' : 'DateTimeLiteral';
    }
    if (value.type === 'SeparatorLiteral') {
        return value.raw.startsWith('^ ') ? 'InvalidSeparatorLiteral' : 'SeparatorLiteral';
    }
    if (value.type === 'HexLiteral') {
        return hasValidLiteralUnderscores(value.raw) ? 'HexLiteral' : 'InvalidHexLiteral';
    }
    if (value.type === 'RadixLiteral') {
        return hasValidRadixLiteral(value.raw) ? 'RadixLiteral' : 'InvalidRadixLiteral';
    }
    if (value.type === 'EncodingLiteral') {
        return hasValidEncodingLiteral(value.raw) ? 'EncodingLiteral' : 'InvalidEncodingLiteral';
    }
    return value.type;
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

    for (; index < body.length; index += 1) {
        const c = body[index]!;
        if (isValidRadixDigit(c)) {
            sawDigit = true;
            prevWasDigit = true;
            continue;
        }
        if (c === '_') {
            if (!prevWasDigit || index + 1 >= body.length || !isValidRadixDigit(body[index + 1]!)) return false;
            prevWasDigit = false;
            continue;
        }
        if (c === '.') {
            if (sawDecimal || !prevWasDigit || index + 1 >= body.length || !isValidRadixDigit(body[index + 1]!)) return false;
            sawDecimal = true;
            prevWasDigit = false;
            continue;
        }
        return false;
    }

    return sawDigit && prevWasDigit;
}

function hasValidEncodingLiteral(raw: string): boolean {
    const body = raw.slice(1);
    if (body.length === 0) return false;
    if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(body)) return false;
    const firstPadding = body.indexOf('=');
    if (firstPadding === -1) return true;
    return /^=+$/.test(body.slice(firstPadding));
}

function validateAnnotationEntries(
    annotations: ReadonlyMap<string, AttributeEntry> | undefined,
    ownerPath: string,
    span: Span,
    events: readonly AssignmentEvent[],
    pathToIndex: ReadonlyMap<string, number>,
    mode: Mode,
    datatypePolicy: DatatypePolicy
): readonly ModeEnforcementError[] {
    if (!annotations || annotations.size === 0) {
        return [];
    }

    const errors: ModeEnforcementError[] = [];
    for (const [key, entry] of annotations) {
        const attrPath = `${ownerPath}@${key}`;
        if (entry.datatype) {
            const expectedKinds = expectedKindsForReservedDatatype(entry.datatype);
            if ((mode === 'strict' || mode === 'custom') && !expectedKinds && datatypePolicy === 'reserved_only') {
                errors.push(new CustomDatatypeNotAllowedError(span, attrPath, entry.datatype));
            } else {
                const resolved = resolveReferenceValue(entry.value, events, pathToIndex) ?? entry.value;
                if (expectedKinds && !expectedKinds.includes(resolved.type)) {
                    errors.push(new DatatypeLiteralMismatchError(
                        span,
                        attrPath,
                        entry.datatype,
                        resolved.type,
                        expectedKinds
                    ));
                }
            }
        }
        errors.push(...validateNodeHeadDatatypes(entry.value, attrPath, span, mode));
        errors.push(...validateAnnotationEntries(
            entry.annotations,
            attrPath,
            span,
            events,
            pathToIndex,
            mode,
            datatypePolicy
        ));
    }
    return errors;
}

function validateNodeHeadDatatypes(
    value: Value,
    ownerPath: string,
    span: Span,
    mode: Mode
): readonly ModeEnforcementError[] {
    const errors: ModeEnforcementError[] = [];

    if (value.type === 'NodeLiteral') {
        const headDatatype = value.datatype ? formatTypeAnnotation(value.datatype) : null;
        if (mode === 'strict' && headDatatype && value.datatype!.name.toLowerCase() !== 'node') {
            errors.push(new InvalidNodeHeadDatatypeError(span, ownerPath, headDatatype));
        }
        for (let i = 0; i < value.children.length; i++) {
            errors.push(...validateNodeHeadDatatypes(value.children[i]!, `${ownerPath}[${i}]`, span, mode));
        }
        return errors;
    }

    if (value.type === 'ObjectNode') {
        for (const binding of value.bindings) {
            errors.push(...validateNodeHeadDatatypes(binding.value, `${ownerPath}.${binding.key}`, span, mode));
        }
        return errors;
    }

    if (value.type === 'ListNode' || value.type === 'TupleLiteral') {
        for (let i = 0; i < value.elements.length; i++) {
            errors.push(...validateNodeHeadDatatypes(value.elements[i]!, `${ownerPath}[${i}]`, span, mode));
        }
    }

    return errors;
}

function formatTypeAnnotation(datatype: NonNullable<Extract<Value, { type: 'NodeLiteral' }>['datatype']>): string {
    const generics = datatype.genericArgs.length > 0 ? `<${datatype.genericArgs.join(', ')}>` : '';
    const separators = datatype.separators.map((separator) => `[${separator}]`).join('');
    return `${datatype.name}${generics}${separators}`;
}

type ResolutionContext = {
    readonly value: Value;
    readonly annotations: ReadonlyMap<string, AttributeEntry> | undefined;
};

function isAttrSegment(segment: ReferencePathSegment): segment is Extract<ReferencePathSegment, { readonly type: 'attr' }> {
    return typeof segment === 'object' && segment !== null && segment.type === 'attr';
}

function resolveReferenceValue(
    value: Value,
    events: readonly AssignmentEvent[],
    pathToIndex: ReadonlyMap<string, number>
): Value | null {
    if (value.type !== 'CloneReference' && value.type !== 'PointerReference') {
        return value;
    }

    const resolution = resolveReferenceTarget(value.path, events, pathToIndex);
    if (!resolution) {
        return null;
    }
    return resolveReferenceSubpath(resolution.event, resolution.remainder);
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

        if (resolveReferenceSubpath(event, remainder)) {
            return { targetPath: prefixPath, event, remainder };
        }
    }

    return null;
}

function resolveReferenceSubpath(
    event: AssignmentEvent,
    remainder: readonly ReferencePathSegment[]
): Value | null {
    let context: ResolutionContext = {
        value: event.value,
        annotations: selectAnnotations(event.annotations, event.value),
    };

    for (const segment of remainder) {
        if (isAttrSegment(segment)) {
            const attrEntry = context.annotations?.get(segment.key);
            if (!attrEntry) return null;
            context = {
                value: attrEntry.value,
                annotations: selectAnnotations(attrEntry.annotations, attrEntry.value),
            };
            continue;
        }

        if (typeof segment === 'string') {
            if (context.value.type !== 'ObjectNode') return null;
            const binding = context.value.bindings.find((candidate) => candidate.key === segment);
            if (!binding) return null;
            context = {
                value: binding.value,
                annotations: selectAnnotations(buildAnnotationMap(binding.attributes), binding.value),
            };
            continue;
        }

        if (typeof segment === 'number') {
            if (context.value.type !== 'ListNode' && context.value.type !== 'TupleLiteral') return null;
            const element = context.value.elements[segment];
            if (!element) return null;
            context = {
                value: element,
                annotations: selectAnnotations(undefined, element),
            };
            continue;
        }

        return null;
    }

    return context.value;
}

function selectAnnotations(
    preferred: ReadonlyMap<string, AttributeEntry> | undefined,
    value: Value
): ReadonlyMap<string, AttributeEntry> | undefined {
    if (preferred && preferred.size > 0) return preferred;
    return buildValueAnnotationMap(value);
}

function buildValueAnnotationMap(value: Value): ReadonlyMap<string, AttributeEntry> | undefined {
    if (
        value.type !== 'ObjectNode'
        && value.type !== 'ListNode'
        && value.type !== 'TupleLiteral'
        && value.type !== 'NodeLiteral'
    ) {
        return undefined;
    }
    return buildAnnotationMap(value.attributes);
}

function buildAnnotationMap(attributes: readonly Attribute[]): ReadonlyMap<string, AttributeEntry> | undefined {
    if (!attributes || attributes.length === 0) return undefined;

    const result = new Map<string, AttributeEntry>();
    for (const attribute of attributes) {
        for (const [key, entry] of attribute.entries) {
            const mapped: AttributeEntry = { value: entry.value };
            const nested = buildAnnotationMap(entry.attributes);
            if (nested) {
                (mapped as { annotations: ReadonlyMap<string, AttributeEntry> }).annotations = nested;
            }
            result.set(key, mapped);
        }
    }

    return result;
}

function expectedKindsForReservedDatatype(datatype: string): readonly string[] | null {
    const base = datatypeBase(datatype).toLowerCase();

    // Reserved scalar and container names validated by strict mode.
    // Custom datatypes intentionally remain unconstrained.
    if (NUMERIC_TYPES.has(base)) return ['NumberLiteral'];
    if (base === 'infinity') return ['InfinityLiteral'];
    if (base === 'string') return ['StringLiteral'];
    if (base === 'trimtick') return ['TrimtickStringLiteral'];
    if (base === 'boolean' || base === 'bool') return ['BooleanLiteral'];
    if (base === 'switch') return ['SwitchLiteral'];
    if (base === 'hex') return ['HexLiteral'];
    if (RADIX_TYPES.has(base)) return ['RadixLiteral'];
    if (ENCODING_TYPES.has(base)) return ['EncodingLiteral'];
    if (base === 'date') return ['DateLiteral'];
    if (base === 'time') return ['TimeLiteral'];
    if (base === 'datetime') return ['DateTimeLiteral'];
    if (base === 'zrut') return ['ZRUTDateTimeLiteral'];
    if (SEPARATOR_TYPES.has(base)) return ['SeparatorLiteral'];
    if (base === 'tuple') return ['TupleLiteral'];
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
    'radix2',
    'radix6',
    'radix8',
    'radix12',
]);

const ENCODING_TYPES = new Set([
    'encoding',
    'base64',
    'embed',
    'inline',
]);

const SEPARATOR_TYPES = new Set([
    'sep',
    'set',
]);

const OBJECT_TYPES = new Set([
    'object',
    'obj',
    'envelope',
    'o',
]);
