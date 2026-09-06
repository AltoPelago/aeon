/**
 * @altopelago/aeos-core - AEOS™ Validate
 *
 * Main validation orchestrator for AEOS™ (Another Easy Object Schema).
 */

import type { AES, PortableAesBodyEvent } from './types/aes.js';
import type { SchemaRule, SchemaV1 } from './types/schema.js';
import type { ResultEnvelope } from './types/envelope.js';
import { createPassingEnvelope, createFailingEnvelope } from './types/envelope.js';
import { createDiag, createDiagContext, emitError, emitWarning } from './diag/emit.js';
import { ErrorCodes } from './diag/codes.js';
import { spanToTuple } from './types/spans.js';
import { buildRuleIndex, type RuleIndex } from './rules/schemaIndex.js';
import { checkPresence } from './rules/presence.js';
import { checkTypes } from './rules/typeCheck.js';
import { checkReferenceForms } from './rules/referenceForm.js';
import { checkNumericForm } from './rules/numericForm.js';
import { checkStringForm, checkPatterns, matchesPortablePattern } from './rules/stringForm.js';
import { datatypeBase, declaredRadixFromDatatype, parseClarifierValues } from './util/datatypes.js';
import type { ConstraintsV1, ResourcePolicyV1 } from './types/schema.js';
import {
    parseAddress,
    resolveAddress,
    type SansaResolveNamespace,
} from '@altopelago/sansa';
import {
    formatDatatypeDescriptor,
    type AesDatatypeDescriptor,
    type AesNumberLiteral,
    type AesStringLiteral,
    type TelexRecord,
} from '@altopelago/aeon-aes';

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
    HexLiteral: ['HexLiteral'],
    RadixLiteral: ['RadixLiteral'],
    EncodingLiteral: ['EncodingLiteral'],
    SeparatorLiteral: ['SeparatorLiteral'],
    SansaAddressLiteral: ['SansaAddressLiteral'],
    DateLiteral: ['DateLiteral'],
    TimeLiteral: ['TimeLiteral'],
    DateTimeLiteral: ['DateTimeLiteral'],
    WTCDateTimeLiteral: ['WTCDateTimeLiteral'],
    CloneReference: ['CloneReference'],
    PointerReference: ['PointerReference'],
    NodeLiteral: ['NodeLiteral'],
    NodeHead: ['NodeHead'],
};

type AttributeInfo = {
    identity?: string;
    type: string;
    raw: string;
    value: string;
    datatype?: string;
    span: [number, number] | null;
    attributes?: ReadonlyMap<string, AttributeInfo>;
};

type EventInfo = {
    identity?: string;
    type: string;
    raw: string;
    value: string;
    datatype?: string;
    span: [number, number] | null;
    attributes?: ReadonlyMap<string, AttributeInfo>;
    referencePath?: readonly (string | number | { readonly type: 'attr'; readonly key: string })[];
};

type AeosSansaResolveBinding = {
    path: string;
    identity?: string;
    name?: string;
    index?: number;
    info?: EventInfo;
    children: AeosSansaResolveBinding[];
    attributeSpace?: AeosSansaResolveBinding;
};

function formatQuotedMemberSegment(key: unknown): string {
    return `.[${JSON.stringify(String(key))}]`;
}

function formatMemberSelector(key: unknown): string {
    const value = String(key);
    return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)
        ? `.${value}`
        : formatQuotedMemberSegment(value);
}

function appendAttributePath(basePath: string, key: string): string {
    return `${basePath}.@${formatMemberSelector(key)}`;
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

    /** Optional consumer-controlled validation resource limits. */
    readonly resourcePolicy?: ResourcePolicyV1;

}

const DEFAULT_RESOURCE_POLICY: Required<ResourcePolicyV1> = {
    max_events: 100_000,
    max_rules: 10_000,
    max_any_of_cases: 64,
    max_schema_depth: 64,
    max_path_length: 4_096,
    max_reference_resolution_steps: 64,
    max_selector_expansions: 100_000,
    max_string_length_default: 10_000_000,
    max_container_children_default: 1_000_000,
};

function normalizeResourcePolicy(
    policy: ResourcePolicyV1 | undefined,
    source: string,
    ctx: ReturnType<typeof createDiagContext>
): Partial<Required<ResourcePolicyV1>> {
    if (policy === undefined) return {};
    if (policy === null || typeof policy !== 'object') {
        emitResourceError(ctx, '$', `${source} resource policy must be an object`);
        return {};
    }
    const normalized: Record<string, number> = {};
    for (const key of Object.keys(policy) as (keyof ResourcePolicyV1)[]) {
        if (!(key in DEFAULT_RESOURCE_POLICY)) {
            emitResourceError(ctx, '$', `Unknown ${source} resource policy key: ${String(key)}`);
            continue;
        }
        const value = policy[key];
        if (value !== undefined && (typeof value !== 'number' || !Number.isInteger(value) || value < 0)) {
            emitResourceError(ctx, '$', `${source} resource policy ${String(key)} must be a non-negative integer`);
            continue;
        }
        if (value !== undefined) {
            normalized[key] = value;
        }
    }
    return normalized as Partial<Required<ResourcePolicyV1>>;
}

function resolveResourcePolicy(
    schemaPolicy: ResourcePolicyV1 | undefined,
    optionPolicy: ResourcePolicyV1 | undefined,
    ctx: ReturnType<typeof createDiagContext>
): Required<ResourcePolicyV1> {
    return {
        ...DEFAULT_RESOURCE_POLICY,
        ...normalizeResourcePolicy(schemaPolicy, 'schema', ctx),
        ...normalizeResourcePolicy(optionPolicy, 'option', ctx),
    };
}

function emitResourceError(
    ctx: ReturnType<typeof createDiagContext>,
    path: string,
    message: string,
    span: [number, number] | null = null,
): void {
    emitError(ctx, createDiag(path, span, message, ErrorCodes.INVALID_SCHEMA_POLICY));
}

