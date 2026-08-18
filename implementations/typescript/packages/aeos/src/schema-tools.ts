/**
 * Tooling primitives for deriving editable schema candidates and reviewing
 * changes between schema versions. These functions do not admit migrations.
 */

import { compile, type CompileOptions } from '@altopelago/aeon-core';
import type { AssignmentEvent } from './types/aes.js';
import type { ConstraintsV1, SchemaRule, SchemaV1 } from './types/schema.js';
import { normalizeSchemaObject, parseSchemaSource, schemaToAeon } from './schema-codec.js';

type AttributeEntry = NonNullable<AssignmentEvent['annotations']> extends ReadonlyMap<string, infer T> ? T : never;
type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export interface InferSchemaOptions {
    /** Generated candidates are open-world unless the caller explicitly closes them. */
    readonly world?: 'open' | 'closed';
    readonly compileOptions?: CompileOptions;
    readonly maxInputBytes?: number;
    readonly maxEvents?: number;
}

export interface InferredSchemaCandidate {
    readonly schema: SchemaV1;
    readonly source: string;
    readonly observedEventCount: number;
    readonly assumptions: readonly string[];
}

export class SchemaInferenceError extends Error {
    readonly diagnostics: readonly string[];

    constructor(message: string, diagnostics: readonly string[] = []) {
        super(message);
        this.name = 'SchemaInferenceError';
        this.diagnostics = diagnostics;
    }
}

export type SchemaDiffChange =
    | { readonly kind: 'setting-changed'; readonly setting: string; readonly before?: JsonValue; readonly after?: JsonValue }
    | { readonly kind: 'rule-added'; readonly rule: SchemaRule }
    | { readonly kind: 'rule-removed'; readonly rule: SchemaRule }
    | {
        readonly kind: 'rule-changed';
        readonly identity: string;
        readonly before: SchemaRule;
        readonly after: SchemaRule;
        readonly constraintPaths: readonly string[];
    };

export interface PossibleRuleMove {
    readonly from: string;
    readonly to: string;
    readonly reason: 'identical-constraints';
}

export interface SchemaDiff {
    readonly equal: boolean;
    readonly changes: readonly SchemaDiffChange[];
    /** These are review hints, not inferred migration instructions. */
    readonly possibleRuleMoves: readonly PossibleRuleMove[];
}

const INFERENCE_ASSUMPTIONS = Object.freeze([
    'Only bindings observed in this bootstrap document are represented.',
    'Observed bindings are marked required; optionality must be reviewed by the author.',
    'Collection indexes remain exact paths; selectors and reusable shapes must be authored deliberately.',
    'Value types and datatype labels are copied, but bounds, patterns, unions, and business rules are not inferred.',
]);

export function inferSchemaFromAeon(source: string, options: InferSchemaOptions = {}): InferredSchemaCandidate {
    const maxInputBytes = options.maxInputBytes ?? options.compileOptions?.maxInputBytes;
    const maxEvents = options.maxEvents ?? options.compileOptions?.maxEvents;
    const compiled = compile(source, {
        ...options.compileOptions,
        recovery: false,
        datatypePolicy: options.compileOptions?.datatypePolicy ?? 'allow_custom',
        ...(maxInputBytes === undefined ? {} : { maxInputBytes }),
        ...(maxEvents === undefined ? {} : { maxEvents }),
    });
    if (compiled.errors.length > 0) {
        const diagnostics = compiled.errors.map(formatDiagnostic);
        throw new SchemaInferenceError(`Bootstrap AEON did not compile: ${diagnostics.join('; ')}`, diagnostics);
    }
    return inferSchemaFromEvents(compiled.events, options.world === undefined ? {} : { world: options.world });
}

export function inferSchemaFromEvents(
    events: readonly AssignmentEvent[],
    options: Pick<InferSchemaOptions, 'world'> = {},
): InferredSchemaCandidate {
    const rules: SchemaRule[] = [];
    const seen = new Set<string>();
    for (const event of events) {
        const path = formatEventPath(event.path);
        if (path === '$' || isHeaderPath(path) || seen.has(path)) continue;
        seen.add(path);
        rules.push({ path, constraints: constraintsFromShape(event) });
    }

    const schema = normalizeSchemaObject({ world: options.world ?? 'open', rules });
    return {
        schema,
        source: schemaToAeon(schema),
        observedEventCount: events.length,
        assumptions: INFERENCE_ASSUMPTIONS,
    };
}

export function diffSchemaSources(source: string, target: string): SchemaDiff {
    return diffSchemas(parseSchemaSource(source), parseSchemaSource(target));
}

