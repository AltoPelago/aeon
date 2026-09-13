import assert from 'node:assert/strict';
import test from 'node:test';

import {
    FILM_V1_PREAMBLE,
    FilmDecodeError,
    IncrementalFilmDecoder,
    decodeFilm,
    decodeFilmSyntax,
    filmV1IsDraft,
} from './film.js';

const CANONICAL_SCALAR = fromHex(
    '4f5f5fff010012000109242e6d6573736167650568656c6c6f',
);

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
    assert.equal(complete.status, 'complete');
    assert.deepEqual(complete.stream?.records, second.records);
});

function fromHex(input: string): Uint8Array {
    return Uint8Array.from(input.match(/../gu) ?? [], (pair) => Number.parseInt(pair, 16));
}
