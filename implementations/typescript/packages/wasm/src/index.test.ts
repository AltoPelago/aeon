import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { loadAeonWasm, TelexWasmError } from './index.js';

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

test('validates, canonicalizes, and checks Telex inside wasm', async () => {
  const wasm = readFileSync(resolve(packageRoot, 'pkg/aeon_wasm_bg.wasm'));
  const runtime = await loadAeonWasm(wasm);
  const complete = 'telex.aes=0\n\npath=$.answer\nkind=NumberLiteral\nvalue=42\n';
  const nonCanonical = 'telex.aes=0\r\n\r\nvalue=\\u{000041}\r\nkind=StringLiteral\r\npath=$.answer\r\n';
  const partial = 'telex.aes=0\nprofile=aes.partial.v0\n\npath=$.a.b\nkind=NumberLiteral\nvalue=1\n';

  assert.deepEqual(runtime.validateTelex(complete), {
    valid: true,
    profile: 'aes.complete.v0',
    diagnostics: [],
  });
  assert.equal(
    runtime.canonicalizeTelex(nonCanonical),
    'telex.aes=0\n\npath=$.answer\nkind=StringLiteral\nvalue=A\n',
  );
  assert.deepEqual(runtime.checkTelexCompleteness(partial), {
    complete: false,
    missing: [{ path: '$.a', requiredBy: '$.a.b' }],
  });
  assert.deepEqual(runtime.materializeTelex(complete), {
    document: { answer: 42 },
    meta: { errors: [], warnings: [] },
  });
  assert.throws(
    () => runtime.validateTelex('not telex'),
    (error: unknown) => error instanceof TelexWasmError
      && error.code === 'TELEX_INVALID_PREAMBLE'
      && error.line === 1,
  );
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

test('binds comments inside node values to owning and descendant paths deterministically', async () => {
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
  assert.equal(result.annotations[12]?.target.path, '$.page');
  assert.deepEqual(result.annotations[12]?.placement, { after: 'key', before: 'datatype-colon' });
  assert.equal(result.annotations[30]?.target.path, '$.page[0][0]');
  assert.deepEqual(result.annotations[30]?.placement, { after: 'node-tag', before: 'node-children-open' });
  assert.equal(result.annotations[32]?.target.path, '$.page[0][1][0]');
  assert.deepEqual(result.annotations[32]?.placement, { after: 'value' });
});
