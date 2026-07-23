import { describe, it } from 'node:test';
import assert from 'node:assert';
import { tokenize } from '@altopelago/aeon-lexer';
import type { AssignmentEvent } from '@altopelago/aeon-aes';
import { buildAnnotationStream } from './stream.js';

function createEvent(path: string, start: number, end: number, line: number): AssignmentEvent {
    const segments = pathToSegments(path);
    return {
        path: { segments },
        key: path.split('.').at(-1) ?? 'x',
        value: {
            type: 'NumberLiteral',
            raw: '1',
            value: '1',
            span: {
                start: { offset: start, line, column: 1 },
                end: { offset: end, line, column: 1 },
            },
        } as AssignmentEvent['value'],
        span: {
            start: { offset: start, line, column: 1 },
            end: { offset: end, line, column: 1 },
        },
    };
}

function createStringEvent(path: string, source: string): AssignmentEvent {
    const valueStart = source.indexOf('"hello"');
    const valueEnd = valueStart + '"hello"'.length;
    return {
        path: { segments: pathToSegments(path) },
        key: path.split('.').at(-1) ?? 'x',
        datatype: 'string',
        value: {
            type: 'StringLiteral',
            raw: 'hello',
            value: 'hello',
            delimiter: '"',
            span: {
                start: { offset: valueStart, line: 1, column: valueStart + 1 },
                end: { offset: valueEnd, line: 1, column: valueEnd + 1 },
            },
        } as AssignmentEvent['value'],
        span: {
            start: { offset: 0, line: 1, column: 1 },
            end: { offset: valueEnd, line: 1, column: valueEnd + 1 },
        },
    };
}

function pathToSegments(path: string): AssignmentEvent['path']['segments'] {
    const segments: Array<{ type: 'root' } | { type: 'member'; key: string } | { type: 'index'; index: number }> = [{ type: 'root' }];
    const memberPart = path.replace(/^\$\.?/, '');
    if (!memberPart) {
        return segments;
    }
    for (const part of memberPart.split('.')) {
        const match = /^(?<member>[a-zA-Z_][a-zA-Z0-9_]*)(?<index>\[\d+\])?$/.exec(part);
        if (!match?.groups) {
            continue;
        }
        const member = match.groups.member;
        if (!member) {
            continue;
        }
        segments.push({ type: 'member', key: member });
        if (match.groups.index) {
            const index = Number(match.groups.index.slice(1, -1));
            segments.push({ type: 'index', index });
        }
    }
    return segments;
}

