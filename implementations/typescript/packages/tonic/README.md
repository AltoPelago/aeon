# @aeon/tonic

AES-in materialization boundary scaffold.

This package currently exposes a minimal `materialize()` API.
At the moment it passes AES through unchanged and preserves the optional annotation stream when present.
It does not yet build a materialized `document`.

## Quick Start

```ts
import { materialize } from '@aeon/tonic';

const result = materialize({
  aes: [],
});

console.log(result.aes);
```

## Current Behavior

- returns the input `aes` unchanged
- preserves `annotations` when provided
- does not currently populate `document`
- does not currently populate `meta` unless future phases add materialization diagnostics

## When To Use This Package

Use `@aeon/tonic` only if you want the explicit materialization boundary package surface.

If you need:

- compile-only behavior, use `@aeon/core`
- validation over AES, use `@aeos/core`
- an orchestrated end-to-end runtime, use `@aeon/runtime`

## API

```ts
import type { AssignmentEvent } from '@aeon/aes';
import type { AnnotationRecord } from '@aeon/annotation-stream';

export interface TonicInput {
	aes: readonly AssignmentEvent[];
	annotations?: readonly AnnotationRecord[];
}

export interface TonicResult {
	aes: readonly AssignmentEvent[];
	annotations?: readonly AnnotationRecord[];
	document?: unknown;
	meta?: {
		errors?: readonly { message: string; code?: string }[];
		warnings?: readonly { message: string; code?: string }[];
	};
}
```

```ts
export function materialize(input: TonicInput): TonicResult;
```

## Annotation contract

- `annotations` is an optional parallel channel and may be absent.
- Annotation records are non-authoritative metadata and MUST NOT change AES semantics.
- Materialization behavior MUST remain deterministic whether `annotations` is present or omitted.

## Current Example Output

```json
{
	"aes": [
		{
			"path": { "segments": [{ "type": "root" }, { "type": "member", "key": "a" }] },
			"key": "a",
			"value": { "type": "NumberLiteral", "raw": "1", "value": "1" },
			"span": { "start": { "line": 1, "column": 1, "offset": 0 }, "end": { "line": 1, "column": 6, "offset": 5 } }
		}
	],
	"annotations": [
		{
			"kind": "doc",
			"form": "line",
			"raw": "//# docs",
			"span": {
				"start": { "line": 1, "column": 1, "offset": 0 },
				"end": { "line": 1, "column": 9, "offset": 8 }
			},
			"target": { "kind": "path", "path": "$.a" }
		}
	]
}
```
