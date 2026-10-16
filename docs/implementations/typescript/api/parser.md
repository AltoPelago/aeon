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
  Limits clarifier value depth in datatype annotations. Default: `1`.

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

- Generic arguments are datatype descriptors, not literal parameters:
  `custom<number>[1.0]` and `list<custom[1.0]>` are valid syntax;
  `custom<1.0>` is not. Quoted strings cannot be generic type names either.
- Parsed numeric datatype clarifiers use `NumberLiteral` nodes, just like
  numeric values: `value` is normalized exact text, `raw` retains the source
  spelling, and `span` identifies the numeric token. They are not JavaScript
  `Number` values. String clarifiers remain strings, so `custom[123]` and
  `custom["123"]` remain distinct. Caller-constructed annotations may still
  supply native numbers, but precision already lost by a caller cannot be
  recovered.
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
