# @altopelago/aeos-core

**AEOS™** (Another Easy Object Schema) — validates Assignment Event Streams (AES) against AEOS schemas.

Implementation docs:

- [`docs/implementations/typescript/api/aeos.md`](../../../../docs/implementations/typescript/api/aeos.md)

## Installation

```bash
pnpm add @altopelago/aeos-core
```

## Quick Start

```ts
import { validate } from '@altopelago/aeos-core';
import { compile } from '@altopelago/aeon-core';

const compiled = compile('port = 8080');
if (compiled.errors.length > 0) throw new Error('compile failed');

const schema = {
  rules: [
    { path: '$.port', constraints: { type: 'IntegerLiteral' } }
  ]
};

const result = validate(compiled.events, schema);

if (result.ok) {
  console.log('Valid!');
} else {
  console.log('Errors:', result.errors);
}
```

## What AEOS Does

AEOS answers: "Is this AES structurally and representationally valid?"

AEOS does not:

- coerce values
- resolve references
- compare numeric magnitudes unless the rule explicitly requires it
- inject defaults
- reinterpret Core-owned reference-legality failures as schema errors

## Common Patterns

### Compile first, then validate

AEOS consumes AES, not raw AEON source text.
The usual pipeline is:

1. `compile(input)` with `@altopelago/aeon-core`
2. `validate(events, schema)` with `@altopelago/aeos-core`

### Read the result envelope

`validate()` returns a result envelope with:

- `ok`
- `errors`
- `warnings`
- `guarantees`

### Indexed child paths

AEOS validates AES paths, including synthetic indexed child events emitted by Core.

That means schemas can target list elements, tuple elements, and node children directly:

```ts
const schema = {
  rules: [
    { path: '$.page', constraints: { type: 'NodeLiteral' } },
    { path: '$.page[0]', constraints: { type: 'NumberLiteral' } },
  ]
};
```

For example, this AEON source:

```aeon
page:node = <page(:int32 = 3)>
```

produces AES paths including `$.page` and `$.page[0]`.

### Attribute-aware constraints

AEOS now validates attribute payload contents through:

- `constraints.attributes`
- `closed_attributes`

This applies to ordinary binding attributes and anonymous child attributes on
indexed AES events.

Example:

```ts
const schema = {
  rules: [
    {
      path: '$.values[0]',
      constraints: {
        type: 'NumberLiteral',
        attributes: {
          unit: {
            required: true,
            type: 'StringLiteral',
            datatype: 'string',
          },
        },
        closed_attributes: true,
      },
    },
  ],
};
```

Attribute entries continue to travel in AES metadata, but AEOS now exposes a
first-class schema surface for validating them.

## API

### `validate(aes, schema, options?)`

Validates an AES against an AEOS schema.

**Returns:** `ResultEnvelope`
```ts
{
  ok: boolean;
  errors: Diag[];
  warnings: Diag[];
  guarantees: Record<string, string[]>;
}
```
