# Parser API

Informative status: implementation documentation for `@altopelago/aeon-parser`.

## Package

- Module: `@altopelago/aeon-parser`
- Entry point: [`implementations/typescript/packages/parser/src/index.ts`](../../../../implementations/typescript/packages/parser/src/index.ts)

## Primary entry point

```ts
parse(tokens, options?)
```

The parser consumes lexer tokens and returns an AST-oriented parse result.

## Signature

```ts
interface ParserOptions {
  readonly maxAttributeDepth?: number;
  readonly maxSeparatorDepth?: number;
}
```

## Options

- `maxAttributeDepth`
  Limits nesting depth for attribute heads. Default: `1`.
- `maxSeparatorDepth`
  Limits separator-spec depth in datatype annotations. Default: `1`.

## Return shape

```ts
interface ParseResult {
  readonly document: Document | null;
  readonly errors: readonly ParserError[];
}
```

- `document`
  Parsed document AST, or `null` if parsing did not complete.
- `errors`
  Parser diagnostics collected during the parse.

## Notes

- These options are implementation controls, not AEON document syntax.
- The parser expects token input from `@altopelago/aeon-lexer`.
- If you need the canonical high-level processing entry point, use `@altopelago/aeon-core` instead of calling parser phases manually.

## Example

```ts
import { tokenize } from '@altopelago/aeon-lexer';
import { parse } from '@altopelago/aeon-parser';

const lexed = tokenize('config = { port = 8080 }');
const parsed = parse(lexed.tokens, {
  maxAttributeDepth: 1,
  maxSeparatorDepth: 1,
});
```
