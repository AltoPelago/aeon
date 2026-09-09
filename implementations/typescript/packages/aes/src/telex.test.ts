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
    validateTelexRecords,
} from './telex.js';

describe('telex.aes v1', () => {
    it('parses and encodes portable records', () => {
        const source = 'telex.aes=1\n\npath=$.answer\nkind=NumberLiteral\nvalue=42\n';
        const parsed = parseTelex(source);

        assert.equal(parsed.canonical, true);
        assert.deepEqual(parsed.records, [{ path: '$.answer', kind: 'NumberLiteral', value: '42' }]);
        assert.equal(encodeTelex(parsed.records), source);
    });

    it('canonicalizes field order and payload escapes', () => {
        const source = 'telex.aes=1\r\n\r\nvalue=\\u{000041}\r\nkind=StringLiteral\r\npath=$.answer\r\n';
        assert.equal(
            canonicalizeTelex(source),
            'telex.aes=1\n\npath=$.answer\nkind=StringLiteral\nvalue=A\n',
        );
    });

    it('expands compact datatype descriptors at the Telex boundary', () => {
        const parsed = parseTelex(
            'telex.aes=1\n\npath=$.items\nkind=ListNode\ndatatype=list<int>\n',
        );
        assert.deepEqual(parsed.records[0], {
            path: '$.items',
            kind: 'ListNode',
            datatype: 'list',
            generics: [{ datatype: 'int', generics: [], clarifiers: [] }],
            clarifiers: [],
        });
        assert.equal(encodeTelex(parsed.records), 'telex.aes=1\n\npath=$.items\nkind=ListNode\ndatatype=list<int>\n');
    });

    it('enforces datatype component limits for simple descriptors', () => {
        const source = 'telex.aes=1\n\npath=$.answer\nkind=NumberLiteral\ndatatype=int\nvalue=42\n';
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
        const source = 'telex.aes=1\n\npath=$.answer\nkind=NumberLiteral\nvalue=42\n';
        assert.throws(
            () => checkTelexCompleteness(source, { maxEvents: 0 }),
            (error: unknown) => error instanceof Error
                && 'code' in error
                && error.code === 'TELEX_LIMIT_EXCEEDED',
        );
    });

    it('enforces the shared structural counters on direct Telex validation', () => {
        const cases = [
            ['maxAttributeDepth', [{ path: '$.a.@.x.@.y', kind: 'NumberLiteral', value: '1' }]],
            ['maxValueNestingDepth', [
                { path: '$.a', kind: 'ObjectNode' },
                { path: '$.a.b', kind: 'ListNode' },
            ]],
            ['maxStringCodepoints', [{ path: '$.a', kind: 'StringLiteral', value: '😀x' }]],
            ['maxKeySegmentCodepoints', [{ path: '$.["😀x"]', kind: 'NumberLiteral', value: '1' }]],
            ['maxListItems', [
                { path: '$.a', kind: 'ListNode' },
                { path: '$.a[0]', kind: 'NumberLiteral', value: '1' },
                { path: '$.a[1]', kind: 'NumberLiteral', value: '2' },
            ]],
            ['maxTupleItems', [
                { path: '$.a', kind: 'TupleLiteral' },
                { path: '$.a[0]', kind: 'NumberLiteral', value: '1' },
                { path: '$.a[1]', kind: 'NumberLiteral', value: '2' },
            ]],
        ] as const;
        for (const [limit, records] of cases) {
            const counter = limit.replace(/[A-Z]/g, (character) => `_${character.toLowerCase()}`);
            const result = validateTelexRecords(records, { [limit]: 1 });
            assert.equal(result.valid, false, limit);
            assert.ok(result.diagnostics.some(({ code }) => code === 'AES_LIMIT_EXCEEDED'), limit);
            assert.throws(
                () => encodeTelex(records, { profile: 'aes.partial.v1', [limit]: 1 }),
                (error: unknown) => error instanceof Error
                    && 'code' in error
                    && error.code === 'TELEX_LIMIT_EXCEEDED'
                    && 'counter' in error
                    && error.counter === counter,
                limit,
            );
        }
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
