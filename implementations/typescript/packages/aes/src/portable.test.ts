import { describe, it } from 'node:test';
import assert from 'node:assert';
import { tokenize } from '@altopelago/aeon-lexer';
import { parse } from '@altopelago/aeon-parser';
import { emitEvents } from './events.js';
import { resolvePaths } from './paths.js';
import { projectPortableNodeEvents } from './portable.js';

function project(input: string) {
    const parsed = parse(tokenize(input).tokens, { maxAttributeDepth: 8 });
    assert.ok(parsed.document);
    const emitted = emitEvents(resolvePaths(parsed.document, { indexedPaths: true }));
    assert.deepStrictEqual(emitted.errors, []);
    return projectPortableNodeEvents(emitted.events);
}

describe('portable AES node projection', () => {
    it('separates binding, node-head, and child identities at expanded paths', () => {
        const events = project(String.raw`a\BINDING\ = <tag\HEAD\(\CHILD\ = "value")>`);

        assert.deepStrictEqual(
            events.map(({ path, kind, identity }) => ({ path, kind, identity: identity ?? null })),
            [
                { path: '$.a', kind: 'node', identity: 'BINDING' },
                { path: '$.a[0]', kind: 'node-head', identity: 'HEAD' },
                { path: '$.a[0][0]', kind: 'string', identity: 'CHILD' },
            ],
        );
        assert.strictEqual(events[0]?.value, undefined);
        assert.strictEqual(events[1]?.value, 'tag');
        assert.strictEqual(events[1]?.span, undefined);
    });

    it('adds one head index for every crossed nested-node boundary', () => {
        const events = project(String.raw`a = <outer(<inner("leaf")>)>`);

        assert.deepStrictEqual(
            events.map(({ path, kind }) => ({ path, kind })),
            [
                { path: '$.a', kind: 'node' },
                { path: '$.a[0]', kind: 'node-head' },
                { path: '$.a[0][0]', kind: 'node' },
                { path: '$.a[0][0][0]', kind: 'node-head' },
                { path: '$.a[0][0][0][0]', kind: 'string' },
            ],
        );
    });

    it('translates reference targets across node boundaries with document structure', () => {
        const events = project('a = <tag("child")>\ncopy = ~a[0]\nalias = ~>a[0]');

        assert.strictEqual(events.find((event) => event.path === '$.copy')?.value, '$.a[0][0]');
        assert.strictEqual(events.find((event) => event.path === '$.alias')?.value, '$.a[0][0]');
    });

    it('does not embed binding attributes in the node-only projection', () => {
        const events = project(String.raw`a@{x\ATTRIBUTE\ = "metadata"} = <tag("child")>`);

        assert.deepStrictEqual(events.map((event) => event.path), ['$.a', '$.a[0]', '$.a[0][0]']);
        assert.ok(events.every((event) => event.identity !== 'ATTRIBUTE'));
    });
});
