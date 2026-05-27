# @altopelago/aeon-lexer

Tokenization for AEON source text.

## Installation

```bash
pnpm add @altopelago/aeon-lexer
```

## Usage

```ts
import { tokenize } from '@altopelago/aeon-lexer';

const result = tokenize('answer = 42');

if (result.errors.length > 0) {
  console.error(result.errors);
}

for (const token of result.tokens) {
  console.log(token.kind, token.raw);
}
```

## What This Package Does

- converts AEON source text into lexer tokens
- preserves raw token text for diagnostics and source-aware tooling
- reports lexical errors without executing or interpreting document meaning

## API

- `tokenize(input, options?)`
- token kinds and token metadata types used by parser and editor tooling

## When To Use It

Use this package when you need direct token access for tooling, analysis, or editor features.
If you want the stable application-facing entry point, prefer `@altopelago/aeon-core`.

## Notes

- The lexer does not build AST nodes.
- The lexer does not validate AEON schemas or materialize JSON.
- Downstream packages such as `@altopelago/aeon-parser` and
  `@altopelago/aeon-core` consume the token stream.
