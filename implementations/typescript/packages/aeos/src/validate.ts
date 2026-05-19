/**
 * @altopelago/aeos-core - AEOS™ Validate
 *
 * Main validation orchestrator for AEOS™ (Another Easy Object Schema).
 */

import type { AES } from './types/aes.js';
import type { SchemaV1 } from './types/schema.js';
import type { ResultEnvelope } from './types/envelope.js';
import { createPassingEnvelope, createFailingEnvelope } from './types/envelope.js';
import { createDiag, createDiagContext, emitError, emitWarning } from './diag/emit.js';
import { ErrorCodes } from './diag/codes.js';
import { spanToTuple } from './types/spans.js';
import { buildRuleIndex } from './rules/schemaIndex.js';
import { checkPresence } from './rules/presence.js';
import { checkTypes } from './rules/typeCheck.js';
import { checkReferenceForms } from './rules/referenceForm.js';
import { checkNumericForm } from './rules/numericForm.js';
import { checkStringForm, checkPatterns } from './rules/stringForm.js';
import type { ConstraintsV1 } from './types/schema.js';

const TYPE_ALIASES: Record<string, readonly string[]> = {
    NumberLiteral: ['NumberLiteral'],
    StringLiteral: ['StringLiteral'],
    BooleanLiteral: ['BooleanLiteral'],
    NullLiteral: ['NullLiteral'],
    ObjectNode: ['ObjectNode'],
    ListNode: ['ListNode'],
    ListLiteral: ['ListNode', 'ListLiteral'],
    TupleLiteral: ['TupleLiteral'],
    ToggleLiteral: ['ToggleLiteral'],
    InfinityLiteral: ['InfinityLiteral'],
    NaNLiteral: ['NaNLiteral'],
    CloneReference: ['CloneReference'],
    PointerReference: ['PointerReference'],
    NodeLiteral: ['NodeLiteral'],
};

type AttributeInfo = {
    type: string;
    raw: string;
    value: string;
    datatype?: string;
    span: [number, number] | null;
    attributes?: ReadonlyMap<string, AttributeInfo>;
};

type EventInfo = {
    type: string;
    raw: string;
    value: string;
    datatype?: string;
    span: [number, number] | null;
    attributes?: ReadonlyMap<string, AttributeInfo>;
    referencePath?: readonly (string | number | { readonly type: 'attr'; readonly key: string })[];
};

function formatQuotedMemberSegment(key: unknown): string {
    return `.[${JSON.stringify(String(key))}]`;
}

/**
 * Validation options
 */
export interface ValidateOptions {
    /**
     * Enable strict mode (reserved for future use).
     */
    readonly strict?: boolean;
    /**
     * Optional policy for separator literal payloads that end with a declared separator.
     * - off (default): ignore trailing delimiter payload
     * - warn: emit warning
     * - error: emit error
     */
    readonly trailingSeparatorDelimiterPolicy?: 'off' | 'warn' | 'error';

}

/**
 * Validate an AES against a schema.
 *
 * This is the main entry point for AEOS validation.
 *
 * AEOS validates representations, not values. It answers:
 * "Is this AES structurally and representationally valid?"
 *
 * AEOS MUST NOT:
 * - Mutate the input AES or schema
 * - Resolve references
 * - Coerce values
 * - Compare numeric magnitudes
 * - Inject defaults
 *
 * @param aes - Assignment Event Stream (readonly)
 * @param schema - AEOS Schema v1 (readonly)
 * @param options - Validation options
 * @returns ResultEnvelope (never contains AES)
 */
