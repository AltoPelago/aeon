import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tokenize } from '@altopelago/aeon-lexer';
import { parse } from '@altopelago/aeon-parser';
import { emitEvents, projectPortableEvents, resolvePaths } from '@altopelago/aeon-aes';
import { finalizeJson } from './json.js';
import { finalizePortableJson } from './portable-json.js';

function compileEvents(source: string) {
    const parsed = parse(tokenize(source).tokens, { maxAttributeDepth: 8 });
    assert.ok(parsed.document);
    const emitted = emitEvents(resolvePaths(parsed.document, { indexedPaths: true }));
    assert.deepEqual(emitted.errors, []);
    return emitted.events;
}

describe('portable AES JSON finalization', () => {
    it('materializes flat containers and clone references without a parser AST', () => {
        const result = finalizePortableJson([
            { path: '$.base', kind: 'ObjectNode' },
            { path: '$.base.name', kind: 'StringLiteral', value: 'AEON' },
            { path: '$.base.values', kind: 'ListNode' },
            { path: '$.base.values[0]', kind: 'NumberLiteral', value: '2' },
            { path: '$.base.values[1]', kind: 'NumberLiteral', value: '3' },
            { path: '$.copy', kind: 'CloneReference', value: '$.base' },
        ]);

        assert.deepEqual(result.document, {
            base: { name: 'AEON', values: [2, 3] },
            copy: { name: 'AEON', values: [2, 3] },
        });
        assert.equal(result.meta?.errors?.length ?? 0, 0);
    });

    it('matches the legacy JSON result for a rich AEON-origin stream', () => {
        const events = compileEvents(String.raw`config\ROOT\@{scope\META\ = "test"} = {
  title:string = "Demo"
  values:list<int> = [2, 3, 4]
  card:node = <tag\HEAD\@{role = "button"}(\CHILD\@{lang = "en"}:string = "hello", true)>
}
copy = ~config.values
pointer = ~>config.title`);
        const legacy = finalizeJson(events, { mode: 'loose' });
        const portable = finalizePortableJson(projectPortableEvents(events), { mode: 'loose' });

        assert.deepEqual(portable.document, legacy.document);
        assert.deepEqual(
            portable.meta?.warnings?.map(({ code, path }) => ({ code, path })),
            legacy.meta?.warnings?.map(({ code, path }) => ({ code, path })),
        );
    });

    it('applies clone depth and materialized-weight limits', () => {
        const records = [
            { path: '$.base', kind: 'ObjectNode' },
            { path: '$.base.a', kind: 'NumberLiteral', value: '1' },
            { path: '$.base.b', kind: 'NumberLiteral', value: '2' },
            { path: '$.copy1', kind: 'CloneReference', value: '$.base' },
            { path: '$.copy2', kind: 'CloneReference', value: '$.copy1' },
        ] as const;
        const depth = finalizePortableJson(records, { maxReferenceDepth: 1 });
        const weight = finalizePortableJson(records, { maxMaterializedWeight: 3 });

        assert.ok(depth.meta?.errors?.some((diagnostic) => diagnostic.code === 'FINALIZE_REFERENCE_DEPTH_EXCEEDED'));
        assert.ok(weight.meta?.errors?.some((diagnostic) => diagnostic.code === 'FINALIZE_REFERENCE_BUDGET_EXCEEDED'));
    });

    it('rejects portable multi-head nodes that the JSON profile cannot represent', () => {
        const result = finalizePortableJson([
            { path: '$.value', kind: 'NodeLiteral' },
            { path: '$.value[0]', kind: 'NodeHead', value: 'first' },
            { path: '$.value[1]', kind: 'NodeHead', value: 'second' },
        ]);

        assert.equal(result.document.value, null);
        assert.ok(result.meta?.errors?.some((diagnostic) => diagnostic.code === 'FINALIZE_UNREPRESENTABLE_NODE_HEADS'));
    });

    it('rejects sparse indexes without allocating up to an attacker-controlled index', () => {
        const result = finalizePortableJson([
            { path: '$.values', kind: 'ListNode' },
            { path: '$.values[999999999999999999999999]', kind: 'StringLiteral', value: 'far away' },
        ]);

        assert.deepEqual(result.document, { values: [] });
        assert.ok(result.meta?.errors?.some((diagnostic) => diagnostic.code === 'FINALIZE_NON_CONTIGUOUS_INDEX'));
    });
});