const STRING_LIKE_VALUE_TYPES = new Set([
    'StringLiteral',
    'TrimtickLiteral',
    'SeparatorLiteral',
    'SansaAddressLiteral',
    'HexLiteral',
    'EncodingLiteral',
    'NullLiteral',
    'DateLiteral',
    'TimeLiteral',
    'DateTimeLiteral',
    'WTCDateTimeLiteral',
]);

function stringLikePayloadLength(event: Pick<EventInfo, 'type' | 'raw' | 'value'>): number | null {
    if (!STRING_LIKE_VALUE_TYPES.has(event.type)) return null;
    const payload = event.value.length > 0 ? event.value : event.raw;
    return payload.length;
}

function enforceStringLengthResourceBudget(
    info: EventInfo | AttributeInfo,
    path: string,
    policy: Required<ResourcePolicyV1>,
    ctx: ReturnType<typeof createDiagContext>
): void {
    const payloadLength = stringLikePayloadLength(info);
    if (payloadLength !== null && payloadLength > policy.max_string_length_default) {
        emitResourceError(ctx, path, `String-like payload length ${payloadLength} exceeds max_string_length_default ${policy.max_string_length_default}`, info.span);
    }
    for (const [key, attribute] of info.attributes ?? []) {
        enforceStringLengthResourceBudget(attribute, appendAttributePath(path, key), policy, ctx);
    }
}

function inspectSchemaResourceShape(
    schema: SchemaV1,
    policy: Required<ResourcePolicyV1>,
    ctx: ReturnType<typeof createDiagContext>
): void {
    for (const rule of schema.rules) {
        const rulePath = typeof rule.path === 'string' && rule.path.length > 0
            ? rule.path
            : typeof rule.selector === 'string' && rule.selector.length > 0
                ? rule.selector
                : '$';
        if (rulePath.length > policy.max_path_length) {
            emitResourceError(ctx, rulePath, `Rule path length ${rulePath.length} exceeds max_path_length ${policy.max_path_length}`);
        }
        inspectConstraintResourceShape(rule.constraints, rulePath, 1, policy, ctx);
    }
    for (const [datatype, constraints] of Object.entries(schema.datatype_rules ?? {})) {
        inspectConstraintResourceShape(constraints, `datatype_rules.${datatype}`, 1, policy, ctx);
    }
}

