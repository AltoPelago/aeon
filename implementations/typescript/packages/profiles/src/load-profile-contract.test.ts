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
  separator = { literal_family = "SeparatorLiteral", clarifiers = "separator_chars", alias_of = "sep" }
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
    assert.equal(error('<tag>\na:node<number> = ~tag', original), genericNotAllowed);
    assert.equal(error('<tag>\na:node<number> = ~tag', revised), undefined);
    assert.equal(error('<tag:node<number>>', original), undefined);
    assert.equal(error('<tag:node<number>>', revised), genericNotAllowed);
    assert.equal(error('<tag:list<number>>', revised), 'DATATYPE_LITERAL_MISMATCH');

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

test('applies loaded defaults and honors trusted overrides', () => {
    const profile = createProfile(loadProfileContract(contract
        .replace('mode_default = "transport"', 'mode_default = "strict"')));
    const reservedOnly = createProfile(loadProfileContract(contract
        .replace('mode_default = "transport"', 'mode_default = "strict"')
        .replace('datatype_policy_default = "allow_custom"', 'datatype_policy_default = "reserved_only"')));
    const errors = (result: ReturnType<typeof compile>) => result.meta?.errors?.map(({ code }) => code) ?? [];

    assert.deepEqual(errors(compile('a = 3', { profile })), ['UNTYPED_VALUE_IN_STRICT_MODE']);
    const authoredTransport = 'aeon:header = { mode = "transport" }\na = 3';
    assert.deepEqual(errors(compile(authoredTransport, { profile })), ['UNTYPED_VALUE_IN_STRICT_MODE']);
    const registry = createDefaultRegistry().register(profile);
    assert.deepEqual(errors(compile(authoredTransport, { profile: profile.id, registry, effectiveMode: 'transport' })), []);
    assert.deepEqual(errors(compile(authoredTransport, {})), []);

    const custom = 'a:Box<n> = [1]';
    assert.deepEqual(errors(compile(custom, { profile })), []);
    assert.deepEqual(errors(compile(custom, { profile: reservedOnly })), ['CUSTOM_DATATYPE_NOT_ALLOWED']);
    assert.deepEqual(errors(compile(custom, { profile: reservedOnly, datatypePolicy: 'allow_custom' })), []);
    assert.deepEqual(errors(compile(custom, { profile, datatypePolicy: 'reserved_only' })), ['CUSTOM_DATATYPE_NOT_ALLOWED']);

    const permissive = createProfile(loadProfileContract(contract));
    assert.deepEqual(errors(compile('aeon:mode = "strict"\na = 3', { profile: permissive })), []);
    const unspecified = createProfile(loadProfileContract(contract.replace('mode_default = "transport"\n', '')));
    assert.deepEqual(errors(compile('aeon:mode = "strict"\na = 3', { profile: unspecified })), ['UNTYPED_VALUE_IN_STRICT_MODE']);
});

test('checks the declared literal family of an admitted alias', () => {
    const profile = createProfile(loadProfileContract(contract.replace('custom_labels = true', 'custom_labels = false')));
    for (const [source, effectiveMode, datatypePolicy, path] of [
        ['a:separator["."] = "a.b"', 'strict', 'allow_custom', '$.a'],
        ['a:separator = "a.b"', 'transport', 'allow_custom', '$.a'],
        ['b:string = "a.b"\na:separator["."] = ~b', 'strict', 'allow_custom', '$.a'],
        ['a@{part:separator["."] = "a.b"}:n = 1', 'transport', 'reserved_only', '$.a.@.part'],
        ['a:list = [:separator["."] = "a.b"]', 'transport', 'reserved_only', '$.a[0]'],
        ['a:sep["."] = "a.b"', 'strict', 'allow_custom', '$.a'],
        ['a@{<tag:node("wrong")>}:n=1\nb@{p:separator["."] = ~a.@.tag[0]}:n=2',
            'strict', 'allow_custom', '$.b.@.p'],
    ] as const) {
        const result = compile(source, { profile, effectiveMode, datatypePolicy });
        assert.deepEqual(result.meta?.errors?.map(({ code, path }) => ({ code, path })),
            [{ code: 'DATATYPE_LITERAL_MISMATCH', path }], source);
        assert.deepEqual(result.aes, []);
    }
    const result = compile('b@{<tag:node(^a.b)>}:n=1\na:separator["."] = ~b.@.tag[0]', {
        profile, effectiveMode: 'strict', datatypePolicy: 'allow_custom',
    });
    assert.deepEqual(result.meta?.errors ?? [], []);
    assert.equal(result.aes.at(-1)?.datatype, 'separator["."]');
    assert.equal(result.aes.at(-1)?.value.type, 'CloneReference');
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

test('distinguishes general encoding and base64 when classifying a shared reference target', () => {
    const profile = createProfile(loadProfileContract(contract.replace(
        '  separator =',
        '  packet = { literal_family = "EncodingLiteral", clarifiers = "none", alias_of = "encoding" }\n  separator =',
    )));
    for (const claims of ['good:packet = ~base\nbad:base64 = ~base', 'bad:base64 = ~base\ngood:packet = ~base']) {
        const result = compile(`base:encoding = &A\n${claims}`, { profile, mode: 'loose' });
        assert.deepEqual(result.meta?.errors?.map(({ code, path }) => ({ code, path })),
            [{ code: 'DATATYPE_LITERAL_MISMATCH', path: '$.bad' }]);
    }
});
