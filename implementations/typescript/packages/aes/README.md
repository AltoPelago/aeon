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

Generic arguments must be recursive datatype descriptors, never tagged numeric
or string literals. For example, `custom<1.0>` is invalid while
`custom<child[9007199254740993]>[2.0000000000000001]` preserves exact clarifier
strings. The selected targets are AES Events CTS 0.2, Telex CTS 0.2, and
reader-only Film CTS 0.4. TypeScript exposes no Film writer.

Film syntax inspection and incremental progress remain provisional and can
expose historical physical numeric generic tags. Their `FilmSyntaxStream` and
`FilmSyntaxRecord` types do not imply valid AES. Only `decodeFilm()` or an
incremental result with `status === 'complete'` returns validated type-only
records. Film shares AES logical generic-depth accounting: `list<int>` fits a
maximum of zero; leaf descriptors and clarifiers add no generic-bearing level.
Over-limit generic-bearing descriptors fail before generic allocation or descent.
Independent byte, count, component and malformed-input guards still apply.
`validateTelexRecords()` accepts untrusted/provisional records for diagnostics;
that does not grant them the validated writer input type.

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
- `aeonRadixDigitValue(character)` maps the case-sensitive Core radix alphabet
  (`0-9`, `A-Z`, `a-z`, `&`, `!`) to digit values 0 through 63
- `aeonRadixBaseFromDatatype(datatype)` resolves `decimal`, reserved radix
  aliases, and `radix[n]` declarations to bases 2 through 64
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
