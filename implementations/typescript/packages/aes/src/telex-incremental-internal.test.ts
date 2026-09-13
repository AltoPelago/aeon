import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    IncrementalAesAccumulator,
    IncrementalTelexDecoder,
    parseTelexInChunks,
    validateTelexInChunks,
} from './telex-incremental-internal.js';
import {
    parseTelex,
    validateTelex,
} from './telex.js';

const UTF8_ENCODER = new TextEncoder();

const POSITIVE_INPUTS = [
    'telex.aes=1\n',
    'telex.aes=1',
    'telex.aes=1\n\npath=$.answer\nkind=NumberLiteral\nvalue=42\n',
    'telex.aes=1\n\npath=$.answer\nkind=StringLiteral\nvalue=😀\\nvalue',
    [
        'telex.aes=1',
        'profile=aes.partial.v1',
        'projection=aeon.document.v1',
        '',
        'header=$.["aeon:mode"]',
        'kind=StringLiteral',
        'value=strict',
        '',
        'path=$.items',
        'kind=ListNode',
        'datatype=list<int>',
        '',
        'path=$.items[0]',
        'kind=NumberLiteral',
        'value=2',
        '',
    ].join('\r\n'),
] as const;

const NEGATIVE_INPUTS = [
    'telex.aes=0\n',
    'telex.aes=1\npath=$.a\n',
    'telex.aes=1\n\npath=$.a\npath=$.b\n',
    'telex.aes=1\n\nPath=$.a\n',
    'telex.aes=1\n\npath=$.a\nvalue=\\q\n',
    'telex.aes=1\rpath=$.a\n',
] as const;

