# @aeon/sdk-internal

Internal convenience package for AEON read/write flows during integration testing.

## Quick Start

```ts
import { readAeonStrictCustom, writeAeon } from '@aeon/sdk-internal';

const emitted = writeAeon({ app: 'todo', version: 1, todos: [] }, {
  includeHeader: true,
  header: {
    encoding: 'utf-8',
    mode: 'loose',
    profile: 'aeon.gp.profile.v1',
    version: 1,
  },
});

const parsed = readAeonStrictCustom(`
aeon:mode = "strict"
message:msgContainer = {
  bodyText:body = {
    msg:string = "Hello"
  }
  random:salt = 0.123456
}
`);
```

## What This Package Does

- wraps common read flows around `@aeon/core` and `@aeon/finalize`
- wraps object emission via `@aeon/canonical`
- exposes a canonical-path event index for tests and examples

## API

- `readAeon(input, options?)` - returns compile and finalized results
- `readAeonChecked(input, options?)` - throws on compile/finalize errors and returns `eventsByPath`
- `readAeonStrictCustom(input)` - strict finalize plus `allow_custom` compile policy
- `writeAeon(object, options?)` - wraps `emitFromObject`
- `formatPath(path)` - re-export from `@aeon/core`
- `indexEventsByPath(events)` - builds a canonical-path event map

## Notes

- This is an internal convenience layer, not the primary public entrypoint.
- Prefer `@aeon/core`, `@aeos/core`, `@aeon/runtime`, or `@aeon/canonical` directly for stable package-level usage.
