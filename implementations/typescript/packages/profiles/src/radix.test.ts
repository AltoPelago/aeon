import assert from 'node:assert/strict';
import test from 'node:test';
import fixtures from '../../../../../test-fixtures/radix-bases.json' with { type: 'json' };
import contexts from '../../../../../test-fixtures/gp-radix-contexts.json' with { type: 'json' };
import datatypeNames from '../../../../../test-fixtures/radix-datatype-names.json' with { type: 'json' };
import { compile } from './compile.js';

for (const { literal, base } of fixtures.filter(f => f.testSource)) {
    test(`GP validates the exact radix-base value of ${literal} across binding, generic and item contexts`, () => {
        for (const { before, after } of contexts) {
            const source = `${before}${literal}${after}`;
            const core = compile(source, { profile: 'core', mode: 'strict' });
            assert.deepEqual(core.meta?.errors ?? [], [], source);
            for (const mode of ['strict', 'loose'] as const) {
                const result = compile(source, { profile: 'aeon.gp.profile.v1', mode });
                assert.deepEqual(result.meta?.errors?.map(d => d.code) ?? [], base === null ? ['PROFILE_DATATYPE_CLARIFIER_INVALID'] : [], source);
                if (mode === 'strict' && base === null) assert.equal(result.aes.length, 0, source);
            }
        }
    });
}

test('GP keeps radix name and clarifier-kind distinctions', () => {
    for (const { datatype, invalid } of datatypeNames) {
        const source = `mask:${datatype}=%1`;
        const result = compile(source, { profile: 'aeon.gp.profile.v1', mode: 'strict', datatypePolicy: 'allow_custom' });
        assert.deepEqual(result.meta?.errors?.map(d => d.code) ?? [], invalid ? ['PROFILE_DATATYPE_CLARIFIER_INVALID'] : [], source);
    }
    for (const clarifiers of ['"2"', '2, 10', '"2", 2']) {
        const result = compile(`mask:radix[${clarifiers}]=%1`, { profile: 'aeon.gp.profile.v1', mode: 'strict', maxClarifierValues: 2 });
        assert.deepEqual(result.meta?.errors?.map(d => d.code), ['PROFILE_DATATYPE_CLARIFIER_INVALID']);
    }
});

test('GP resolves source numeric separators before exact radix checks', () => {
    for (const literal of ['2_0', '2_0e-1', '6_4.0']) {
        assert.deepEqual(compile(`mask:radix[${literal}]=%1`, { profile: 'aeon.gp.profile.v1', mode: 'strict' }).meta?.errors ?? [], []);
    }
});

test('GP string clarifiers retain quoting, escapes, commas and brackets', () => {
    for (const source of ['mask:sep["a,b"] = ^a1a', 'mask:sep["]"] = ^a1a', String.raw`mask:sep["a\"b"] = ^a1a`, 'mask:sep[".", ":"] = ^1.2:3']) {
        assert.deepEqual(compile(source, { profile: 'aeon.gp.profile.v1', mode: 'strict', maxClarifierValues: 2 }).meta?.errors ?? [], [], source);
    }
});