export function validate(
    aes: AES,
    schema: SchemaV1,
    options: ValidateOptions = {}
): ResultEnvelope {
    const trailingSeparatorPolicy = options.trailingSeparatorDelimiterPolicy ?? 'off';
    // Phase 0 guardrail: inputs are readonly, we never mutate
    // TypeScript enforces this at compile time via readonly types

    // TODO: Phase 7 - String form constraints
    // Phase 8a: schema-side datatype label allowlist during rule indexing
    // Phase 8b: datatype-wide semantic rules via schema.datatype_rules
    // TODO: Phase 9 - Guarantees

    // Phase 1: Envelope plumbing
    const ctx = createDiagContext();

    // Phase 3: (moved to run after Phase 2)

    // Helpers: format canonical path (local, no runtime AEON deps)
    function formatCanonicalPath(path: any): string {
        if (!path || !Array.isArray(path.segments)) return '$';
        let result = '';
        for (const segment of path.segments) {
            switch (segment.type) {
                case 'root':
                    result = '$';
                    break;
                case 'member':
                    if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(segment.key)) {
                        result += `.${segment.key}`;
                    } else {
                        result += formatQuotedMemberSegment(segment.key);
                    }
                    break;
                case 'index':
                    result += `[${String(segment.index)}]`;
                    break;
                default:
                    break;
            }
        }
        return result;
    }

    function toTuple(span: any): [number, number] | null {
        if (!span) return null;
        if (Array.isArray(span) && span.length === 2 && typeof span[0] === 'number') return span as [number, number];
        if (span.start && span.end && typeof span.start.offset === 'number') return spanToTuple(span);
        return null;
    }

    function decodeSeparatorChars(datatype: string | undefined): string[] {
        if (!datatype) return [];
        const match = datatype.match(/\[([^\]]*)\]$/);
        if (!match) return [];
        const payload = match[1] ?? '';
        if (payload.length === 0) return [];

        const separators: string[] = [];
        let i = 0;
        while (i < payload.length) {
            separators.push(payload[i]!);
            i += 1;
            if (i < payload.length) {
                if (payload[i] !== ',') return [];
                i += 1;
            }
        }
        return separators;
    }

    // Phase 2 — Baseline invariants
    const seen = new Map<string, any>();
    const eventsByPath = new Map<string, EventInfo>();
    const containerArity = new Map<string, number>();

    function hydrateIndexedFallback(basePath: string, value: any, fallbackSpan: [number, number] | null): void {
        const isContainer = value?.type === 'TupleLiteral' || value?.type === 'ListLiteral' || value?.type === 'ListNode' || value?.type === 'NodeLiteral';
        const elements = Array.isArray(value?.elements) ? value.elements : Array.isArray(value?.children) ? value.children : null;
        if (!isContainer || !elements) return;
        for (let i = 0; i < elements.length; i++) {
            const elementPath = `${basePath}[${i}]`;
            if (eventsByPath.has(elementPath)) continue;
            const element = elements[i];
            const attributes = buildAttributeInfoMap(element?.attributes);
            const info: EventInfo = {
                type: typeof element?.type === 'string' ? element.type : 'Unknown',
                raw: typeof element?.raw === 'string' ? element.raw : '',
                value: typeof element?.value === 'string' ? element.value : '',
                span: toTuple(element?.span) ?? fallbackSpan,
                ...(Array.isArray(element?.path) ? { referencePath: element.path as readonly (string | number | { readonly type: 'attr'; readonly key: string })[] } : {}),
                ...(attributes ? { attributes } : {}),
            };
            eventsByPath.set(elementPath, info);
        }
    }

    function buildAttributeInfoMap(attributes: ReadonlyMap<string, unknown> | Record<string, unknown> | undefined): ReadonlyMap<string, AttributeInfo> | undefined {
        const sourceEntries = attributes instanceof Map
            ? Array.from(attributes.entries())
            : attributes && typeof attributes === 'object'
                ? Object.entries(attributes)
                : [];
        if (sourceEntries.length === 0) return undefined;
        const mapped = new Map<string, AttributeInfo>();
        for (const [key, entry] of sourceEntries) {
            const valueNode = (entry as any)?.value;
            const nestedAttributes = buildAttributeInfoMap((entry as any)?.annotations as ReadonlyMap<string, unknown> | Record<string, unknown> | undefined);
            const info: AttributeInfo = {
                type: typeof valueNode?.type === 'string' ? valueNode.type : 'Unknown',
                raw: typeof valueNode?.raw === 'string' ? valueNode.raw : '',
                value: typeof valueNode?.value === 'string' ? valueNode.value : '',
                ...(typeof (entry as any)?.datatype === 'string' ? { datatype: (entry as any).datatype as string } : {}),
                span: toTuple(valueNode?.span),
                ...(nestedAttributes ? { attributes: nestedAttributes } : {}),
            };
            mapped.set(String(key), info);
        }
        return mapped;
    }

    for (let i = 0; i < aes.length; i++) {
        const event = aes[i] as any;
        const pathStr = formatCanonicalPath(event.path);

        if (Array.isArray(event.path?.segments)) {
            for (const seg of event.path.segments) {
                if (seg?.type === 'index') {
                    const idx = seg.index;
                    const validNumeric = typeof idx === 'number' && Number.isInteger(idx) && idx >= 0;
                    if (!validNumeric) {
                        emitError(ctx, createDiag(pathStr, toTuple(event.span), `Invalid index segment format at ${pathStr}`, ErrorCodes.INVALID_INDEX_FORMAT));
                    }
                }
            }
        }

        // Uniqueness
        if (seen.has(pathStr)) {
            const spanTuple = toTuple(event.span);
            const diag = createDiag(pathStr, spanTuple, `Duplicate binding: ${pathStr}`, ErrorCodes.DUPLICATE_BINDING);
            emitError(ctx, diag);
        } else {
            seen.set(pathStr, event.span);
            // Collect event info for Phase 5-7 checks
            if (event.value && typeof event.value.type === 'string') {
                const attributes = buildAttributeInfoMap(event.annotations);
                const info: EventInfo = {
                    type: event.value.type,
                    raw: typeof event.value.raw === 'string' ? event.value.raw : '',
                    value: typeof event.value.value === 'string' ? event.value.value : '',
                    ...(typeof event.datatype === 'string' ? { datatype: event.datatype } : {}),
                    span: toTuple(event.span),
                    ...(Array.isArray(event.value.path) ? { referencePath: event.value.path as readonly (string | number | { readonly type: 'attr'; readonly key: string })[] } : {}),
                    ...(attributes ? { attributes } : {}),
                };
                eventsByPath.set(pathStr, info);
                if ((event.value.type === 'TupleLiteral' || event.value.type === 'ListLiteral' || event.value.type === 'ListNode')
                    && Array.isArray((event.value as any).elements)) {
                    containerArity.set(pathStr, (event.value as any).elements.length);
                    hydrateIndexedFallback(pathStr, event.value, toTuple(event.span));
                } else if (event.value.type === 'ObjectNode' && Array.isArray((event.value as any).bindings)) {
                    containerArity.set(pathStr, (event.value as any).bindings.length);
                } else if (event.value.type === 'NodeLiteral' && Array.isArray((event.value as any).children)) {
                    containerArity.set(pathStr, (event.value as any).children.length);
                    hydrateIndexedFallback(pathStr, event.value, toTuple(event.span));
                }
            }
        }

        // Register index even for first occurrence
    }

    // Optional separator literal trailing-delimiter policy
    if (trailingSeparatorPolicy !== 'off') {
        for (const event of aes as readonly any[]) {
            if (event?.value?.type !== 'SeparatorLiteral') continue;
            const payload = typeof event.value.value === 'string' ? event.value.value : '';
            if (payload.length === 0) continue;

            const separators = decodeSeparatorChars(typeof event.datatype === 'string' ? event.datatype : undefined);
            if (separators.length === 0) continue;

            const lastChar = payload[payload.length - 1]!;
            if (!separators.includes(lastChar)) continue;

            const pathStr = formatCanonicalPath(event.path);
            const diag = createDiag(
                pathStr,
                toTuple(event.span),
                `Separator literal payload ends with declared separator '${lastChar}'`,
                ErrorCodes.TRAILING_SEPARATOR_DELIMITER
            );
            if (trailingSeparatorPolicy === 'warn') emitWarning(ctx, diag);
            else emitError(ctx, diag);
        }
    }

    // Phase 3: Build rule index from schema (run after baseline invariants)
    const ruleIndex = buildRuleIndex(schema, ctx);

    // Phase 4: Presence checks (required fields)
    const boundPaths = new Set(seen.keys());
    checkPresence(ruleIndex, boundPaths, ctx);
    checkWorldPolicy(schema, aes as readonly { key?: string; path?: unknown; span?: unknown }[], boundPaths, ctx);

    // Phase 5: Type checks (literal kind)
    checkReferenceForms(schema, ruleIndex, eventsByPath, ctx);

    const effectiveEventsByPath = resolveReferenceFormEvents(ruleIndex, eventsByPath);
    checkTypes(ruleIndex, effectiveEventsByPath, ctx);

    // Phase 5b: core v1 arity/cardinality checks for tuple/list/node containers
    for (const [path, rule] of ruleIndex) {
        const { length_exact, min_children, max_children } = rule.constraints;
        if (length_exact === undefined && min_children === undefined && max_children === undefined) continue;
        const actualLength = containerArity.get(path);
        if (actualLength === undefined) continue;
        const span = eventsByPath.get(path)?.span ?? null;
        if (typeof length_exact === 'number' && actualLength !== length_exact) {
            emitError(ctx, createDiag(
                path,
                span,
                `Container cardinality mismatch: expected exactly ${length_exact} children, got ${actualLength}`,
                ErrorCodes.TUPLE_ARITY_MISMATCH
            ));
        }
        if (typeof min_children === 'number' && actualLength < min_children) {
            emitError(ctx, createDiag(
                path,
                span,
                `Container cardinality mismatch: expected at least ${min_children} children, got ${actualLength}`,
                ErrorCodes.CONTAINER_CARDINALITY_MISMATCH
            ));
        }
        if (typeof max_children === 'number' && actualLength > max_children) {
            emitError(ctx, createDiag(
                path,
                span,
                `Container cardinality mismatch: expected at most ${max_children} children, got ${actualLength}`,
                ErrorCodes.CONTAINER_CARDINALITY_MISMATCH
            ));
        }
    }

    checkLexicalLiteralConstraints(ruleIndex, effectiveEventsByPath, ctx);

    // Phase 5c: constraints that widen NumberLiteral type acceptance to infinity/NaN
    for (const [path, rule] of ruleIndex) {
        const event = effectiveEventsByPath.get(path);
        if (!event) continue;
        if (event.type === 'InfinityLiteral' && rule.constraints.allow_infinity !== true) {
            continue;
        }
        if (event.type === 'NaNLiteral' && rule.constraints.allow_nan !== true) {
            continue;
        }
        if ((event.type === 'InfinityLiteral' || event.type === 'NaNLiteral')
            && rule.constraints.type !== undefined
            && !isNumericExpectedType(rule.constraints.type)) {
            const span = eventsByPath.get(path)?.span ?? null;
            emitError(ctx, createDiag(
                path,
                span,
                `Type mismatch: expected ${rule.constraints.type}, got ${event.type}`,
                ErrorCodes.TYPE_MISMATCH
            ));
        }
    }

    // Phase 6: Numeric form constraints (sign, digit count)
    checkNumericForm(ruleIndex, effectiveEventsByPath, ctx);

    // Phase 7: String form constraints (length, pattern)
    checkStringForm(ruleIndex, effectiveEventsByPath, ctx);
    checkPatterns(ruleIndex, effectiveEventsByPath, ctx);
    checkAttributeConstraints(ruleIndex, effectiveEventsByPath, schema.datatype_rules, ctx);
    checkDatatypeRules(schema.datatype_rules, effectiveEventsByPath, ctx);

    if (ctx.errors.length > 0) {
        return createFailingEnvelope(ctx.errors, ctx.warnings, {});
    }

    // Phase 9: Guarantees (advisory, non-semantic)
    const guarantees: Record<string, readonly string[]> = {};

    // Helper: add a tag to a path's guarantee list
    function addGuarantee(path: string, tag: string) {
        const existing = guarantees[path];
        const list = existing ? [...existing] : [];
        if (!list.includes(tag)) list.push(tag);
        guarantees[path] = list;
    }

    // Mark presence for all bound paths
    for (const p of Array.from(boundPaths)) {
        addGuarantee(p, 'present');
    }

    // Representation guarantees based on literal forms
    const intRe = /^[+-]?\d+$/;
    const floatRe = /^[+-]?(?:\d+\.\d*|\d*\.\d+|\d+)(?:[eE][+-]?\d+)?$/;

    for (const [path, info] of eventsByPath.entries()) {
        const t = info.type;
        const raw = typeof info.raw === 'string' ? info.raw : '';
        const val = typeof info.value === 'string' ? info.value : '';

        if (t === 'NumberLiteral') {
            if (intRe.test(raw)) addGuarantee(path, 'integer-representable');
            if (floatRe.test(raw)) addGuarantee(path, 'float-representable');
        } else if (t === 'StringLiteral') {
            if (intRe.test(val)) addGuarantee(path, 'integer-representable');
            if (floatRe.test(val)) addGuarantee(path, 'float-representable');
            if (val === 'true' || val === 'false') addGuarantee(path, 'boolean-representable');
            if (val.length > 0) addGuarantee(path, 'non-empty-string');
        } else if (t === 'BooleanLiteral') {
            addGuarantee(path, 'boolean-representable');
        }
    }

    return createPassingEnvelope(guarantees, ctx.warnings);
}

