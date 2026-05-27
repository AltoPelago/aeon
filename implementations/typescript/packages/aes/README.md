# @altopelago/aeon-aes

Assignment Event Stream emission and supporting AEON path utilities.

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

## API

- `emitAssignmentEvents(input, options?)`
- canonical path helpers
- Assignment Event Stream types

## When To Use It

Use this package when you need direct access to emitted AEON assignment events.
If you want the stable application-facing entry point, prefer `@altopelago/aeon-core`.

## Notes

- AES is the structural event layer between parsing and downstream validation.
- This package does not materialize application objects.
- Schema validation belongs in `@altopelago/aeos-core`.
- JSON or map materialization belongs in `@altopelago/aeon-finalize`.
