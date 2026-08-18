/**
 * @altopelago/aeos-core - Schema source codec
 *
 * Parses and prints AEOS schema documents expressed as AEON source.
 */

import { compile, type CompileOptions } from '@altopelago/aeon-core';
import { finalizeJson, type FinalizeOptions } from '@altopelago/aeon-finalize';
import { parseAddress, renderAddress } from '@altopelago/sansa';
import type {
    ConstraintsV1,
    ResourcePolicyV1,
    SchemaEvolutionKindV1,
    SchemaEvolutionV1,
    SchemaRule,
    SchemaV1,
} from './types/schema.js';

type JsonLike = null | boolean | number | string | readonly JsonLike[] | { readonly [key: string]: JsonLike };
type UnknownRecord = Record<string, unknown>;

export interface SchemaCodecOptions {
    readonly compileOptions?: CompileOptions;
    readonly finalizeOptions?: FinalizeOptions;
}

export class SchemaCodecError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'SchemaCodecError';
    }
}

export function parseSchemaSource(source: string, options: SchemaCodecOptions = {}): SchemaV1 {
    const compiled = compile(source, {
        ...options.compileOptions,
        datatypePolicy: options.compileOptions?.datatypePolicy ?? 'allow_custom',
    });
    if (compiled.errors.length > 0) {
        throw new SchemaCodecError(formatErrors(compiled.errors));
    }

    const finalized = finalizeJson(compiled.events, {
        mode: 'strict',
        scope: 'payload',
        ...options.finalizeOptions,
    });
    const errors = finalized.meta?.errors ?? [];
    if (errors.length > 0) {
        throw new SchemaCodecError(formatErrors(errors));
    }

    return normalizeSchemaObject(finalized.document);
}

export function normalizeSchemaObject(input: unknown): SchemaV1 {
    const root = extractSchemaRoot(input);
    const rules = normalizeRules(root.rules);
    const schema: {
        rules: readonly SchemaRule[];
        evolution?: readonly SchemaEvolutionV1[];
        world?: NonNullable<SchemaV1['world']>;
        reference_policy?: NonNullable<SchemaV1['reference_policy']>;
        attribute_policy?: NonNullable<SchemaV1['attribute_policy']>;
        datatype_rules?: NonNullable<SchemaV1['datatype_rules']>;
        resource_policy?: ResourcePolicyV1;
    } = { rules };

    if (root.evolution !== undefined) {
        schema.evolution = normalizeEvolution(root.evolution, rules);
    }

    if (root.world !== undefined) {
        if (root.world !== 'open' && root.world !== 'closed') {
            throw new SchemaCodecError("Schema field 'world' must be 'open' or 'closed'");
        }
        schema.world = root.world;
    }
    if (root.reference_policy !== undefined) {
        if (root.reference_policy !== 'allow' && root.reference_policy !== 'forbid') {
            throw new SchemaCodecError("Schema field 'reference_policy' must be 'allow' or 'forbid'");
        }
        schema.reference_policy = root.reference_policy;
    }
    if (root.attribute_policy !== undefined) {
        if (root.attribute_policy !== 'inherit_world' && root.attribute_policy !== 'forbid') {
            throw new SchemaCodecError("Schema field 'attribute_policy' must be 'inherit_world' or 'forbid'");
        }
        schema.attribute_policy = root.attribute_policy;
    }
    if (root.datatype_rules !== undefined) {
        if (!isRecord(root.datatype_rules)) {
            throw new SchemaCodecError("Schema field 'datatype_rules' must be an object");
        }
        schema.datatype_rules = normalizeConstraintMap(root.datatype_rules, 'datatype_rules');
    }
    if (root.resource_policy !== undefined) {
        if (!isRecord(root.resource_policy)) {
            throw new SchemaCodecError("Schema field 'resource_policy' must be an object");
        }
        schema.resource_policy = cloneJsonObject(root.resource_policy) as ResourcePolicyV1;
    }

    return schema;
}

