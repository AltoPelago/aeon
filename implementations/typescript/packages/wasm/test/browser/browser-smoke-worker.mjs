import { loadAeonWasm } from '../../dist/index.js';

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function pullAvailable(stream, events, sequences) {
  while (true) {
    const batch = stream.pullBatch();
    if (batch === null) return;
    sequences.push(batch.sequence);
    events.push(...batch.events);
  }
}

self.onmessage = async ({ data }) => {
  if (data?.type !== 'run') return;

  try {
    const runtime = await loadAeonWasm();
    const oneShot = runtime.processAeon('worker:string = "ready"\n', {
      validationMode: 'strict',
    });
    invariant(oneShot.ok, 'worker one-shot compilation failed');
    invariant(oneShot.finalized.document?.worker === 'ready', 'worker one-shot result drifted');

    const stream = runtime.createAeonStream({
      validationMode: 'strict',
      maxBatchEvents: 1,
      maxPendingBatches: 1,
    });
    const events = [];
    const sequences = [];

    for (const chunk of data.chunks) {
      let progress = stream.push(chunk);
      while (!progress.accepted) {
        pullAvailable(stream, events, sequences);
        progress = stream.push(chunk);
      }
      pullAvailable(stream, events, sequences);
    }

    let progress = stream.finish();
    while (!progress.accepted) {
      pullAvailable(stream, events, sequences);
      progress = stream.finish();
    }
    pullAvailable(stream, events, sequences);
    const terminal = stream.takeTerminal();

    invariant(terminal.status === 'accepted', 'worker stream was not accepted');
    invariant(terminal.eventCount === 3, 'worker terminal event count drifted');
    invariant(events.length === 3, 'worker delivered event count drifted');
    invariant(events[1]?.path === '$.beta', 'worker event ordering drifted');
    invariant(events[1]?.valueType === 'StringLiteral', 'worker Unicode event kind drifted');
    invariant(sequences.every((sequence, index) => sequence === index), 'worker batch sequence drifted');

    self.postMessage({
      ok: true,
      summary: {
        oneShot: oneShot.finalized.document,
        streamedPaths: events.map((event) => event.path),
        batchSequences: sequences,
        terminalStatus: terminal.status,
      },
    });
  } catch (error) {
    self.postMessage({
      ok: false,
      error: error instanceof Error ? error.stack ?? error.message : String(error),
    });
  }
};
