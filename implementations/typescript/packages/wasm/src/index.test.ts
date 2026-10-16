import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import referenceOrderFixtures from '../../../../../test-fixtures/reference-authored-order.json' with { type: 'json' };

import {
  loadAeonWasm,
  TelexWasmError,
  type AeonStreamBatch,
  type EventSummary,
} from './index.js';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('generated wasm rejects metadata object duplicates in one-shot and chunked compilation', async () => {
  const runtime = await loadAeonWasm(readFileSync(resolve(packageRoot, 'pkg/aeon_wasm_bg.wasm')));
  const sources = [
    'a@{m = [{z = 1, z = 2}]} = 0',
    'a = {b@{m = [{z = 1, z = 2}]} = 0}',
    'a = [@{m = [{z = 1, z = 2}]} = 0]',
    'a = (@{m = [{z = 1, z = 2}]} = 0,)',
    'a = <tag(@{m = [{z = 1, z = 2}]} = 0)>',
    'a = [@{m = [{z = 1, z = 2}]} = {leaf = 0}]',
    'a = <tag@{m = [{z = 1, z = 2}]}>',
    'a = [<tag@{m = [{z = 1, z = 2}]}>]',
    'a@{m@{n = [{z = 1, z = 2}]} = 0} = 0',
    'a@{m = {n = [{z = 1, z = 2}]}} = 0',
    'a@{m = {n@{p = [{z = 1, z = 2}]} = 0}} = 0',
    'a@{m = ({z = 1, z = 2},)} = 0',
    'a@{m = <tag({z = 1, z = 2})>} = 0',
    'a@{m = <tag@{n = [{z = 1, z = 2}]}>} = 0',
    'aeon:header = {x@{m = [{z = 1, z = 2}]} = 0}',
    'aeon:header = {x = {leaf@{m = [{z = 1, z = 2}]} = 0}}',
    'aeon:header@{m = [{z = 1, z = 2}]} = {x = 0}',
    'aeon:header@{m = {n = [{z = 1, z = 2}]}} = {}',
  ];
  for (const source of sources) {
    const options = { validationMode: 'loose' as const, maxAttributeDepth: 4 };
    const rejected = runtime.processAeon(source, { ...options, finalize: false });
    assert.equal(rejected.ok, false, source);
    // The inspection wrapper retains recovery events; rejection is expressed
    // by ok/errors. The native parse-only API separately forbids partial ASTs.
    assert.deepEqual(rejected.errors.map(error => error.code), ['DUPLICATE_KEY'], source);
    assert.equal(runtime.processAeon(source.replace('z = 2', 'y = 2'), { ...options, finalize: false }).ok, true, source);
    for (let split = 0; split <= source.length; split += 1) {
      const stream = runtime.createAeonStream(options);
      assert.equal(stream.push(source.slice(0, split)).accepted, true);
      assert.equal(stream.push(source.slice(split)).accepted, true);
      assert.equal(stream.finish().accepted, true);
      while (stream.pullBatch() !== null) { /* drain provisional events */ }
      const terminal = stream.takeTerminal();
      assert.equal(terminal.status, 'invalidated', `${source}, split=${split}`);
      assert.deepEqual(terminal.errors.map(error => error.code), ['DUPLICATE_KEY'], `${source}, split=${split}`);
    }
  }
});

test('generated wasm preserves authored reference availability, including anonymous metadata', async () => {
  const wasm = readFileSync(resolve(packageRoot, 'pkg/aeon_wasm_bg.wasm'));
  const runtime = await loadAeonWasm(wasm);
  for (const fixture of referenceOrderFixtures) {
    const result = runtime.processAeon(fixture.source, {
      validationMode: 'loose',
      maxAttributeDepth: fixture.maxAttributeDepth ?? 1,
      finalize: false,
    });
    assert.deepEqual(result.errors.map(error => error.code), fixture.errors, fixture.id);
    assert.equal(result.ok, fixture.errors.length === 0, fixture.id);
  }
});

