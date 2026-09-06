import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { tokenize } from '@altopelago/aeon-lexer';
import { parse } from '@altopelago/aeon-parser';
import { emitEvents } from './events.js';
import { projectPortableEvents } from './portable.js';
import { resolvePaths } from './paths.js';
import {
    canonicalizeTelex,
    checkTelexCompleteness,
    encodeTelex,
    parseTelex,
    validateTelex,
} from './telex.js';

describe('telex.aes v0', () => {
    it('parses and encodes portable records', () => {
        const source = 'telex.aes=0\n\npath=$.answer\nkind=NumberLiteral\nvalue=42\n';
        const parsed = parseTelex(source);

        assert.equal(parsed.canonical, true);
        assert.deepEqual(parsed.records, [{ path: '$.answer', kind: 'NumberLiteral', value: '42' }]);
        assert.equal(encodeTelex(parsed.records), source);
    });

    it('canonicalizes field order and payload escapes', () => {
        const source = 'telex.aes=0\r\n\r\nvalue=\\u{000041}\r\nkind=StringLiteral\r\npath=$.answer\r\n';
        assert.equal(
            canonicalizeTelex(source),
            'telex.aes=0\n\npath=$.answer\nkind=StringLiteral\nvalue=A\n',
        );
    });

    it('expands compact datatype descriptors at the Telex boundary', () => {
        const parsed = parseTelex(
            'telex.aes=0\n\npath=$.items\nkind=ListNode\ndatatype=list<int>\n',
        );
        assert.deepEqual(parsed.records[0], {
            path: '$.items',
            kind: 'ListNode',
            datatype: 'list',
            generics: [{ datatype: 'int', generics: [], clarifiers: [] }],
            clarifiers: [],
        });
        assert.equal(encodeTelex(parsed.records), 'telex.aes=0\n\npath=$.items\nkind=ListNode\ndatatype=list<int>\n');
    });

    it('enforces datatype component limits for simple descriptors', () => {
        const source = 'telex.aes=0\n\npath=$.answer\nkind=NumberLiteral\ndatatype=int\nvalue=42\n';
        assert.throws(
            () => parseTelex(source, { maxDatatypeComponents: 0 }),
            (error: unknown) => error instanceof Error
                && 'code' in error
                && error.code === 'TELEX_DATATYPE_LIMIT',
        );
        assert.throws(
            () => encodeTelex([{
                path: '$.answer',
                kind: 'NumberLiteral',
                datatype: 'int',
                generics: [],
                clarifiers: [],
                value: '42',
            }], { maxDatatypeComponents: 0 }),
            (error: unknown) => error instanceof Error
                && 'code' in error
                && error.code === 'AES_DATATYPE_LIMIT',
        );
    });

    it('applies caller-selected parser limits during completeness checks', () => {
        const source = 'telex.aes=0\n\npath=$.answer\nkind=NumberLiteral\nvalue=42\n';
        assert.throws(
            () => checkTelexCompleteness(source, { maxEvents: 0 }),
            (error: unknown) => error instanceof Error
                && 'code' in error
                && error.code === 'TELEX_LIMIT_EXCEEDED',
        );
    });

    it('projects AEON into records that can be encoded directly', () => {
        const document = parse(tokenize('items:list<int> = [2, 3]').tokens).document;
        assert.ok(document);
        const emitted = emitEvents(resolvePaths(document, { indexedPaths: true }));
        assert.deepEqual(emitted.errors, []);
        const records = projectPortableEvents(emitted.events);
        const telex = encodeTelex(records);

        assert.match(telex, /path=\$\.items\nkind=ListNode\ndatatype=list<int>/u);
        assert.equal(validateTelex(telex).valid, true);
    });
});
