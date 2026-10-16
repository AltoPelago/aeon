import assert from 'node:assert/strict';
import test from 'node:test';
import fixtures from '../../../../../test-fixtures/radix-bases.json' with { type: 'json' };
import { tokenize } from '@altopelago/aeon-lexer';
import { parse } from '@altopelago/aeon-parser';
import { emitEvents, projectPortableEvents, resolvePaths } from '@altopelago/aeon-aes';
import { finalizeJson } from './json.js';
import { finalizePortableJson } from './portable-json.js';

for (const { literal, base } of fixtures.filter(f => f.testSource)) {
    test(`source/portable radix finalization agrees for ${literal}`, () => {
        for (const payload of ['1', '2']) {
            const parsed = parse(tokenize(`mask:radix[${literal}]=%${payload}`).tokens);
            assert.deepEqual(parsed.errors, []);
            assert.ok(parsed.document);
            const emitted = emitEvents(resolvePaths(parsed.document, { indexedPaths: true }));
            assert.deepEqual(emitted.errors, []);
            const records = projectPortableEvents(emitted.events);
            for (const mode of ['strict', 'loose'] as const) {
                const legacy = finalizeJson(emitted.events, { mode });
                const portable = finalizePortableJson(records, { mode });
                const diagnostics = (result: typeof legacy) => result.meta?.[mode === 'strict' ? 'errors' : 'warnings']?.map(d => ({ code: d.code, path: d.path })) ?? [];
                assert.deepEqual(portable.document, legacy.document);
                assert.deepEqual(diagnostics(portable), diagnostics(legacy));
                assert.equal(diagnostics(legacy).length > 0, base === null || Number(payload) >= base);
                for (const diagnostic of diagnostics(legacy)) assert.equal(diagnostic.code, 'FINALIZE_INVALID_RADIX_BASE');
            }
        }
    });
}

test('invalid and absent portable radix clarifiers remain distinct', () => {
    for (const clarifiers of [[], [{ kind: 'StringLiteral', value: '2' }], [{ kind: 'NumberLiteral', value: '2' }, { kind: 'NumberLiteral', value: '10' }]] as const) {
        const result = finalizePortableJson([{ path: '$.mask', kind: 'RadixLiteral', value: '1', datatype: 'radix', generics: [], clarifiers }], { maxClarifierValues: 2 });
        assert.equal((result.meta?.errors?.length ?? 0) > 0, clarifiers.length > 0);
    }
});

test('source numeric separators normalize before radix-base interpretation', () => {
    for (const [payload, invalid] of [['J', false], ['K', true]] as const) {
        const parsed = parse(tokenize(`mask:radix[2_0]=%${payload}`).tokens);
        assert.ok(parsed.document);
        const events = emitEvents(resolvePaths(parsed.document, { indexedPaths: true })).events;
        assert.equal(events[0]?.datatype, 'radix[20]');
        for (const result of [finalizeJson(events), finalizePortableJson(projectPortableEvents(events))]) {
            assert.equal((result.meta?.errors?.length ?? 0) > 0, invalid);
        }
    }
});
