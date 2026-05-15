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

Use this package when you need direct access to emitted AEON assignment events.
If you want the stable application-facing entry point, prefer `@altopelago/aeon-core`.
