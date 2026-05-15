# @altopelago/aeon-lexer

Tokenization for AEON source text.

## Installation

```bash
pnpm add @altopelago/aeon-lexer
```

## Usage

```ts
import { lex } from '@altopelago/aeon-lexer';

const result = lex('answer = 42');

for (const token of result.tokens) {
  console.log(token.kind, token.raw);
}
```

Use this package when you need direct token access for tooling, analysis, or editor features.
If you want the stable application-facing entry point, prefer `@altopelago/aeon-core`.