describe('annotation stream', () => {
    it('returns no records when the document has no structured comments', () => {
        const source = 'a = 1\n// plain\nb = 2';
        const events = [
            createEvent('$.a', 0, 5, 1),
            createEvent('$.b', 15, 20, 3),
        ];
        const lexResult = tokenize(source, { includeComments: true });
        assert.strictEqual(lexResult.errors.length, 0);

        const records = buildAnnotationStream({ tokens: lexResult.tokens, events });

        assert.deepStrictEqual(records, []);
    });

    it('emits structured records in source order', () => {
        const source = '//# one\na = 1\n//@ two\n//? three\n// plain';
        const events = [createEvent('$.a', 8, 13, 2)];

        const lexResult = tokenize(source, { includeComments: true });
        assert.strictEqual(lexResult.errors.length, 0);

        const records = buildAnnotationStream({
            tokens: lexResult.tokens,
            events,
        });
        assert.deepStrictEqual(records.map((record) => record.kind), ['doc', 'annotation', 'hint']);
        assert.deepStrictEqual(records.map((record) => record.raw), ['//# one', '//@ two', '//? three']);
    });

    it('binds trailing comments to the same-line assignment', () => {
        const source = 'a = 1 //? required';
        const events = [createEvent('$.a', 0, 5, 1)];
        const lexResult = tokenize(source, { includeComments: true });
        const records = buildAnnotationStream({ tokens: lexResult.tokens, events });

        assert.strictEqual(records.length, 1);
        assert.deepStrictEqual(records[0]?.target, { kind: 'path', path: '$.a' });
        assert.deepStrictEqual(records[0]?.placement, { after: 'value' });
    });

    it('binds standalone structured comments forward', () => {
        const source = '//# docs\na = 1';
        const events = [createEvent('$.a', 9, 14, 2)];
        const lexResult = tokenize(source, { includeComments: true });
        const records = buildAnnotationStream({ tokens: lexResult.tokens, events });

        assert.strictEqual(records.length, 1);
        assert.deepStrictEqual(records[0]?.target, { kind: 'path', path: '$.a' });
        assert.deepStrictEqual(records[0]?.placement, { before: 'key' });
    });

    it('reports binding-head placement for comments between assignment landmarks', () => {
        const cases = [
            {
                source: 'a:string= /?comment?/ "hello"',
                placement: { after: 'equals', before: 'value' },
            },
            {
                source: 'b:string /?comment?/ = "hello"',
                placement: { after: 'datatype', before: 'equals' },
            },
            {
                source: 'c:/?comment?/ string = "hello"',
                placement: { after: 'datatype-colon', before: 'datatype' },
            },
            {
                source: 'd /?comment?/ :string = "hello"',
                placement: { after: 'key', before: 'datatype-colon' },
            },
            {
                source: 'e @{a:n=2} /?comment?/ :string = "hello"',
                placement: { after: 'attribute-close', before: 'datatype-colon' },
            },
            {
                source: 'f /?comment?/ @{a:n=2} :string = "hello"',
                placement: { after: 'key', before: 'attribute-marker' },
            },
        ] as const;

        for (const { source, placement } of cases) {
            const event = createStringEvent(`$.${source[0]}`, source);
            const lexResult = tokenize(source, { includeComments: true });
            const records = buildAnnotationStream({ tokens: lexResult.tokens, events: [event] });

            assert.strictEqual(records.length, 1, source);
            assert.deepStrictEqual(records[0]?.target, { kind: 'path', path: `$.${source[0]}` }, source);
            assert.deepStrictEqual(records[0]?.placement, placement, source);
        }
    });

    it('targets comments inside attribute entries with attribute paths', () => {
        const source = '/#1#/a/#a#/@/#@#/{/#{#/b/#b#/:/#:#/n/#n#/=/#@=#/3/#3#/,/#@,#/c/#c#/=/#@=#/4/#4#/}/#}#/:/#:#/node/#node#/=/#=#/</#<#/tag/#tag#/(/#(#/"hello"/#"hello"#/,/#,#/"world"/#"world"#/)/#)#/>/#>#/';
        const valueStart = source.indexOf('<');
        const lexResult = tokenize(source, { includeComments: true });
        const records = buildAnnotationStream({
            tokens: lexResult.tokens,
            events: [{
                path: { segments: pathToSegments('$.a') },
                key: 'a',
                datatype: 'node',
                span: {
                    start: { offset: source.indexOf('a'), line: 1, column: source.indexOf('a') + 1 },
                    end: { offset: source.length, line: 1, column: source.length + 1 },
                },
                value: {
                    type: 'NodeLiteral',
                    tag: 'tag',
                    attributes: [],
                    datatype: null,
                    children: [],
                    span: {
                        start: { offset: valueStart, line: 1, column: valueStart + 1 },
                        end: { offset: source.length, line: 1, column: source.length + 1 },
                    },
                } as AssignmentEvent['value'],
            }],
        });

        assert.deepStrictEqual(lexResult.errors, []);
        const byRaw = records.map((record) => ({
            raw: record.raw,
            path: record.target.kind === 'path' ? record.target.path : '',
            placement: record.placement,
        }));

        assert.deepStrictEqual(
            byRaw.filter((record) => record.raw === '/#b#/' || record.raw === '/#:#/' || record.raw === '/#@=#/' || record.raw === '/#3#/').slice(0, 4),
            [
                { raw: '/#b#/', path: '$.a.@.b', placement: { after: 'attribute-key', before: 'attribute-datatype-colon' } },
                { raw: '/#:#/', path: '$.a.@.b', placement: { after: 'attribute-datatype-colon', before: 'attribute-datatype' } },
                { raw: '/#@=#/', path: '$.a.@.b', placement: { after: 'attribute-equals', before: 'attribute-value' } },
                { raw: '/#3#/', path: '$.a.@.b', placement: { after: 'attribute-value' } },
            ],
        );
        assert.deepStrictEqual(byRaw.find((record) => record.raw === '/#@,#/'), {
            raw: '/#@,#/',
            path: '$.a',
            placement: { after: 'attribute-separator', before: 'attribute-key' },
        });
        assert.deepStrictEqual(byRaw.find((record) => record.raw === '/#c#/'), {
            raw: '/#c#/',
            path: '$.a.@.c',
            placement: { after: 'attribute-key', before: 'attribute-equals' },
        });
    });

    it('binds infix comments to nearest indexed element inside a container', () => {
        const source = 'a = [1, /? in-list ?/ 2]';
        const firstElementOffset = source.indexOf('1');
        const secondElementOffset = source.lastIndexOf('2');
        const events = [
            createEvent('$.a', 0, source.length, 1),
            createEvent('$.a[0]', firstElementOffset, firstElementOffset + 1, 1),
            createEvent('$.a[1]', secondElementOffset, secondElementOffset + 1, 1),
        ];
        const lexResult = tokenize(source, { includeComments: true });
        const records = buildAnnotationStream({ tokens: lexResult.tokens, events });

        assert.strictEqual(records.length, 1);
        assert.deepStrictEqual(records[0]?.target, { kind: 'path', path: '$.a[1]' });
        assert.strictEqual(records[0]?.kind, 'hint');
        assert.strictEqual(records[0]?.form, 'block');
    });

    it('binds postfix and prefix container comments to indexed element paths', () => {
        const source = 'a = [1 /# post #/, /# pre #/ 2]';
        const firstElementOffset = source.indexOf('1');
        const secondElementOffset = source.lastIndexOf('2');
        const events = [
            createEvent('$.a', 0, source.length, 1),
            createEvent('$.a[0]', firstElementOffset, firstElementOffset + 1, 1),
            createEvent('$.a[1]', secondElementOffset, secondElementOffset + 1, 1),
        ];
        const lexResult = tokenize(source, { includeComments: true });
        const records = buildAnnotationStream({ tokens: lexResult.tokens, events });

        assert.strictEqual(records.length, 2);
        assert.deepStrictEqual(records[0]?.target, { kind: 'path', path: '$.a[0]' });
        assert.deepStrictEqual(records[1]?.target, { kind: 'path', path: '$.a[1]' });
    });

    it('binds a compact comment after a nested list to the list binding', () => {
        const source = 'settings={tags=["browser","wasm","aeon"]/# tail #/}';
        const settingsStart = source.indexOf('{');
        const tagsStart = source.indexOf('[');
        const tagsEnd = source.indexOf(']') + 1;
        const thirdElementStart = source.indexOf('"aeon"');
        const thirdElementEnd = thirdElementStart + '"aeon"'.length;
        const events = [
            createEvent('$.settings', settingsStart, source.length, 1),
            createEvent('$.settings.tags', tagsStart, tagsEnd, 1),
            createEvent('$.settings.tags[2]', thirdElementStart, thirdElementEnd, 1),
        ];
        const lexResult = tokenize(source, { includeComments: true });
        const records = buildAnnotationStream({ tokens: lexResult.tokens, events });

        assert.strictEqual(records.length, 1);
        assert.deepStrictEqual(records[0]?.target, { kind: 'path', path: '$.settings.tags' });
        assert.deepStrictEqual(records[0]?.placement, { after: 'value' });
    });

    it('marks comment as unbound eof when no forward target exists', () => {
        const source = 'a = 1\n//# tail';
        const events = [createEvent('$.a', 0, 5, 1)];
        const lexResult = tokenize(source, { includeComments: true });
        const records = buildAnnotationStream({ tokens: lexResult.tokens, events });

        assert.strictEqual(records.length, 1);
        assert.deepStrictEqual(records[0]?.target, { kind: 'unbound', reason: 'eof' });
    });

    it('marks comment as unbound no_bindable when document has no bindables', () => {
        const source = '//@ lonely';
        const lexResult = tokenize(source, { includeComments: true });
        const records = buildAnnotationStream({ tokens: lexResult.tokens, events: [] });

        assert.strictEqual(records.length, 1);
        assert.deepStrictEqual(records[0]?.target, { kind: 'unbound', reason: 'no_bindable' });
    });

    it('binds to span target when only non-addressable spans are provided', () => {
        const source = '//# span-only';
        const lexResult = tokenize(source, { includeComments: true });
        const targetSpan = {
            start: { offset: 20, line: 2, column: 1 },
            end: { offset: 25, line: 2, column: 6 },
        };

        const records = buildAnnotationStream({
            tokens: lexResult.tokens,
            events: [],
            spans: [targetSpan],
        });

        assert.strictEqual(records.length, 1);
        assert.deepStrictEqual(records[0]?.target, { kind: 'span', span: targetSpan });
    });

    it('prefers path targets over span targets', () => {
        const source = 'a = 1 //? choose-path';
        const events = [createEvent('$.a', 0, 5, 1)];
        const lexResult = tokenize(source, { includeComments: true });
        const span = {
            start: { offset: 0, line: 1, column: 1 },
            end: { offset: source.length, line: 1, column: source.length + 1 },
        };
        const records = buildAnnotationStream({
            tokens: lexResult.tokens,
            events,
            spans: [span],
        });

        assert.strictEqual(records.length, 1);
        assert.deepStrictEqual(records[0]?.target, { kind: 'path', path: '$.a' });
    });

    it('preserves reserved subtype', () => {
        const source = '//{ structure\na = 1';
        const events = [createEvent('$.a', 13, 18, 2)];
        const lexResult = tokenize(source, { includeComments: true });
        const records = buildAnnotationStream({ tokens: lexResult.tokens, events });

        assert.strictEqual(records.length, 1);
        assert.strictEqual(records[0]?.kind, 'reserved');
        assert.strictEqual(records[0]?.subtype, 'structure');
    });

    it('ignores shebang and file-header host directive comments', () => {
        const source = '#!/usr/bin/env aeon\n//! format:aeon.test.v1\na = 1';
        const events = [createEvent('$.a', source.lastIndexOf('a = 1'), source.length, 3)];
        const lexResult = tokenize(source, { includeComments: true });
        const records = buildAnnotationStream({ tokens: lexResult.tokens, events });

        assert.strictEqual(lexResult.errors.length, 0);
        assert.deepStrictEqual(records, []);
    });
});
