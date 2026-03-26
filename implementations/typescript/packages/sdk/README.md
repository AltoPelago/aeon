# @aeon/sdk

Application-facing convenience layer for common AEON read/write flows.

## Quick Start

```ts
import { readAeonChecked, writeAeon } from '@aeon/sdk';

const parsed = readAeonChecked('greeting:string = "Hello"');
console.log(parsed.finalized.document);

const emitted = writeAeon({ app: 'todo', version: 1 });
console.log(emitted.text);
```

## What This Package Does

- wraps common read flows around `@aeon/core` and `@aeon/finalize`
- wraps object emission via `@aeon/canonical`
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
- Use `@aeon/core` when you only need compile-only behavior.
- Use `@aeon/runtime` when you need the full orchestrated runtime pipeline.
