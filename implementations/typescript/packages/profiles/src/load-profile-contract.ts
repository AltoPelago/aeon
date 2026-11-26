import type { AssignmentEvent } from '@altopelago/aeon-aes';
import { compile } from '@altopelago/aeon-core';
import { isReservedDatatypeName } from './reserved-datatypes.js';
import type { DatatypeSemantics, GenericAdmissionPolicy, ProfilePolicy } from './types.js';

const PROFILE_FIELDS = [
    'profile_id', 'profile_version', 'core_id', 'description', 'mode_default', 'datatype_policy_default',
    'collections', 'containers', 'datatype_semantics', 'generic_admission', 'capabilities',
];
const GENERIC_FIELDS = [
    'reserved_datatypes', 'custom_labels', 'custom_value_kinds', 'node_head_datatypes',
    'binding_node_reserved_arguments',
];
const CLARIFIER_RULES = ['none', 'radix_base', 'separator_chars', 'encoding_name'] as const;
const LITERAL_KINDS = [
    'StringLiteral', 'TrimtickStringLiteral', 'NumberLiteral', 'InfinityLiteral', 'NaNLiteral', 'NullLiteral',
    'BooleanLiteral', 'ToggleLiteral', 'HexLiteral', 'RadixLiteral', 'EncodingLiteral', 'SeparatorLiteral',
    'SymbolicLiteral', 'SansaAddressLiteral', 'DateLiteral', 'TimeLiteral', 'DateTimeLiteral', 'WTCDateTimeLiteral',
];
const VALUE_KINDS = new Set([...LITERAL_KINDS, 'ListNode', 'TupleLiteral', 'ObjectNode', 'NodeLiteral']);
const DATATYPE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

type Value = AssignmentEvent['value'];
type Fields = ReadonlyMap<string, Value>;

function invalid(path: string, reason: string): never {
    throw new Error(`Invalid AEON profile contract at ${path}: ${reason}`);
}

function fields(value: Value | undefined, path: string, keys?: readonly string[]): Fields {
    if (value?.type !== 'ObjectNode' || value.attributes.length > 0) {
        return invalid(path, 'expected a plain object');
    }
    const result = new Map<string, Value>();
    for (const binding of value.bindings) {
        if (binding.attributes.length || binding.structuralId || binding.datatype) {
            invalid(`${path}.${binding.key}`, 'contract fields use plain bindings');
        }
        result.set(binding.key, binding.value);
    }
    checkKeys(result, path, keys);
    return result;
}

function checkKeys(fields: Fields, path: string, keys?: readonly string[]): void {
    for (const key of fields.keys()) {
        if (keys && !keys.includes(key)) invalid(`${path}.${key}`, 'unsupported field');
    }
}

function string(value: Value | undefined, path: string): string {
    if (value?.type !== 'StringLiteral') return invalid(path, 'expected a string');
    return value.value;
}

function boolean(value: Value | undefined, path: string): boolean {
    if (value?.type !== 'BooleanLiteral') return invalid(path, 'expected a boolean');
    return value.value;
}

function optionalString(fields: Fields, key: string, path: string): string | undefined {
    return fields.has(key) ? string(fields.get(key), `${path}.${key}`) : undefined;
}

function choice<T extends string>(value: Value | undefined, allowed: readonly T[], path: string): T {
    const text = string(value, path);
    const selected = allowed.find(option => option === text);
    return selected ?? invalid(path, `unsupported value ${JSON.stringify(text)}`);
}

function names(value: Value | undefined, path: string, allowed: (name: string) => boolean): readonly string[] {
    if (value?.type !== 'ListNode' || value.attributes.length > 0) return invalid(path, 'expected a plain list');
    const result = new Set<string>();
    for (const [index, item] of value.elements.entries()) {
        const itemPath = `${path}[${index}]`;
        const name = string(item, itemPath);
        if (!allowed(name)) invalid(itemPath, `unsupported name ${JSON.stringify(name)}`);
        if (result.has(name)) invalid(itemPath, `duplicate name ${JSON.stringify(name)}`);
        result.add(name);
    }
    return Object.freeze([...result]);
}

function readGenericAdmission(value: Value | undefined): GenericAdmissionPolicy {
    const path = '$.generic_admission';
    const record = fields(value, path, GENERIC_FIELDS);
    return Object.freeze({
        reservedDatatypes: names(record.get('reserved_datatypes'), `${path}.reserved_datatypes`, isReservedDatatypeName),
        customLabels: boolean(record.get('custom_labels'), `${path}.custom_labels`),
        customValueKinds: names(record.get('custom_value_kinds'), `${path}.custom_value_kinds`, name => VALUE_KINDS.has(name)),
        nodeHeadDatatypes: names(record.get('node_head_datatypes'), `${path}.node_head_datatypes`, name => DATATYPE_NAME.test(name)),
        bindingNodeReservedArguments: names(record.get('binding_node_reserved_arguments'), `${path}.binding_node_reserved_arguments`, isReservedDatatypeName),
    });
}

