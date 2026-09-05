# @altopelago/aeon-aes

Assignment Event Stream emission, portable projection, and Telex v0 codec.

## Installation

```bash
pnpm add @altopelago/aeon-aes
```

## Usage

```ts
import { emitAssignmentEvents } from '@altopelago/aeon-aes';

const result = emitAssignmentEvents('answer = 42');

if (result.errors.length === 0) {
  console.log(result.events);
}
```

## What This Package Does

- emits Assignment Events from AEON source or parsed syntax
- formats and works with canonical AEON paths
- exposes event-level data used by AEOS validation, finalization, and tooling
- parses, validates, encodes, and canonicalizes `telex.aes` v0 streams
- splits compact Telex datatypes into `datatype`, `generics`, and `clarifiers`

## API

- `emitAssignmentEvents(input, options?)`
- `projectPortableEvents(events)`
- `parseTelex(input, options?)`
- `encodeTelex(records, options?)`
- `canonicalizeTelex(input, options?)`
- `validateTelex(input, options?)`
- `validateTelexRecords(records, options?)`
- canonical path helpers
- Assignment Event Stream types
- reconstructed candidate AES types:
  - `CandidateAES`
  - `CandidateAssignmentEvent`
  - `CandidateAttributeEntry`
  - `CandidateValue`

## When To Use It

Use this package when you need direct access to assignment events or the
encoding-neutral portable AES/Telex boundary.
If you want the stable application-facing entry point, prefer `@altopelago/aeon-core`.

## Notes

- AES is the structural event layer between parsing and downstream validation.
- Candidate AES types describe reconstructed validation input for speculative
  post-commit state. They do not define substrate materialization policy.
- This package does not materialize application objects.
- Schema validation belongs in `@altopelago/aeos-core`.
- JSON or map materialization belongs in `@altopelago/aeon-finalize`.