function inspectConstraintResourceShape(
    constraints: ConstraintsV1,
    path: string,
    depth: number,
    policy: Required<ResourcePolicyV1>,
    ctx: ReturnType<typeof createDiagContext>
): void {
    if (depth > policy.max_schema_depth) {
        emitResourceError(ctx, path, `Schema constraint depth exceeds max_schema_depth ${policy.max_schema_depth}`);
        return;
    }
    if (constraints.any_of !== undefined) {
        if (constraints.any_of.length > policy.max_any_of_cases) {
            emitResourceError(ctx, path, `any_of case count ${constraints.any_of.length} exceeds max_any_of_cases ${policy.max_any_of_cases}`);
        }
        constraints.any_of.forEach((branch, index) => {
            inspectConstraintResourceShape(branch, `${path}.any_of[${index}]`, depth + 1, policy, ctx);
        });
    }
    if (constraints.attributes !== undefined) {
        for (const [key, child] of Object.entries(constraints.attributes)) {
            inspectConstraintResourceShape(child, appendAttributePath(path, key), depth + 1, policy, ctx);
        }
    }
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
    const resourcePolicy = resolveResourcePolicy(schema.resource_policy, options.resourcePolicy, ctx);
    if (ctx.errors.length > 0) {
        return createFailingEnvelope(ctx.errors, ctx.warnings, {});
    }
    if (aes.length > resourcePolicy.max_events) {
        emitResourceError(ctx, '$', `AES event count ${aes.length} exceeds max_events ${resourcePolicy.max_events}`);
    }
    if (schema.rules.length > resourcePolicy.max_rules) {
        emitResourceError(ctx, '$', `Schema rule count ${schema.rules.length} exceeds max_rules ${resourcePolicy.max_rules}`);
    }
    inspectSchemaResourceShape(schema, resourcePolicy, ctx);
    if (ctx.errors.length > 0) {
        return createFailingEnvelope(ctx.errors, ctx.warnings, {});
    }

    // Phase 3: (moved to run after Phase 2)

    // Helpers: format canonical path (local, no runtime AEON deps)
    function formatCanonicalPath(path: any): string {
        if (typeof path === 'string') return path;
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
        if (typeof span === 'string') {
            const match = span.match(/^(0|[1-9][0-9]*):(0|[1-9][0-9]*)$/u);
            return match === null ? null : [Number(match[1]), Number(match[2])];
        }
        if (Array.isArray(span) && span.length === 2 && typeof span[0] === 'number') return span as [number, number];
        if (span.start && span.end && typeof span.start.offset === 'number') return spanToTuple(span);
        return null;
    }

    function decodeSeparatorChars(datatype: string | undefined): string[] {
        if (!datatype) return [];
        if (datatypeBase(datatype).toLowerCase() !== 'sep') return [];
        return parseClarifierValues(datatype).filter((value): value is string => typeof value === 'string');
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
                ...(typeof element?.structuralId === 'string' ? { identity: element.structuralId } : {}),
                type: typeof element?.type === 'string' ? element.type : 'Unknown',
                raw: typeof element?.raw === 'string' ? element.raw : '',
                value: typeof element?.value === 'string' ? element.value : '',
                span: toTuple(element?.span) ?? fallbackSpan,
                ...(Array.isArray(element?.path) ? { referencePath: element.path as readonly (string | number | { readonly type: 'attr'; readonly key: string })[] } : {}),
                ...(attributes ? { attributes } : {}),
            };
            eventsByPath.set(elementPath, info);
            addAttributeEvents(elementPath, attributes);
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
                ...(typeof (entry as any)?.structuralId === 'string' ? { identity: (entry as any).structuralId as string } : {}),
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

    function addAttributeEvents(basePath: string, attributes: ReadonlyMap<string, AttributeInfo> | undefined): void {
        if (!attributes) return;
        for (const [key, attribute] of attributes.entries()) {
            const attributePath = appendAttributePath(basePath, key);
            eventsByPath.set(attributePath, {
                ...(attribute.identity !== undefined ? { identity: attribute.identity } : {}),
                type: attribute.type,
                raw: attribute.raw,
                value: attribute.value,
                ...(attribute.datatype !== undefined ? { datatype: attribute.datatype } : {}),
                span: attribute.span,
                ...(attribute.attributes ? { attributes: attribute.attributes } : {}),
            });
            addAttributeEvents(attributePath, attribute.attributes);
        }
    }

    for (let i = 0; i < aes.length; i++) {
        const event = aes[i] as any;
        const pathStr = formatCanonicalPath(event.path);
        const portable = isPortableTelexRecord(event);
        if (pathStr.length > resourcePolicy.max_path_length) {
            emitResourceError(ctx, pathStr, `Path length ${pathStr.length} exceeds max_path_length ${resourcePolicy.max_path_length}`, toTuple(event.span));
        }

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
            if (portable) {
                const value = typeof event.value === 'string' ? event.value : '';
                const datatype = portableDatatype(event);
                const info: EventInfo = {
                    ...(typeof event.identity === 'string' ? { identity: event.identity } : {}),
                    type: event.kind,
                    raw: value,
                    value,
                    ...(datatype !== undefined ? { datatype } : {}),
                    span: toTuple(event.span),
                    ...((event.kind === 'CloneReference' || event.kind === 'PointerReference')
                        && typeof event.value === 'string'
                        ? { referencePath: parsePortableReferencePath(event.value) }
                        : {}),
                };
                eventsByPath.set(pathStr, info);
            } else if (event.value && typeof event.value.type === 'string') {
                const attributes = buildAttributeInfoMap(event.annotations);
                const info: EventInfo = {
                    ...(typeof event.structuralId === 'string' ? { identity: event.structuralId } : {}),
                    type: event.value.type,
                    raw: typeof event.value.raw === 'string' ? event.value.raw : '',
                    value: typeof event.value.value === 'string' ? event.value.value : '',
                    ...(typeof event.datatype === 'string' ? { datatype: event.datatype } : {}),
                    span: toTuple(event.span),
                    ...(Array.isArray(event.value.path) ? { referencePath: event.value.path as readonly (string | number | { readonly type: 'attr'; readonly key: string })[] } : {}),
                    ...(attributes ? { attributes } : {}),
                };
                eventsByPath.set(pathStr, info);
                addAttributeEvents(pathStr, attributes);
                if ((event.value.type === 'TupleLiteral' || event.value.type === 'ListLiteral' || event.value.type === 'ListNode')
                    && Array.isArray((event.value as any).elements)) {
                    containerArity.set(pathStr, (event.value as any).elements.length);
                    if ((event.value as any).elements.length > resourcePolicy.max_container_children_default) {
                        emitResourceError(ctx, pathStr, `Container child count ${(event.value as any).elements.length} exceeds max_container_children_default ${resourcePolicy.max_container_children_default}`, toTuple(event.span));
                    }
                    hydrateIndexedFallback(pathStr, event.value, toTuple(event.span));
                } else if (event.value.type === 'ObjectNode' && Array.isArray((event.value as any).bindings)) {
                    containerArity.set(pathStr, (event.value as any).bindings.length);
                    if ((event.value as any).bindings.length > resourcePolicy.max_container_children_default) {
                        emitResourceError(ctx, pathStr, `Container child count ${(event.value as any).bindings.length} exceeds max_container_children_default ${resourcePolicy.max_container_children_default}`, toTuple(event.span));
                    }
                } else if (event.value.type === 'NodeLiteral' && Array.isArray((event.value as any).children)) {
                    containerArity.set(pathStr, (event.value as any).children.length);
                    if ((event.value as any).children.length > resourcePolicy.max_container_children_default) {
                        emitResourceError(ctx, pathStr, `Container child count ${(event.value as any).children.length} exceeds max_container_children_default ${resourcePolicy.max_container_children_default}`, toTuple(event.span));
                    }
                    hydrateIndexedFallback(pathStr, event.value, toTuple(event.span));
                }
            }
        }

        // Register index even for first occurrence
    }
    hydratePortableAttributes(eventsByPath, aes);
    hydratePortableContainerArities(aes, containerArity, resourcePolicy, ctx, toTuple);
    for (const [path, info] of eventsByPath) {
        enforceStringLengthResourceBudget(info, path, resourcePolicy, ctx);
    }

    // Optional separator literal trailing-delimiter policy
    if (trailingSeparatorPolicy !== 'off') {
        for (const event of aes as readonly any[]) {
            const portable = isPortableTelexRecord(event);
            const kind = portable ? event.kind : event?.value?.type;
            if (kind !== 'SeparatorLiteral') continue;
            const payload = portable
                ? (typeof event.value === 'string' ? event.value : '')
                : (typeof event.value.value === 'string' ? event.value.value : '');
            if (payload.length === 0) continue;

            const separators = decodeSeparatorChars(portable
                ? portableDatatype(event)
                : (typeof event.datatype === 'string' ? event.datatype : undefined));
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
    const selectorExpansionBudget = { count: 0 };
    const expandedRuleIndex = expandSelectorRules(ruleIndex, schema, eventsByPath, ctx, resourcePolicy, selectorExpansionBudget);
    const effectiveRuleIndex = mergeDatatypeRules(expandedRuleIndex, schema.datatype_rules, eventsByPath);

    // Phase 4: Presence checks (required fields)
    const boundPaths = new Set(eventsByPath.keys());
    checkPresence(effectiveRuleIndex, boundPaths, ctx);
    checkWorldPolicy(schema, aes as readonly { key?: string; path?: unknown; span?: unknown }[], boundPaths, eventsByPath, ctx);

    // Phase 5: Type checks (literal kind)
    checkReferenceForms(schema, effectiveRuleIndex, eventsByPath, ctx);

    const effectiveEventsByPath = resolveReferenceFormEvents(effectiveRuleIndex, eventsByPath, resourcePolicy, ctx);
    const selectedRuleIndex = selectAnyOfRules(effectiveRuleIndex, effectiveEventsByPath, ctx);
    checkTypes(selectedRuleIndex, effectiveEventsByPath, ctx);

    // Phase 5b: core v1 arity/cardinality checks for tuple/list/node containers
    for (const [path, rule] of selectedRuleIndex) {
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

    checkLexicalLiteralConstraints(selectedRuleIndex, effectiveEventsByPath, ctx);

    // Phase 5c: constraints that widen NumberLiteral type acceptance to infinity/NaN
    for (const [path, rule] of selectedRuleIndex) {
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
    checkNumericForm(selectedRuleIndex, effectiveEventsByPath, ctx);

    // Phase 7: String form constraints (length, pattern)
    checkStringForm(selectedRuleIndex, effectiveEventsByPath, ctx);
    checkPatterns(selectedRuleIndex, effectiveEventsByPath, ctx);
    checkAttributePolicy(schema, selectedRuleIndex, effectiveEventsByPath, ctx);
    checkAttributeConstraints(selectedRuleIndex, effectiveEventsByPath, schema.datatype_rules, ctx);
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
    eventsByPath: ReadonlyMap<string, EventInfo>,
    ctx: ReturnType<typeof createDiagContext>,
): void {
    if ((schema.world ?? 'open') !== 'closed') return;

    const allowedRules = schema.rules
        .map((rule) => typeof rule.path === 'string' && rule.path.length > 0
            ? { kind: 'path' as const, value: rule.path }
            : typeof rule.selector === 'string' && rule.selector.length > 0
                ? { kind: 'selector' as const, value: rule.selector }
                : null)
        .filter((rule): rule is { kind: 'path' | 'selector'; value: string } => rule !== null);
    const selectorMatches = new Map<string, ReadonlySet<string> | null>();
    for (const rule of allowedRules) {
        if (rule.kind !== 'selector' || selectorMatches.has(rule.value)) continue;
        selectorMatches.set(rule.value, resolveSansaSelectorPathSet(rule.value, eventsByPath, ctx));
    }
    for (const event of aes) {
        const key = typeof event.key === 'string' ? event.key : '';
        if (key.startsWith('aeon:')) continue;
        const path = formatCanonicalPathLocal(event.path);
        if (!boundPaths.has(path)) continue;
        if (allowedRules.some((rule) => rule.kind === 'selector'
            ? selectorMatches.get(rule.value)?.has(path) === true
            : matchesAllowedPath(path, rule.value))) continue;
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
    resourcePolicy: Required<ResourcePolicyV1>,
    ctx: ReturnType<typeof createDiagContext>,
): ReadonlyMap<string, EventInfo> {
    const resolved = new Map(eventsByPath);
    for (const [path, rule] of ruleIndex.entries()) {
        if ((rule.constraints as any).resolve_reference_form !== true) continue;
        const event = eventsByPath.get(path);
        if (!event || !isReferenceType(event.type) || !event.referencePath) continue;
        const resolutionState = { exhausted: false };
        const terminal = resolveTerminalReferenceEvent(event, eventsByPath, new Set<string>(), resourcePolicy.max_reference_resolution_steps, resolutionState);
        if (!terminal) {
            if (resolutionState.exhausted) {
                emitResourceError(ctx, path, `Reference resolution exceeded max_reference_resolution_steps ${resourcePolicy.max_reference_resolution_steps}`, event.span);
            }
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

function expandSelectorRules(
    ruleIndex: RuleIndex,
    schema: SchemaV1,
    eventsByPath: ReadonlyMap<string, EventInfo>,
    ctx: ReturnType<typeof createDiagContext>,
    resourcePolicy: Required<ResourcePolicyV1>,
    expansionBudget: { count: number },
): RuleIndex {
    const expanded = new Map(ruleIndex);
    for (const rule of schema.rules) {
        if (typeof rule.selector !== 'string' || rule.selector.length === 0) continue;
        if (typeof rule.path === 'string' && rule.path.length > 0) continue;
        const resolvedPaths = resolveSansaSelectorPathSet(rule.selector, eventsByPath, ctx);
        if (resolvedPaths === null) continue;
        let matched = false;
        for (const actualPath of resolvedPaths) {
            matched = true;
            expansionBudget.count += 1;
            if (expansionBudget.count > resourcePolicy.max_selector_expansions) {
                emitResourceError(ctx, rule.selector, `Selector expansion count exceeds max_selector_expansions ${resourcePolicy.max_selector_expansions}`);
                return expanded;
            }
            if (!expanded.has(actualPath)) {
                expanded.set(actualPath, { ...rule, path: actualPath });
            }
        }
        if (!matched && rule.constraints.required === true) {
            emitError(ctx, createDiag(
                rule.selector,
                null,
                `Missing required field: ${rule.selector}`,
                ErrorCodes.MISSING_REQUIRED_FIELD
            ));
        }
    }
    return expanded;
}

function selectAnyOfRules(
    ruleIndex: RuleIndex,
    eventsByPath: ReadonlyMap<string, EventInfo>,
    ctx: ReturnType<typeof createDiagContext>,
): RuleIndex {
    const selected = new Map(ruleIndex);
    for (const [path, rule] of ruleIndex.entries()) {
        if (!Array.isArray(rule.constraints.any_of)) continue;
        const event = eventsByPath.get(path);
        if (!event) continue;
        const outer = withoutAnyOf(rule.constraints);
        const branch = rule.constraints.any_of.find((candidate) => constraintBranchMatchesEvent(candidate, event));
        if (!branch) {
            emitError(ctx, createDiag(
                path,
                event.span,
                `Value does not match any allowed constraint branch at ${path}`,
                ErrorCodes.TYPE_MISMATCH
            ));
            selected.set(path, { ...rule, constraints: outer });
            continue;
        }
        selected.set(path, { ...rule, constraints: { ...outer, ...branch } });
    }
    return selected;
}

function withoutAnyOf(constraints: ConstraintsV1): ConstraintsV1 {
    const { any_of: _anyOf, ...rest } = constraints;
    return rest;
}

function patternMatches(pattern: string | undefined, value: string): boolean {
    return matchesPortablePattern(pattern, value);
}

function constraintBranchMatchesEvent(
    constraints: ConstraintsV1,
    event: EventInfo,
): boolean {
    if (constraints.type_is !== undefined) {
        const containerOk = constraints.type_is === 'list'
            ? (event.type === 'ListLiteral' || event.type === 'ListNode')
            : event.type === 'TupleLiteral';
        if (!containerOk) return false;
    }
    if (constraints.type !== undefined && !constraintTypeMatches(event.type, constraints.type, event.raw, constraints)) {
        return false;
    }
    if (constraints.datatype !== undefined && event.datatype !== constraints.datatype) {
        return false;
    }
    if (event.type === 'NullLiteral' && !nullValueMatches(event.value, constraints)) {
        return false;
    }
    if (event.type === 'ToggleLiteral' && constraints.toggle_pair !== undefined && constraints.toggle_pair !== 'any') {
        const value = (event.raw || event.value).toLowerCase();
        const allowed = constraints.toggle_pair === 'yes_no'
            ? ['yes', 'no']
            : constraints.toggle_pair === 'on_off'
                ? ['on', 'off']
                : [];
        if (allowed.length > 0 && !allowed.includes(value)) return false;
    }
    if (isStringType(event.type)) {
        const valueLength = event.value.length;
        if (constraints.min_length !== undefined && valueLength < constraints.min_length) return false;
        if (constraints.max_length !== undefined && valueLength > constraints.max_length) return false;
        if (!patternMatches(constraints.pattern, event.value)) return false;
    }
    if (hasDigitFormConstraints(constraints) && isDigitFormLiteral(event.type)) {
        const digitCount = countFormDigits(event.type, event.raw);
        if (constraints.sign === 'unsigned' && isFormNegative(event.raw)) return false;
        if (constraints.min_digits !== undefined && digitCount < constraints.min_digits) return false;
        if (constraints.max_digits !== undefined && digitCount > constraints.max_digits) return false;
        if (event.type === 'RadixLiteral' && constraints.radix !== undefined && !radixConstraintMatches(event.datatype, event.raw, constraints)) return false;
    }
    return true;
}

function resolveTerminalReferenceEvent(
    event: EventInfo,
    eventsByPath: ReadonlyMap<string, EventInfo>,
    activePaths: Set<string>,
    remainingSteps: number,
    state: { exhausted: boolean },
): EventInfo | null {
    if (!isReferenceType(event.type) || !event.referencePath) {
        return event;
    }
    if (remainingSteps <= 0) {
        state.exhausted = true;
        return null;
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
        ? resolveTerminalReferenceEvent(target, eventsByPath, activePaths, remainingSteps - 1, state)
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
        out = appendAttributePath(out, segment.key);
    }
    return out;
}

function matchesAllowedPath(actualPath: string, allowedPath: string): boolean {
    return actualPath === allowedPath;
}

function resolveSansaSelectorPathSet(
    selector: string,
    eventsByPath: ReadonlyMap<string, EventInfo>,
    ctx: ReturnType<typeof createDiagContext>,
): ReadonlySet<string> | null {
    const result = resolveAddress(selector, createAeosSansaResolveNamespace(eventsByPath));
    if (!result.ok) {
        const first = result.errors[0];
        emitError(ctx, createDiag(
            selector,
            null,
            first ? `Invalid or unsupported SANSA selector: ${first.message}` : `Invalid or unsupported SANSA selector: ${selector}`,
            ErrorCodes.INVALID_SCHEMA_POLICY,
        ));
        return null;
    }

    return new Set(result.bindings.map((binding) => binding.path).filter((path) => eventsByPath.has(path)));
}

function createAeosSansaResolveNamespace(
    eventsByPath: ReadonlyMap<string, EventInfo>,
): SansaResolveNamespace<AeosSansaResolveBinding> {
    const root = buildAeosSansaResolveTree(eventsByPath);
    return {
        root,
        children: (binding) => binding.children,
        member: (binding, name) => binding.children.find((child) => child.name === name),
        position: (binding, index) => binding.children.find((child) => child.index === index),
        attributeSpace: (binding) => binding.attributeSpace,
        name: (binding) => binding.name,
        index: (binding) => binding.index,
        semanticType: (binding) => binding.info?.datatype,
        representationKind: (binding) => binding.info?.type,
    };
}

function buildAeosSansaResolveTree(eventsByPath: ReadonlyMap<string, EventInfo>): AeosSansaResolveBinding {
    const root: AeosSansaResolveBinding = { path: '$', children: [] };
    for (const [path, info] of [...eventsByPath.entries()].sort((a, b) => a[0].length - b[0].length)) {
        insertAeosSansaResolvePath(root, path, info);
    }
    return root;
}

function insertAeosSansaResolvePath(root: AeosSansaResolveBinding, path: string, info: EventInfo): void {
    const parsed = parseAddress(path);
    if (!parsed.ok) return;
    if (parsed.address.root.kind !== 'absolute') return;

    let current = root;
    let currentPath = '$';
    for (const selector of parsed.address.selectors) {
        switch (selector.type) {
            case 'member':
                currentPath += formatMemberSelector(selector.name);
                current = getOrCreateChildBinding(current, currentPath, { name: selector.name });
                break;
            case 'position':
                currentPath += `[${selector.index}]`;
                current = getOrCreateChildBinding(current, currentPath, { index: selector.index });
                break;
            case 'attributeSpace':
                currentPath += '.@';
                current.attributeSpace ??= { path: currentPath, children: [] };
                current = current.attributeSpace;
                break;
            default:
                return;
        }
    }
    current.info = info;
    if (info.identity !== undefined) current.identity = info.identity;
}

function getOrCreateChildBinding(
    parent: AeosSansaResolveBinding,
    path: string,
    identity: { readonly name?: string; readonly index?: number },
): AeosSansaResolveBinding {
    const existing = parent.children.find((child) =>
        identity.name !== undefined
            ? child.name === identity.name
            : child.index === identity.index
    );
    if (existing) return existing;
    const child: AeosSansaResolveBinding = { path, children: [], ...identity };
    parent.children.push(child);
    return child;
}

function collectAllowedAttributePaths(ruleIndex: ReadonlyMap<string, { constraints: ConstraintsV1 }>): string[] {
    const allowed: string[] = [];
    function visit(basePath: string, constraints: ConstraintsV1): void {
        if (basePath.includes('.@.')) {
            allowed.push(basePath);
        }
        const attributes = constraints.attributes;
        if (!attributes) return;
        for (const [key, childConstraints] of Object.entries(attributes)) {
            visit(appendAttributePath(basePath, key), childConstraints);
        }
    }
    for (const [path, rule] of ruleIndex) {
        visit(path, rule.constraints);
    }
    return allowed;
}

function collectAttributeEntries(
    eventsByPath: ReadonlyMap<string, EventInfo>,
): { path: string; span: [number, number] | null }[] {
    const entries: { path: string; span: [number, number] | null }[] = [];
    function visit(basePath: string, attributes: ReadonlyMap<string, AttributeInfo> | undefined): void {
        if (!attributes) return;
        for (const [key, entry] of attributes.entries()) {
            const path = appendAttributePath(basePath, key);
            entries.push({ path, span: entry.span });
            visit(path, entry.attributes);
        }
    }
    for (const [path, event] of eventsByPath) {
        visit(path, event.attributes);
    }
    return entries;
}

function checkAttributePolicy(
    schema: SchemaV1,
    ruleIndex: ReadonlyMap<string, { constraints: ConstraintsV1 }>,
    eventsByPath: ReadonlyMap<string, EventInfo>,
    ctx: ReturnType<typeof createDiagContext>,
): void {
    const policy = schema.attribute_policy ?? 'inherit_world';
    if (policy === 'inherit_world' && (schema.world ?? 'open') !== 'closed') return;
    if (policy !== 'inherit_world' && policy !== 'forbid') return;

    const attributeEntries = collectAttributeEntries(eventsByPath);
    if (attributeEntries.length === 0) return;

    const allowedPaths = policy === 'inherit_world'
        ? collectAllowedAttributePaths(ruleIndex)
        : [];
    for (const entry of attributeEntries) {
        if (allowedPaths.some((allowedPath) => matchesAllowedPath(entry.path, allowedPath))) continue;
        emitError(ctx, createDiag(
            entry.path,
            entry.span,
            policy === 'forbid'
                ? `Attribute '${entry.path}' is forbidden by schema attribute_policy`
                : `Attribute '${entry.path}' is not allowed by closed-world schema`,
            ErrorCodes.UNEXPECTED_ATTRIBUTE_ENTRY
        ));
    }
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
            const range = normalizeRangeLiteral(event.type, raw);
            if (!range) {
                emitError(ctx, createDiag(
                    path,
                    event.span,
                    `Datatype rule violation for ':${event.datatype}': range constraints require numeric literal form`,
                    ErrorCodes.NUMERIC_FORM_VIOLATION
                ));
                continue;
            }

            if (constraints.min_value !== undefined && isBelowRange(range, constraints.min_value)) {
                emitError(ctx, createDiag(
                    path,
                    event.span,
                    `Datatype rule violation for ':${event.datatype}': expected value >= ${constraints.min_value}, got ${range.raw}`,
                    ErrorCodes.NUMERIC_FORM_VIOLATION
                ));
                continue;
            }
            if (constraints.max_value !== undefined && isAboveRange(range, constraints.max_value)) {
                emitError(ctx, createDiag(
                    path,
                    event.span,
                    `Datatype rule violation for ':${event.datatype}': expected value <= ${constraints.max_value}, got ${range.raw}`,
                    ErrorCodes.NUMERIC_FORM_VIOLATION
                ));
            }
        }
    }
}

function mergeDatatypeRules(
    ruleIndex: RuleIndex,
    datatypeRules: Readonly<Record<string, ConstraintsV1>> | undefined,
    eventsByPath: ReadonlyMap<string, EventInfo>,
): RuleIndex {
    if (!datatypeRules) return ruleIndex;
    const merged = new Map<string, SchemaRule>();
    for (const [path, rule] of ruleIndex.entries()) {
        merged.set(path, { ...rule, constraints: { ...rule.constraints } });
    }
    for (const [path, event] of eventsByPath.entries()) {
        if (!event.datatype) continue;
        const datatypeRule = datatypeRules[datatypeBase(event.datatype).toLowerCase()];
        if (!datatypeRule) continue;
        const existing = merged.get(path);
        const constraints = existing?.constraints ?? {};
        merged.set(path, {
            path,
            constraints: { ...datatypeRule, ...constraints },
        });
    }
    return merged;
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
        const childPath = appendAttributePath(basePath, key);
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
            const childPath = appendAttributePath(basePath, key);
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

    if (hasDigitFormConstraints(effectiveConstraints) && isDigitFormLiteral(entry.type)) {
        const digitCount = countFormDigits(entry.type, entry.raw);
        if ((entry.type === 'NumberLiteral' || entry.type === 'RadixLiteral') && effectiveConstraints.sign === 'unsigned' && isFormNegative(entry.raw)) {
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
        if (entry.type === 'RadixLiteral' && effectiveConstraints.radix !== undefined) {
            const declaredRadix = declaredRadixFromDatatype(entry.datatype);
            if ((declaredRadix === null && effectiveConstraints.allow_unspecified_radix !== true)
                || (declaredRadix !== null && declaredRadix !== effectiveConstraints.radix)) {
                emitError(ctx, createDiag(
                    path,
                    entry.span,
                    `Numeric form violation: expected declared radix ${effectiveConstraints.radix}`,
                    ErrorCodes.NUMERIC_FORM_VIOLATION
                ));
                return;
            }
            const invalidDigit = firstInvalidRadixDigit(entry.raw, effectiveConstraints.radix);
            if (invalidDigit !== null) {
                emitError(ctx, createDiag(
                    path,
                    entry.span,
                    `Numeric form violation: radix literal digit '${invalidDigit}' is outside radix ${effectiveConstraints.radix}`,
                    ErrorCodes.NUMERIC_FORM_VIOLATION
                ));
            }
        }
    }

    if (isStringType(entry.type)) {
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
        if (effectiveConstraints.pattern !== undefined && !patternMatches(effectiveConstraints.pattern, entry.value)) {
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
    if (event.type === 'NullLiteral' && !nullValueMatches(event.value, constraints)) {
        emitError(ctx, createDiag(
            path,
            event.span,
            `Null value mismatch: expected ${formatExpectedNullValues(constraints)}, got ${event.value || '<none>'}`,
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

function nullValueMatches(value: string, constraints: ConstraintsV1): boolean {
    const expected = expectedNullValues(constraints);
    return expected.length === 0 || expected.includes(value);
}

function expectedNullValues(constraints: ConstraintsV1): readonly string[] {
    const values: string[] = [];
    if (constraints.null_value !== undefined) values.push(constraints.null_value);
    if (constraints.null_values !== undefined) values.push(...constraints.null_values);
    return values;
}

function formatExpectedNullValues(constraints: ConstraintsV1): string {
    const values = expectedNullValues(constraints);
    return values.length > 0 ? values.join(' | ') : '<any>';
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

type NormalizedRange = { kind: 'integer'; raw: string; value: bigint } | { kind: 'float'; raw: string; value: number };

function normalizeRangeLiteral(type: string, raw: string): NormalizedRange | null {
    const normalized = raw.replace(/_/g, '');
    if (type === 'FloatLiteral' || /[.eE]/.test(normalized)) {
        if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(normalized)) return null;
        const value = Number(normalized);
        return Number.isFinite(value) ? { kind: 'float', raw: normalized, value } : null;
    }
    if (!/^[+-]?\d+$/.test(normalized)) return null;
    return { kind: 'integer', raw: normalized, value: BigInt(normalized) };
}

function isBelowRange(range: NormalizedRange, bound: string): boolean {
    if (range.kind === 'integer' && /^[-+]?\d+$/.test(bound)) {
        return range.value < BigInt(bound);
    }
    return rangeAsNumber(range) < Number(bound);
}

function isAboveRange(range: NormalizedRange, bound: string): boolean {
    if (range.kind === 'integer' && /^[-+]?\d+$/.test(bound)) {
        return range.value > BigInt(bound);
    }
    return rangeAsNumber(range) > Number(bound);
}

function rangeAsNumber(range: NormalizedRange): number {
    return range.kind === 'integer' ? Number(range.value) : range.value;
}

function countIntegerDigits(raw: string): number {
    return raw.replace(/^[+-]/, '').replace(/_/g, '').split('.')[0]?.length ?? 0;
}

function hasDigitFormConstraints(constraints: ConstraintsV1): boolean {
    return constraints.sign !== undefined || constraints.min_digits !== undefined || constraints.max_digits !== undefined || constraints.radix !== undefined;
}

function isDigitFormLiteral(type: string): boolean {
    return type === 'NumberLiteral' || type === 'HexLiteral' || type === 'RadixLiteral';
}

function radixConstraintMatches(datatype: string | undefined, raw: string, constraints: ConstraintsV1): boolean {
    if (constraints.radix === undefined) return true;
    const declaredRadix = declaredRadixFromDatatype(datatype);
    if (declaredRadix === null && constraints.allow_unspecified_radix !== true) return false;
    if (declaredRadix !== null && declaredRadix !== constraints.radix) return false;
    return firstInvalidRadixDigit(raw, constraints.radix) === null;
}

function isStringType(type: string): boolean {
    return type === 'StringLiteral'
        || type === 'TrimtickLiteral'
        || type === 'TrimtickStringLiteral'
        || type === 'SeparatorLiteral'
        || type === 'SansaAddressLiteral'
        || type === 'NullLiteral'
        || type === 'EncodingLiteral'
        || type === 'DateLiteral'
        || type === 'TimeLiteral'
        || type === 'DateTimeLiteral'
        || type === 'WTCDateTimeLiteral';
}

function countFormDigits(type: string, raw: string): number {
    if (type === 'NumberLiteral') return countIntegerDigits(raw);
    const body = raw
        .replace(/^[#%^]/, '')
        .replace(/^[+-]/, '')
        .replace(/_/g, '');
    let count = 0;
    for (const char of body) {
        if ((char >= '0' && char <= '9') || ((char >= 'A' && char <= 'Z') || (char >= 'a' && char <= 'z') || char === '&' || char === '!')) {
            count++;
        }
    }
    return count;
}

function firstInvalidRadixDigit(raw: string, radix: number): string | null {
    const body = raw.replace(/^%/, '').replace(/^[+-]/, '').replace(/_/g, '');
    for (const char of body) {
        const value = radixDigitValue(char);
        if (value !== null && value >= radix) return char;
    }
    return null;
}

function radixDigitValue(char: string): number | null {
    if (char >= '0' && char <= '9') return char.charCodeAt(0) - 48;
    const lower = char.toLowerCase();
    if (lower >= 'a' && lower <= 'z') return lower.charCodeAt(0) - 87;
    if (char === '&') return 36;
    if (char === '!') return 37;
    return null;
}

function isNegative(raw: string): boolean {
    return raw.startsWith('-');
}

function isFormNegative(raw: string): boolean {
    return /^[$#%^]?-/.test(raw) || raw.startsWith('-');
}

function isPortableTelexRecord(value: unknown): value is PortableAesBodyEvent {
    if (value === null || typeof value !== 'object') return false;
    const record = value as Readonly<Record<string, unknown>>;
    return typeof record.path === 'string' && typeof record.kind === 'string' && record.header === undefined;
}

function portableDatatype(record: TelexRecord): string | undefined {
    if (typeof record.datatype !== 'string') return undefined;
    if (!Array.isArray(record.generics) || !Array.isArray(record.clarifiers)) return record.datatype;
    return formatDatatypeDescriptor({
        datatype: record.datatype,
        generics: record.generics as readonly (AesDatatypeDescriptor | AesNumberLiteral)[],
        clarifiers: record.clarifiers as readonly (AesStringLiteral | AesNumberLiteral)[],
    });
}

type PortablePathSegment =
    | { readonly type: 'member'; readonly key: string }
    | { readonly type: 'attribute'; readonly key: string }
    | { readonly type: 'index'; readonly index: number };

function parsePortablePath(path: string): { readonly segments: readonly PortablePathSegment[]; readonly prefixes: readonly string[] } {
    if (!path.startsWith('$')) throw new TypeError(`Expected absolute portable AES path: ${path}`);
    const segments: PortablePathSegment[] = [];
    const prefixes: string[] = [];
    let cursor = 1;
    while (cursor < path.length) {
        const start = cursor;
        let type: 'member' | 'attribute' | 'index';
        if (path.startsWith('.@.', cursor)) {
            type = 'attribute';
            cursor += 3;
        } else if (path[cursor] === '.') {
            type = 'member';
            cursor += 1;
        } else if (path[cursor] === '[') {
            const match = path.slice(cursor).match(/^\[(0|[1-9][0-9]*)\]/u);
            if (match === null) throw new TypeError(`Invalid portable AES index: ${path}`);
            cursor += match[0].length;
            segments.push({ type: 'index', index: Number(match[1]) });
            prefixes.push(path.slice(0, cursor));
            continue;
        } else {
            throw new TypeError(`Invalid portable AES path: ${path}`);
        }

        let key: string;
        if (path[cursor] === '[' && path[cursor + 1] === '"') {
            let end = cursor + 2;
            let escaped = false;
            for (; end < path.length; end += 1) {
                const character = path[end];
                if (escaped) escaped = false;
                else if (character === '\\') escaped = true;
                else if (character === '"') break;
            }
            if (path[end] !== '"' || path[end + 1] !== ']') throw new TypeError(`Invalid quoted member: ${path}`);
            key = JSON.parse(path.slice(cursor + 1, end + 1)) as string;
            cursor = end + 2;
        } else {
            const match = path.slice(cursor).match(/^[A-Za-z_][A-Za-z0-9_]*/u);
            if (match === null) throw new TypeError(`Invalid portable AES member: ${path}`);
            key = match[0];
            cursor += key.length;
        }
        segments.push({ type, key });
        prefixes.push(path.slice(0, cursor));
        if (cursor === start) throw new TypeError(`Invalid portable AES path: ${path}`);
    }
    return { segments, prefixes };
}

function parsePortableReferencePath(path: string): readonly (string | number | { readonly type: 'attr'; readonly key: string })[] {
    return parsePortablePath(path).segments.map((segment) => {
        if (segment.type === 'index') return segment.index;
        if (segment.type === 'attribute') return { type: 'attr' as const, key: segment.key };
        return segment.key;
    });
}

function hydratePortableAttributes(eventsByPath: Map<string, EventInfo>, aes: AES): void {
    const attributes = aes
        .filter(isPortableTelexRecord)
        .map((record) => {
            try {
                return { record, details: parsePortablePath(record.path) };
            } catch {
                return null;
            }
        })
        .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
        .filter(({ details }) => details.segments.at(-1)?.type === 'attribute')
        .sort((a, b) => a.details.segments.length - b.details.segments.length);

    for (const { record, details } of attributes) {
        const final = details.segments.at(-1);
        if (final?.type !== 'attribute') continue;
        const ownerPath = details.prefixes.at(-2) ?? '$';
        const owner = eventsByPath.get(ownerPath);
        const attribute = eventsByPath.get(record.path);
        if (owner === undefined || attribute === undefined) continue;
        const mapped = new Map(owner.attributes ?? []);
        mapped.set(final.key, attribute);
        owner.attributes = mapped;
    }
}

function hydratePortableContainerArities(
    aes: AES,
    containerArity: Map<string, number>,
    resourcePolicy: Required<ResourcePolicyV1>,
    ctx: ReturnType<typeof createDiagContext>,
    toTuple: (span: unknown) => [number, number] | null,
): void {
    const records = aes.filter(isPortableTelexRecord);
    if (records.length === 0) return;
    const details = new Map<string, ReturnType<typeof parsePortablePath>>();
    for (const record of records) {
        try {
            details.set(record.path, parsePortablePath(record.path));
        } catch {
            // The portable AES validation layer reports malformed paths.
        }
    }
    for (const record of records) {
        if (!['ObjectNode', 'ListNode', 'TupleLiteral', 'NodeLiteral', 'NodeHead'].includes(record.kind)) continue;
        const childOwner = record.kind === 'NodeLiteral' ? `${record.path}[0]` : record.path;
        let count = 0;
        for (const candidate of records) {
            const candidateDetails = details.get(candidate.path);
            if (candidateDetails === undefined) continue;
            const parent = candidateDetails.prefixes.at(-2) ?? '$';
            const last = candidateDetails.segments.at(-1);
            if (parent !== childOwner || last === undefined) continue;
            if (record.kind === 'ObjectNode' ? last.type === 'member' : last.type === 'index') count += 1;
        }
        containerArity.set(record.path, count);
        if (count > resourcePolicy.max_container_children_default) {
            emitResourceError(
                ctx,
                record.path,
                `Container child count ${count} exceeds max_container_children_default ${resourcePolicy.max_container_children_default}`,
                toTuple(record.span),
            );
        }
    }
}

function formatCanonicalPathLocal(path: any): string {
    if (typeof path === 'string') return path;
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
    if (typeof span === 'string') {
        const match = span.match(/^(0|[1-9][0-9]*):(0|[1-9][0-9]*)$/u);
        return match === null ? null : [Number(match[1]), Number(match[2])];
    }
    if (Array.isArray(span) && span.length === 2 && typeof span[0] === 'number') return span as [number, number];
    if (span.start && span.end && typeof span.start.offset === 'number') return spanToTuple(span);
    return null;
}
