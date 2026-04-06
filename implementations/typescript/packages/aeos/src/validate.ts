/**
 * @aeos/core - AEOS™ Validate
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
    const eventsByPath = new Map<string, {
        type: string;
        raw: string;
        value: string;
        datatype?: string;
        span: [number, number] | null;
    }>();
    const containerArity = new Map<string, number>();

    function hydrateIndexedFallback(basePath: string, value: any, fallbackSpan: [number, number] | null): void {
        const isContainer = value?.type === 'TupleLiteral' || value?.type === 'ListLiteral' || value?.type === 'ListNode';
        if (!isContainer || !Array.isArray(value.elements)) return;
        for (let i = 0; i < value.elements.length; i++) {
            const elementPath = `${basePath}[${i}]`;
            if (eventsByPath.has(elementPath)) continue;
            const element = value.elements[i];
            eventsByPath.set(elementPath, {
                type: typeof element?.type === 'string' ? element.type : 'Unknown',
                raw: typeof element?.raw === 'string' ? element.raw : '',
                value: typeof element?.value === 'string' ? element.value : '',
                span: toTuple(element?.span) ?? fallbackSpan,
            });
        }
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
                eventsByPath.set(pathStr, {
                    type: event.value.type,
                    raw: typeof event.value.raw === 'string' ? event.value.raw : '',
                    value: typeof event.value.value === 'string' ? event.value.value : '',
                    ...(typeof event.datatype === 'string' ? { datatype: event.datatype } : {}),
                    span: toTuple(event.span),
                });
                if ((event.value.type === 'TupleLiteral' || event.value.type === 'ListLiteral' || event.value.type === 'ListNode')
                    && Array.isArray((event.value as any).elements)) {
                    containerArity.set(pathStr, (event.value as any).elements.length);
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
    checkTypes(ruleIndex, eventsByPath, ctx);
    checkReferenceForms(schema, ruleIndex, eventsByPath, ctx);

    // Phase 5b: core v1 arity checks for tuple/list containers
    for (const [path, rule] of ruleIndex) {
        const expectedLength = (rule.constraints as any).length_exact;
        if (expectedLength === undefined) continue;
        const actualLength = containerArity.get(path);
        if (actualLength === undefined) continue;
        if (typeof expectedLength === 'number' && actualLength !== expectedLength) {
            const span = eventsByPath.get(path)?.span ?? null;
            emitError(ctx, createDiag(
                path,
                span,
                `Tuple/List arity mismatch: expected ${expectedLength}, got ${actualLength}`,
                ErrorCodes.TUPLE_ARITY_MISMATCH
            ));
        }
    }

    // Phase 6: Numeric form constraints (sign, digit count)
    checkNumericForm(ruleIndex, eventsByPath, ctx);

    // Phase 7: String form constraints (length, pattern)
    checkStringForm(ruleIndex, eventsByPath, ctx);
    checkPatterns(ruleIndex, eventsByPath, ctx);
    checkDatatypeRules(schema.datatype_rules, eventsByPath, ctx);

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

function datatypeBase(datatype: string): string {
    const genericIdx = datatype.indexOf('<');
    const separatorIdx = datatype.indexOf('[');
    const endIdx = [genericIdx, separatorIdx]
        .filter((idx) => idx >= 0)
        .reduce((min, idx) => Math.min(min, idx), datatype.length);
    return datatype.slice(0, endIdx);
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