test('streamed anonymous metadata availability is independent of chunk boundaries', async () => {
  const wasm = readFileSync(resolve(packageRoot, 'pkg/aeon_wasm_bg.wasm'));
  const runtime = await loadAeonWasm(wasm);
  const fixtures = referenceOrderFixtures.filter(fixture =>
    /^anonymous-(list|tuple|node-child)-(payload-own|head-later)/.test(fixture.id));
  assert.equal(fixtures.length, 12);
  for (const fixture of fixtures) {
    for (let split = 0; split <= fixture.source.length; split += 1) {
      const label = `${fixture.id}, split=${split}`;
      const stream = runtime.createAeonStream({ validationMode: 'loose' });
      assert.equal(stream.push(fixture.source.slice(0, split)).accepted, true, label);
      assert.equal(stream.push(fixture.source.slice(split)).accepted, true, label);
      assert.equal(stream.finish().accepted, true, label);
      // These small fixtures fit in one batch; drain it before taking the terminal.
      while (stream.pullBatch() !== null) { /* discard provisional events */ }
      const terminal = stream.takeTerminal();
      assert.deepEqual(terminal.errors.map(error => error.code), fixture.errors, label);
      assert.equal(terminal.status, fixture.errors.length === 0 ? 'accepted' : 'invalidated', label);
    }
  }
});

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

test('exposes Core compilation without JSON finalization through generated wasm', async () => {
  const wasm = readFileSync(resolve(packageRoot, 'pkg/aeon_wasm_bg.wasm'));
  const runtime = await loadAeonWasm(wasm);
  const result = runtime.processAeon('notJson:nan = NaN\n', {
    validationMode: 'strict',
    datatypePolicy: 'allow_custom',
    finalize: false,
  });

  assert.equal(result.ok, true);
  assert.equal(result.canonical.text, '');
  assert.equal(result.finalized.document, null);
  assert.equal(result.events[0]?.path, '$.notJson');
  assert.equal(result.events[0]?.valueType, 'NaNLiteral');
});