function checkWorldPolicy(
    schema: SchemaV1,
    aes: readonly { key?: string; path?: unknown; span?: unknown }[],
    boundPaths: ReadonlySet<string>,
    ctx: ReturnType<typeof createDiagContext>,
): void {
    if ((schema.world ?? 'open') !== 'closed') return;

    const allowedPaths = schema.rules.map((rule) => rule.path);
    for (const event of aes) {
        const key = typeof event.key === 'string' ? event.key : '';
        if (key.startsWith('aeon:')) continue;
        const path = formatCanonicalPathLocal(event.path);
        if (!boundPaths.has(path)) continue;
        if (allowedPaths.some((allowedPath) => matchesAllowedPath(path, allowedPath))) continue;
        emitError(ctx, createDiag(
            path,
            toTupleLocal(event.span),
            `Binding '${path}' is not allowed by closed-world schema`,
            ErrorCodes.UNEXPECTED_BINDING
        ));
    }
}

function resolveReferenceFormEvents(
    ruleIndex: ReadonlyMap<string, { constraints: ConstraintsV1 }>,
    eventsByPath: ReadonlyMap<string, EventInfo>,
): ReadonlyMap<string, EventInfo> {
    const resolved = new Map(eventsByPath);
    for (const [path, rule] of ruleIndex.entries()) {
        if ((rule.constraints as any).resolve_reference_form !== true) continue;
        const event = eventsByPath.get(path);
        if (!event || !isReferenceType(event.type) || !event.referencePath) continue;
        const terminal = resolveTerminalReferenceEvent(event, eventsByPath, new Set<string>());
        if (!terminal) {
            resolved.delete(path);
            continue;
        }
        resolved.set(path, {
            ...terminal,
            span: event.span,
        });
    }
    return resolved;
}

