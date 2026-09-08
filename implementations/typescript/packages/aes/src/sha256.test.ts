import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { sha256Hex } from './sha256.js';

const encoder = new TextEncoder();

test('computes standard SHA-256 vectors without a Node runtime dependency', () => {
    assert.equal(
        sha256Hex(new Uint8Array()),
        'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    assert.equal(
        sha256Hex(encoder.encode('abc')),
        'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    assert.equal(
        sha256Hex(encoder.encode('The quick brown fox jumps over the lazy dog')),
        'd7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592',
    );
});

test('matches Node SHA-256 across padding and multi-block boundaries', () => {
    for (const length of [1, 55, 56, 63, 64, 65, 127, 128, 129, 1024]) {
        const bytes = Uint8Array.from({ length }, (_, index) => (index * 37 + 11) & 0xff);
        const expected = createHash('sha256').update(bytes).digest('hex');
        assert.equal(sha256Hex(bytes), expected, `length ${length}`);
    }
});
