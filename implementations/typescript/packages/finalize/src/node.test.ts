import { describe, it } from 'node:test';
import assert from 'node:assert';
import { finalizeNode } from './node.js';
import { tokenize } from '@aeon/lexer';
import { parse } from '@aeon/parser';
import { resolvePaths, emitEvents } from '@aeon/aes';

function compileToEvents(input: string, _legacySyntaxFlag: boolean = false) {
    const tokens = tokenize(input).tokens;
    const ast = parse(tokens);
    if (!ast.document) throw new Error('Parse failed');
    const resolved = resolvePaths(ast.document, { indexedPaths: true });
    const emitted = emitEvents(resolved, { recovery: true });
    return emitted.events;
}

describe('Finalization (Node)', () => {
    it('materializes a node tree', () => {
        const events = compileToEvents(
            [
                'config = {',
                '  host = "localhost"',
                '  port:int32 = 5432',
                '}',
                'flags = [true, false]',
            ].join('\n')
        );
        const result = finalizeNode(events);
        const root = result.document.root;
        const config = root.entries.get('config');
        assert.ok(config);
        assert.strictEqual(config?.type, 'Object');
        const flags = root.entries.get('flags');
        assert.ok(flags);
        assert.strictEqual(flags?.type, 'List');
    });

    it('captures annotations on bindings', () => {
        const events = compileToEvents('title@{lang="en"} = "Hello"');
        const result = finalizeNode(events);
        const node = result.document.root.entries.get('title');
        assert.ok(node);
        assert.ok(node?.annotations);
        assert.strictEqual(node?.annotations?.get('lang')?.value.type, 'StringLiteral');
    });

    it('materializes time literals as scalar time nodes', () => {
        const events = compileToEvents('opens = 09:30:00Z');
        const result = finalizeNode(events);
        const node = result.document.root.entries.get('opens');
        assert.ok(node);
        assert.strictEqual(node?.type, 'Time');
    });

    it('projects only whitelisted paths in node materialization', () => {
        const events = compileToEvents('app = { name = "demo", port = 8080 }\nother = "ignore"');
        const result = finalizeNode(events, {
            mode: 'strict',
            materialization: 'projected',
            includePaths: ['$.app.name'],
        });

        const app = result.document.root.entries.get('app');
        assert.ok(app);
        assert.strictEqual(result.document.root.entries.has('other'), false);
        assert.strictEqual(app?.type, 'Object');

        const appObject = app as { entries: ReadonlyMap<string, { type: string }> };
        assert.strictEqual(appObject.entries.has('name'), true);
        assert.strictEqual(appObject.entries.has('port'), false);
    });

    it('materializes node literals with @ and $children', () => {
        const events = compileToEvents('view = <div@{id="main"}("hello")>');
        const result = finalizeNode(events);
        const view = result.document.root.entries.get('view');
        assert.ok(view);
        assert.strictEqual(view?.type, 'Object');

        const objectView = view as { entries: ReadonlyMap<string, { type: string; value?: string }> };
        assert.strictEqual(objectView.entries.get('$node')?.type, 'String');
        assert.strictEqual(objectView.entries.get('@')?.type, 'Object');
        assert.strictEqual(objectView.entries.get('$children')?.type, 'List');
    });

    it('errors on reserved projection keys during node finalization', () => {
        const events = compileToEvents('"@" = 1\n"$node" = 2\n"$children" = 3');
        const result = finalizeNode(events, { mode: 'strict' });
        assert.ok(result.meta?.errors && result.meta.errors.length >= 3);
        assert.equal(result.meta?.errors?.[0]?.message, 'Reserved key: @');
        assert.strictEqual(result.document.root.entries.size, 0);
    });

    it('records duplicate keys in strict mode', () => {
        const events = [
            ...compileToEvents('a = 1'),
            ...compileToEvents('a = 2'),
        ];
        const result = finalizeNode(events, { mode: 'strict' });
        assert.ok(result.meta?.errors && result.meta.errors.length > 0);
    });

    it('preserves generic datatype signatures for nested bindings and annotations in core v1', () => {
        const events = compileToEvents(
            'top = { coords:tuple<int32, int32> = (1, 2), item@{meta:pair<int32, string> = "ok"} = 1 }',
            true
        );
        const result = finalizeNode(events);

        const top = result.document.root.entries.get('top');
        assert.ok(top);
        assert.strictEqual(top?.type, 'Object');

        const topObject = top as { entries: ReadonlyMap<string, { datatype?: string; annotations?: ReadonlyMap<string, { datatype?: string }> }> };
        assert.strictEqual(topObject.entries.get('coords')?.datatype, 'tuple<int32, int32>');
        assert.strictEqual(topObject.entries.get('item')?.annotations?.get('meta')?.datatype, 'pair<int32, string>');
    });
});
