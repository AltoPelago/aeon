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
        const parsed = parse(tokenize(String.raw`<tag@{role = "root"}("child")>
copy = ~tag[0]
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
        assert.equal(converted.events.find(event => event.path === '$.tag')?.tag, 'tag');
        assert.equal(codes.has('AES_COMPAT_ATTRIBUTE_FLATTENED'), true);
        assert.equal(codes.has('AES_COMPAT_DATATYPE_EXPANDED'), true);
        assert.equal(converted.events.find(event => event.path === '$.copy')?.value, '$.tag[0]');
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
            '\uFEFF' + String.raw`<tag\NODE\@{role = "café"}:node("😀")>`,
            'b = "nai\u0308ve"',
        ].join('\r\n');
        const sourceBytes = Buffer.from(source, 'utf8');
        const parsed = parse(tokenize(source).tokens, { maxAttributeDepth: 8 });
        assert.ok(parsed.document);
        const emitted = emitEvents(resolvePaths(parsed.document, { indexedPaths: true }));
        assert.deepStrictEqual(emitted.errors, []);

        const converted = adaptTypeScriptAssignmentEventsToPortableAes(emitted.events, { sourceBytes });
        const origin = 'sha256:89f440463a2fdea64790344a1511238d2af592991c0818794c26e15ca82a749c';
        const expectedLexemes = new Map([
            ['$.tag', String.raw`<tag\NODE\@{role = "café"}:node("😀")>`],
            ['$.tag.@.role', 'role = "café"'],
            ['$.tag[0]', '"😀"'],
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

    it('preserves source paths across nested node occurrences', () => {
        const parsed = parse(tokenize('<outer(<inner("leaf")>)>').tokens);
        assert.ok(parsed.document);
        const emitted = emitEvents(resolvePaths(parsed.document, { indexedPaths: true }));
        assert.deepStrictEqual(emitted.errors, []);
        assert.deepEqual([...createPortableEventPathMap(emitted.events)], [
            ['$.outer', '$.outer'],
            ['$.outer[0]', '$.outer[0]'],
            ['$.outer[0][0]', '$.outer[0][0]'],
        ]);
        assert.deepEqual(projectPortableEvents(emitted.events), [
            { path: '$.outer', kind: 'NodeLiteral', tag: 'outer' },
            { path: '$.outer[0]', kind: 'NodeLiteral', tag: 'inner' },
            { path: '$.outer[0][0]', kind: 'StringLiteral', value: 'leaf' },
        ]);
    });

    it('keeps node identity, tag and indexed child identity at their authored paths', () => {
        assert.deepEqual(project(String.raw`<tag\NODE\(\CHILD\ = "value")>`), [
            { path: '$.tag', kind: 'NodeLiteral', tag: 'tag', identity: 'NODE' },
            { path: '$.tag[0]', kind: 'StringLiteral', value: 'value', identity: 'CHILD' },
        ]);
    });

    it('keeps symbolic reference targets at the same direct child path', () => {
        const events = project('<tag("child")>\ncopy = ~tag[0]\nalias = ~>tag[0]');
        assert.strictEqual(events.find((event) => event.path === '$.copy')?.value, '$.tag[0]');
        assert.strictEqual(events.find((event) => event.path === '$.alias')?.value, '$.tag[0]');
    });

    it('flattens node and anonymous-child attributes before structural descendants', () => {
        const events = project(String.raw`<tag\ROOT\@{x\X\@{deep\D\ = 3} = { b\B\ = 2 }, role\R\ = "button"}(\CHILD\@{unit\U\ = "cm"} = "value")>`);
        assert.deepEqual(events.map(({ path, kind, identity }) => ({ path, kind, identity })), [
            { path: '$.tag', kind: 'NodeLiteral', identity: 'ROOT' },
            { path: '$.tag.@.x', kind: 'ObjectNode', identity: 'X' },
            { path: '$.tag.@.x.@.deep', kind: 'NumberLiteral', identity: 'D' },
            { path: '$.tag.@.x.b', kind: 'NumberLiteral', identity: 'B' },
            { path: '$.tag.@.role', kind: 'StringLiteral', identity: 'R' },
            { path: '$.tag[0]', kind: 'StringLiteral', identity: 'CHILD' },
            { path: '$.tag[0].@.unit', kind: 'StringLiteral', identity: 'U' },
        ]);
    });

    it('emits attribute nodes and references to their direct children', () => {
        assert.deepEqual(project(String.raw`a@{<inner\NODE\(\CHILD\ = "value")>} = 1
copy = ~a.@.inner[0]`), [
            { path: '$.a', kind: 'NumberLiteral', value: '1' },
            { path: '$.a.@.inner', kind: 'NodeLiteral', tag: 'inner', identity: 'NODE' },
            { path: '$.a.@.inner[0]', kind: 'StringLiteral', value: 'value', identity: 'CHILD' },
            { path: '$.copy', kind: 'CloneReference', value: '$.a.@.inner[0]' },
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