function resolveTerminalReferenceEvent(
    event: EventInfo,
    eventsByPath: ReadonlyMap<string, EventInfo>,
    activePaths: Set<string>,
): EventInfo | null {
    if (!isReferenceType(event.type) || !event.referencePath) {
        return event;
    }

    const targetPath = formatReferenceLookupPath(event.referencePath);
    if (activePaths.has(targetPath)) {
        return null;
    }
    const target = eventsByPath.get(targetPath);
    if (!target) {
        return null;
    }

    activePaths.add(targetPath);
    const resolved = isReferenceType(target.type)
        ? resolveTerminalReferenceEvent(target, eventsByPath, activePaths)
        : target;
    activePaths.delete(targetPath);
    return resolved;
}

function formatReferenceLookupPath(
    segments: readonly (string | number | { readonly type: 'attr'; readonly key: string })[],
): string {
    if (segments.length === 0) return '$';
    let out = '$';
    for (const segment of segments) {
        if (typeof segment === 'number') {
            out += `[${segment}]`;
            continue;
        }
        if (typeof segment === 'string') {
            out += /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(segment)
                ? `.${segment}`
                : formatQuotedMemberSegment(segment);
            continue;
        }
        out += /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(segment.key)
            ? `@${segment.key}`
            : `@[${JSON.stringify(segment.key)}]`;
    }
    return out;
}

