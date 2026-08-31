/**
 * Tooling primitives for deriving editable schema candidates and reviewing
 * changes between schema versions. These functions do not admit migrations.
 */

import { compile, type CompileOptions } from '@altopelago/aeon-core';
import { parseAddress } from '@altopelago/sansa';
import type { AssignmentEvent } from './types/aes.js';
import type { ConstraintsV1, SchemaEvolutionV1, SchemaRule, SchemaV1 } from './types/schema.js';
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
        readonly kind: 'rule-relocated';
        readonly identity: string;
        readonly before: SchemaRule;
        readonly after: SchemaRule;
        readonly constraintPaths: readonly string[];
        readonly evidence: 'shared-declaration-id';
    }
    | {
        readonly kind: 'rule-changed';
        readonly identity: string;
        readonly before: SchemaRule;
        readonly after: SchemaRule;
        readonly constraintPaths: readonly string[];
        readonly metadataPaths?: readonly string[];
    };

export interface PossibleRuleMove {
    readonly from: string;
    readonly to: string;
    readonly reason: 'shared-lineage-id' | 'identical-constraints';
}

export interface SchemaDiff {
    readonly equal: boolean;
    readonly changes: readonly SchemaDiffChange[];
    /** These are review hints, not inferred migration instructions. */
    readonly possibleRuleMoves: readonly PossibleRuleMove[];
}

export interface SchemaEvolutionDiagnostic {
    readonly changeId: string;
    readonly code: 'SOURCE_DECLARATION_MISSING' | 'TEMPORAL_KIND_MISMATCH';
    readonly message: string;
}