export function schemaToAeon(input: SchemaV1): string {
    const schema = normalizeSchemaObject(input);
    const lines = [
        '//! format:aeos-v1',
        'aeos:schema = {',
    ];
    if (schema.world !== undefined) {
        lines.push(`  world:string = ${renderString(schema.world)}`);
    }
    if (schema.reference_policy !== undefined) {
        lines.push(`  reference_policy:string = ${renderString(schema.reference_policy)}`);
    }
    if (schema.attribute_policy !== undefined) {
        lines.push(`  attribute_policy:string = ${renderString(schema.attribute_policy)}`);
    }
    if (schema.datatype_rules !== undefined) {
        lines.push(`  datatype_rules:object = ${renderAeonValue(schema.datatype_rules as JsonLike, 2)}`);
    }
    if (schema.resource_policy !== undefined) {
        lines.push(`  resource_policy:object = ${renderAeonValue(schema.resource_policy as JsonLike, 2)}`);
    }
    if (schema.evolution !== undefined) {
        lines.push(`  evolution:list<object> = ${renderAeonValue(schema.evolution as unknown as JsonLike, 2)}`);
    }
    lines.push('  rules:list<object> = [');
    for (const rule of schema.rules) {
        lines.push('    {');
        if (rule.declaration_id !== undefined) {
            lines.push(`      declaration_id:string = ${renderString(rule.declaration_id)}`);
        }
        if (rule.lineage_id !== undefined) {
            lines.push(`      lineage_id:string = ${renderString(rule.lineage_id)}`);
        }
        if (rule.path !== undefined) {
            lines.push(`      path:sansa = ${canonicalAddress(rule.path, 'path')}`);
        } else if (rule.selector !== undefined) {
            lines.push(`      selector:sansa = ${canonicalAddress(rule.selector, 'selector')}`);
        }
        lines.push(`      constraints:object = ${renderAeonValue(rule.constraints as JsonLike, 3)}`);
        lines.push('    }');
    }
    lines.push('  ]');
    lines.push('}');
    return `${lines.join('\n')}\n`;
}

function extractSchemaRoot(input: unknown): UnknownRecord {
    const document = isRecord(input) && isRecord(input.payload) ? input.payload : input;
    if (!isRecord(document)) {
        throw new SchemaCodecError('AEOS schema source must finalize to an object');
    }
    if (isRecord(document.aeos)) {
        return document.aeos;
    }
    if (isRecord(document.schema)) {
        return document.schema;
    }
    return document;
}

function normalizeRules(value: unknown): readonly SchemaRule[] {
    let rules: readonly SchemaRule[];
    if (Array.isArray(value)) {
        rules = value.map((rule, index) => normalizeRule(rule, `rules[${index}]`));
    } else if (isRecord(value)) {
        rules = Object.entries(value).map(([path, constraints]) => normalizeRule({ path, constraints }, `rules.${path}`));
    } else if (value === undefined) {
        rules = [];
    } else {
        throw new SchemaCodecError("Schema field 'rules' must be a list or object");
    }

    const declarationIds = new Set<string>();
    for (const rule of rules) {
        if (rule.declaration_id === undefined) continue;
        if (declarationIds.has(rule.declaration_id)) {
            throw new SchemaCodecError(`Schema declaration_id '${rule.declaration_id}' must be unique`);
        }
        declarationIds.add(rule.declaration_id);
    }
    return rules;
}

function normalizeRule(input: unknown, label: string): SchemaRule {
    if (!isRecord(input)) {
        throw new SchemaCodecError(`Schema rule ${label} must be an object`);
    }
    const path = optionalString(input.path, `${label}.path`);
    const selector = optionalString(input.selector, `${label}.selector`);
    const declarationId = optionalSchemaIdentity(input.declaration_id, `${label}.declaration_id`);
    const lineageId = optionalSchemaIdentity(input.lineage_id, `${label}.lineage_id`);
    if ((path === undefined) === (selector === undefined)) {
        throw new SchemaCodecError(`Schema rule ${label} must define exactly one of 'path' or 'selector'`);
    }
    if (!isRecord(input.constraints)) {
        throw new SchemaCodecError(`Schema rule ${label} must define an object 'constraints'`);
    }
    const constraints = normalizeConstraints(input.constraints, `${label}.constraints`);
    const identity = {
        ...(declarationId === undefined ? {} : { declaration_id: declarationId }),
        ...(lineageId === undefined ? {} : { lineage_id: lineageId }),
    };
    if (path !== undefined) {
        return { ...identity, path: canonicalAddress(path, 'path'), constraints };
    }
    return { ...identity, selector: canonicalAddress(selector!, 'selector'), constraints };
}

const EVOLUTION_KINDS: ReadonlySet<SchemaEvolutionKindV1> = new Set([
    'add', 'remove', 'rename', 'move', 'constraint-change',
    'datatype-change', 'split', 'merge', 'derive', 'replace',
]);