function matchesAllowedPath(actualPath: string, allowedPath: string): boolean {
    if (actualPath === allowedPath) return true;

    // Closed-world schemas may allow list descendants via canonical wildcard paths
    // such as `$.items[*]` or `$.items[*].x`.
    if (!allowedPath.includes('[*]')) return false;

    const escaped = allowedPath
        .split('[*]')
        .map((part) => part.replace(/[|\\{}()[\]^$+?.]/g, '\\$&'))
        .join('\\[\\d+\\]');
    const pattern = `^${escaped}$`;
    return new RegExp(pattern).test(actualPath);
}

function checkDatatypeRules(
    datatypeRules: Readonly<Record<string, ConstraintsV1>> | undefined,
    eventsByPath: ReadonlyMap<string, {
        type: string;
        raw: string;
        value: string;
        datatype?: string;
        span: [number, number] | null;
    }>,
    ctx: ReturnType<typeof createDiagContext>,
): void {
    if (!datatypeRules) return;

    for (const [path, event] of eventsByPath.entries()) {
        if (!event.datatype) continue;
        const constraints = datatypeRules[datatypeBase(event.datatype).toLowerCase()];
        if (!constraints) continue;

        if (constraints.type && !datatypeTypeMatches(event.type, constraints.type, event.raw)) {
            emitError(ctx, createDiag(
                path,
                event.span,
                `Datatype rule mismatch for ':${event.datatype}': expected ${constraints.type}, got ${event.type}`,
                ErrorCodes.TYPE_MISMATCH
            ));
            continue;
        }

        if (event.type !== 'NumberLiteral') continue;

        const raw = event.raw;
        const digitCount = countIntegerDigits(raw);

        if (constraints.sign === 'unsigned' && isNegative(raw)) {
            emitError(ctx, createDiag(
                path,
                event.span,
                `Datatype rule violation for ':${event.datatype}': expected unsigned numeric form`,
                ErrorCodes.NUMERIC_FORM_VIOLATION
            ));
            continue;
        }

        if (constraints.min_digits !== undefined && digitCount < constraints.min_digits) {
            emitError(ctx, createDiag(
                path,
                event.span,
                `Datatype rule violation for ':${event.datatype}': expected min ${constraints.min_digits} digits, got ${digitCount}`,
                ErrorCodes.NUMERIC_FORM_VIOLATION
            ));
            continue;
        }

        if (constraints.max_digits !== undefined && digitCount > constraints.max_digits) {
            emitError(ctx, createDiag(
                path,
                event.span,
                `Datatype rule violation for ':${event.datatype}': expected max ${constraints.max_digits} digits, got ${digitCount}`,
                ErrorCodes.NUMERIC_FORM_VIOLATION
            ));
            continue;
        }

        if (constraints.min_value !== undefined || constraints.max_value !== undefined) {
            const normalized = normalizeIntegerLiteral(raw);
            if (!normalized) {
                emitError(ctx, createDiag(
                    path,
                    event.span,
                    `Datatype rule violation for ':${event.datatype}': exact integer range requires integer literal form`,
                    ErrorCodes.NUMERIC_FORM_VIOLATION
                ));
                continue;
            }

            const numeric = BigInt(normalized);
            if (constraints.min_value !== undefined && numeric < BigInt(constraints.min_value)) {
                emitError(ctx, createDiag(
                    path,
                    event.span,
                    `Datatype rule violation for ':${event.datatype}': expected value >= ${constraints.min_value}, got ${normalized}`,
                    ErrorCodes.NUMERIC_FORM_VIOLATION
                ));
                continue;
            }
            if (constraints.max_value !== undefined && numeric > BigInt(constraints.max_value)) {
                emitError(ctx, createDiag(
                    path,
                    event.span,
                    `Datatype rule violation for ':${event.datatype}': expected value <= ${constraints.max_value}, got ${normalized}`,
                    ErrorCodes.NUMERIC_FORM_VIOLATION
                ));
            }
        }
    }
}

