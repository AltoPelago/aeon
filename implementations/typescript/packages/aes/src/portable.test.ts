import { describe, it } from 'node:test';
import assert from 'node:assert';
import { tokenize } from '@altopelago/aeon-lexer';
import { parse } from '@altopelago/aeon-parser';
import { emitEvents } from './events.js';
import { resolvePaths } from './paths.js';
import { projectPortableEvents } from './portable.js';

function project(input: string) {
    const parsed = parse(tokenize(input).tokens, { maxAttributeDepth: 8 });
    assert.ok(parsed.document);
    const emitted = emitEvents(resolvePaths(parsed.document, { indexedPaths: true }));
    assert.deepStrictEqual(emitted.errors, []);
    return projectPortableEvents(emitted.events);
}

describe('portable AES projection', () => {
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

    it('flattens nested binding, node-head, and anonymous-child attributes in preorder', () => {
        const events = project(String.raw`a\ROOT\@{x\X\@{deep\D\ = 3} = { b\B\ = 2 }} = <tag\HEAD\@{role\R\ = "button"}(\CHILD\@{unit\U\ = "cm"} = "value")>`);

        assert.deepStrictEqual(
            events.map(({ path, kind, identity }) => ({ path, kind, identity: identity ?? null })),
            [
                { path: '$.a', kind: 'node', identity: 'ROOT' },
                { path: '$.a.@.x', kind: 'object', identity: 'X' },
                { path: '$.a.@.x.@.deep', kind: 'number', identity: 'D' },
                { path: '$.a.@.x.b', kind: 'number', identity: 'B' },
                { path: '$.a[0]', kind: 'node-head', identity: 'HEAD' },
                { path: '$.a[0].@.role', kind: 'string', identity: 'R' },
                { path: '$.a[0][0]', kind: 'string', identity: 'CHILD' },
                { path: '$.a[0][0].@.unit', kind: 'string', identity: 'U' },
            ],
        );
    });

    it('recursively expands node values inside attribute space', () => {
        const events = project(String.raw`a@{x = <inner\HEAD\(\CHILD\ = "value")>} = 1`);

        assert.deepStrictEqual(events.map(({ path, kind }) => ({ path, kind })), [
            { path: '$.a', kind: 'number' },
            { path: '$.a.@.x', kind: 'node' },
            { path: '$.a.@.x[0]', kind: 'node-head' },
            { path: '$.a.@.x[0][0]', kind: 'string' },
        ]);
    });

    it('uses canonical quoted member spelling in attribute paths', () => {
        const events = project('a@{"x.y" = { "deep key" = 1 }} = 0');

        assert.deepStrictEqual(events.map((event) => event.path), [
            '$.a',
            '$.a.@.["x.y"]',
            '$.a.@.["x.y"].["deep key"]',
        ]);
    });
});
