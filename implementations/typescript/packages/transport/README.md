# @aeon/transport

Transport framing helpers for AEON document units.

This package implements **u32 big-endian length-prefix framing** and
lightweight header inspection utilities for streaming workflows.

## Quick Start

```ts
import {
  encodeFrame,
  decodeFrame,
  FrameDecoder,
  inspectHeader,
} from '@aeon/transport';

const framed = encodeFrame('a = 1');
const decoded = decodeFrame(framed);
console.log(decoded?.frame);

const decoder = new FrameDecoder({ maxFrameSize: 8 * 1024 * 1024 });
const frames = decoder.push(framed);

const inspection = inspectHeader('aeon:version = "2.0"\na = 1');
console.log(inspection.header);
```

## Common Patterns

### Decode incrementally from a stream

```ts
const decoder = new FrameDecoder({ maxFrameSize: 8 * 1024 * 1024 });
const frames = decoder.push(chunk);
```

### Inspect only the transport header

```ts
const inspection = inspectHeader(sourceText);
console.log(inspection.header.mode);
console.log(inspection.errors);
```

## API

- `encodeFrame(payload, options?)`
- `decodeFrame(buffer, options?)`
- `FrameDecoder`
- `createFrameEncoderStream(options?)`
- `createFrameDecoderStream(options?)`
- `inspectHeader(input, options?)`

## Notes

- Frames are encoded as: 4-byte length prefix (big-endian) + payload bytes.
- Resource limits are enforced to fail closed on oversized frames.
