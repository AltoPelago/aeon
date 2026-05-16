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

test('reports toggle literal naming from wasm events', async () => {
  const wasm = readFileSync(resolve(packageRoot, 'pkg/aeon_wasm_bg.wasm'));
  const runtime = await loadAeonWasm(wasm);
  const result = runtime.processAeon('state:toggle = on\n', {
    validationMode: 'strict',
    maxSeparatorDepth: 8,
    finalizeScope: 'payload',
  });

  assert.equal(result.errors.length, 0);
  assert.equal(result.events[0]?.datatype, 'toggle');
  assert.equal(result.events[0]?.valueType, 'ToggleLiteral');
  assert.deepEqual(result.finalized.document, { state: true });
});

test('binds block comments between equals and value to the current field', async () => {
  const wasm = readFileSync(resolve(packageRoot, 'pkg/aeon_wasm_bg.wasm'));
  const runtime = await loadAeonWasm(wasm);
  const result = runtime.processAeon(
    'app:object = {\n  name:string = "alignment playground"\n  enabled:boolean = /# h #/ true\n  port:number = 8080\n}\n',
    {
      validationMode: 'strict',
      maxSeparatorDepth: 8,
      finalizeScope: 'payload',
    },
  );

  assert.equal(result.errors.length, 0);
  assert.equal(result.annotations[0]?.target.kind, 'path');
  assert.equal(result.annotations[0]?.target.path, '$.app.enabled');
  assert.deepEqual(result.annotations[0]?.placement, { after: 'equals', before: 'value' });
});

test('binds comments inside node values to descendant paths', async () => {
  const wasm = readFileSync(resolve(packageRoot, 'pkg/aeon_wasm_bg.wasm'));
  const runtime = await loadAeonWasm(wasm);
  const result = runtime.processAeon(
    [
      '/# #/title/# #/:/# #/string/# #/=/# #/ "AEON Design Board"/# #/',
      'activePage/# #/:/# #/string /# #/= /# #/"design-board"/# #/',
      '/# #/',
      'page/# #/:/# #/node/# #/ =/# #/ <page(/# #/',
      '  /# #/<section/# #/ @{/# #/type/# #/:/# #/string /# #/= /# #/"feature", /# #/level/# #/:/# #/string /# #/=/# #/ "1"/# #/} (',
      '    <kicker/# #/("Design Board")>/# #/',
      '    <title("Keep the recurring blocks visible in one place."/# #/)>/# #/',
      '  )>/# #/',
      ')/# #/>',
    ].join('\n'),
    {
      validationMode: 'strict',
      maxSeparatorDepth: 8,
      finalizeScope: 'payload',
    },
  );

  assert.equal(result.errors.length, 0);
  assert.equal(result.annotations.length, 36);
  assert.equal(result.annotations[12]?.target.path, '$.page[0]');
  assert.deepEqual(result.annotations[12]?.placement, { before: 'key' });
  assert.equal(result.annotations[30]?.target.path, '$.page[0][0][0]');
  assert.deepEqual(result.annotations[30]?.placement, { before: 'key' });
  assert.equal(result.annotations[32]?.target.path, '$.page[0][1][0]');
  assert.deepEqual(result.annotations[32]?.placement, { after: 'value' });
});
