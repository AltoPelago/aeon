# @aeon/sdk-internal

Compatibility wrapper around `@aeon/sdk`.

## Quick Start

Prefer `@aeon/sdk` for new code.

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

- This package exists only as a short-lived compatibility bridge.
- New code should use `@aeon/sdk`.
