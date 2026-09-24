import { loadAeonWasm } from '../../dist/index.js';

const status = document.querySelector('[data-testid="status"]');
const reportNode = document.querySelector('[data-testid="report"]');

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

async function runMainThread() {
  const runtime = await loadAeonWasm();
  const result = runtime.processAeon(
    'title:string = "Sofía 🌊"\ncount:int32 = 3\n',
    { validationMode: 'strict' },
  );

  invariant(result.ok, 'main-thread one-shot compilation failed');
  invariant(result.finalized.document?.title === 'Sofía 🌊', 'main-thread Unicode result drifted');
  invariant(result.finalized.document?.count === 3, 'main-thread numeric result drifted');
  invariant(result.events.length === 2, 'main-thread event count drifted');

  const compileOnly = runtime.processAeon('notJson:nan = NaN\n', {
    validationMode: 'declared',
    finalize: false,
  });
  invariant(compileOnly.ok, 'main-thread compile-only path failed');
  invariant(compileOnly.canonical.text === '', 'compile-only path canonicalized input');
  invariant(compileOnly.finalized.document === null, 'compile-only path materialized JSON');
  invariant(compileOnly.events[0]?.valueType === 'NaNLiteral', 'compile-only event kind drifted');

  const cancelled = runtime.createAeonStream({ maxBatchEvents: 1, maxPendingBatches: 1 });
  cancelled.push('first:int32 = 1\nsecond:int32 = 2\n');
  const exposed = cancelled.pullBatch();
  invariant(exposed?.events[0]?.path === '$.first', 'main-thread provisional batch drifted');
  cancelled.cancel();
  const terminal = cancelled.takeTerminal();
  invariant(terminal.status === 'invalidated', 'main-thread cancellation was accepted');
  invariant(terminal.reason === 'cancelled', 'main-thread cancellation reason drifted');
  invariant(terminal.exposedEventCount === 1, 'main-thread exposed-event count drifted');

  return {
    oneShotEvents: result.events.length,
    compileOnlyKind: compileOnly.events[0]?.valueType,
    cancellation: terminal.status,
  };
}

async function runWorker() {
  const source = 'alpha:int32 = 1\nbeta:string = "Sofía 🌊"\ngamma:boolean = true\n';
  const bytes = new TextEncoder().encode(source);
  const chunkWidths = [1, 2, 5, 3, 8, 13];
  const chunks = [];
  for (let offset = 0, index = 0; offset < bytes.length; index += 1) {
    const width = chunkWidths[index % chunkWidths.length];
    const end = Math.min(bytes.length, offset + width);
    chunks.push(bytes.slice(offset, end));
    offset = end;
  }

  const worker = new Worker(new URL('./browser-smoke-worker.mjs', import.meta.url), {
    type: 'module',
  });

  try {
    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('worker smoke test timed out')), 10_000);
      worker.onmessage = ({ data }) => {
        clearTimeout(timeout);
        if (data?.ok) resolve(data);
        else reject(new Error(data?.error ?? 'worker smoke test failed'));
      };
      worker.onerror = ({ message }) => {
        clearTimeout(timeout);
        reject(new Error(message || 'worker module failed'));
      };
      worker.postMessage({ type: 'run', chunks }, chunks.map((chunk) => chunk.buffer));
    });
  } finally {
    worker.terminate();
  }
}

try {
  const mainThread = await runMainThread();
  const worker = await runWorker();
  const report = {
    status: 'passed',
    mainThread,
    worker: worker.summary,
    browser: navigator.userAgent,
    crossOriginIsolated: globalThis.crossOriginIsolated,
  };
  status.textContent = 'PASS';
  status.dataset.state = 'passed';
  reportNode.textContent = JSON.stringify(report, null, 2);
  document.documentElement.dataset.testState = 'passed';
  globalThis.aeonBrowserSmoke = report;
} catch (error) {
  const report = {
    status: 'failed',
    error: error instanceof Error ? error.stack ?? error.message : String(error),
    browser: navigator.userAgent,
  };
  status.textContent = 'FAIL';
  status.dataset.state = 'failed';
  reportNode.textContent = JSON.stringify(report, null, 2);
  document.documentElement.dataset.testState = 'failed';
  globalThis.aeonBrowserSmoke = report;
}
