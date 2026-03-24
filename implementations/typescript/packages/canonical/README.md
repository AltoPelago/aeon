# @aeon/canonical

Canonical AEON emitter.

This package produces a deterministic AEON text representation suitable for
hashing, diffing, and signing.

## Quick Start

### Canonicalize existing AEON text

```ts
import { canonicalize } from '@aeon/canonical';

const result = canonicalize('b = 1\na = 2', {
  maxSeparatorDepth: 8,
  maxAttributeDepth: 8,
});
if (result.errors.length === 0) {
  console.log(result.text);
}
```

### Emit AEON from a plain object

```ts
import { emitFromObject } from '@aeon/canonical';

const result = emitFromObject(
  {
    name: 'miss-monsoon',
    settings: { targetLufs: -14 },
  },
  { includeHeader: true }
);
```

## What This Package Does

- canonicalizes parsed AEON documents into stable text
- emits deterministic AEON from plain TypeScript objects
- sorts header fields and binding keys lexicographically

## Common Patterns

### Include a generated header when emitting

```ts
const result = emitFromObject(
  { name: 'miss-monsoon' },
  { includeHeader: true }
);
```

### Override emitted header fields

```ts
const result = emitFromObject(
  { name: 'miss-monsoon' },
  {
    includeHeader: true,
    header: {
      encoding: 'utf-8',
      mode: 'strict',
      profile: 'aeon.gp.profile.v1',
      version: 1,
    },
  }
);
```

## API

- `canonicalize(input, options?)`
- `emitFromObject(object, options?)`

## Notes

- Emits a default header when none exists.
- Sorts header fields and binding keys lexicographically.
- Preserves reference tokens (`~` / `~>`).
- Parses separator-spec depth up to the AEON v1 capability floor (`8`) during canonicalization.
- `emitFromObject` emits deterministic AEON from plain TS objects and fails closed on unsupported values.