test('validates, canonicalizes, and checks Telex inside wasm', async () => {
  const wasm = readFileSync(resolve(packageRoot, 'pkg/aeon_wasm_bg.wasm'));
  const runtime = await loadAeonWasm(wasm);
  const complete = 'telex.aes=1\n\npath=$.answer\nkind=NumberLiteral\nvalue=42\n';
  const nonCanonical = 'telex.aes=1\r\n\r\nvalue=\\u{000041}\r\nkind=StringLiteral\r\npath=$.answer\r\n';
  const partial = 'telex.aes=1\nprofile=aes.partial.v1\n\npath=$.a.b\nkind=NumberLiteral\nvalue=1\n';

  assert.deepEqual(runtime.validateTelex(complete), {
    valid: true,
    profile: 'aes.complete.v1',
    diagnostics: [],
  });
  assert.equal(
    runtime.canonicalizeTelex(nonCanonical),
    'telex.aes=1\n\npath=$.answer\nkind=StringLiteral\nvalue=A\n',
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

test('preserves structural identity in normalized wasm event summaries', async () => {
  const wasm = readFileSync(resolve(packageRoot, 'pkg/aeon_wasm_bg.wasm'));
  const runtime = await loadAeonWasm(wasm);
  const result = runtime.processAeon('age\\A1\\:int32 = 42\n');

  assert.equal(result.errors.length, 0);
  assert.equal(result.events[0]?.structuralId, 'A1');
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

test('streams byte chunks through bounded batches with one-shot event parity', async () => {
  const wasm = readFileSync(resolve(packageRoot, 'pkg/aeon_wasm_bg.wasm'));
  const runtime = await loadAeonWasm(wasm);
  const source = 'alpha:int32 = 1\nbeta:string = "Sofía 🌊"\ngamma:boolean = true\n';
  const expected = runtime.processAeon(source, { validationMode: 'strict' }).events;
  const stream = runtime.createAeonStream({
    validationMode: 'strict',
    maxBatchEvents: 1,
    maxPendingBatches: 1,
  });
  const events: EventSummary[] = [];
  const batches: AeonStreamBatch[] = [];
  const encoded = new TextEncoder().encode(source);

  for (const byte of encoded) {
    while (true) {
      const progress = stream.push(Uint8Array.of(byte));
      if (progress.accepted) break;
      const batch = stream.pullBatch();
      assert.ok(batch);
      batches.push(batch);
      events.push(...batch.events);
    }
    while (true) {
      const batch = stream.pullBatch();
      if (batch === null) break;
      batches.push(batch);
      events.push(...batch.events);
    }
  }

  while (true) {
    const progress = stream.finish();
    if (progress.accepted) break;
    const batch = stream.pullBatch();
    assert.ok(batch);
    batches.push(batch);
    events.push(...batch.events);
  }
  while (true) {
    const batch = stream.pullBatch();
    if (batch === null) break;
    batches.push(batch);
    events.push(...batch.events);
  }

  assert.deepEqual(events, expected);
  assert.deepEqual(batches.map((batch) => batch.sequence), [0, 1, 2]);
  assert.deepEqual(batches.map((batch) => batch.firstEventIndex), [0, 1, 2]);
  assert.ok(batches.every((batch) => batch.streamId === stream.id));
  assert.equal(stream.state(), 'terminal-ready');
  assert.deepEqual(stream.takeTerminal(), {
    streamId: stream.id,
    status: 'accepted',
    reason: null,
    eventCount: 3,
    exposedEventCount: 3,
    diagnostics: { errors: [], warnings: [] },
    errors: [],
    warnings: [],
  });
  assert.equal(stream.state(), 'complete');
  assert.throws(() => stream.finish());
});

test('refuses backpressured chunks until their predecessor batch is pulled', async () => {
  const wasm = readFileSync(resolve(packageRoot, 'pkg/aeon_wasm_bg.wasm'));
  const runtime = await loadAeonWasm(wasm);
  const stream = runtime.createAeonStream({ maxBatchEvents: 1, maxPendingBatches: 1 });

  const first = stream.push('alpha:int32 = 1\nbeta:int32 = 2\n');
  assert.equal(first.accepted, true);
  assert.equal(first.backpressured, true);
  const refused = stream.push('gamma:int32 = 3\n');
  assert.equal(refused.accepted, false);
  assert.equal(refused.backpressured, true);
  assert.equal(stream.pullBatch()?.events[0]?.path, '$.alpha');
  const retried = stream.push('gamma:int32 = 3\n');
  assert.equal(retried.accepted, true);
  assert.equal(stream.pullBatch()?.events[0]?.path, '$.beta');
  stream.finish();
  assert.equal(stream.pullBatch()?.events[0]?.path, '$.gamma');
  assert.equal(stream.takeTerminal().status, 'accepted');
});

test('cancellation invalidates exposed batches and releases the stream lifecycle', async () => {
  const wasm = readFileSync(resolve(packageRoot, 'pkg/aeon_wasm_bg.wasm'));
  const runtime = await loadAeonWasm(wasm);
  const stream = runtime.createAeonStream({ maxBatchEvents: 1, maxPendingBatches: 1 });

  stream.push('alpha:int32 = 1\nbeta:int32 = 2\n');
  assert.equal(stream.pullBatch()?.events[0]?.path, '$.alpha');
  assert.equal(stream.cancel().state, 'terminal-ready');
  const terminal = stream.takeTerminal();
  assert.equal(terminal.status, 'invalidated');
  assert.equal(terminal.reason, 'cancelled');
  assert.equal(terminal.exposedEventCount, 1);
  assert.throws(() => stream.push('gamma:int32 = 3\n'));
});

test('late syntax failure explicitly invalidates already exposed batches', async () => {
  const wasm = readFileSync(resolve(packageRoot, 'pkg/aeon_wasm_bg.wasm'));
  const runtime = await loadAeonWasm(wasm);
  const stream = runtime.createAeonStream({ maxBatchEvents: 1, maxPendingBatches: 1 });

  stream.push('good:int32 = 1\nbad = [\n');
  assert.equal(stream.pullBatch()?.events[0]?.path, '$.good');
  assert.equal(stream.finish().state, 'terminal-ready');
  const terminal = stream.takeTerminal();
  assert.equal(terminal.status, 'invalidated');
  assert.equal(terminal.reason, 'diagnostics');
  assert.equal(terminal.exposedEventCount, 1);
  assert.ok(terminal.errors.length > 0);
});

test('incomplete UTF-8 becomes an explicit terminal invalidation', async () => {
  const wasm = readFileSync(resolve(packageRoot, 'pkg/aeon_wasm_bg.wasm'));
  const runtime = await loadAeonWasm(wasm);
  const stream = runtime.createAeonStream();

  assert.equal(stream.push(Uint8Array.of(0xf0, 0x9f)).accepted, true);
  assert.equal(stream.finish().state, 'terminal-ready');
  const terminal = stream.takeTerminal();
  assert.equal(terminal.status, 'invalidated');
  assert.equal(terminal.reason, 'diagnostics');
  assert.equal(terminal.errors[0]?.code, 'INVALID_UTF8');
});

test('streaming rejects non-validating and unknown validation modes', async () => {
  const wasm = readFileSync(resolve(packageRoot, 'pkg/aeon_wasm_bg.wasm'));
  const runtime = await loadAeonWasm(wasm);

  assert.throws(() => runtime.createAeonStream({ validationMode: 'none' as never }));
  assert.throws(() => runtime.createAeonStream({ validationMode: 'mystery' as never }));
});
