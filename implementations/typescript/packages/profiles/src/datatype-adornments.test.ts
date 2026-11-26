import assert from 'node:assert/strict';
import test from 'node:test';
import fixtures from '../../../../../test-fixtures/gp-datatype-generics.json' with { type: 'json' };
import { compile } from './compile.js';

for (const fixture of fixtures) {
    test(`profile datatype adornments: ${fixture.id}`, () => {
        const core = compile(fixture.source, {});
        assert.deepEqual(core.meta?.errors ?? [], []);

        const permissive = compile(fixture.source, { profile: 'set.to.eleven.v1' });
        assert.equal(permissive.meta?.profileId, 'set.to.eleven.v1');
        assert.deepEqual(permissive.meta?.errors ?? [], []);
        assert.deepEqual(permissive.aes, core.aes);

        const gp = compile(fixture.source, { profile: 'aeon.gp.profile.v1' });
        assert.deepEqual(gp.meta?.errors?.map(({ code, path }) => ({ code, path })) ?? [], fixture.errors);
        assert.deepEqual(gp.aes, fixture.errors.length ? [] : core.aes);
    });
}

test('the test profile uses Core syntax, limits, and literal-family validation', () => {
    const profile = 'set.to.eleven.v1';
    for (const [source, code] of [
        ['a:symbol<1> = |approved|', 'SYNTAX_ERROR'],
        ['a:string<Locale>["en", "AU"] = "hello"', 'CLARIFIER_VALUES_EXCEEDED'],
        ['a:string<Language, Region> = "hello"', 'GENERIC_ARGUMENTS_EXCEEDED'],
        ['aeon:mode = "strict"\na:node<radix[2]> = 1', 'DATATYPE_LITERAL_MISMATCH'],
    ] as const) {
        const result = compile(source, { profile, maxGenericArguments: 1 });
        assert.equal(result.meta?.errors?.[0]?.code, code, source);
        assert.deepEqual(result.aes, []);
    }

    const result = compile('a:string<Locale>["en", 9007199254740993] = "hello"', { profile, maxClarifierValues: 2 });
    assert.deepEqual(result.meta?.errors ?? [], []);
    assert.equal(result.aes[0]?.datatype, 'string<Locale>["en", 9007199254740993]');
});
