# AEOS API

Informative status: implementation documentation for `@altopelago/aeos-core`.

## Package

- Module: `@altopelago/aeos-core`
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
- Indexed child AES paths are part of the current validation surface. Core emits bracket-addressed child events such as `$.page[0]`, `$.values[0]`, and `$.tuple[1]`, and AEOS rules can target those paths directly.
- Attribute payload constraints are part of the current validation surface through `constraints.attributes` and `closed_attributes`.
- This applies to ordinary binding attributes and anonymous child attributes alike.
- Attribute entries with datatypes participate in `datatype_rules` by default unless explicitly overridden by nested attribute constraints.
- AEOS validation is implementation-facing here, but mapped to the normative AEOS spec in `specs/`.

## Example

```ts
import { validate } from '@altopelago/aeos-core';

const result = validate(aes, schema, {
  trailingSeparatorDelimiterPolicy: 'warn',
});
```

Indexed child example:

```ts
const schema = {
  rules: [
    { path: '$.page', constraints: { type: 'NodeLiteral' } },
    { path: '$.page[0]', constraints: { type: 'NumberLiteral' } },
  ],
};

const result = validate(aes, schema);
```

Attribute-aware example:

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
          precision: {
            type: 'NumberLiteral',
            datatype: 'n',
          },
        },
        closed_attributes: true,
      },
    },
  ],
};

const result = validate(aes, schema);
```