describe('internal incremental Telex pipeline', () => {
    it('matches one-shot parsing at every two-chunk boundary', () => {
        for (const source of POSITIVE_INPUTS) {
            const bytes = UTF8_ENCODER.encode(source);
            const expected = parseTelex(source);
            for (let split = 0; split <= bytes.byteLength; split += 1) {
                assert.deepEqual(
                    parseTelexInChunks(bytes, [split]),
                    expected,
                    `split ${split} of ${bytes.byteLength}`,
                );
            }
        }
    });

    it('matches one-shot parsing with byte-at-a-time delivery', () => {
        for (const source of POSITIVE_INPUTS) {
            const bytes = UTF8_ENCODER.encode(source);
            const splits = Array.from(
                { length: Math.max(0, bytes.byteLength - 1) },
                (_, index) => index + 1,
            );
            assert.deepEqual(parseTelexInChunks(bytes, splits), parseTelex(source));
        }
    });

    it('matches one-shot syntax diagnostics at every split position', () => {
        for (const source of NEGATIVE_INPUTS) {
            const bytes = UTF8_ENCODER.encode(source);
            const expected = captureSyntaxError(() => parseTelex(source));
            for (let split = 0; split <= bytes.byteLength; split += 1) {
                assert.deepEqual(
                    captureSyntaxError(() => parseTelexInChunks(bytes, [split])),
                    expected,
                    `split ${split} of ${JSON.stringify(source)}`,
                );
            }
        }
    });

    it('rejects malformed UTF-8 independently of the string API', () => {
        const prefix = UTF8_ENCODER.encode('telex.aes=1\n\npath=$.a\nkind=StringLiteral\nvalue=');
        const bytes = new Uint8Array(prefix.byteLength + 2);
        bytes.set(prefix);
        bytes.set([0xc3, 0x28], prefix.byteLength);
        assert.deepEqual(
            captureSyntaxError(() => parseTelexInChunks(bytes, [bytes.byteLength - 1])),
            {
                code: 'TELEX_INVALID_UTF8',
                line: 5,
                message: 'Line 5: Telex input must be valid UTF-8',
            },
        );
    });

    it('emits records only after a stanza boundary or final EOF', () => {
        const decoder = new IncrementalTelexDecoder();
        let update = decoder.push(UTF8_ENCODER.encode(
            'telex.aes=1\n\npath=$.answer\nkind=NumberLiteral\nvalue=42',
        ));
        assert.equal(update.progress, 'need-more-input');
        assert.deepEqual(update.records, []);
        assert.ok(update.context);

        update = decoder.push(UTF8_ENCODER.encode('\n'));
        assert.equal(update.progress, 'need-more-input');
        assert.deepEqual(update.records, []);
        assert.equal(update.context, undefined);

        update = decoder.push(UTF8_ENCODER.encode('\n'));
        assert.equal(update.progress, 'provisional-records');
        assert.deepEqual(update.records, [{ path: '$.answer', kind: 'NumberLiteral', value: '42' }]);
        assert.equal(update.context, undefined);

        update = decoder.push(new Uint8Array(), { final: true });
        assert.equal(update.progress, 'syntax-complete');
        assert.equal(update.completion?.canonical, false);
    });

    it('copies an unfinished caller line before the caller buffer expires', () => {
        const decoder = new IncrementalTelexDecoder();
        const first = UTF8_ENCODER.encode('telex.aes=1\n\npath=$.answer\nkind=StringLiteral\nvalue=hel');
        decoder.push(first);
        first.fill(0x78);
        const update = decoder.push(UTF8_ENCODER.encode('lo\n'), { final: true });
        assert.deepEqual(update.records, [{ path: '$.answer', kind: 'StringLiteral', value: 'hello' }]);
    });

    it('keeps syntax failure and successful completion terminal', () => {
        const failed = new IncrementalTelexDecoder();
        const firstError = captureThrown(() => failed.push(UTF8_ENCODER.encode('wrong\n')));
        const secondError = captureThrown(() => failed.push(new Uint8Array(), { final: true }));
        assert.equal(secondError, firstError);

        const complete = new IncrementalTelexDecoder();
        complete.push(UTF8_ENCODER.encode('telex.aes=1\n'), { final: true });
        assert.deepEqual(
            captureSyntaxError(() => complete.push(new Uint8Array())),
            {
                code: 'TELEX_DECODER_CLOSED',
                message: 'The incremental Telex decoder is already complete',
            },
        );
    });

    it('applies physical limits before retaining over-limit input', () => {
        const inputLimited = new IncrementalTelexDecoder({ maxInputBytes: 4 });
        assert.deepEqual(
            captureSyntaxError(() => inputLimited.push(UTF8_ENCODER.encode('12345'))),
            {
                code: 'TELEX_LIMIT_EXCEEDED',
                counter: 'max_input_bytes',
                observed: 5,
                limit: 4,
                message: 'max_input_bytes observed value 5 exceeds configured limit 4',
            },
        );

        const lineLimited = new IncrementalTelexDecoder({ maxLineBytes: 4 });
        lineLimited.push(UTF8_ENCODER.encode('abcde'));
        assert.deepEqual(
            captureSyntaxError(() => lineLimited.push(UTF8_ENCODER.encode('f\n'))),
            {
                code: 'TELEX_LIMIT_EXCEEDED',
                line: 1,
                counter: 'max_line_bytes',
                observed: 6,
                limit: 4,
                message: 'Line 1: max_line_bytes observed value 6 exceeds configured limit 4',
            },
        );
    });

    it('matches complete semantic validation across record batches', () => {
        const sources = [
            'telex.aes=1\n\npath=$.a\nkind=ObjectNode\n\npath=$.a.b\nkind=NumberLiteral\nvalue=1\n',
            'telex.aes=1\n\npath=$.a.b\nkind=NumberLiteral\nvalue=1\n',
            'telex.aes=1\nprofile=aes.partial.v1\n\npath=$.a\nkind=NumberLiteral\nvalue=1\n\npath=$.a\nkind=NumberLiteral\nvalue=2\n',
            'telex.aes=1\n\npath=$.copy\nkind=CloneReference\nvalue=$.target\n\npath=$.target\nkind=NumberLiteral\nvalue=1\n',
        ] as const;
        for (const source of sources) {
            const bytes = UTF8_ENCODER.encode(source);
            const splits = Array.from(
                { length: Math.max(0, bytes.byteLength - 1) },
                (_, index) => index + 1,
            );
            const incremental = validateTelexInChunks(bytes, splits);
            assert.deepEqual(incremental.records, parseTelex(source).records);
            assert.deepEqual(incremental.validation, validateTelex(source));
        }
    });

    it('requires contiguous batches and owns accepted record data', () => {
        const context = {
            profile: 'aes.complete.v1',
            profileExplicit: false,
            projection: null,
            projectionExplicit: false,
        } as const;
        const accumulator = new IncrementalAesAccumulator(context);
        const record = { path: '$.answer', kind: 'NumberLiteral', value: '42' };
        accumulator.pushBatch(0, [record]);
        record.value = 'invalid';
        assert.throws(
            () => accumulator.pushBatch(2, []),
            /ordinal is not contiguous/u,
        );
        const result = accumulator.finish();
        assert.equal(result.records[0]?.value, '42');
        assert.equal(result.validation.valid, true);
        assert.throws(() => accumulator.finish(), /already complete/u);
    });

    it('preserves semantic results across explicit batch sizes', () => {
        const source = [
            'telex.aes=1',
            '',
            'path=$.items',
            'kind=ListNode',
            '',
            ...Array.from({ length: 9 }, (_, index) => [
                `path=$.items[${index}]`,
                'kind=NumberLiteral',
                `value=${index}`,
                '',
            ]).flat(),
        ].join('\n');
        const parsed = parseTelex(source);
        const expected = validateTelex(source);
        for (const batchSize of [1, 2, 4, 8, 16]) {
            const accumulator = new IncrementalAesAccumulator({
                profile: parsed.profile,
                profileExplicit: parsed.profileExplicit,
                projection: parsed.projection,
                projectionExplicit: parsed.projectionExplicit,
            });
            for (let start = 0; start < parsed.records.length; start += batchSize) {
                accumulator.pushBatch(start, parsed.records.slice(start, start + batchSize));
            }
            assert.deepEqual(accumulator.finish().validation, expected, `batch size ${batchSize}`);
        }
    });
});

interface CapturedSyntaxError {
    readonly code?: unknown;
    readonly line?: unknown;
    readonly counter?: unknown;
    readonly observed?: unknown;
    readonly limit?: unknown;
    readonly message: string;
}

function captureSyntaxError(operation: () => unknown): CapturedSyntaxError {
    const error = captureThrown(operation);
    assert.ok(error instanceof Error);
    const details = error as Error & Readonly<Record<string, unknown>>;
    return {
        ...('code' in details ? { code: details.code } : {}),
        ...('line' in details && details.line !== undefined ? { line: details.line } : {}),
        ...('counter' in details && details.counter !== undefined ? { counter: details.counter } : {}),
        ...('observed' in details && details.observed !== undefined ? { observed: details.observed } : {}),
        ...('limit' in details && details.limit !== undefined ? { limit: details.limit } : {}),
        message: details.message,
    };
}

function captureThrown(operation: () => unknown): unknown {
    try {
        operation();
    } catch (error) {
        return error;
    }
    assert.fail('Expected operation to throw');
}
