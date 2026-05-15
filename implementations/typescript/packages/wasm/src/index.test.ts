import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { loadAeonWasm } from './index.js';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('processes a basic document through the generated wasm artifact', async () => {
  const wasm = readFileSync(resolve(packageRoot, 'pkg/aeon_wasm_bg.wasm'));
  const runtime = await loadAeonWasm(wasm);
  const result = runtime.processAeon('a:string = "ok"\n', {
    validationMode: 'strict',
    maxSeparatorDepth: 8,
    finalizeScope: 'payload',
  });

  assert.equal(result.engine, 'rust-wasm');
  assert.equal(result.ok, true);
  assert.equal(result.errors.length, 0);
  assert.deepEqual(result.diagnostics.errors, []);
  assert.deepEqual(result.finalized.document, { a: 'ok' });
  assert.equal(result.events[0]?.path, '$.a');
});

test('normalizes internal switch literal naming to toggle literal naming', async () => {
  const wasm = readFileSync(resolve(packageRoot, 'pkg/aeon_wasm_bg.wasm'));
  const runtime = await loadAeonWasm(wasm);
  const result = runtime.processAeon('state:switch = on\n', {
    validationMode: 'strict',
    maxSeparatorDepth: 8,
    finalizeScope: 'payload',
  });

  assert.equal(result.errors.length, 0);
  assert.equal(result.events[0]?.datatype, 'toggle');
  assert.equal(result.events[0]?.valueType, 'ToggleLiteral');
  assert.deepEqual(result.finalized.document, { state: true });
});
