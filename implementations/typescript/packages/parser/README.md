# @aeon/parser

AST construction for AEON source text.

## Installation

```bash
pnpm add @aeon/parser
```

## Usage

```ts
import { parse } from '@aeon/parser';

const result = parse('answer = 42');

if (result.errors.length === 0) {
  console.log(result.root);
}
```

Use this package when you need direct parser output for tooling or advanced analysis.
If you want the stable application-facing entry point, prefer `@aeon/core`.
