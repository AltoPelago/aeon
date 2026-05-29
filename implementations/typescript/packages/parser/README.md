# @altopelago/aeon-parser

AST construction for AEON source text.

## Installation

```bash
pnpm add @altopelago/aeon-parser
```

## Usage

```ts
import { tokenize } from '@altopelago/aeon-lexer';
import { parse } from '@altopelago/aeon-parser';

const tokens = tokenize('answer = 42').tokens;
const result = parse(tokens);

if (result.errors.length === 0) {
  console.log(result.root);
} else {
  console.error(result.errors);
}
```

## What This Package Does

- converts lexer tokens into AEON syntax trees
- preserves parser diagnostics for source-aware tooling
- keeps parsing separate from schema validation and final materialization

## API

- `parse(tokens, options?)`
- parser result and AST node types

## When To Use It

Use this package when you need direct parser output for tooling or advanced analysis.
If you want the stable application-facing entry point, prefer `@altopelago/aeon-core`.

## Notes

- The parser does not execute AEON documents.
- The parser does not coerce values into JavaScript application types.
- Most applications should use `@altopelago/aeon-core`, which combines lexing,
  parsing, mode checks, AES emission, and diagnostics into a safer entry point.
