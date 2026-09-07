# @altopelago/aeon-integrity

Canonical hash utilities for AEON integrity envelopes.

This package computes deterministic hashes over the legacy TypeScript AEON
assignment-event projection, excluding the top-level `:envelope` binding when
present. The projection predates portable `aes.events.v0`: it covers canonical
AEON source paths and values, not event kind, structural identity, expanded
datatype structure, profile/projection, or an AES ordering-policy identifier.
It must not be presented or verified as a portable AES semantic hash.

## Quick Start

```ts
import {
  buildCanonicalReceipt,
  computeCanonicalHash,
  computeByteHash,
  generateEd25519KeyPair,
  signCanonicalStream,
  validateEnvelopeEvents,
} from '@altopelago/aeon-integrity';

const result = computeCanonicalHash(aes, { algorithm: 'sha-256' });
console.log(result.hash);

const bytes = computeByteHash('hello', { algorithm: 'sha-256' });
console.log(bytes.hash);

const { publicKey, privateKey } = generateEd25519KeyPair();
const signed = signCanonicalStream(result.stream, privateKey);
console.log(signed.signature, publicKey);

const validation = validateEnvelopeEvents(aes, { mode: 'strict' });
console.log(validation.errors);

const receipt = buildCanonicalReceipt(sourceText, aes, {
  canonicalSpecRelease: 'r5',
  producer: {
    implementation: 'aeon-ts',
    version: '2.4.1',
  },
});
console.log(receipt.canonical.digest, receipt.canonical.payload);
```

## Common Patterns

### Hash the legacy AEON canonical projection

```ts
const result = computeCanonicalHash(aes, { algorithm: 'sha-256' });
console.log(result.stream);
console.log(result.hash);
```

### Validate an envelope on parsed document events

```ts
const validation = validateEnvelopeEvents(aes, { mode: 'strict' });
if (validation.errors.length > 0) {
  console.error(validation.errors);
}
```

## API

- `computeCanonicalHash(events, options?)`
- `computeByteHash(input, options?)`
- `buildCanonicalReceipt(source, events, options)`
- `verifyCanonicalReceipt(receipt, source, events)`
- `verifyByteHash(input, expectedHash, options?)`
- `verifyCanonicalHash(events, expectedHash, options?)`
- `signCanonicalStream(stream, privateKey, options?)`
- `verifyCanonicalStreamSignature(stream, signatureHex, publicKey, options?)`
- `generateEd25519KeyPair()`
- `validateEnvelopeDocument(document, options?)`
- `validateEnvelopeEvents(events, options?)`

## Notes

- Canonical hashing is based on the legacy AEON assignment projection, not on
  source text.
- Portable AES hashes and signatures require a separately versioned logical-byte
  and integrity contract bound to `aes.events.v0`, the effective profile and
  projection, and the selected ordering policy.
- References are preserved as `~` / `~>` tokens in canonical values.
