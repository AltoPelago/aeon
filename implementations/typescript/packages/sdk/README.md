# @altopelago/aeon-sdk

Application-facing convenience layer for common AEON read/write flows.

## Quick Start

```ts
import { readAeonChecked, writeAeon } from '@altopelago/aeon-sdk';

const parsed = readAeonChecked('greeting:string = "Hello"');
console.log(parsed.finalized.document);

const emitted = writeAeon({ app: 'todo', version: 1 });
console.log(emitted.text);
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
- `formatPath(path)`
- `indexEventsByPath(events)`

## Notes

- Prefer this package for simple application examples.
- Use `@altopelago/aeon-core` when you only need compile-only behavior.
- Use `@altopelago/aeon-runtime` when you need the full orchestrated runtime pipeline.
