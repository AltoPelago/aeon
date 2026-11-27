import test from 'node:test';
import assert from 'node:assert/strict';
import cases from '../../../../../test-fixtures/aeos-property-selectors.json' with {type:'json'};
import regressions from '../../../../../test-fixtures/aeos-property-regressions.json' with {type:'json'};
import contextRegressions from '../../../../../test-fixtures/aeos-property-context-regressions.json' with {type:'json'};
import rangeAttributeRegressions from '../../../../../test-fixtures/aeos-property-range-attribute-regressions.json' with {type:'json'};
import nestedRegressions from '../../../../../test-fixtures/aeos-property-nested-attribute-regressions.json' with {type:'json'};
import {encodeTelex, PARTIAL_AES_PROFILE, validateTelexRecords as validateAesRecords, type TelexRecord} from '@altopelago/aeon-aes';
import {validate, type ValidateOptions} from './validate.js';
import {validateTelex, validateTelexRecords} from './telex.js';
import type {SchemaV1} from './types/schema.js';

function hasHistoricalNodeRecords(records: readonly TelexRecord[]): boolean {
    return records.some(record => record.kind === 'NodeHead' || (record.kind === 'NodeLiteral' && !record.tag));
}

const exactTagBudgets = new Map([
    ['tag-needs-container-and-head', 0],
    ['tag-exact-budget', 1],
    ['repeated-predicate-shares-budget', 1],
    ['repeated-predicate-exact-budget', 2],
    ['distinct-rules-budget-3', 1],
    ['distinct-rules-budget-4', 2],
    ['identical-rule-cache', 1],
    ['stop-property-work-after-expansion-failure', 1],
    ['closed-world-reuses-resolution', 1],
]);

for (const item of [...cases.tests, ...regressions.tests, ...contextRegressions.tests, ...rangeAttributeRegressions.tests]) {
    test(`AEOS properties: ${item.id}`, () => {
        let records = structuredClone(item.records) as unknown as TelexRecord[];
        let schema = structuredClone(item.schema) as unknown as SchemaV1;
        let expected = item.expected;
        const options = ('options' in item ? item.options : undefined) as ValidateOptions | undefined;
        if (records.some(record => record.path === '$.items[0][0]' && record.kind === 'NodeHead')) {
            // These cases share a two-item fixture. Move each tag to its
            // indexed node and retain the independent scalar child.
            records = records.flatMap(record => {
                if (record.kind === 'NodeHead') return [];
                if (record.path === '$.items[0]') return [{ ...record, tag: 'book' }];
                if (record.path === '$.items[1]') return [{ ...record, tag: 'chapter' }];
                const path = record.path?.replace(/^(\$\.items\[[01]\])\[0\]\[0\]$/u, '$1[0]');
                return path ? [{ ...record, path }] : [record];
            });
            const inspectionLimit = exactTagBudgets.get(item.id);
            if (inspectionLimit !== undefined) {
                schema = { ...schema, resource_policy: { ...schema.resource_policy, max_property_inspections: inspectionLimit } };
            }
            const legacySelector = schema.rules.find(rule => rule.selector?.includes('&headTag('))?.selector;
            if (legacySelector) {
                expected = { ok: false, errors: [{ code: 'invalid_schema_policy', path: legacySelector }] };
            } else if (item.id === 'head-tag-is-not-key') {
                schema = { ...schema, rules: [{ selector: '$.items[0]&key("book")', constraints: { type: 'NumberLiteral' } }] };
            }
        } else if (hasHistoricalNodeRecords(records)) {
            // The frozen head-only cases still cover historical runtimes. In
            // this lane the revised portable reader has no valid such record.
            const validation = validateAesRecords(records, { profile: PARTIAL_AES_PROFILE, maxAttributeDepth: 3 });
            assert.equal(validation.valid, false);
            assert.ok(validation.diagnostics.some(({code}) => ['AES_UNKNOWN_KIND', 'AES_INVALID_TAG'].includes(code)));
            return;
        }

        const before = JSON.stringify({records, schema, options});
        for (let repeat = 0; repeat < 2; repeat++) {
            const results = 'entrypoint' in item && item.entrypoint === 'legacy'
                ? [validate([], schema, options)]
                : [validateTelexRecords(records, schema, options), validateTelex(encodeTelex(records, 'profile' in item ? {profile: item.profile} : {}), schema, options)];
            for (const result of results) {
                assert.equal(result.ok, expected.ok, JSON.stringify(result));
                const actual = result.errors.map(error => ({code:error.code, path:error.path})).sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
                assert.deepEqual(actual, [...expected.errors].sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b))), JSON.stringify(result));
                if (!result.ok) assert.deepEqual(result.guarantees, {});
                assert.equal(JSON.stringify({records, schema, options}), before);
            }
        }
    });
}

