# @altopelago/aeon-sdk

Application-facing convenience layer for common AEON read/write flows.

## Quick Start

```ts
import { aeonToTelex, readAeonChecked, readFilmDocument, readTelexDocumentChecked, writeAeon } from '@altopelago/aeon-sdk';

const parsed = readAeonChecked('greeting:string = "Hello"');
console.log(parsed.finalized.document);

const emitted = writeAeon({ app: 'todo', version: 1 });
console.log(emitted.text);

const wire = aeonToTelex('answer = 42').telex!;
const imported = readTelexDocumentChecked(wire);
console.log(imported.finalized.document);

const film = readFilmDocument(filmBytes);
console.log(film.finalized.document);
```

## What This Package Does

- wraps common read flows around `@altopelago/aeon-core` and `@altopelago/aeon-finalize`
- wraps object emission via `@altopelago/aeon-canonical`
- exposes a canonical-path event index for app code and examples

## API

- `readAeon(input, options?)`
- `readAeonChecked(input, options?)`
- `readAeonStrictCustom(input)`
- `writeAeon(object, options?)`
- `aeonToTelex(input, options?)`
- `readTelex(input, options?)`
- `readTelexChecked(input, options?)`
- `readTelexDocument(input, options?)`
- `readTelexDocumentChecked(input, options?)`
- `writeTelex(records, options?)`
- `readFilm(input, options?)`
- `readFilmDocument(input, options?)`
- `formatPath(path)`
- `indexEventsByPath(events)`

## Notes

- Prefer this package for simple application examples.
- Use `@altopelago/aeon-core` when you only need compile-only behavior.
- Use `@altopelago/aeon-runtime` when you need the full orchestrated runtime pipeline.
- Film is reader-only. This package deliberately exposes no Film writer or
  AEON-to-Film conversion helper.
- `aeonicLimits` contributes its shared AES structural and processing values to
  Film. Select Film-local byte ceilings separately with `filmLimits`.
