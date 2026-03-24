# AEOS API

Informative status: implementation documentation for `@aeos/core`.

## Package

- Module: `@aeos/core`
- Entry point: [`implementations/typescript/packages/aeos/src/index.ts`](../../../../implementations/typescript/packages/aeos/src/index.ts)

## Primary entry point

```ts
validate(aes, schema, options?)
```

AEOS validates AES against schema constraints. It validates representation and structure. It does not resolve references, coerce values, or change input data.

## Options

```ts
interface ValidateOptions {
  readonly strict?: boolean;
  readonly trailingSeparatorDelimiterPolicy?: 'off' | 'warn' | 'error';
}
```

## Behavior

- `strict`
  Reserved for future use in the current implementation.
- `trailingSeparatorDelimiterPolicy`
  Controls diagnostics for separator literal payloads that end with a declared separator.

## Return shape

`validate()` returns an AEOS result envelope containing:

- `ok`
- `errors`
- `warnings`
- `guarantees`

The envelope intentionally excludes the original AES payload.

## Notes

- AEOS is a validation boundary, not a semantic evaluation engine.
- Closed-world schema behavior is part of the current validation surface.
- AEOS validation is implementation-facing here, but mapped to the normative AEOS spec in `specs/`.

## Example

```ts
import { validate } from '@aeos/core';

const result = validate(aes, schema, {
  trailingSeparatorDelimiterPolicy: 'warn',
});
```