test('AEOS tags inspect a wide node once and leave scalar children selectable', () => {
    for (const width of [64, 128]) {
        const records: TelexRecord[] = [
            { path: '$.book', kind: 'NodeLiteral', tag: 'book' },
            ...Array.from({length: width}, (_, index) => ({path: `$.book[${index}]`, kind: 'StringLiteral', value: 'chapter'})),
        ];
        for (const tag of ['book', 'missing']) {
            const schema: SchemaV1 = {
                rules: [
                    {selector: `$.book&tag("${tag}")`, constraints: {type: 'NodeLiteral', min_children: width, max_children: width}},
                    {path: '$.book[0]', constraints: {type: 'StringLiteral', required: true}},
                ],
                resource_policy: {max_property_inspections: 1},
            };
            assert.equal(validateTelex(encodeTelex(records), schema).ok, true);
        }
    }
});

test('AEOS indexed node tags preserve sparse positions and skip absent occurrences', () => {
    for (const index of [999999, 1000000, 9007199254740991]) {
        const address = `$.items[${index}]`;
        const records: TelexRecord[] = [
            {path: '$.items', kind: 'NodeLiteral', tag: 'items'},
            {path: address, kind: 'NodeLiteral', tag: 'book'},
        ];
        const rule: SchemaV1 = {rules: [{selector: '$.items.*&tag("book")', constraints: {type: 'NumberLiteral'}}]};
        const result = validateTelexRecords(records, rule);
        assert.deepEqual(result.errors.map(({code, path}) => ({code, path})), [{code: 'type_mismatch', path: address}]);
    }
});

test('AEOS partial nodes expose authored descendants independently of scaffolds', () => {
    const records: TelexRecord[] = [
        {path: '$.items', kind: 'NodeLiteral', tag: 'items'},
        {path: '$.items[0][0]', kind: 'NodeLiteral', tag: 'book'},
    ];
    const wire = encodeTelex(records, {profile: PARTIAL_AES_PROFILE});
    const missing = '$.items[0]&tag("book")';
    const schema: SchemaV1 = {rules: [
        {selector: '$.items[0][0]&tag("book")', constraints: {type: 'NodeLiteral', required: true}},
        {selector: missing, constraints: {required: true}},
    ]};
    for (const result of [validateTelex(wire, schema), validateTelexRecords(records, schema)]) {
        assert.deepEqual(result.errors.map(({code, path}) => ({code, path})), [{code: 'missing_required_field', path: missing}]);
    }
});

test('AEOS present named node attributes supply key and tag together', () => {
    const records: TelexRecord[] = [
        {path: '$.host', kind: 'StringLiteral', value: 'v'},
        {path: '$.host.@.a', kind: 'NumberLiteral', value: '1'},
        {path: '$.host.@.a.@.book', kind: 'NodeLiteral', tag: 'book'},
    ];
    const schema: SchemaV1 = {rules: [{
        selector: '$.host.@.*.@.*&key("book")&tag("book")',
        constraints: {type: 'NodeLiteral', required: true},
    }]};
    for (const result of [
        validateTelexRecords(records, schema),
        validateTelex(encodeTelex(records, {maxAttributeDepth: 2}), schema, {maxAttributeDepth: 2}),
    ]) {
        assert.equal(result.ok, true, JSON.stringify(result.errors));
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
    if (hasHistoricalNodeRecords(records)) {
        const validation = validateAesRecords(records, {profile: PARTIAL_AES_PROFILE, maxAttributeDepth: 2});
        assert.ok(validation.diagnostics.some(({code}) => ['AES_UNKNOWN_KIND', 'AES_INVALID_TAG'].includes(code)));
        return;
    }
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
