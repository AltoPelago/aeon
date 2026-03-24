import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildCanonicalReceipt,
    computeCanonicalHash,
    computeByteHash,
    generateEd25519KeyPair,
    serializeCanonicalEvents,
    serializeCanonicalValue,
    signStringPayload,
    signCanonicalStream,
    validateEnvelopeDocument,
    validateEnvelopeEvents,
    verifyCanonicalReceipt,
    verifyByteHash,
    verifyStringPayloadSignature,
    verifyCanonicalStreamSignature,
} from './index.js';
import { tokenize } from '@aeon/lexer';
import { parse } from '@aeon/parser';
import { resolvePaths, emitEvents } from '@aeon/aes';

function compileToEvents(input: string) {
    const tokens = tokenize(input).tokens;
    const ast = parse(tokens);
    if (!ast.document) throw new Error('Parse failed');
    const resolved = resolvePaths(ast.document);
    const emitted = emitEvents(resolved, { recovery: true });
    return emitted.events;
}

test('serializes canonical values', () => {
    const events = compileToEvents('a = "x"\nb = 1.20\nc = [true, false]');
    assert.equal(serializeCanonicalValue(events[0]!.value), '"x"');
    assert.equal(serializeCanonicalValue(events[1]!.value), '1.2');
    assert.equal(serializeCanonicalValue(events[2]!.value), '[true,false]');
});

test('serializes canonical event stream', () => {
    const events = compileToEvents('b = 2\na = 1');
    const stream = serializeCanonicalEvents(events);
    const lines = stream.trim().split('\n');
    assert.equal(lines[0]?.startsWith('$.a\t'), true);
    assert.equal(lines[1]?.startsWith('$.b\t'), true);
});

test('computes deterministic hash', () => {
    const events = compileToEvents('a = 1');
    const first = computeCanonicalHash(events, { algorithm: 'sha-256' });
    const second = computeCanonicalHash(events, { algorithm: 'sha-256' });
    assert.equal(first.hash, second.hash);
});

test('builds canonical receipts with embedded payloads', () => {
    const source = 'a = 1\n';
    const events = compileToEvents(source);
    const receipt = buildCanonicalReceipt(source, events, {
        canonicalMode: 'strict',
        canonicalProfile: 'core',
        canonicalSpecRelease: 'r5',
        producer: {
            implementation: 'aeon-ts',
            version: '2.4.1',
            build: 'abc123',
        },
        generatedAt: '2026-03-17T13:21:00Z',
    });
    assert.equal(receipt.source.mediaType, 'text/aeon');
    assert.equal(receipt.canonical.specRelease, 'r5');
    assert.equal(receipt.canonical.payload, '$.a\t1\n');
    assert.equal(receipt.canonical.length, 6);
    assert.equal(receipt.producer.implementation, 'aeon-ts');
    assert.equal(receipt.generated.at, '2026-03-17T13:21:00Z');
});

test('stores canonical payload length as utf-8 bytes', () => {
    const source = 'emoji = "😀"\n';
    const events = compileToEvents(source);
    const receipt = buildCanonicalReceipt(source, events, {
        producer: {
            implementation: 'aeon-ts',
            version: '2.4.1',
        },
        generatedAt: '2026-03-17T13:21:00Z',
    });
    assert.equal(receipt.canonical.payload, '$.emoji\t"😀"\n');
    assert.equal(receipt.canonical.length, Buffer.byteLength(receipt.canonical.payload, 'utf-8'));
    assert.equal(receipt.canonical.length > receipt.canonical.payload.length, true);
});

test('verifies canonical receipts and flags replay divergence separately', () => {
    const source = 'a = 1\n';
    const events = compileToEvents(source);
    const receipt = buildCanonicalReceipt(source, events, {
        producer: {
            implementation: 'aeon-ts',
            version: '2.4.1',
        },
        generatedAt: '2026-03-17T13:21:00Z',
    });
    const sourceVerification = verifyCanonicalReceipt(receipt, source, events);
    assert.equal(sourceVerification.source.matches, true);
    assert.equal(sourceVerification.canonical.matches, true);
    assert.equal(sourceVerification.replay.matches, true);

    const divergentReceipt = {
        ...receipt,
        canonical: {
            ...receipt.canonical,
            digest: 'deadbeef',
            payload: '$.a\t1\n',
        },
    };
    const divergentVerification = verifyCanonicalReceipt(divergentReceipt, source, events);
    assert.equal(divergentVerification.source.matches, true);
    assert.equal(divergentVerification.canonical.matches, false);
    assert.equal(divergentVerification.replay.matches, false);
});