export interface SchemaAeonProjection {
    /** Illustrative AEON instance shape. It is not schema authority or validation evidence. */
    readonly source: string;
    readonly assumptions: readonly string[];
    readonly omittedRules: readonly string[];
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

/**
 * Projects a schema into one inspectable AEON instance shape. The schema remains
 * authoritative; this deliberately cannot represent every valid value.
 */
export function projectSchemaToAeon(schema: SchemaV1): SchemaAeonProjection {
    const root = projectionNode();
    const omittedRules: string[] = [];
    let includesOptional = false;
    let expandsSelector = false;

    const orderedRules = [...schema.rules].sort((left, right) => Number(left.selector !== undefined) - Number(right.selector !== undefined));
    for (const rule of orderedRules) {
        const address = parseAddress(rule.path ?? rule.selector!);
        if (!address.ok || address.address.root.kind !== 'absolute') {
            omittedRules.push(ruleAddress(rule));
            continue;
        }
        let current = root;
        let supported = true;
        for (const selector of address.address.selectors) {
            if (selector.type === 'member') {
                current = childMember(current, selector.name);
            } else if (selector.type === 'position') {
                current = childPosition(current, selector.index);
            } else if (selector.type === 'directExpansion') {
                expandsSelector = true;
                current = projectionContainerKind(current) === 'sequence'
                    ? childPosition(current, 0)
                    : childMember(current, 'example');
            } else {
                supported = false;
                break;
            }
        }
        if (!supported) {
            omittedRules.push(ruleAddress(rule));
            continue;
        }
        current.rule = rule;
        if (rule.constraints.required !== true) includesOptional = true;
    }

    const assumptions = [
        'Placeholder values illustrate representation shape; they are not guaranteed to satisfy business patterns or ranges.',
        ...(includesOptional ? ['Optional declarations are included to make the available shape visible.'] : []),
        ...(expandsSelector ? ["Each direct wildcard selector is represented by one member or item named 'example'."] : []),
        ...(omittedRules.length > 0 ? ['Rules using filters, ranges, parent traversal, or other non-structural selectors are omitted.'] : []),
    ];
    return {
        source: `${renderProjectionRoot(root)}\n`,
        assumptions,
        omittedRules,
    };
}

export function projectSchemaSourceToAeon(source: string): SchemaAeonProjection {
    return projectSchemaToAeon(parseSchemaSource(source));
}

interface ProjectionNode {
    rule?: SchemaRule;
    readonly members: Map<string, ProjectionNode>;
    readonly positions: Map<number, ProjectionNode>;
}

function projectionNode(): ProjectionNode {
    return { members: new Map(), positions: new Map() };
}

function childMember(parent: ProjectionNode, name: string): ProjectionNode {
    const existing = parent.members.get(name);
    if (existing !== undefined) return existing;
    const child = projectionNode();
    parent.members.set(name, child);
    return child;
}

function childPosition(parent: ProjectionNode, index: number): ProjectionNode {
    const existing = parent.positions.get(index);
    if (existing !== undefined) return existing;
    const child = projectionNode();
    parent.positions.set(index, child);
    return child;
}

function projectionContainerKind(node: ProjectionNode): 'object' | 'sequence' {
    const type = node.rule?.constraints.type;
    return type === 'ListNode' || type === 'ListLiteral' || type === 'TupleLiteral'
        || node.rule?.constraints.type_is === 'list' || node.rule?.constraints.type_is === 'tuple'
        ? 'sequence'
        : 'object';
}

function renderProjectionRoot(root: ProjectionNode): string {
    return [...root.members.entries()].map(([name, node]) => renderProjectionBinding(name, node, 0)).join('\n');
}

function renderProjectionBinding(name: string, node: ProjectionNode, indent: number): string {
    const pad = '  '.repeat(indent);
    return `${pad}${renderProjectionKey(name)}:${projectionDatatype(node)} = ${renderProjectionValue(node, indent)}`;
}

function renderProjectionValue(node: ProjectionNode, indent: number): string {
    const type = node.rule?.constraints.type;
    if (node.positions.size > 0 || type === 'ListNode' || type === 'ListLiteral' || type === 'TupleLiteral') {
        const tuple = type === 'TupleLiteral' || node.rule?.constraints.type_is === 'tuple';
        const open = tuple ? '(' : '[';
        const close = tuple ? ')' : ']';
        const maximum = Math.max(-1, ...node.positions.keys());
        if (maximum < 0) return `${open}${close}`;
        const items = Array.from({ length: maximum + 1 }, (_, index) => {
            const item = node.positions.get(index);
            return `${'  '.repeat(indent + 1)}${item === undefined ? '!notSet' : renderProjectionValue(item, indent + 1)}`;
        });
        return `${open}\n${items.join('\n')}\n${'  '.repeat(indent)}${close}`;
    }
    if (node.members.size > 0 || type === 'ObjectNode') {
        if (node.members.size === 0) return '{}';
        const entries = [...node.members.entries()].map(([name, child]) => renderProjectionBinding(name, child, indent + 1));
        return `{\n${entries.join('\n')}\n${'  '.repeat(indent)}}`;
    }
    return projectionLiteral(node.rule?.constraints);
}

function projectionDatatype(node: ProjectionNode): string {
    if (node.rule?.constraints.datatype !== undefined) return node.rule.constraints.datatype;
    const type = node.rule?.constraints.type;
    if (type === 'ObjectNode' || node.members.size > 0) return 'object';
    if (type === 'TupleLiteral') return 'tuple';
    if (type === 'ListNode' || type === 'ListLiteral' || node.positions.size > 0) return 'list';
    return {
        StringLiteral: 'string', NumberLiteral: 'number', BooleanLiteral: 'boolean', ToggleLiteral: 'toggle',
        NullLiteral: 'null', SansaAddressLiteral: 'sansa',
    }[type ?? ''] ?? 'value';
}

function projectionLiteral(constraints: ConstraintsV1 | undefined): string {
    const effective = constraints?.any_of?.[0] === undefined ? constraints : { ...constraints, ...constraints.any_of[0], any_of: undefined };
    switch (effective?.type) {
        case 'StringLiteral': {
            const minimum = Math.max(0, effective.min_length ?? 0);
            const maximum = Math.max(minimum, effective.max_length ?? Math.max(7, minimum));
            const length = Math.max(minimum, Math.min(7, maximum));
            return JSON.stringify('example'.slice(0, length).padEnd(length, 'x'));
        }
        case 'NumberLiteral': return effective.min_value ?? '0';
        case 'BooleanLiteral': return 'true';
        case 'ToggleLiteral': return effective.toggle_pair === 'on_off' ? 'on' : 'yes';
        case 'NullLiteral': return `!${effective.null_value ?? effective.null_values?.[0] ?? 'notSet'}`;
        case 'SansaAddressLiteral': return '$';
        case 'InfinityLiteral': return 'Infinity';
        case 'NaNLiteral': return 'NaN';
        case 'HexLiteral': return '#0';
        default: return '!notSet';
    }
}

function renderProjectionKey(key: string): string {
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ? key : JSON.stringify(key);
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
        const declarationId = generatedRuleIdentity(path);
        rules.push({
            declaration_id: declarationId,
            lineage_id: declarationId,
            path,
            constraints: constraintsFromShape(event),
        });
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

/** Validate authored temporal intent against the two schema states it relates. */
export function validateSchemaEvolution(source: SchemaV1, target: SchemaV1): readonly SchemaEvolutionDiagnostic[] {
    const before = normalizeSchemaObject(source);
    const after = normalizeSchemaObject(target);
    const beforeById = declarationsById(before.rules);
    const afterById = declarationsById(after.rules);
    const diagnostics: SchemaEvolutionDiagnostic[] = [];
    for (const change of after.evolution ?? []) {
        const missing = change.from_declarations.filter((id) => !beforeById.has(id));
        if (missing.length > 0) {
            diagnostics.push({
                changeId: change.change_id,
                code: 'SOURCE_DECLARATION_MISSING',
                message: `Source declaration${missing.length === 1 ? '' : 's'} ${missing.join(', ')} do not exist in the source schema.`,
            });
            continue;
        }
        if (!evolutionMatchesStates(change, beforeById, afterById)) {
            diagnostics.push({
                changeId: change.change_id,
                code: 'TEMPORAL_KIND_MISMATCH',
                message: `The declared '${change.kind}' intent does not match the source and target schema states.`,
            });
        }
    }
    return diagnostics;
}

export function validateSchemaEvolutionSources(source: string, target: string): readonly SchemaEvolutionDiagnostic[] {
    return validateSchemaEvolution(parseSchemaSource(source), parseSchemaSource(target));
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

    const afterByDeclaration = new Map(after.rules
        .filter((rule): rule is SchemaRule & { readonly declaration_id: string } => rule.declaration_id !== undefined)
        .map((rule) => [rule.declaration_id, rule]));
    const afterByAddress = new Map(after.rules.map((rule) => [ruleIdentity(rule), rule]));
    const matchedAfter = new Set<SchemaRule>();
    const removed: SchemaRule[] = [];
    const added: SchemaRule[] = [];

    for (const rule of before.rules) {
        const declarationMatch = rule.declaration_id === undefined ? undefined : afterByDeclaration.get(rule.declaration_id);
        const addressMatch = afterByAddress.get(ruleIdentity(rule));
        const compatibleAddressMatch = addressMatch !== undefined
            && (rule.declaration_id === undefined
                || addressMatch.declaration_id === undefined
                || rule.declaration_id === addressMatch.declaration_id)
            ? addressMatch
            : undefined;
        const next = declarationMatch !== undefined && !matchedAfter.has(declarationMatch)
            ? declarationMatch
            : compatibleAddressMatch !== undefined && !matchedAfter.has(compatibleAddressMatch)
                ? compatibleAddressMatch
                : undefined;
        if (!next) {
            removed.push(rule);
            changes.push({ kind: 'rule-removed', rule });
            continue;
        }
        matchedAfter.add(next);
        const identity = rule.declaration_id !== undefined && rule.declaration_id === next.declaration_id
            ? `declaration:${rule.declaration_id}`
            : ruleIdentity(rule);
        if (ruleIdentity(rule) !== ruleIdentity(next)) {
            changes.push({
                kind: 'rule-relocated',
                identity,
                before: rule,
                after: next,
                constraintPaths: changedPaths(rule.constraints, next.constraints),
                evidence: 'shared-declaration-id',
            });
        } else if (!jsonEqual(rule.constraints, next.constraints)
            || rule.declaration_id !== next.declaration_id
            || rule.lineage_id !== next.lineage_id) {
            const metadataPaths = [
                ...(rule.declaration_id === next.declaration_id ? [] : ['declaration_id']),
                ...(rule.lineage_id === next.lineage_id ? [] : ['lineage_id']),
            ];
            changes.push({
                kind: 'rule-changed',
                identity,
                before: rule,
                after: next,
                constraintPaths: changedPaths(rule.constraints, next.constraints),
                ...(metadataPaths.length === 0 ? {} : { metadataPaths }),
            });
        }
    }
    for (const rule of after.rules) {
        if (!matchedAfter.has(rule)) {
            added.push(rule);
            changes.push({ kind: 'rule-added', rule });
        }
    }

    const possibleRuleMoves: PossibleRuleMove[] = [];
    for (const oldRule of removed) {
        const lineageMatches = oldRule.lineage_id === undefined
            ? []
            : added.filter((newRule) => newRule.lineage_id === oldRule.lineage_id);
        const uniqueLineage = lineageMatches.length === 1
            && removed.filter((candidate) => candidate.lineage_id === oldRule.lineage_id).length === 1;
        const constraintMatches = added.filter((newRule) => jsonEqual(oldRule.constraints, newRule.constraints));
        const uniqueConstraints = constraintMatches.length === 1
            && removed.filter((candidate) => jsonEqual(candidate.constraints, constraintMatches[0]!.constraints)).length === 1;
        const matches = uniqueLineage ? lineageMatches : uniqueConstraints ? constraintMatches : [];
        if (matches.length === 1) {
            possibleRuleMoves.push({
                from: ruleIdentity(oldRule),
                to: ruleIdentity(matches[0]!),
                reason: uniqueLineage ? 'shared-lineage-id' : 'identical-constraints',
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

function declarationsById(rules: readonly SchemaRule[]): ReadonlyMap<string, SchemaRule> {
    return new Map(rules.flatMap((rule) => rule.declaration_id === undefined ? [] : [[rule.declaration_id, rule] as const]));
}

function evolutionMatchesStates(
    change: SchemaEvolutionV1,
    before: ReadonlyMap<string, SchemaRule>,
    after: ReadonlyMap<string, SchemaRule>,
): boolean {
    const from = change.from_declarations.map((id) => before.get(id)!);
    const to = change.to_declarations.map((id) => after.get(id)!);
    if (change.kind === 'add') return !before.has(change.to_declarations[0]!) && to.length === 1;
    if (change.kind === 'remove') return !after.has(change.from_declarations[0]!) && from.length === 1;
    if (['split', 'merge', 'derive', 'replace'].includes(change.kind)) return true;
    if (from.length !== 1 || to.length !== 1) return false;
    const sourceAddress = ruleAddress(from[0]!);
    const targetAddress = ruleAddress(to[0]!);
    if (change.kind === 'rename') return sameParent(sourceAddress, targetAddress) && sourceAddress !== targetAddress;
    if (change.kind === 'move') return !sameParent(sourceAddress, targetAddress);
    if (change.kind === 'constraint-change') {
        return sourceAddress === targetAddress && !jsonEqual(from[0]!.constraints, to[0]!.constraints);
    }
    if (change.kind === 'datatype-change') {
        return sourceAddress === targetAddress
            && from[0]!.constraints.datatype !== to[0]!.constraints.datatype;
    }
    return false;
}

function ruleAddress(rule: SchemaRule): string {
    return rule.path ?? rule.selector!;
}

function sameParent(left: string, right: string): boolean {
    const leftAddress = parseAddress(left);
    const rightAddress = parseAddress(right);
    if (!leftAddress.ok || !rightAddress.ok) return false;
    return jsonEqual(leftAddress.address.root, rightAddress.address.root)
        && jsonEqual(leftAddress.address.selectors.slice(0, -1), rightAddress.address.selectors.slice(0, -1));
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

function generatedRuleIdentity(path: string): string {
    return `rule:path:${encodeURIComponent(path)}`;
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
