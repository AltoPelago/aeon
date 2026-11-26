import assert from 'node:assert/strict';
import test from 'node:test';
import { compile, createDefaultRegistry, createProfile, loadProfileContract } from './index.js';

const contract = `
profile_id = "test.generic.profile.v1"
profile_version = "1.1.0"
core_id = "aeon.core.v1"
description = "Test contract"
mode_default = "transport"
datatype_policy_default = "allow_custom"
collections = { list = { ordered = false, heterogeneous = true, unique = false, fixed_length = false } }
containers = {
  object = { ordered = false, heterogeneous = true, unique_keys = true }
  node = { ordered = true, heterogeneous = true, unique_attributes = true, mixed_content = true }
}
datatype_semantics = {
  symbol = { literal_family = "SymbolicLiteral", clarifiers = "none" }
  encoding = { literal_family = "EncodingLiteral", clarifiers = "encoding_name" }
  decimal = { literal_family = "RadixLiteral", clarifiers = "none", equivalent_to = "radix[10]" }
}
generic_admission = {
  reserved_datatypes = ["symbol", "list", "node"]
  custom_labels = true
  custom_value_kinds = ["ListNode", "TupleLiteral"]
  node_head_datatypes = ["node"]
  binding_node_reserved_arguments = ["node"]
}
capabilities = { references = true, clones = true }
`;

test('loads contract metadata and immutable rules into a reusable executable profile', () => {
    const policy = loadProfileContract(contract);
    assert.equal(policy.coreId, 'aeon.core.v1');
    assert.equal(policy.modeDefault, 'loose');
    assert.equal(policy.datatypePolicyDefault, 'allow_custom');
    assert.equal(policy.collections?.list?.fixedLength, false);
    assert.deepEqual(policy.containers?.node, {
        ordered: true, heterogeneous: true, uniqueAttributes: true, mixedContent: true,
    });
    assert.equal(policy.datatypeSemantics.decimal?.equivalentTo, 'radix[10]');
    assert.ok(Object.isFrozen(policy));
    assert.ok(Object.isFrozen(policy.genericAdmission.reservedDatatypes));
    assert.ok(Object.isFrozen(policy.datatypeSemantics.symbol));
    assert.ok(Object.isFrozen(policy.collections?.list));
    const profile = createProfile(policy);
    const registry = createDefaultRegistry().register(profile);

    const allowed = compile('duration:symbol<time> = |1min|', { profile: profile.id, registry });
    assert.equal(allowed.meta?.version, '1.1.0');
    assert.equal(allowed.aes[0]?.datatype, 'symbol<time>');
    assert.deepEqual(allowed.meta?.errors ?? [], []);
    const rejected = compile('duration:symbol<time>["minutes"] = |1min|', { profile });
    assert.equal(rejected.meta?.errors?.[0]?.code, 'PROFILE_DATATYPE_CLARIFIER_NOT_ALLOWED');
    assert.equal(compile('duration:symbol<time> = |1min|', { profile }).aes.length, 1);
});

test('reads generic admission and clarifier decisions from the artifact', () => {
    const original = createProfile(loadProfileContract(contract));
    const revised = createProfile(loadProfileContract(contract
        .replace('["symbol", "list", "node"]', '["number", "list", "node"]')
        .replace('["ListNode", "TupleLiteral"]', '["SymbolicLiteral"]')
        .replace('node_head_datatypes = ["node"]', 'node_head_datatypes = ["list"]')
        .replace('binding_node_reserved_arguments = ["node"]', 'binding_node_reserved_arguments = ["number"]')
        .replace('clarifiers = "encoding_name"', 'clarifiers = "none"')));
    const error = (source: string, profile: typeof original) => compile(source, { profile }).meta?.errors?.[0]?.code;
    const genericNotAllowed = 'PROFILE_DATATYPE_GENERIC_NOT_ALLOWED';

    assert.equal(error('a:number<time> = 1', original), genericNotAllowed);
    assert.equal(error('a:number<time> = 1', revised), undefined);
    assert.equal(error('a:symbol<time> = |1min|', revised), genericNotAllowed);
    assert.equal(error('a:node<number> = <tag>', original), genericNotAllowed);
    assert.equal(error('a:node<number> = <tag>', revised), undefined);
    assert.equal(error('a:node = <tag:node<number>>', original), undefined);
    assert.equal(error('a:node = <tag:node<number>>', revised), genericNotAllowed);
    assert.equal(error('a:node = <tag:list<number>>', revised), undefined);

    const customSource = 'aeon:mode = "custom"\nv:rational<number> = |1/3|';
    assert.equal(error(customSource, original), 'DATATYPE_LITERAL_MISMATCH');
    assert.equal(error(customSource, revised), undefined);
    const noCustom = createProfile(loadProfileContract(contract.replace('custom_labels = true', 'custom_labels = false')));
    assert.equal(error(customSource, noCustom), genericNotAllowed);

    const encoding = 'a:encoding["base58"] = &FFF';
    assert.equal(error(encoding, original), undefined);
    assert.equal(error(encoding, revised), 'PROFILE_DATATYPE_CLARIFIER_NOT_ALLOWED');
    assert.equal(error('a:radix16[2] = %F', original), 'PROFILE_DATATYPE_CLARIFIER_NOT_ALLOWED');
});

test('rejects invalid syntax, versions, and unsupported policy rules', () => {
    for (const [source, expected] of [
        [contract + 'unknown = true\n', /\$\.unknown: unsupported field/],
        [contract + 'profile_id = "other"\n', /DUPLICATE_KEY/],
        [contract + 'unfinished =', /SYNTAX_ERROR/],
        [contract.replace('"aeon.core.v1"', '"aeon.core.v2"'), /\$\.core_id: unsupported value/],
        [contract.replace('"1.1.0"', '"1.1"'), /\$\.profile_version: expected a semantic version/],
        [contract.replace('"1.1.0"', '"1.1.0-01"'), /\$\.profile_version: expected a semantic version/],
        [contract.replace('custom_labels = true', 'custom_labels = "true"'), /custom_labels: expected a boolean/],
        [contract.replace('"TupleLiteral"', '"UnknownLiteral"'), /custom_value_kinds\[1\]: unsupported name/],
        [contract.replace('"symbol", "list", "node"', '"symbol", "symbol", "node"'), /reserved_datatypes\[1\]: duplicate name/],
        [contract.replace('clarifiers = "none"', 'clarifiers = "unknown"'), /datatype_semantics\.symbol\.clarifiers: unsupported value/],
        [contract.replace('custom_labels = true', 'custom_labels = true\n  extension = true'), /generic_admission\.extension: unsupported field/],
        [contract.replace('custom_labels = true', 'custom_labels = ~collections.list.heterogeneous'), /custom_labels: expected a boolean/],
        ['aeon:mode = "strict"\n' + contract, /profile contracts use body bindings only/],
    ] as const) {
        assert.throws(() => loadProfileContract(source), expected);
    }
});
