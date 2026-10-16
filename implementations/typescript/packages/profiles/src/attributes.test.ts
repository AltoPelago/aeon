import assert from 'node:assert/strict';
import test from 'node:test';
import fixtures from '../../../../../test-fixtures/gp-attribute-clarifiers.json' with { type: 'json' };
import tagHeadFixtures from '../../../../../test-fixtures/gp-tag-head-clarifiers.json' with { type: 'json' };
import { compile } from './compile.js';

for (const fixture of [...fixtures, ...tagHeadFixtures]) {
    test(`GP unprojected claims: ${fixture.id}`, () => {
        const options = { datatypePolicy: 'allow_custom', maxAttributeDepth: 2, maxClarifierValues: 2 } as const;
        const core = compile(fixture.source, { ...options, profile: 'core', mode: 'strict' });
        assert.deepEqual(core.meta?.errors ?? [], [], fixture.source);
        for (const mode of ['strict', 'loose'] as const) {
            const result = compile(fixture.source, { ...options, profile: 'aeon.gp.profile.v1', mode });
            assert.deepEqual(result.meta?.errors?.map(({ code, path }) => ({ code, path })) ?? [], fixture.errors, fixture.source);
            if (mode === 'strict' && fixture.errors.length) assert.equal(result.aes.length, 0);
        }
    });
}
