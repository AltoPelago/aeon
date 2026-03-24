import { describe, it } from 'node:test';
import assert from 'node:assert';
import { tokenize } from '@aeon/lexer';
import type { AssignmentEvent } from '@aeon/aes';
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
    });

    it('binds standalone structured comments forward', () => {
        const source = '//# docs\na = 1';
        const events = [createEvent('$.a', 9, 14, 2)];
        const lexResult = tokenize(source, { includeComments: true });
        const records = buildAnnotationStream({ tokens: lexResult.tokens, events });

        assert.strictEqual(records.length, 1);
        assert.deepStrictEqual(records[0]?.target, { kind: 'path', path: '$.a' });
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
