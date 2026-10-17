import assert from 'node:assert/strict';
import test from 'node:test';
import { encodeTelex } from './telex.js';
import type { FilmDecodeOptions } from './film.js';

import {
    FILM_V1_PREAMBLE,
    FilmDecodeError,
    IncrementalFilmDecoder,
    decodeFilm,
    decodeFilmSyntax,
    filmV1IsDraft,
    normalizeFilmLimits,
} from './film.js';

const CANONICAL_SCALAR = fromHex(
    '4f5f5fff010012000109242e6d6573736167650568656c6c6f',
);
// Fixed bytes from immutable Film CTS 0.4 (depth-002, depth-003 and depth-024).
const LEAF_GENERIC = fromHex('4f5f5fff010018020203242e610f046c69737401000603696e740000000130');
const CLARIFIED_LEAF = fromHex('4f5f5fff01002d020203242e6124046c69737401001b06637573746f6d0001021039303037313939323534373430393933000130');
const MISSING_NESTED_ARGUMENT = fromHex('4f5f5fff010018020203242e610f046c697374010006046c69737401000130');

test('Film logical depth zero accepts leaf arguments and preserves exact clarifiers', () => {
    for (const [bytes, generic] of [
        [LEAF_GENERIC, { datatype: 'int', generics: [], clarifiers: [] }],
        [CLARIFIED_LEAF, { datatype: 'custom', generics: [], clarifiers: [
            { kind: 'NumberLiteral', value: '9007199254740993' },
        ] }],
    ] as const) {
        const expected = decodeFilm(bytes, { maxGenericDepth: 0 });
        assert.deepEqual(expected.records[0]?.generics, [generic]);
        for (let split = 0; split <= bytes.length; split += 1) {
            const decoder = new IncrementalFilmDecoder({ aesLimits: { maxGenericDepth: 0 } });
            assert.notEqual(decoder.push(bytes.subarray(0, split)).status, 'complete');
            const result = decoder.push(bytes.subarray(split), { final: true });
            assert.equal(result.status, 'complete');
            assert.deepEqual(result.stream, expected);
        }
    }
});

test('Film checks generic-bearing depth before descent without bypassing independent limits', () => {
    const cases: readonly [Uint8Array, FilmDecodeOptions, string, number, number][] = [
        [MISSING_NESTED_ARGUMENT, { maxGenericDepth: 0 }, 'max_generic_depth', 1, 0],
        [LEAF_GENERIC, { maxGenericDepth: 0, maxDatatypeComponents: 1 }, 'max_datatype_components', 2, 1],
        [CLARIFIED_LEAF, { maxGenericDepth: 0, maxClarifierValues: 0 }, 'max_clarifier_values', 1, 0],
    ];
    for (const [bytes, options, counter, observed, limit] of cases) {
        assert.throws(() => decodeFilm(bytes, options), (error: unknown) => {
            assert.ok(error instanceof FilmDecodeError);
            assert.equal(error.code, 'FILM_AES_INVALID');
            assert.deepEqual(error.diagnostics.map(({ code, counter, observed, limit }) => (
                { code, counter, observed, limit }
            )), [{ code: 'AES_LIMIT_EXCEEDED', counter, observed, limit }]);
            return true;
        });
    }
});

test('Film logical-depth acceptance does not suppress malformed leaf or argument errors', () => {
    const trailingLeaf = fromHex('4f5f5fff010010020203242e610703696e740000000130');
    for (const [bytes, depth, code] of [
        [trailingLeaf, 0, 'FILM_NONCANONICAL'],
        [MISSING_NESTED_ARGUMENT, 1, 'FILM_TRUNCATED'],
    ] as const) {
        assert.throws(() => decodeFilm(bytes, { maxGenericDepth: depth }),
            (error: unknown) => error instanceof FilmDecodeError && error.code === code);
    }
});

test('decodes the Film v1 specification scalar as complete portable AES', () => {
    const stream = decodeFilm(CANONICAL_SCALAR);

    assert.deepEqual(stream, {
        profile: 'aes.complete.v1',
        profileExplicit: false,
        projection: null,
        projectionExplicit: false,
        records: [{ path: '$.message', kind: 'StringLiteral', value: 'hello' }],
    });
    assert.deepEqual(FILM_V1_PREAMBLE, [0x4f, 0x5f, 0x5f, 0xff, 0x01]);
    assert.equal(filmV1IsDraft(), true);
});

test('keeps syntax-only Film records provisional until AES validation', () => {
    const invalidAes = fromHex('4f5f5fff01000f00010a6e6f742d612d706174680178');
    assert.deepEqual(decodeFilmSyntax(invalidAes).records, [
        { path: 'not-a-path', kind: 'StringLiteral', value: 'x' },
    ]);
    assert.throws(
        () => decodeFilm(invalidAes),
        (error: unknown) => error instanceof FilmDecodeError
            && error.code === 'FILM_AES_INVALID'
            && error.stage === 'aes',
    );
});

test('merges flat and nested Film/AES limit options without crossing domains', () => {
    assert.throws(
        () => decodeFilm(CANONICAL_SCALAR, { maxEvents: 0 }),
        (error: unknown) => error instanceof FilmDecodeError
            && error.code === 'FILM_AES_INVALID'
            && error.diagnostics.some(({ counter }) => counter === 'max_events'),
    );
    assert.throws(
        () => decodeFilm(CANONICAL_SCALAR, { aesLimits: { maxEvents: 0 } }),
        (error: unknown) => error instanceof FilmDecodeError
            && error.code === 'FILM_AES_INVALID',
    );
    assert.doesNotThrow(() => decodeFilm(CANONICAL_SCALAR, {
        limits: { maxEvents: 1, maxStringCodepoints: 4 },
        aesLimits: { maxStringCodepoints: 5 },
    }));
    assert.throws(
        () => decodeFilm(CANONICAL_SCALAR, {
            limits: { maxEvents: 0 },
            aesLimits: { maxStringCodepoints: 5 },
        }),
        (error: unknown) => error instanceof FilmDecodeError
            && error.code === 'FILM_AES_INVALID'
            && error.diagnostics.some(({ counter }) => counter === 'max_events'),
    );
    assert.deepEqual(normalizeFilmLimits({
        maxRecordBytes: 7,
        filmLimits: { maxInputBytes: 8 },
    }), {
        maxInputBytes: 8,
        maxRecordBytes: 7,
        maxFieldBytes: 4_194_304,
        maxBufferedBytes: 16_777_216,
    });
});

test('incremental Film decoding withholds completion until final input', () => {
    const decoder = new IncrementalFilmDecoder();
    const first = decoder.push(CANONICAL_SCALAR.subarray(0, 8));
    assert.equal(first.status, 'need-more-input');

    const second = decoder.push(CANONICAL_SCALAR.subarray(8));
    assert.equal(second.status, 'provisional');
    assert.deepEqual(second.records, [
        { path: '$.message', kind: 'StringLiteral', value: 'hello' },
    ]);

    const complete = decoder.finish();
    if (complete.status !== 'complete') assert.fail('expected validated completion');
    assert.deepEqual(complete.stream?.records, second.records);
    assert.equal(encodeTelex(complete.stream.records), 'telex.aes=1\n\npath=$.message\nkind=StringLiteral\nvalue=hello\n');
});

function fromHex(input: string): Uint8Array {
    return Uint8Array.from(input.match(/../gu) ?? [], (pair) => Number.parseInt(pair, 16));
}