function checkAttributeConstraints(
    ruleIndex: ReadonlyMap<string, { constraints: ConstraintsV1 }>,
    eventsByPath: ReadonlyMap<string, EventInfo>,
    datatypeRules: Readonly<Record<string, ConstraintsV1>> | undefined,
    ctx: ReturnType<typeof createDiagContext>,
): void {
    for (const [path, rule] of ruleIndex) {
        if (!rule.constraints.attributes && rule.constraints.closed_attributes !== true) continue;
        const event = eventsByPath.get(path);
        if (!event) continue;
        validateAttributeMap(path, event.attributes, rule.constraints, datatypeRules, ctx);
    }
}

function validateAttributeMap(
    basePath: string,
    attributes: ReadonlyMap<string, AttributeInfo> | undefined,
    constraints: ConstraintsV1,
    datatypeRules: Readonly<Record<string, ConstraintsV1>> | undefined,
    ctx: ReturnType<typeof createDiagContext>,
): void {
    const requiredAttributes = constraints.attributes ?? {};
    for (const [key, childConstraints] of Object.entries(requiredAttributes)) {
        const childPath = `${basePath}@${key}`;
        const entry = attributes?.get(key);
        if (childConstraints.required === true && !entry) {
            emitError(ctx, createDiag(
                childPath,
                null,
                `Missing required field: ${childPath}`,
                ErrorCodes.MISSING_REQUIRED_FIELD
            ));
            continue;
        }
        if (!entry) continue;
        validateAttributeEntry(childPath, entry, childConstraints, datatypeRules, ctx);
    }

    if (constraints.closed_attributes === true && attributes) {
        const allowed = new Set(Object.keys(requiredAttributes));
        for (const key of attributes.keys()) {
            if (allowed.has(key)) continue;
            const childPath = `${basePath}@${key}`;
            emitError(ctx, createDiag(
                childPath,
                attributes.get(key)?.span ?? null,
                `Attribute '${childPath}' is not allowed by closed attribute constraints`,
                ErrorCodes.UNEXPECTED_ATTRIBUTE_ENTRY
            ));
        }
    }
}

