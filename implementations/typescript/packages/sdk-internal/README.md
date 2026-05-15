# @altopelago/aeon-sdk-internal

Compatibility wrapper around `@altopelago/aeon-sdk`.

## Quick Start

Prefer `@altopelago/aeon-sdk` for new code.

## What This Package Does

- wraps common read flows around `@altopelago/aeon-core` and `@altopelago/aeon-finalize`
- wraps object emission via `@altopelago/aeon-canonical`
- exposes a canonical-path event index for tests and examples

## API

- `readAeon(input, options?)` - returns compile and finalized results
- `readAeonChecked(input, options?)` - throws on compile/finalize errors and returns `eventsByPath`
- `readAeonStrictCustom(input)` - strict finalize plus `allow_custom` compile policy
- `writeAeon(object, options?)` - wraps `emitFromObject`
- `formatPath(path)` - re-export from `@altopelago/aeon-core`
- `indexEventsByPath(events)` - builds a canonical-path event map

## Notes

- This package exists only as a short-lived compatibility bridge.
- New code should use `@altopelago/aeon-sdk`.
