# @altopelago/aeon-annotation-stream

Annotation and comment attachment stream generation for AEON.

## Installation

```bash
pnpm add @altopelago/aeon-annotation-stream
```

## Usage

```ts
import { buildAnnotationStream } from '@altopelago/aeon-annotation-stream';

const result = buildAnnotationStream('//# docs\nanswer = 42');

if (result.errors.length === 0) {
  console.log(result.annotations);
}
```

## What This Package Does

- binds AEON comments and source annotations to nearby structural targets
- emits annotation stream records without mutating canonical data semantics
- preserves source-oriented metadata for editors, documentation tools, and
  semantic processors

## API

- `buildAnnotationStream(input, options?)`
- `buildAnnotationStreamFromSource(input, options?)`
- annotation record and placement metadata types

## When To Use It

Use this package when you need comment and annotation binding behavior directly.
For the stable compile entry point, prefer `@altopelago/aeon-core` and enable annotation emission there when appropriate.

## Notes

- Annotation streams are separate from canonical data output.
- Semantic comments can guide tools without changing finalized JSON.
- Attribute values remain part of the structural AEON data model; comment
  annotations remain soft metadata.