function validateAttributeEntry(
    path: string,
    entry: AttributeInfo,
    constraints: ConstraintsV1,
    datatypeRules: Readonly<Record<string, ConstraintsV1>> | undefined,
    ctx: ReturnType<typeof createDiagContext>,
): void {
    const effectiveConstraints = mergeDatatypeRuleConstraints(constraints, entry.datatype, datatypeRules);
    if (effectiveConstraints.type_is !== undefined) {
        const containerOk = effectiveConstraints.type_is === 'list'
            ? (entry.type === 'ListLiteral' || entry.type === 'ListNode')
            : entry.type === 'TupleLiteral';
        if (!containerOk) {
            emitError(ctx, createDiag(
                path,
                entry.span,
                `Container kind mismatch: expected ${effectiveConstraints.type_is}, got ${entry.type}`,
                ErrorCodes.WRONG_CONTAINER_KIND
            ));
        }
    }

    if (effectiveConstraints.type !== undefined && !constraintTypeMatches(entry.type, effectiveConstraints.type, entry.raw, effectiveConstraints)) {
        emitError(ctx, createDiag(
            path,
            entry.span,
            `Type mismatch: expected ${effectiveConstraints.type}, got ${entry.type}`,
            ErrorCodes.TYPE_MISMATCH
        ));
    }

    checkLexicalLiteralConstraint(path, entry, effectiveConstraints, ctx);

    if (effectiveConstraints.datatype !== undefined && entry.datatype !== effectiveConstraints.datatype) {
        emitError(ctx, createDiag(
            path,
            entry.span,
            `Datatype mismatch: expected ${effectiveConstraints.datatype}, got ${entry.datatype ?? '<none>'}`,
            ErrorCodes.TYPE_MISMATCH
        ));
    }

    if (effectiveConstraints.reference === 'require' && !isReferenceType(entry.type)) {
        emitError(ctx, createDiag(
            path,
            entry.span,
            `Reference required at ${path}, got ${entry.type}`,
            ErrorCodes.REFERENCE_REQUIRED
        ));
    } else if (effectiveConstraints.reference === 'forbid' && isReferenceType(entry.type)) {
        emitError(ctx, createDiag(
            path,
            entry.span,
            `Reference not allowed at ${path}, got ${entry.type}`,
            ErrorCodes.REFERENCE_FORBIDDEN
        ));
    }

    if (effectiveConstraints.reference === 'require' && effectiveConstraints.reference_kind && effectiveConstraints.reference_kind !== 'either') {
        const expectedType = effectiveConstraints.reference_kind === 'clone' ? 'CloneReference' : 'PointerReference';
        if (entry.type !== expectedType) {
            emitError(ctx, createDiag(
                path,
                entry.span,
                `Reference kind mismatch at ${path}: expected ${expectedType}, got ${entry.type}`,
                ErrorCodes.REFERENCE_KIND_MISMATCH
            ));
        }
    }

    if (entry.type === 'NumberLiteral') {
        const digitCount = countIntegerDigits(entry.raw);
        if (effectiveConstraints.sign === 'unsigned' && isNegative(entry.raw)) {
            emitError(ctx, createDiag(
                path,
                entry.span,
                `Numeric form violation: expected unsigned, got negative`,
                ErrorCodes.NUMERIC_FORM_VIOLATION
            ));
        }
        if (effectiveConstraints.min_digits !== undefined && digitCount < effectiveConstraints.min_digits) {
            emitError(ctx, createDiag(
                path,
                entry.span,
                `Numeric form violation: expected min ${effectiveConstraints.min_digits} digits, got ${digitCount}`,
                ErrorCodes.NUMERIC_FORM_VIOLATION
            ));
        }
        if (effectiveConstraints.max_digits !== undefined && digitCount > effectiveConstraints.max_digits) {
            emitError(ctx, createDiag(
                path,
                entry.span,
                `Numeric form violation: expected max ${effectiveConstraints.max_digits} digits, got ${digitCount}`,
                ErrorCodes.NUMERIC_FORM_VIOLATION
            ));
        }
    }

    if (entry.type === 'StringLiteral') {
        if (effectiveConstraints.min_length !== undefined && entry.value.length < effectiveConstraints.min_length) {
            emitError(ctx, createDiag(
                path,
                entry.span,
                `String length violation: expected min length ${effectiveConstraints.min_length}, got ${entry.value.length}`,
                ErrorCodes.STRING_LENGTH_VIOLATION
            ));
        }
        if (effectiveConstraints.max_length !== undefined && entry.value.length > effectiveConstraints.max_length) {
            emitError(ctx, createDiag(
                path,
                entry.span,
                `String length violation: expected max length ${effectiveConstraints.max_length}, got ${entry.value.length}`,
                ErrorCodes.STRING_LENGTH_VIOLATION
            ));
        }
        if (effectiveConstraints.pattern !== undefined && !(new RegExp(effectiveConstraints.pattern).test(entry.value))) {
            emitError(ctx, createDiag(
                path,
                entry.span,
                `Pattern mismatch: value does not match ${effectiveConstraints.pattern}`,
                ErrorCodes.PATTERN_MISMATCH
            ));
        }
    }

    if (effectiveConstraints.attributes || effectiveConstraints.closed_attributes === true) {
        validateAttributeMap(path, entry.attributes, effectiveConstraints, datatypeRules, ctx);
    }
}

function datatypeBase(datatype: string): string {
    const genericIdx = datatype.indexOf('<');
    const separatorIdx = datatype.indexOf('[');
    const endIdx = [genericIdx, separatorIdx]
        .filter((idx) => idx >= 0)
        .reduce((min, idx) => Math.min(min, idx), datatype.length);
    return datatype.slice(0, endIdx);
}

function mergeDatatypeRuleConstraints(
    constraints: ConstraintsV1,
    datatype: string | undefined,
    datatypeRules: Readonly<Record<string, ConstraintsV1>> | undefined,
): ConstraintsV1 {
    if (!datatype || !datatypeRules) return constraints;
    const datatypeRule = datatypeRules[datatypeBase(datatype).toLowerCase()];
    if (!datatypeRule) return constraints;
    return { ...datatypeRule, ...constraints };
}

