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

### Query AEON with SANSA

The optional `@altopelago/aeon-sdk/sansa` entry point converts compiled AEON
events into the resolver namespace expected by `@altopelago/sansa`:

```ts
import { readAeonNamespace } from '@altopelago/aeon-sdk/sansa';
import { evaluateQuery } from '@altopelago/sansa';

const { namespace } = readAeonNamespace(`
  inventory = {
    items = [
      { sku = "A-100" active = true }
      { sku = "B-200" active = false }
    ]
  }
`);

const result = evaluateQuery(
  'from $.inventory.items.* where .active == true select { sku = .sku }',
  namespace,
);
```

`readAeonNamespace()` requires successful compilation before returning. It
keeps finalization diagnostics alongside the lossless AES-backed namespace, so
AEON values that are not representable in strict JSON remain queryable. The
namespace exposes payload bindings by default; pass
`{ namespace: { scope: 'header' | 'full' } }` to select another document plane.
Use `createAeonNamespace(events)` when the source has already been compiled.

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
- `createAeonNamespace(events, options?)` from `@altopelago/aeon-sdk/sansa`
- `readAeonNamespace(input, options?)` from `@altopelago/aeon-sdk/sansa`

## Notes

- Prefer this package for simple application examples.
- Use `@altopelago/aeon-core` when you only need compile-only behavior.
- Use `@altopelago/aeon-runtime` when you need the full orchestrated runtime pipeline.
- Film is reader-only. This package deliberately exposes no Film writer or
  AEON-to-Film conversion helper.
- `aeonicLimits` contributes its shared AES structural and processing values to
  Film. Select Film-local byte ceilings separately with `filmLimits`.
