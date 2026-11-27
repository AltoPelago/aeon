import test from 'node:test';
import assert from 'node:assert/strict';
import cases from '../../../../../test-fixtures/aeos-property-selectors.json' with {type:'json'};
import regressions from '../../../../../test-fixtures/aeos-property-regressions.json' with {type:'json'};
import contextRegressions from '../../../../../test-fixtures/aeos-property-context-regressions.json' with {type:'json'};
import rangeAttributeRegressions from '../../../../../test-fixtures/aeos-property-range-attribute-regressions.json' with {type:'json'};
import nestedRegressions from '../../../../../test-fixtures/aeos-property-nested-attribute-regressions.json' with {type:'json'};
import {encodeTelex, type TelexRecord} from '@altopelago/aeon-aes';
import {validate, type ValidateOptions} from './validate.js';
import {validateTelex, validateTelexRecords} from './telex.js';
import type {SchemaV1} from './types/schema.js';

for (const item of [...cases.tests, ...regressions.tests, ...contextRegressions.tests, ...rangeAttributeRegressions.tests]) test(`AEOS properties: ${item.id}`, () => {
    const records = structuredClone(item.records) as unknown as TelexRecord[];
    const schema = structuredClone(item.schema) as unknown as SchemaV1;
    const options = ('options' in item ? item.options : undefined) as ValidateOptions | undefined;
    const before = JSON.stringify({records, schema, options});
    for (let repeat = 0; repeat < 2; repeat++) {
        const results = 'entrypoint' in item && item.entrypoint === 'legacy'
            ? [validate([], schema, options)]
            : [validateTelexRecords(records, schema, options), validateTelex(encodeTelex(records, 'profile' in item ? {profile: item.profile} : {}), schema, options)];
        for (const result of results) {
            assert.equal(result.ok, item.expected.ok, JSON.stringify(result));
            const actual = result.errors.map(error => ({code:error.code, path:error.path})).sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
            const expected = [...item.expected.errors].sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
            assert.deepEqual(actual, expected, JSON.stringify(result));
            if (!result.ok) assert.deepEqual(result.guarantees, {});
            assert.equal(JSON.stringify({records, schema, options}), before);
        }
    }
});

test('AEOS property profile inspects intrinsic node tags before direct child traversal', async () => {
    const {compile} = await import('@altopelago/aeon-core');
    const {projectPortableEvents} = await import('@altopelago/aeon-aes');
    const compiled = compile('<book("yes")>\nroot@{<leaf(1)>} = 2');
    assert.deepEqual(compiled.errors, []);
    const schema: SchemaV1 = {rules:[
        {selector:'$.book&tag("book")[0]', constraints:{type:'NumberLiteral', required:true}},
        {selector:'$.root.@.leaf&tag("leaf")[0]', constraints:{type:'NumberLiteral', required:true}},
    ]};
    const portable = projectPortableEvents(compiled.events);
    for (const result of [validateTelexRecords(portable, schema), validateTelex(encodeTelex(portable), schema)]) {
        assert.deepEqual(result.errors.map(error => [error.code, error.path]), [['type_mismatch', '$.book[0]']]);
    }
    const native = validate(compiled.events as Parameters<typeof validate>[0], schema);
    assert.ok(native.errors.some(error => error.code === 'invalid_schema_policy'));
});

test('a scalar node child cannot satisfy a tag predicate', async () => {
    const {compile} = await import('@altopelago/aeon-core');
    const {projectPortableEvents} = await import('@altopelago/aeon-aes');
    const compiled = compile('<book("book", <page>)>');
    assert.deepEqual(compiled.errors, []);
    const records = projectPortableEvents(compiled.events);
    const selector = '$.book[0]&tag("book")';
    const schema: SchemaV1 = {rules:[{selector, constraints:{required:true, type:'NodeLiteral'}}]};
    for (const result of [validateTelexRecords(records, schema), validateTelex(encodeTelex(records), schema)]) {
        assert.deepEqual(result.errors.map(error => [error.code, error.path]), [['missing_required_field', selector]]);
        assert.deepEqual(result.guarantees, {});
    }
});

for (const item of nestedRegressions.tests) test(`AEOS nested attributes: ${item.id}`, () => {
    const records = structuredClone(item.records) as unknown as TelexRecord[];
    const schema = structuredClone(item.schema) as unknown as SchemaV1;
    const before = JSON.stringify({records, schema});
    for (let repeat = 0; repeat < 2; repeat++) {
        const wire = encodeTelex(records, {profile:item.profile, ...item.limits});
        for (const result of [validateTelexRecords(records, schema), validateTelex(wire, schema, item.limits)]) {
            assert.equal(result.ok, item.expected.ok, item.id);
            assert.deepEqual(result.errors.map(({code,path}) => ({code,path})).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))),
                [...item.expected.errors].sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))), item.id);
            if (!result.ok) assert.deepEqual(result.guarantees, {});
            assert.equal(JSON.stringify({records,schema}), before);
        }
    }
});

test('nested Telex keeps the existing default attribute depth limit', () => {
    const item = nestedRegressions.tests[0]!;
    const result = validateTelex(item.telex, item.schema as unknown as SchemaV1);
    assert.equal(result.ok, false);
    assert.equal(result.errors[0]?.code, 'AES_LIMIT_EXCEEDED');
    assert.deepEqual(result.guarantees, {});
});
