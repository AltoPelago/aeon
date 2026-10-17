import assert from 'node:assert/strict';
import test from 'node:test';
import fixtures from '../../../../../test-fixtures/transport-generic-arguments.json' with { type: 'json' };
import {
    assertDatatypeDescriptor, canonicalizeTelex, encodeTelex, formatDatatypeDescriptor,
    parseDatatypeDescriptor, parseTelex, TelexSyntaxError, validateTelex, validateTelexRecords,
    type AesDatatypeDescriptor, type TelexRecord,
} from './telex.js';
import { IncrementalTelexDecoder } from './telex-incremental-internal.js';
import { decodeFilm, decodeFilmSyntax, FilmDecodeError, IncrementalFilmDecoder } from './film.js';

const wire = (datatype: string): string => `telex.aes=1\n\npath=$.a\nkind=NumberLiteral\ndatatype=${datatype}\nvalue=0\n`;

test('type-only generics reject literals at every Telex and record boundary', () => {
    for (const datatype of fixtures.invalid_datatypes) {
        const source = wire(datatype);
        const rejected = (error: unknown): boolean => error instanceof TelexSyntaxError
            && error.code === 'TELEX_INVALID_DATATYPE' && error.line === 5;
        assert.throws(() => parseDatatypeDescriptor(datatype));
        assert.throws(() => parseTelex(source), rejected);
        assert.throws(() => canonicalizeTelex(source), rejected);
        assert.throws(() => validateTelex(source), rejected);
        const bytes = new TextEncoder().encode(source);
        for (let split = 0; split <= bytes.length; split += 1) {
            const decoder = new IncrementalTelexDecoder();
            assert.throws(() => {
                decoder.push(bytes.subarray(0, split));
                decoder.push(bytes.subarray(split), { final: true });
            }, rejected, `${datatype}, split=${split}`);
        }
    }
    for (const literal of fixtures.literal_arguments) {
        for (const generics of [[literal], [{ datatype: 'nested', generics: [literal], clarifiers: [] }]]) {
            const descriptor = { datatype: 'custom', generics, clarifiers: [] };
            assert.throws(() => assertDatatypeDescriptor(descriptor), /generic argument must be a datatype descriptor/u);
            assert.throws(() => formatDatatypeDescriptor(descriptor as unknown as AesDatatypeDescriptor));
            const record = { path: '$.a', kind: 'NumberLiteral', ...descriptor, value: '0' } as unknown as TelexRecord;
            const result = validateTelexRecords([record]);
            assert.equal(result.valid, false);
            assert.ok(result.diagnostics.some(({ code }) => code === 'AES_INVALID_DATATYPE'));
            assert.throws(() => encodeTelex([record]));
        }
    }
});

test('recursive datatype clarifiers retain exact numeric strings through Telex', () => {
    const descriptor = parseDatatypeDescriptor(fixtures.valid_datatype);
    assert.equal(formatDatatypeDescriptor(descriptor), fixtures.valid_datatype);
    const record = { path: '$.a', kind: 'NumberLiteral', ...descriptor, value: '0' };
    assert.equal(validateTelexRecords([record]).valid, true);
    const encoded = encodeTelex([record]);
    assert.equal(encoded, wire(fixtures.valid_datatype));
    assert.deepEqual(parseTelex(encoded).records, [record]);
    assert.equal(canonicalizeTelex(encoded), encoded);
});

test('historical Film generic tags stay provisional and fail validated completion at every split', () => {
    for (const hex of fixtures.legacy_film) {
        const bytes = Uint8Array.from(Buffer.from(hex, 'hex'));
        const provisional = decodeFilmSyntax(bytes);
        assert.equal(provisional.records.length, 1);
        const validation = validateTelexRecords(provisional.records);
        assert.equal(validation.valid, false);
        assert.ok(validation.diagnostics.some(({ code }) => code === 'AES_INVALID_DATATYPE'));
        assert.throws(() => {
            // @ts-expect-error Provisional physical records are not valid type-only AES records.
            encodeTelex(provisional.records);
        });
        const rejected = (error: unknown): boolean => error instanceof FilmDecodeError
            && error.stage === 'aes' && error.code === 'FILM_AES_INVALID'
            && error.diagnostics.some(({ code }) => code === 'AES_INVALID_DATATYPE');
        assert.throws(() => decodeFilm(bytes), rejected);
        for (let split = 0; split <= bytes.length; split += 1) {
            const decoder = new IncrementalFilmDecoder();
            assert.notEqual(decoder.push(bytes.subarray(0, split)).status, 'complete');
            assert.throws(() => decoder.push(bytes.subarray(split), { final: true }), rejected);
        }
    }
});
