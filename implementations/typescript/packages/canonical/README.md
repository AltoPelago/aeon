# @altopelago/aeon-canonical

Canonical AEON emitter.

This package produces a deterministic AEON text representation suitable for
hashing, diffing, and signing.

## Quick Start

### Canonicalize existing AEON text

```ts
import { canonicalize } from '@altopelago/aeon-canonical';

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
import { emitFromObject } from '@altopelago/aeon-canonical';

const result = emitFromObject(
  {
    name: 'miss-monsoon',
    settings: { targetLufs: -14 },
  },
  { includeHeader: true }
);
```

### Try reference safe canonical ordering

The experimental TypeScript API contract validates authored Core references,
then emits the smallest eligible decoded key after every step. It preserves
references rather than evaluating them:

```ts
const result = canonicalize('d=3\nc=2\nb=~c\na=1', {
  ordering: 'reference-safe-v1',
  maxOrderingEdges: 1_000_000,
});
// Body order: a, c, b, d. A default header is added when absent.
```

The option covers header fields, root bindings, object members, and attribute
entries, including nested metadata. List, tuple, and node-child positions remain
unchanged. Decoded keys are compared by Unicode scalar value. Missing, forward,
and self references in the authored source are rejected before sorting or
default-header insertion. This checks Core reference legality, not profile or
schema approval.

Quoted reference selectors use canonical string escaping, preserving control
characters in decoded keys without introducing raw line breaks into references.

`maxOrderingEdges` caps distinct projected dependency edges; it defaults to
1,000,000 and accepts non-negative safe integers. Ordering failures return
diagnostics and empty text, without an alphabetical fallback.

During cross-runtime rollout, omitting `ordering` retains the historical
`lexical-v1` behavior and bytes, including its lack of authored reference
validation. The internal Rust canonical crate also offers an explicit opt-in;
see the [Rust README](../../../rust/README.md#experimental-reference-safe-canonical-ordering).
The pure-Python reference API also has an explicit opt-in; see the
[Python guide](../../../../docs/implementations/python/README.md).
The [installed native-Python facade](../../../rust/crates/aeon-python/README.md#experimental-reference-safe-canonical-ordering)
also offers an explicit opt-in, as does the standalone
[WASM API](../wasm/README.md#experimental-reference-safe-canonical-ordering).
CLI, integrity hashing, native-Python defaults, and the WASM process pipeline
have not switched contracts. Treat opt-in output as experimental; do not mix its
hashes or signatures with historical canonical output. `emitFromObject` and
Telex canonicalization are unchanged.

## What This Package Does

- canonicalizes parsed AEON documents into stable text
- emits deterministic AEON from plain TypeScript objects
- supports historical lexical ordering and experimental reference-safe ordering
- canonicalizes Telex v1 independently from AEON source canonicalization

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
- `canonicalizeTelex(input, options?)`
- `emitFromObject(object, options?)`

## Notes

- Emits a default header when none exists.
- Uses historical lexical ordering by default; select `reference-safe-v1` explicitly during rollout.
- Preserves reference tokens (`~` / `~>`).
- Parses separator-spec depth up to the AEON v1 capability floor (`8`) during canonicalization.
- `emitFromObject` emits deterministic AEON from plain TS objects and fails closed on unsupported values.
