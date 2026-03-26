# @aeon/annotation-stream

Annotation and comment attachment stream generation for AEON.

## Installation

```bash
pnpm add @aeon/annotation-stream
```

## Usage

```ts
import { buildAnnotationStream } from '@aeon/annotation-stream';

const result = buildAnnotationStream('//# docs\nanswer = 42');

if (result.errors.length === 0) {
  console.log(result.annotations);
}
```

Use this package when you need comment and annotation binding behavior directly.
For the stable compile entry point, prefer `@aeon/core` and enable annotation emission there when appropriate.