test('reports embedded canonical payload length as utf-8 bytes during verification', () => {
    const source = 'emoji = "😀"\n';
    const events = compileToEvents(source);
    const receipt = buildCanonicalReceipt(source, events, {
        producer: {
            implementation: 'aeon-ts',
            version: '2.4.1',
        },
        generatedAt: '2026-03-17T13:21:00Z',
    });
    const verification = verifyCanonicalReceipt(receipt, source, events);
    assert.equal(verification.canonical.length, Buffer.byteLength(receipt.canonical.payload!, 'utf-8'));
    assert.equal(verification.canonical.length > receipt.canonical.payload!.length, true);
});

test('canonical hash ignores envelope subtree', () => {
    const body = 'a = 1';
    const withEnvelope = compileToEvents(`${body}\nclose:envelope = { canonical_hash_alg = "sha-256" canonical_hash = "deadbeef" }`);
    const withoutEnvelope = compileToEvents(body);
    const hashWithEnvelope = computeCanonicalHash(withEnvelope, { algorithm: 'sha-256' }).hash;
    const hashWithoutEnvelope = computeCanonicalHash(withoutEnvelope, { algorithm: 'sha-256' }).hash;
    assert.equal(hashWithEnvelope, hashWithoutEnvelope);
});

test('computes and verifies byte hash', () => {
    const input = 'hello';
    const result = computeByteHash(input, { algorithm: 'sha-256' });
    assert.equal(verifyByteHash(input, result.hash, { algorithm: 'sha-256' }), true);
    assert.equal(verifyByteHash(input, 'deadbeef', { algorithm: 'sha-256' }), false);
});

test('signs and verifies canonical stream', () => {
    const events = compileToEvents('a = 1');
    const stream = serializeCanonicalEvents(events);
    const { publicKey, privateKey } = generateEd25519KeyPair();
    const signature = signCanonicalStream(stream, privateKey);
    assert.equal(
        verifyCanonicalStreamSignature(stream, signature.signature, publicKey, { algorithm: 'ed25519' }),
        true
    );
    assert.equal(
        verifyCanonicalStreamSignature(`${stream}x`, signature.signature, publicKey, { algorithm: 'ed25519' }),
        false
    );
});

test('signs and verifies string payloads', () => {
    const { publicKey, privateKey } = generateEd25519KeyPair();
    const signature = signStringPayload('abc123', privateKey);
    assert.equal(
        verifyStringPayloadSignature('abc123', signature.signature, publicKey, { algorithm: 'ed25519' }),
        true
    );
    assert.equal(
        verifyStringPayloadSignature('abc124', signature.signature, publicKey, { algorithm: 'ed25519' }),
        false
    );
});

test('validates envelope placement and shape', () => {
    const ok = `
a = 1
close:envelope = {
  integrity:integrityBlock = {
    alg:string = "sha-256"
    hash:string = "deadbeef"
  }
}
`;
    const okResult = validateEnvelopeEvents(compileToEvents(ok), { mode: 'strict' });
    assert.equal(okResult.errors.length, 0);

    const notLast = `
close:envelope = {
  integrity:integrityBlock = {
    alg:string = "sha-256"
    hash:string = "deadbeef"
  }
}
a = 1
`;
    const notLastResult = validateEnvelopeEvents(compileToEvents(notLast), { mode: 'strict' });
    assert.equal(notLastResult.errors.some((diag) => diag.code === 'ENVELOPE_NOT_LAST'), true);

    const notObject = `
close:envelope = "oops"
`;
    const notObjectResult = validateEnvelopeEvents(compileToEvents(notObject), { mode: 'strict' });
    assert.equal(notObjectResult.errors.some((diag) => diag.code === 'ENVELOPE_NOT_OBJECT'), true);
});

test('warns on unknown envelope fields in loose mode', () => {
    const input = `
close:envelope = {
  integrity:integrityBlock = {
    alg:string = "sha-256"
    hash:string = "deadbeef"
    unknown:string = "x"
  }
}
`;
    const result = validateEnvelopeEvents(compileToEvents(input), { mode: 'loose' });
    assert.equal(result.errors.length, 0);
    assert.equal(result.warnings.some((diag) => diag.code === 'ENVELOPE_UNKNOWN_FIELD'), true);
});

test('validates envelope from document object', () => {
    const tokens = tokenize(`
close:envelope = {
  integrity:integrityBlock = {
    alg:string = "sha-256"
    hash:string = "deadbeef"
  }
}
`).tokens;
    const ast = parse(tokens);
    if (!ast.document) throw new Error('Parse failed');
    const result = validateEnvelopeDocument(ast.document, { mode: 'strict' });
    assert.equal(result.errors.length, 0);
});