function readDatatypeSemantics(value: Value | undefined): ProfilePolicy['datatypeSemantics'] {
    const rules = fields(value, '$.datatype_semantics');
    const entries = new Map<string, DatatypeSemantics>();
    for (const [name, value] of rules) {
        const path = `$.datatype_semantics.${name}`;
        if (!DATATYPE_NAME.test(name)) invalid(path, 'expected a datatype name');
        const rule = fields(value, path, ['literal_family', 'clarifiers', 'alias_of', 'equivalent_to']);
        const aliasOf = optionalString(rule, 'alias_of', path);
        const equivalentTo = optionalString(rule, 'equivalent_to', path);
        entries.set(name, Object.freeze({
            literalFamily: choice(rule.get('literal_family'), LITERAL_KINDS, `${path}.literal_family`),
            clarifiers: choice(rule.get('clarifiers'), CLARIFIER_RULES, `${path}.clarifiers`),
            ...(aliasOf === undefined ? {} : { aliasOf }),
            ...(equivalentTo === undefined ? {} : { equivalentTo }),
        }));
    }
    return Object.freeze(Object.fromEntries(entries));
}

function readCollections(value: Value | undefined): NonNullable<ProfilePolicy['collections']> {
    const collections = fields(value, '$.collections', ['list', 'tuple']);
    return Object.freeze(Object.fromEntries([...collections].map(([name, value]) => {
        const path = `$.collections.${name}`;
        const record = fields(value, path, ['ordered', 'heterogeneous', 'unique', 'fixed_length']);
        return [name, Object.freeze({
            ordered: boolean(record.get('ordered'), `${path}.ordered`),
            heterogeneous: boolean(record.get('heterogeneous'), `${path}.heterogeneous`),
            unique: boolean(record.get('unique'), `${path}.unique`),
            fixedLength: boolean(record.get('fixed_length'), `${path}.fixed_length`),
        })];
    })));
}

function readContainers(value: Value | undefined): NonNullable<ProfilePolicy['containers']> {
    const containers = fields(value, '$.containers', ['object', 'node']);
    const objectPath = '$.containers.object';
    const nodePath = '$.containers.node';
    const result: Record<string, NonNullable<ProfilePolicy['containers']>[string]> = {};
    if (containers.has('object')) {
        const object = fields(containers.get('object'), objectPath, ['ordered', 'heterogeneous', 'unique_keys']);
        result.object = Object.freeze({
            ordered: boolean(object.get('ordered'), `${objectPath}.ordered`),
            heterogeneous: boolean(object.get('heterogeneous'), `${objectPath}.heterogeneous`),
            uniqueKeys: boolean(object.get('unique_keys'), `${objectPath}.unique_keys`),
        });
    }
    if (containers.has('node')) {
        const node = fields(containers.get('node'), nodePath, ['ordered', 'heterogeneous', 'unique_attributes', 'mixed_content']);
        result.node = Object.freeze({
            ordered: boolean(node.get('ordered'), `${nodePath}.ordered`),
            heterogeneous: boolean(node.get('heterogeneous'), `${nodePath}.heterogeneous`),
            uniqueAttributes: boolean(node.get('unique_attributes'), `${nodePath}.unique_attributes`),
            mixedContent: boolean(node.get('mixed_content'), `${nodePath}.mixed_content`),
        });
    }
    return Object.freeze(result);
}

/** Decode a caller-selected AEON profile artifact without applying a profile to the artifact itself. */
export function loadProfileContract(source: string): ProfilePolicy {
    const parsed = compile(source, { mode: 'transport', emitAnnotations: false });
    const error = parsed.errors[0];
    if (error) invalid('$', `${error.code}: ${error.message}`);
    if (parsed.header) invalid('$', 'profile contracts use body bindings only');

    const bindings = new Map<string, Value>();
    for (const event of parsed.events) {
        if (event.path.segments.length !== 2) continue;
        if (event.annotations?.size || event.structuralId || event.datatype) {
            invalid(`$.${event.key}`, 'contract fields use plain bindings');
        }
        bindings.set(event.key, event.value);
    }
    checkKeys(bindings, '$', PROFILE_FIELDS);
    const id = string(bindings.get('profile_id'), '$.profile_id');
    if (!id || id !== id.trim()) invalid('$.profile_id', 'expected a nonempty profile identifier');
    const version = string(bindings.get('profile_version'), '$.profile_version');
    const versionMatch = VERSION.exec(version);
    if (!versionMatch || versionMatch[1]?.split('.').some(part => /^0\d+$/.test(part))) {
        invalid('$.profile_version', 'expected a semantic version');
    }
    const coreId = choice(bindings.get('core_id'), ['aeon.core.v1'] as const, '$.core_id');
    const description = optionalString(bindings, 'description', '$');
    const declaredMode = bindings.has('mode_default')
        ? choice(bindings.get('mode_default'), ['strict', 'transport'] as const, '$.mode_default') : undefined;
    const datatypePolicyDefault = bindings.has('datatype_policy_default')
        ? choice(bindings.get('datatype_policy_default'), ['reserved_only', 'allow_custom'] as const, '$.datatype_policy_default') : undefined;
    const capabilities = fields(bindings.get('capabilities'), '$.capabilities', ['references', 'clones']);

    return Object.freeze({
        id, version, coreId,
        ...(description === undefined ? {} : { description }),
        ...(declaredMode === undefined ? {} : { modeDefault: declaredMode === 'transport' ? 'loose' as const : declaredMode }),
        ...(datatypePolicyDefault === undefined ? {} : { datatypePolicyDefault }),
        collections: readCollections(bindings.get('collections')),
        containers: readContainers(bindings.get('containers')),
        datatypeSemantics: readDatatypeSemantics(bindings.get('datatype_semantics')),
        genericAdmission: readGenericAdmission(bindings.get('generic_admission')),
        capabilities: Object.freeze({
            references: boolean(capabilities.get('references'), '$.capabilities.references'),
            clones: boolean(capabilities.get('clones'), '$.capabilities.clones'),
        }),
    });
}