function normalizeEvolution(value: unknown, rules: readonly SchemaRule[]): readonly SchemaEvolutionV1[] {
    if (!Array.isArray(value)) throw new SchemaCodecError("Schema field 'evolution' must be a list");
    const declarationIds = new Set(rules.flatMap((rule) => rule.declaration_id === undefined ? [] : [rule.declaration_id]));
    const changeIds = new Set<string>();
    return value.map((entry, index) => {
        const label = `evolution[${index}]`;
        if (!isRecord(entry)) throw new SchemaCodecError(`${label} must be an object`);
        const changeId = requiredSchemaIdentity(entry.change_id, `${label}.change_id`);
        if (changeIds.has(changeId)) throw new SchemaCodecError(`Schema change_id '${changeId}' must be unique`);
        changeIds.add(changeId);
        const kind = optionalString(entry.kind, `${label}.kind`);
        if (kind === undefined || !EVOLUTION_KINDS.has(kind as SchemaEvolutionKindV1)) {
            throw new SchemaCodecError(`${label}.kind is not a supported schema evolution kind`);
        }
        const fromDeclarations = schemaIdentityList(entry.from_declarations, `${label}.from_declarations`);
        const toDeclarations = schemaIdentityList(entry.to_declarations, `${label}.to_declarations`);
        validateEvolutionCardinality(kind as SchemaEvolutionKindV1, fromDeclarations, toDeclarations, label);
        for (const declarationId of toDeclarations) {
            if (!declarationIds.has(declarationId)) {
                throw new SchemaCodecError(`${label}.to_declarations references unknown target declaration '${declarationId}'`);
            }
        }
        const fromContract = optionalSchemaIdentity(entry.from_contract, `${label}.from_contract`);
        const transform = optionalSchemaIdentity(entry.transform, `${label}.transform`);
        const note = optionalString(entry.note, `${label}.note`);
        if (note !== undefined && note.length > 2000) throw new SchemaCodecError(`${label}.note must be at most 2000 characters`);
        if (requiresTransform(kind as SchemaEvolutionKindV1) && transform === undefined) {
            throw new SchemaCodecError(`${label}.transform is required for '${kind}' evolution`);
        }
        return {
            change_id: changeId,
            kind: kind as SchemaEvolutionKindV1,
            from_declarations: fromDeclarations,
            to_declarations: toDeclarations,
            ...(fromContract === undefined ? {} : { from_contract: fromContract }),
            ...(transform === undefined ? {} : { transform }),
            ...(note === undefined ? {} : { note }),
        };
    });
}

function requiredSchemaIdentity(value: unknown, label: string): string {
    const identity = optionalSchemaIdentity(value, label);
    if (identity === undefined) throw new SchemaCodecError(`${label} must be a non-empty string`);
    return identity;
}

function schemaIdentityList(value: unknown, label: string): readonly string[] {
    if (!Array.isArray(value)) throw new SchemaCodecError(`${label} must be a list`);
    const identities = value.map((item, index) => requiredSchemaIdentity(item, `${label}[${index}]`));
    if (new Set(identities).size !== identities.length) throw new SchemaCodecError(`${label} must not contain duplicates`);
    return identities;
}

function validateEvolutionCardinality(
    kind: SchemaEvolutionKindV1,
    fromDeclarations: readonly string[],
    toDeclarations: readonly string[],
    label: string,
): void {
    const exact = (from: number, to: number): boolean => fromDeclarations.length === from && toDeclarations.length === to;
    const valid = kind === 'add' ? exact(0, 1)
        : kind === 'remove' ? exact(1, 0)
            : ['rename', 'move', 'constraint-change', 'datatype-change', 'derive', 'replace'].includes(kind) ? exact(1, 1)
                : kind === 'split' ? fromDeclarations.length === 1 && toDeclarations.length >= 2
                    : kind === 'merge' ? fromDeclarations.length >= 2 && toDeclarations.length === 1
                        : false;
    if (!valid) throw new SchemaCodecError(`${label} has invalid declaration cardinality for '${kind}' evolution`);
}

function requiresTransform(kind: SchemaEvolutionKindV1): boolean {
    return ['datatype-change', 'split', 'merge', 'derive', 'replace'].includes(kind);
}

function optionalSchemaIdentity(value: unknown, label: string): string | undefined {
    const identity = optionalString(value, label);
    if (identity === undefined) return undefined;
    if (identity.length > 512 || /[\u0000-\u001f\u007f]/.test(identity)) {
        throw new SchemaCodecError(`${label} must be at most 512 characters and contain no control characters`);
    }
    return identity;
}

