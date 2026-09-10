import { describe, it } from 'node:test';
import assert from 'node:assert';
import { tokenize } from '@altopelago/aeon-lexer';
import { parse } from '@altopelago/aeon-parser';
import { emitEvents } from './events.js';
import { resolvePaths } from './paths.js';
import {
    TYPESCRIPT_ASSIGNMENT_EVENTS_CONTRACT_V0,
    TYPESCRIPT_PORTABLE_AES_ADAPTER_V0,
    adaptTypeScriptAssignmentEventsToPortableAes,
    createPortableEventPathMap,
    projectPortableEvents,
} from './portable.js';

function project(input: string) {
    const parsed = parse(tokenize(input).tokens, { maxAttributeDepth: 8 });
    assert.ok(parsed.document);
    const emitted = emitEvents(resolvePaths(parsed.document, { indexedPaths: true }));
    assert.deepStrictEqual(emitted.errors, []);
    return projectPortableEvents(emitted.events);
}

describe('portable AES projection', () => {
    it('exposes the named legacy adapter with an explicit conversion report', () => {
        const parsed = parse(tokenize(String.raw`a@{role = "root"} = <tag("child")>
copy = ~a[0]
items:list<int> = [1]`).tokens, { maxAttributeDepth: 8 });
        assert.ok(parsed.document);
        const emitted = emitEvents(resolvePaths(parsed.document, { indexedPaths: true }));
        assert.deepStrictEqual(emitted.errors, []);

        const converted = adaptTypeScriptAssignmentEventsToPortableAes(emitted.events);

        assert.equal(converted.report.sourceContract, TYPESCRIPT_ASSIGNMENT_EVENTS_CONTRACT_V0);
        assert.equal(converted.report.targetContract, 'aes.events.v1');
        assert.equal(converted.report.adapter, TYPESCRIPT_PORTABLE_AES_ADAPTER_V0);
        assert.equal(converted.report.profile, 'aes.complete.v1');
        assert.equal(converted.report.projection, null);
        assert.equal(converted.report.semanticLossless, true);
        assert.equal(converted.report.recordLossless, false);
        assert.equal(converted.report.provenanceLossless, false);
        assert.equal(converted.events.some((event) => 'span' in event), false);
        const codes = new Set(converted.report.changes.map((change) => change.code));
        assert.equal(codes.has('AES_COMPAT_NODE_HEAD_SYNTHESIZED'), true);
        assert.equal(codes.has('AES_COMPAT_ATTRIBUTE_FLATTENED'), true);
        assert.equal(codes.has('AES_COMPAT_DATATYPE_EXPANDED'), true);
        assert.equal(codes.has('AES_COMPAT_REFERENCE_TRANSLATED'), true);
        assert.equal(codes.has('AES_COMPAT_PROVENANCE_OMITTED'), true);
    });

    it('keeps headers opt-in on the named compatibility adapter', () => {
        const parsed = parse(tokenize('aeon:mode = "transport"\na = 1').tokens);
        assert.ok(parsed.document);
        const emitted = emitEvents(resolvePaths(parsed.document, { indexedPaths: true }));
        assert.deepStrictEqual(emitted.errors, []);

        const body = adaptTypeScriptAssignmentEventsToPortableAes(emitted.events);
        assert.deepEqual(body.events.map((event) => event.path), ['$.a']);
        assert.equal(body.report.changes.some((change) => change.code === 'AES_COMPAT_HEADER_EXCLUDED'), true);

        const document = adaptTypeScriptAssignmentEventsToPortableAes(emitted.events, { includeHeaders: true });
        assert.equal(document.report.projection, 'aeon.document.v1');
        assert.equal(document.events[0]?.header, '$.["aeon:mode"]');
        assert.equal(document.events[1]?.path, '$.a');
    });

    it('keeps the direct portable projection body-only', () => {
        const parsed = parse(tokenize('aeon:mode = "transport"\na = 1').tokens);
        assert.ok(parsed.document);
        const emitted = emitEvents(resolvePaths(parsed.document, { indexedPaths: true }));
        assert.deepStrictEqual(emitted.errors, []);

        assert.deepEqual(projectPortableEvents(emitted.events).map((event) => event.path), ['$.a']);
    });

    it('uses retained header fields to preserve quoted aeon-prefixed payload keys', () => {
        const parsed = parse(tokenize('aeon:mode = "transport"\n"aeon:payload" = 1').tokens);
        assert.ok(parsed.document?.header);
        const emitted = emitEvents(resolvePaths(parsed.document, { indexedPaths: true }));
        assert.deepStrictEqual(emitted.errors, []);

        const converted = adaptTypeScriptAssignmentEventsToPortableAes(emitted.events, {
            headerFieldNames: [...parsed.document.header.fields.keys()],
        });
        assert.deepEqual(converted.events.map((event) => event.path), ['$.["aeon:payload"]']);
    });

    it('derives an exact origin and converts native UTF-16 ranges to UTF-8 byte spans', () => {
        const source = [
            '\uFEFF' + String.raw`a = <tag\HEAD\@{role = "café"}:node("😀")>`,
            'b = "nai\u0308ve"',
        ].join('\r\n');
        const sourceBytes = Buffer.from(source, 'utf8');
        const parsed = parse(tokenize(source).tokens, { maxAttributeDepth: 8 });
        assert.ok(parsed.document);
        const emitted = emitEvents(resolvePaths(parsed.document, { indexedPaths: true }));
        assert.deepStrictEqual(emitted.errors, []);

        const converted = adaptTypeScriptAssignmentEventsToPortableAes(emitted.events, { sourceBytes });
        const origin = 'sha256:c9063ff2481e76331f175afa8a6bd4d7f850048591e737047d8a0b6fc2a701b7';
        const expectedLexemes = new Map([
            ['$.a', String.raw`a = <tag\HEAD\@{role = "café"}:node("😀")>`],
            ['$.a[0]', String.raw`tag\HEAD\@{role = "café"}:node`],
            ['$.a[0].@.role', 'role = "café"'],
            ['$.a[0][0]', '"😀"'],
            ['$.b', 'b = "nai\u0308ve"'],
        ]);

        assert.strictEqual(converted.report.provenanceLossless, true);
        assert.strictEqual(
            converted.report.changes.some(change => change.code === 'AES_COMPAT_PROVENANCE_OMITTED'),
            false,
        );
        for (const event of converted.events) {
            assert.strictEqual(event.origin, origin);
            const path = event.path;
            assert.ok(path);
            const lexeme = expectedLexemes.get(path);
            if (lexeme === undefined) assert.fail(path);
            const utf16Start = source.indexOf(lexeme);
            assert.notStrictEqual(utf16Start, -1);
            const start = Buffer.byteLength(source.slice(0, utf16Start), 'utf8');
            const end = start + Buffer.byteLength(lexeme, 'utf8');
            assert.strictEqual(event.span, `${start}:${end}`, path);
        }
    });

    it('preserves source-backed header ranges in the explicit document projection', () => {
        const source = ['aeon:mode = "transport"', 'a = 1'].join('\r\n');
        const parsed = parse(tokenize(source).tokens);
        assert.ok(parsed.document);
        const emitted = emitEvents(resolvePaths(parsed.document, { indexedPaths: true }));
        assert.deepStrictEqual(emitted.errors, []);

        const converted = adaptTypeScriptAssignmentEventsToPortableAes(emitted.events, {
            includeHeaders: true,
            sourceBytes: Buffer.from(source, 'utf8'),
        });

        assert.strictEqual(converted.events[0]?.header, '$.["aeon:mode"]');
        assert.strictEqual(converted.events[0]?.span, '0:23');
        assert.strictEqual(converted.events[1]?.path, '$.a');
        assert.strictEqual(converted.events[1]?.span, '25:30');
        assert.strictEqual(converted.report.provenanceLossless, true);
    });

    it('rejects invalid UTF-8 artifacts and native ranges that split a Unicode scalar', () => {
        const source = 'a = "😀"';
        const parsed = parse(tokenize(source).tokens);
        assert.ok(parsed.document);
        const emitted = emitEvents(resolvePaths(parsed.document, { indexedPaths: true }));
        assert.deepStrictEqual(emitted.errors, []);

        assert.throws(
            () => adaptTypeScriptAssignmentEventsToPortableAes(emitted.events, {
                sourceBytes: Uint8Array.from([0xFF]),
            }),
            (error: unknown) => error instanceof Error
                && 'code' in error
                && error.code === 'AES_SOURCE_INVALID_UTF8',
        );

        const event = emitted.events[0]!;
        const splitRange = {
            ...event,
            span: {
                start: { line: 1, column: 7, offset: 6 },
                end: event.span.end,
            },
        };
        assert.throws(
            () => adaptTypeScriptAssignmentEventsToPortableAes([splitRange], {
                sourceBytes: Buffer.from(source, 'utf8'),
            }),
            (error: unknown) => error instanceof Error
                && 'code' in error
                && error.code === 'AES_COMPAT_SOURCE_RANGE_INVALID',
        );
    });

    it('publishes structure-aware native-to-portable event path mappings', () => {
        const parsed = parse(tokenize('a:node = <outer(<inner("leaf")>)>').tokens, { maxAttributeDepth: 8 });
        assert.ok(parsed.document);
        const emitted = emitEvents(resolvePaths(parsed.document, { indexedPaths: true }));
        assert.deepStrictEqual(emitted.errors, []);

        assert.deepEqual([...createPortableEventPathMap(emitted.events)], [
            ['$.a', '$.a'],
            ['$.a[0]', '$.a[0][0]'],
            ['$.a[0][0]', '$.a[0][0][0][0]'],
        ]);
    });
    it('separates binding, node-head, and child identities at expanded paths', () => {
        const events = project(String.raw`a\BINDING\ = <tag\HEAD\(\CHILD\ = "value")>`);

        assert.deepStrictEqual(
            events.map(({ path, kind, identity }) => ({ path, kind, identity: identity ?? null })),
            [
                { path: '$.a', kind: 'NodeLiteral', identity: 'BINDING' },
                { path: '$.a[0]', kind: 'NodeHead', identity: 'HEAD' },
                { path: '$.a[0][0]', kind: 'StringLiteral', identity: 'CHILD' },
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
                { path: '$.a', kind: 'NodeLiteral' },
                { path: '$.a[0]', kind: 'NodeHead' },
                { path: '$.a[0][0]', kind: 'NodeLiteral' },
                { path: '$.a[0][0][0]', kind: 'NodeHead' },
                { path: '$.a[0][0][0][0]', kind: 'StringLiteral' },
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
                { path: '$.a', kind: 'NodeLiteral', identity: 'ROOT' },
                { path: '$.a.@.x', kind: 'ObjectNode', identity: 'X' },
                { path: '$.a.@.x.@.deep', kind: 'NumberLiteral', identity: 'D' },
                { path: '$.a.@.x.b', kind: 'NumberLiteral', identity: 'B' },
                { path: '$.a[0]', kind: 'NodeHead', identity: 'HEAD' },
                { path: '$.a[0].@.role', kind: 'StringLiteral', identity: 'R' },
                { path: '$.a[0][0]', kind: 'StringLiteral', identity: 'CHILD' },
                { path: '$.a[0][0].@.unit', kind: 'StringLiteral', identity: 'U' },
            ],
        );
    });

    it('recursively expands node values inside attribute space', () => {
        const events = project(String.raw`a@{x = <inner\HEAD\(\CHILD\ = "value")>} = 1`);

        assert.deepStrictEqual(events.map(({ path, kind }) => ({ path, kind })), [
            { path: '$.a', kind: 'NumberLiteral' },
            { path: '$.a.@.x', kind: 'NodeLiteral' },
            { path: '$.a.@.x[0]', kind: 'NodeHead' },
            { path: '$.a.@.x[0][0]', kind: 'StringLiteral' },
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

    it('keeps ordinary and world-time-context date-times as distinct kinds', () => {
        const events = project('ordinary = 2025-01-01T09:30Z\nworld = 2025-01-01T09:30&local');

        assert.deepStrictEqual(events.map(({ path, kind }) => ({ path, kind })), [
            { path: '$.ordinary', kind: 'DateTimeLiteral' },
            { path: '$.world', kind: 'WTCDateTimeLiteral' },
        ]);
    });
});
