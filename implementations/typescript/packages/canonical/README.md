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

### Reference-safe canonical ordering

The default contract (canonical CTS 0.4) validates authored Core references,
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

Omitting `ordering` selects `reference-safe-v1`. For historical source bytes,
explicitly select `ordering: 'lexical-v1'`; that compatibility contract does not
validate authored references. Do not mix the two contracts' hashes/signatures.
The same default applies to the [Rust API](../../../rust/README.md#reference-safe-canonical-ordering),
the pure-Python reference API (see the
[Python guide](../../../../docs/implementations/python/README.md)),
the [installed native-Python facade](../../../rust/crates/aeon-python/README.md#reference-safe-canonical-ordering),
the [WASM API](../wasm/README.md#reference-safe-canonical-ordering) and its process
pipeline, and all three `fmt` CLIs. Integrity receipt/event hashing remains its
separate historical projection. `emitFromObject` and Telex canonicalization
are unchanged. Existing stored source digests must retain their original contract.

## What This Package Does

- canonicalizes parsed AEON documents into stable text
- emits deterministic AEON from plain TypeScript objects
- defaults to reference-safe ordering, with explicit historical lexical compatibility
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
- Uses reference-safe ordering by default; select `lexical-v1` only for historical compatibility.
- Preserves reference tokens (`~` / `~>`).
- Parses separator-spec depth up to the AEON v1 capability floor (`8`) during canonicalization.
- `emitFromObject` emits deterministic AEON from plain TS objects and fails closed on unsupported values.