function canonicalAddress(value: string, role: 'path' | 'selector'): string {
    if (value.includes('[*]')) {
        throw new SchemaCodecError(`Legacy indexed wildcard '[*]' is not valid in AEOS ${role}s; use SANSA expansion selectors such as '.*'`);
    }
    const parsed = parseAddress(value);
    if (!parsed.ok) {
        const first = parsed.errors[0];
        const detail = first ? `${first.message} at index ${first.index}` : 'invalid SANSA address';
        throw new SchemaCodecError(`Invalid AEOS ${role} '${value}': ${detail}`);
    }
    if (role === 'path' && !parsed.address.isExact) {
        throw new SchemaCodecError(`AEOS path '${value}' must be an exact SANSA address; use 'selector' for wildcard or filter rules`);
    }
    return renderAddress(parsed.address);
}

function normalizeConstraintMap(input: UnknownRecord, label: string): Readonly<Record<string, ConstraintsV1>> {
    const result: Record<string, ConstraintsV1> = {};
    for (const [key, value] of Object.entries(input)) {
        if (!isRecord(value)) {
            throw new SchemaCodecError(`${label}.${key} must be an object`);
        }
        result[key] = normalizeConstraints(value, `${label}.${key}`);
    }
    return result;
}

function normalizeConstraints(input: UnknownRecord, label: string): ConstraintsV1 {
    if (Array.isArray(input.any_of)) {
        for (let index = 0; index < input.any_of.length; index += 1) {
            if (!isRecord(input.any_of[index])) {
                throw new SchemaCodecError(`${label}.any_of[${index}] must be an object`);
            }
        }
    }
    if (input.attributes !== undefined) {
        if (!isRecord(input.attributes)) {
            throw new SchemaCodecError(`${label}.attributes must be an object`);
        }
        normalizeConstraintMap(input.attributes, `${label}.attributes`);
    }
    return cloneJsonObject(input) as ConstraintsV1;
}

function cloneJsonObject(input: UnknownRecord): UnknownRecord {
    const result: UnknownRecord = {};
    for (const [key, value] of Object.entries(input)) {
        result[key] = cloneJsonValue(value);
    }
    return result;
}

function cloneJsonValue(value: unknown): unknown {
    if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
        return value;
    }
    if (Array.isArray(value)) {
        return value.map(cloneJsonValue);
    }
    if (isRecord(value)) {
        return cloneJsonObject(value);
    }
    throw new SchemaCodecError(`Unsupported schema value: ${String(value)}`);
}

function renderAeonValue(value: JsonLike, indent: number): string {
    if (typeof value === 'string') return renderString(value);
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) {
            throw new SchemaCodecError('Schema numeric values must be finite');
        }
        return String(value);
    }
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    if (value === null) return 'null';
    if (Array.isArray(value)) {
        if (value.length === 0) return '[]';
        const pad = '  '.repeat(indent);
        const childPad = '  '.repeat(indent + 1);
        const rendered = value.map((item) => `${childPad}${renderAeonValue(item, indent + 1)}`);
        return `[\n${rendered.join('\n')}\n${pad}]`;
    }
    const entries = Object.entries(value);
    if (entries.length === 0) return '{}';
    const pad = '  '.repeat(indent);
    const childPad = '  '.repeat(indent + 1);
    const rendered = entries.map(([key, item]) => `${childPad}${renderObjectKey(key)}:${datatypeForValue(item)} = ${renderAeonValue(item, indent + 1)}`);
    return `{\n${rendered.join('\n')}\n${pad}}`;
}

function datatypeForValue(value: JsonLike): string {
    if (typeof value === 'string') return 'string';
    if (typeof value === 'number') return 'number';
    if (typeof value === 'boolean') return 'boolean';
    if (value === null) return 'null';
    if (Array.isArray(value)) {
        const first = value[0];
        if (first === undefined) return 'list';
        if (isJsonObject(first)) return 'list<object>';
        if (Array.isArray(first)) return 'list<list>';
        if (first === null) return 'list<null>';
        return `list<${typeof first}>`;
    }
    return 'object';
}

function isJsonObject(value: JsonLike): value is { readonly [key: string]: JsonLike } {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function renderObjectKey(key: string): string {
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ? key : renderString(key);
}

function renderString(value: string): string {
    return JSON.stringify(value);
}

function optionalString(value: unknown, label: string): string | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || value.length === 0) {
        throw new SchemaCodecError(`${label} must be a non-empty string`);
    }
    return value;
}

function isRecord(value: unknown): value is UnknownRecord {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function formatErrors(errors: readonly unknown[]): string {
    return errors.map((error) => {
        if (error instanceof Error) return error.message;
        if (isRecord(error) && typeof error.message === 'string') return error.message;
        return String(error);
    }).join('\n');
}