export function diffSchemas(source: SchemaV1, target: SchemaV1): SchemaDiff {
    const before = normalizeSchemaObject(source);
    const after = normalizeSchemaObject(target);
    const changes: SchemaDiffChange[] = [];

    compareSetting(changes, 'world', before.world, after.world);
    compareSetting(changes, 'reference_policy', before.reference_policy, after.reference_policy);
    compareSetting(changes, 'attribute_policy', before.attribute_policy, after.attribute_policy);
    compareSetting(changes, 'datatype_rules', before.datatype_rules, after.datatype_rules);
    compareSetting(changes, 'resource_policy', before.resource_policy, after.resource_policy);

    const beforeRules = new Map(before.rules.map((rule) => [ruleIdentity(rule), rule]));
    const afterRules = new Map(after.rules.map((rule) => [ruleIdentity(rule), rule]));
    const removed: SchemaRule[] = [];
    const added: SchemaRule[] = [];

    for (const [identity, rule] of beforeRules) {
        const next = afterRules.get(identity);
        if (!next) {
            removed.push(rule);
            changes.push({ kind: 'rule-removed', rule });
        } else if (!jsonEqual(rule.constraints, next.constraints)) {
            changes.push({
                kind: 'rule-changed',
                identity,
                before: rule,
                after: next,
                constraintPaths: changedPaths(rule.constraints, next.constraints),
            });
        }
    }
    for (const [identity, rule] of afterRules) {
        if (!beforeRules.has(identity)) {
            added.push(rule);
            changes.push({ kind: 'rule-added', rule });
        }
    }

    const possibleRuleMoves: PossibleRuleMove[] = [];
    for (const oldRule of removed) {
        const matches = added.filter((newRule) => jsonEqual(oldRule.constraints, newRule.constraints));
        if (matches.length === 1) {
            possibleRuleMoves.push({
                from: ruleIdentity(oldRule),
                to: ruleIdentity(matches[0]!),
                reason: 'identical-constraints',
            });
        }
    }

    return { equal: changes.length === 0, changes, possibleRuleMoves };
}

function constraintsFromShape(entry: AssignmentEvent | AttributeEntry): ConstraintsV1 {
    const constraints: {
        required: true;
        type: string;
        datatype?: string;
        attributes?: Readonly<Record<string, ConstraintsV1>>;
    } = {
        required: true,
        type: entry.value.type,
    };
    if (entry.datatype) constraints.datatype = entry.datatype;
    if (entry.annotations && entry.annotations.size > 0) {
        const attributes: Record<string, ConstraintsV1> = {};
        for (const [key, attribute] of entry.annotations) {
            attributes[key] = constraintsFromShape(attribute);
        }
        constraints.attributes = attributes;
    }
    return constraints;
}

function formatEventPath(path: AssignmentEvent['path']): string {
    let result = '';
    for (const segment of path.segments) {
        if (segment.type === 'root') result = '$';
        if (segment.type === 'member') {
            result += /^[A-Za-z_][A-Za-z0-9_]*$/.test(segment.key)
                ? `.${segment.key}`
                : `.[${JSON.stringify(segment.key)}]`;
        }
        if (segment.type === 'index') result += `[${segment.index}]`;
    }
    return result || '$';
}

function isHeaderPath(path: string): boolean {
    return path.startsWith('$.[') && path.includes('"aeon:');
}

function formatDiagnostic(error: unknown): string {
    if (error instanceof Error) return error.message;
    return String(error);
}

function ruleIdentity(rule: SchemaRule): string {
    return rule.path !== undefined ? `path:${rule.path}` : `selector:${rule.selector}`;
}

function compareSetting(
    changes: SchemaDiffChange[],
    setting: string,
    before: unknown,
    after: unknown,
): void {
    if (!jsonEqual(before, after)) {
        changes.push({
            kind: 'setting-changed',
            setting,
            ...(before !== undefined ? { before: before as JsonValue } : {}),
            ...(after !== undefined ? { after: after as JsonValue } : {}),
        });
    }
}

function jsonEqual(left: unknown, right: unknown): boolean {
    return stableJson(left) === stableJson(right);
}

function stableJson(value: unknown): string {
    if (value === undefined) return 'undefined';
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
    return `{${Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`)
        .join(',')}}`;
}

function changedPaths(before: unknown, after: unknown, prefix = 'constraints'): readonly string[] {
    if (jsonEqual(before, after)) return [];
    if (!isRecord(before) || !isRecord(after)) return [prefix];
    const paths: string[] = [];
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
        paths.push(...changedPaths(before[key], after[key], `${prefix}.${key}`));
    }
    return paths;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
