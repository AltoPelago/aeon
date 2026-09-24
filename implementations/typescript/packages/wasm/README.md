# @altopelago/aeon-wasm

Browser-facing wrapper for the Rust AEON implementation.

The TypeScript package is intentionally thin. It loads the generated `wasm-pack`
output from `pkg/` and exposes a typed async API for parity playgrounds and
browser-based conformance checks.

```ts
import { processAeon } from '@altopelago/aeon-wasm';

const result = await processAeon('name:string = "AEON"\n', {
  validationMode: 'strict',
  finalizeScope: 'payload',
});

console.log(result.finalized.document);
```

The same runtime exposes bulk Rust/WASM operations for Telex without creating
an intermediate JavaScript event graph:

```ts
import {
  canonicalizeTelex,
  checkTelexCompleteness,
  materializeTelex,
  validateTelex,
} from '@altopelago/aeon-wasm';

const validation = await validateTelex(telex);
const canonical = await canonicalizeTelex(telex);
const completeness = await checkTelexCompleteness(telex);
const materialized = await materializeTelex(telex);
```

These operations accept the Telex resource limits as camel-case options. They
perform parsing and validation internally and return only the result needed by
the caller across the JavaScript/WASM boundary. `materializeTelex` consumes the
flat AES records directly; it does not reconstruct an AEON parser AST.

`processAeon` returns the normalized engine contract used by browser parity
tools:

- `engine`: currently `rust-wasm`
- `ok`: true when there are no errors
- `canonical.text`: canonical AEON text
- `finalized.document`: materialized JSON-compatible output, or `null`
- `events`: normalized event summaries
- `annotations`: annotation stream records
- `diagnostics.errors` and `diagnostics.warnings`

For compatibility, `errors` and `warnings` are also exposed as top-level aliases
of `diagnostics.errors` and `diagnostics.warnings`.

For Core conformance or event-processing workloads that do not need a JSON
document, pass `finalize: false`. This compiles Sofia directly and returns Core
events and diagnostics with `canonical.text` empty and
`finalized.document: null`, avoiding canonicalization and materialization work.
The one-shot API also accepts the Core resource limits as camel-case options,
plus `datatypePolicy: 'reserved_only' | 'allow_custom'`. Use
`validationMode: 'declared'` to honor a document's declared mode without a host
override.

## Progressive streams

`createAeonStream` is the bounded-throughput API. It accepts `Uint8Array`
chunks, so a chunk may end in the middle of a UTF-8 scalar. Completed events
are returned in caller-pulled batches rather than through one JavaScript call
per event.

```ts
import { createAeonStream } from '@altopelago/aeon-wasm';

const stream = await createAeonStream({
  validationMode: 'strict',
  maxBatchEvents: 256,
  maxPendingBatches: 2,
});

function pullAvailable() {
  for (let batch = stream.pullBatch(); batch; batch = stream.pullBatch()) {
    // These events are provisional until takeTerminal() reports acceptance.
    consume(batch.streamId, batch.sequence, batch.events);
  }
}

for await (const chunk of response.body!) {
  let progress = stream.push(chunk);
  while (!progress.accepted) {
    pullAvailable();
    progress = stream.push(chunk); // retry the same refused chunk
  }
  pullAvailable();
}

let progress = stream.finish();
while (!progress.accepted) {
  pullAvailable();
  progress = stream.finish();
}
pullAvailable();

const terminal = stream.takeTerminal();
if (terminal.status === 'invalidated') {
  discardProvisionalEvents(terminal.streamId, terminal.reason);
}
```

Each batch carries a stream-local opaque ID, a contiguous batch sequence, and
the first event index. Backpressure refuses an operation without consuming it;
pull at least one batch and retry the same chunk or `finish` call. Cancellation
also produces an `invalidated` terminal result, because already exposed events
must be discarded.

The API is suitable for a Web Worker because the input and output units are
bounded. A worker can transfer fetched byte chunks into WASM and post each
batch back to the main thread:

```ts
// aeon.worker.ts
import { createAeonStream } from '@altopelago/aeon-wasm';

const stream = await createAeonStream({ maxBatchEvents: 256 });

self.onmessage = ({ data }: MessageEvent<Uint8Array | 'finish' | 'cancel'>) => {
  if (data === 'cancel') {
    stream.cancel();
    self.postMessage({ type: 'terminal', value: stream.takeTerminal() });
    return;
  }

  let progress = data === 'finish' ? stream.finish() : stream.push(data);
  while (true) {
    const batch = stream.pullBatch();
    if (batch === null) break;
    self.postMessage({ type: 'batch', value: batch });
  }
  self.postMessage({ type: 'progress', value: progress });

  if (stream.state() === 'terminal-ready') {
    self.postMessage({ type: 'terminal', value: stream.takeTerminal() });
  }
};
```

If a worker receives `accepted: false`, its owner must resend the same message
after the reported batches have been pulled. The worker should not apply
provisional effects irreversibly before the accepted terminal result.

## Browser smoke test

From the repository root, start the deterministic same-origin fixture:

```sh
npm run test:sofia:wasm:browser:serve
```

Open the printed localhost URL in a browser. The page reports `PASS` only after
the committed generated WASM succeeds on the main thread and in a module Web
Worker. The worker case transfers byte chunks, uses one-event bounded batches,
checks contiguous sequencing, and requires an accepted terminal result. The
server sends cross-origin isolation headers so this fixture also matches the
deployment prerequisites for future threaded-WASM experiments.

## Build

Build the TypeScript wrapper:

```sh
pnpm --filter @altopelago/aeon-wasm build
```

Build the Rust WASM artifact:

```sh
pnpm --filter @altopelago/aeon-wasm build:wasm
```

`build:wasm` requires exactly `wasm-pack 0.14.0` and reads the Rust crate from
`implementations/rust/crates/aeon-wasm`. The Rust compiler is pinned separately
by `implementations/rust/rust-toolchain.toml`. After generation, the build
script synchronizes `pkg/package.json` to the TypeScript wrapper version; the
wrapper and Rust crate can therefore remain separate release units. A Rust
toolchain or generator-version change is a reviewed build-input change and must
regenerate the committed `pkg/` artifacts.