function constraintTypeMatches(actualType: string, expectedType: string, raw: string, constraints?: ConstraintsV1): boolean {
    if (constraints?.nullable === true && actualType === 'NullLiteral') return true;
    if (constraints?.allow_infinity === true && actualType === 'InfinityLiteral' && isNumericExpectedType(expectedType)) return true;
    if (constraints?.allow_nan === true && actualType === 'NaNLiteral' && isNumericExpectedType(expectedType)) return true;
    if (actualType === expectedType) return true;
    if (actualType === 'NumberLiteral') {
        if (expectedType === 'IntegerLiteral') return /^[+-]?\d[\d_]*$/.test(raw);
        if (expectedType === 'FloatLiteral') return /^[+-]?(?:\d[\d_]*\.\d[\d_]*|\d[\d_]*\.|\.\d[\d_]*|\d[\d_]*[eE][+-]?\d[\d_]*)$/.test(raw);
    }
    const satisfies = TYPE_ALIASES[actualType];
    return Boolean(satisfies?.includes(expectedType));
}

function isNumericExpectedType(expectedType: string): boolean {
    return expectedType === 'NumberLiteral' || expectedType === 'IntegerLiteral' || expectedType === 'FloatLiteral';
}

function checkLexicalLiteralConstraints(
    ruleIndex: ReadonlyMap<string, { readonly constraints: ConstraintsV1 }>,
    events: ReadonlyMap<string, EventInfo>,
    ctx: ReturnType<typeof createDiagContext>,
): void {
    for (const [path, rule] of ruleIndex) {
        const event = events.get(path);
        if (!event) continue;
        checkLexicalLiteralConstraint(path, event, rule.constraints, ctx);
    }
}

function checkLexicalLiteralConstraint(
    path: string,
    event: Pick<EventInfo, 'type' | 'raw' | 'value' | 'span'>,
    constraints: ConstraintsV1,
    ctx: ReturnType<typeof createDiagContext>,
): void {
    if (event.type === 'NullLiteral' && constraints.null_value !== undefined && event.value !== constraints.null_value) {
        emitError(ctx, createDiag(
            path,
            event.span,
            `Null value mismatch: expected ${constraints.null_value}, got ${event.value || '<none>'}`,
            ErrorCodes.NULL_VALUE_MISMATCH
        ));
    }

    if (event.type === 'ToggleLiteral' && constraints.toggle_pair !== undefined && constraints.toggle_pair !== 'any') {
        const value = (event.raw || event.value).toLowerCase();
        const allowed = constraints.toggle_pair === 'yes_no'
            ? ['yes', 'no']
            : constraints.toggle_pair === 'on_off'
                ? ['on', 'off']
                : [];
        if (allowed.length > 0 && !allowed.includes(value)) {
            emitError(ctx, createDiag(
                path,
                event.span,
                `Toggle pair mismatch: expected ${constraints.toggle_pair}, got ${value || '<none>'}`,
                ErrorCodes.TOGGLE_PAIR_MISMATCH
            ));
        }
    }
}

function isReferenceType(type: string): boolean {
    return type === 'CloneReference' || type === 'PointerReference';
}

function datatypeTypeMatches(actualType: string, expectedType: string, raw: string): boolean {
    if (actualType === expectedType) return true;
    if (actualType === 'NumberLiteral') {
        if (expectedType === 'IntegerLiteral') {
            return /^[+-]?\d[\d_]*$/.test(raw);
        }
        if (expectedType === 'FloatLiteral') {
            return /^[+-]?(?:\d[\d_]*\.\d[\d_]*|\d[\d_]*\.|\.\d[\d_]*|\d[\d_]*[eE][+-]?\d[\d_]*)$/.test(raw);
        }
    }
    if (actualType === 'NumberLiteral' && expectedType === 'NumberLiteral') return true;
    return false;
}

function normalizeIntegerLiteral(raw: string): string | null {
    if (!/^[+-]?\d[\d_]*$/.test(raw)) return null;
    return raw.replace(/_/g, '');
}

function countIntegerDigits(raw: string): number {
    return raw.replace(/^[+-]/, '').replace(/_/g, '').split('.')[0]?.length ?? 0;
}

function isNegative(raw: string): boolean {
    return raw.startsWith('-');
}

function formatCanonicalPathLocal(path: any): string {
    if (!path || !Array.isArray(path.segments)) return '$';
    let result = '';
    for (const segment of path.segments) {
        switch (segment.type) {
            case 'root':
                result = '$';
                break;
            case 'member':
                if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(segment.key)) {
                    result += `.${segment.key}`;
                } else {
                    result += formatQuotedMemberSegment(segment.key);
                }
                break;
            case 'index':
                result += `[${String(segment.index)}]`;
                break;
            default:
                break;
        }
    }
    return result;
}

function toTupleLocal(span: any): [number, number] | null {
    if (!span) return null;
    if (Array.isArray(span) && span.length === 2 && typeof span[0] === 'number') return span as [number, number];
    if (span.start && span.end && typeof span.start.offset === 'number') return spanToTuple(span);
    return null;
}
