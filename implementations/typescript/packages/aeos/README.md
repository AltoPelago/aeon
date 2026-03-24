# @aeos/core

**AEOS™** (Another Easy Object Schema) — validates Assignment Event Streams (AES) against AEOS schemas.

Implementation docs:

- [`docs/implementations/typescript/api/aeos.md`](../../../../docs/implementations/typescript/api/aeos.md)

## Installation

```bash
pnpm add @aeos/core
```

## Quick Start

```ts
import { validate } from '@aeos/core';
import { compile } from '@aeon/core';

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

1. `compile(input)` with `@aeon/core`
2. `validate(events, schema)` with `@aeos/core`

### Read the result envelope

`validate()` returns a result envelope with:

- `ok`
- `errors`
- `warnings`
- `guarantees`

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
