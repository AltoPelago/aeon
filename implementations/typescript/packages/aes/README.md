# @altopelago/aeon-aes

Assignment Event Stream emission, portable projection, Telex v1 codec, and
reader-only Film v1 decoding.

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
- parses, validates, encodes, and canonicalizes `telex.aes` v1 streams
- decodes one-shot and incremental `film.aes` v1 streams, withholding complete
  acceptance until portable AES validation succeeds
- splits compact Telex datatypes into `datatype`, `generics`, and `clarifiers`

## API

- `emitAssignmentEvents(input, options?)`
- `projectPortableEvents(events)` emits the default body-only portable
  projection
- `adaptTypeScriptAssignmentEventsToPortableAes(events, options?)` returns the
  named `aeon.typescript.assignment-events.v0-to-aes.events.v1` compatibility
  result and its conversion report; optional exact `sourceBytes` derive a
  SHA-256 origin and convert native UTF-16 ranges to UTF-8 byte spans;
  `includeHeaders: true` selects `aeon.document.v1`
- `parseTelex(input, options?)`
- `encodeTelex(records, options?)`
- `canonicalizeTelex(input, options?)`
- `validateTelex(input, options?)`
- `validateTelexRecords(records, options?)`
- `decodeFilmSyntax(input, options?)` for provisional inspection
- `decodeFilm(input, options?)` for complete validated reads
- `IncrementalFilmDecoder`
- canonical path helpers
- Assignment Event Stream types
  - emitted native events carry `sourcePlane: 'header' | 'body'`; consumers
    must not infer control-plane identity from an `aeon:` key prefix
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
- Film support is reader-only. No Film encoder or durable-writer surface is
  exported.
- Film byte limits (`maxInputBytes`, `maxRecordBytes`, `maxFieldBytes`, and
  `maxBufferedBytes`) are format-local. Shared event and structural limits may
  be supplied flat or through `aesLimits`; Telex framing limits are never
  imported as Film byte policy.
- Schema validation belongs in `@altopelago/aeos-core`.
- JSON or map materialization belongs in `@altopelago/aeon-finalize`.
