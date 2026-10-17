import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import referenceOrderFixtures from '../../../../../test-fixtures/reference-authored-order.json' with { type: 'json' };
import renderingFixtures from '../../../../../test-fixtures/canonical-rendering-boundaries.json' with { type: 'json' };
import numericClarifiers from '../../../../../test-fixtures/numeric-clarifiers.json' with { type: 'json' };
import genericArguments from '../../../../../test-fixtures/datatype-generic-arguments.json' with { type: 'json' };
import nodeBindingGenerics from '../../../../../test-fixtures/node-binding-generics.json' with { type: 'json' };
import transportGenerics from '../../../../../test-fixtures/transport-generic-arguments.json' with { type: 'json' };
import radixBases from '../../../../../test-fixtures/radix-bases.json' with { type: 'json' };
import datatypeNames from '../../../../../test-fixtures/radix-datatype-names.json' with { type: 'json' };
import gpRadixContexts from '../../../../../test-fixtures/gp-radix-contexts.json' with { type: 'json' };
import gpAttributeFixtures from '../../../../../test-fixtures/gp-attribute-clarifiers.json' with { type: 'json' };
import gpTagHeadFixtures from '../../../../../test-fixtures/gp-tag-head-clarifiers.json' with { type: 'json' };

import {
  loadAeonWasm,
  canonicalize,
  type CanonicalizeOptions,
  TelexWasmError,
  type AeonStreamBatch,
  type EventSummary,
} from './index.js';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('committed WASM standalone canonical opt-in preserves default process behavior', async () => {
  const runtime = await loadAeonWasm(readFileSync(resolve(packageRoot, 'pkg/aeon_wasm_bg.wasm')));
  const source = 'z=1\na=~z';
  const legacy = runtime.canonicalize(source);
  assert.deepEqual(legacy.errors, []);
  assert.ok(legacy.text.endsWith('a = ~z\nz = 1\n'));
  assert.deepEqual(runtime.canonicalize(source, { ordering: 'lexical-v1' }), legacy);
  assert.equal(runtime.processAeon(source, { validationMode: 'none' }).canonical.text, legacy.text);
  assert.equal(runtime.processAeon(source, { validationMode: 'loose', finalize: false }).canonical.text, '');
  const options = { ordering: 'reference-safe-v1' as const };
  const result = runtime.canonicalize('d=3\nc=2\nb=~c\na=1', options);
  assert.deepEqual(result.errors, []);
  assert.ok(result.text.endsWith('a = 1\nc = 2\nb = ~c\nd = 3\n'));
  assert.deepEqual(await canonicalize('d=3\nc=2\nb=~c\na=1', options), result);
});

test('committed WASM canonical source and ordering failures have no partial text', async () => {
  const runtime = await loadAeonWasm(readFileSync(resolve(packageRoot, 'pkg/aeon_wasm_bg.wasm')));
  for (const [source, code] of [['a=~z\nz=1', 'FORWARD_REFERENCE'], ['a=~missing', 'MISSING_REFERENCE_TARGET'], ['a=~a', 'SELF_REFERENCE']]) {
    const result = runtime.canonicalize(source!, { ordering: 'reference-safe-v1' });
    assert.equal(result.text, '');
    assert.equal(result.errors[0]?.code, code);
    assert.equal(result.errors[0]?.path, '$.a');
  }
  const result = runtime.canonicalize('z=1\na=~z', { ordering: 'reference-safe-v1', maxOrderingEdges: 0 });
  assert.equal(result.text, '');
  assert.equal(result.errors[0]?.code, 'CANONICAL_ORDERING_LIMIT_EXCEEDED');
  assert.equal(result.errors[0]?.phase, null);
  assert.deepEqual(runtime.canonicalize('z=1\na={b=~z,c=~>z}', { ordering: 'reference-safe-v1', maxOrderingEdges: 1 }).errors, []);
});

test('committed WASM canonicalization is Core-only and preserves metadata/literal boundaries', async () => {
  const runtime = await loadAeonWasm(readFileSync(resolve(packageRoot, 'pkg/aeon_wasm_bg.wasm')));
  const options = { ordering: 'reference-safe-v1' as const, maxAttributeDepth: 2 };
  const gpSource = 'aeon:profile="aeon.gp.profile.v1"\nx:radix[2.0000000000000001]=%1';
  assert.deepEqual(runtime.canonicalize(gpSource, options).errors, []);
  assert.ok(runtime.processAeon(gpSource, { validationMode: 'loose', finalize: false }).errors.some(error => error.code === 'PROFILE_DATATYPE_CLARIFIER_INVALID'));
  for (const fixture of renderingFixtures) {
    const result = runtime.canonicalize(fixture.source, options);
    assert.deepEqual(result.errors, [], fixture.id);
    assert.ok(result.text.includes(fixture.fragment), fixture.id);
    assert.deepEqual(runtime.canonicalize(result.text, options), result, fixture.id);
  }
  const deep = 'a@{z@{x=1}=1,b=~a.@.z.@.x}=0';
  assert.equal(runtime.canonicalize(deep, { ordering: 'reference-safe-v1' }).text, '');
  assert.deepEqual(runtime.canonicalize(deep, options).errors, []);
});

test('WASM canonical options are checked before JSON conversion and read once', async () => {
  const runtime = await loadAeonWasm(readFileSync(resolve(packageRoot, 'pkg/aeon_wasm_bg.wasm')));
  for (const key of ['maxOrderingEdges', 'maxAttributeDepth']) {
    for (const value of [-1, 0.5, NaN, Infinity, 2 ** 32, Number.MAX_SAFE_INTEGER, true, false, null, '1']) {
      assert.throws(() => runtime.canonicalize('a=1', { [key]: value } as CanonicalizeOptions), RangeError, `${key}=${String(value)}`);
    }
  }
  assert.throws(() => runtime.canonicalize('a=1', { ordering: 'unknown' } as unknown as CanonicalizeOptions), RangeError);
  assert.throws(() => runtime.canonicalize('a=1', { maxOrderEdges: 1 } as CanonicalizeOptions), TypeError);
  for (const value of [null, [], 1, true, 'reference-safe-v1']) {
    assert.throws(() => runtime.canonicalize('a=1', value as CanonicalizeOptions), TypeError);
  }
  let reads = 0;
  const inherited = Object.create({ get ordering() { reads += 1; return 'reference-safe-v1'; } }) as CanonicalizeOptions;
  assert.ok(runtime.canonicalize('z=1\na=~z', inherited).text.endsWith('z = 1\na = ~z\n'));
  assert.equal(reads, 1);
  assert.deepEqual(runtime.canonicalize('a=1', { ordering: 'reference-safe-v1', maxOrderingEdges: 0xffff_ffff, maxAttributeDepth: 0 }).errors, []);
});

test('generated WASM canonical export rejects invalid raw options independently', async () => {
  const generated = await import('../pkg/aeon_wasm.js');
  await generated.default({ module_or_path: readFileSync(resolve(packageRoot, 'pkg/aeon_wasm_bg.wasm')) });
  for (const options of ['{"ordering":"unknown"}', '{"maxOrderingEdges":4294967296}', '{"maxOrderingEdges":true}', '{"maxAttributeDepth":null}', '{"unexpected":1}', 'null', '[]']) {
    assert.throws(() => generated.canonicalize_aeon('a=1', options));
  }
});

test('committed WASM JSON-escapes control keys in Core event and reference paths', async () => {
  const runtime = await loadAeonWasm(readFileSync(resolve(packageRoot, 'pkg/aeon_wasm_bg.wasm')));
  for (let code = 0; code < 32; code += 1) {
    const key = `z${String.fromCharCode(code)}`;
    const quoted = JSON.stringify(key);
    const source = `${quoted}=1\ncopy=~[${quoted}]`;
    const result = runtime.processAeon(source, { validationMode: 'loose', finalize: false });
    assert.deepEqual(result.errors, [], source);
    assert.equal(result.events[0]?.path, `$.[${quoted}]`, source);
    assert.equal(result.events[1]?.path, '$.copy', source);
    assert.equal(result.events[1]?.valueType, 'CloneReference', source);
  }
});

test('generated WASM rejects literal Telex generics and retains exact recursive clarifiers', async () => {
  const runtime = await loadAeonWasm(readFileSync(resolve(packageRoot, 'pkg/aeon_wasm_bg.wasm')));
  const wire = (datatype: string): string => `telex.aes=1\n\npath=$.a\nkind=NumberLiteral\ndatatype=${datatype}\nvalue=0\n`;
  for (const datatype of transportGenerics.invalid_datatypes) {
    for (const operation of [runtime.validateTelex, runtime.canonicalizeTelex, runtime.materializeTelex]) {
      assert.throws(() => operation(wire(datatype)), (error: unknown) => error instanceof TelexWasmError
        && error.code === 'TELEX_INVALID_DATATYPE' && error.line === 5, datatype);
    }
  }
  const source = wire(transportGenerics.valid_datatype);
  assert.equal(runtime.validateTelex(source).valid, true);
  assert.equal(runtime.canonicalizeTelex(source), source);
  assert.deepEqual(runtime.materializeTelex(source).document, { a: 0 });
});

test('generated wasm validates GP unprojected claims in one-shot and every two-chunk split', async () => {
  const runtime = await loadAeonWasm(readFileSync(resolve(packageRoot, 'pkg/aeon_wasm_bg.wasm')));
  for (const validationMode of ['loose', 'strict'] as const) {
    const options = { validationMode, datatypePolicy: 'allow_custom', maxAttributeDepth: 2, maxClarifierValues: 2 } as const;
    const fixtures = validationMode === 'strict' ? gpTagHeadFixtures : [...gpAttributeFixtures, ...gpTagHeadFixtures];
    for (const fixture of fixtures) {
      assert.deepEqual(runtime.processAeon(fixture.source, { ...options, finalize: false }).errors, [], fixture.id);
      for (const source of [`aeon:profile="aeon.gp.profile.v1"\n${fixture.source}`, `${fixture.source}\naeon:profile="aeon.gp.profile.v1"`]) {
        const result = runtime.processAeon(source, { ...options, finalize: false });
        assert.deepEqual(result.errors.map(({ code, path }) => ({ code, path })), fixture.errors, fixture.id);
        for (let split = 0; split <= source.length; split += 1) {
          const stream = runtime.createAeonStream(options);
          const drain = () => { while (stream.pullBatch() !== null) { /* drain provisional events */ } };
          assert.equal(stream.push(source.slice(0, split)).accepted, true);
          drain();
          assert.equal(stream.push(source.slice(split)).accepted, true);
          drain();
          assert.equal(stream.finish().accepted, true);
          drain();
          const terminal = stream.takeTerminal();
          assert.equal(terminal.status, fixture.errors.length ? 'invalidated' : 'accepted', `${fixture.id}, ${validationMode}, split=${split}`);
          assert.deepEqual(terminal.errors.map(({ code, path }) => ({ code, path })), fixture.errors, `${fixture.id}, ${validationMode}, split=${split}`);
        }
      }
    }
  }
});

test('generated wasm GP checks exact numeric radix values across binding, generic and item contexts', async () => {
  const runtime = await loadAeonWasm(readFileSync(resolve(packageRoot, 'pkg/aeon_wasm_bg.wasm')));
  for (const { literal, base } of radixBases.filter(f => f.testSource)) {
    for (const { before, after } of gpRadixContexts) {
      const source = `${before}${literal}${after}`;
      const core = runtime.processAeon(source, { validationMode: 'strict', finalize: false });
      assert.deepEqual(core.errors, [], source);
      const result = runtime.processAeon(`aeon:profile="aeon.gp.profile.v1"\n${source}`, { validationMode: 'strict', finalize: false });
      assert.deepEqual(result.errors.map(d => d.code), base === null ? ['PROFILE_DATATYPE_CLARIFIER_INVALID'] : [], source);
    }
  }
  for (const [literal, valid] of [['2.00', true], ['2e0', true], ['2.0000000000000001', false]] as const) {
    const source = `aeon:profile="aeon.gp.profile.v1"\nmask:radix[${literal}]=%1`;
    for (let split = 0; split <= source.length; split += 1) {
      const stream = runtime.createAeonStream({ validationMode: 'strict' });
      assert.equal(stream.push(source.slice(0, split)).accepted, true);
      assert.equal(stream.push(source.slice(split)).accepted, true);
      assert.equal(stream.finish().accepted, true);
      while (stream.pullBatch() !== null) { /* drain provisional events */ }
      const terminal = stream.takeTerminal();
      assert.equal(terminal.status, valid ? 'accepted' : 'invalidated', `${literal}, split=${split}`);
      if (!valid) assert.deepEqual(terminal.errors.map(d => d.code), ['PROFILE_DATATYPE_CLARIFIER_INVALID']);
    }
  }
});

test('generated wasm keeps custom mixed-case radix names unspecified in both finalizers', async () => {
  const runtime = await loadAeonWasm(readFileSync(resolve(packageRoot, 'pkg/aeon_wasm_bg.wasm')));
  for (const { datatype, base, invalid } of datatypeNames) {
    for (const [payload, digit] of [['1', 1], ['A', 10]] as const) {
      const source = `mask:${datatype}=%${payload}`;
      assert.deepEqual(runtime.processAeon(source, { validationMode: 'strict', datatypePolicy: 'allow_custom', finalize: false }).errors, [], source);
      const legacy = runtime.processAeon(source, { validationMode: 'strict', datatypePolicy: 'allow_custom' });
      const portable = runtime.materializeTelex(`telex.aes=1\n\npath=$.mask\nkind=RadixLiteral\ndatatype=${datatype}\nvalue=${payload}\n`, { finalizeMode: 'strict' });
      const expected = invalid || (base !== null && digit >= base);
      assert.equal(legacy.errors.some(d => d.code === 'FINALIZE_INVALID_RADIX_BASE'), expected, source);
      assert.equal(portable.meta.errors.some(d => d.code === 'FINALIZE_INVALID_RADIX_BASE'), expected, source);
      assert.deepEqual(portable.document, legacy.finalized.document, source);
    }
  }
});

test('generated wasm agrees on exact radix bases in source and portable finalization', async () => {
  const runtime = await loadAeonWasm(readFileSync(resolve(packageRoot, 'pkg/aeon_wasm_bg.wasm')));
  for (const { literal, base } of radixBases.filter(f => f.testSource)) {
    for (const payload of ['1', '2']) {
      const source = `mask:radix[${literal}]=%${payload}`;
      assert.deepEqual(runtime.processAeon(source, { validationMode: 'strict', finalize: false }).errors, []);
      const legacy = runtime.processAeon(source, { validationMode: 'strict' });
      const portable = runtime.materializeTelex(`telex.aes=1\n\npath=$.mask\nkind=RadixLiteral\ndatatype=radix[${literal}]\nvalue=${payload}\n`, { finalizeMode: 'strict' });
      const expectedInvalid = base === null || Number(payload) >= base;
      assert.equal(legacy.errors.some(d => d.code === 'FINALIZE_INVALID_RADIX_BASE'), expectedInvalid, source);
      assert.equal(portable.meta.errors.some(d => d.code === 'FINALIZE_INVALID_RADIX_BASE'), expectedInvalid, source);
      assert.deepEqual(portable.document, legacy.finalized.document);
    }
  }
});

test('generated wasm enforces type-only generic arguments in one-shot, canonical and streaming paths', async () => {
  const runtime = await loadAeonWasm(readFileSync(resolve(packageRoot, 'pkg/aeon_wasm_bg.wasm')));
  for (const fixture of [...genericArguments, ...nodeBindingGenerics]) {
    const result = runtime.processAeon(fixture.source, { validationMode: 'loose', finalize: false });
    assert.equal(result.ok, fixture.ok, fixture.source);
    const canonical = runtime.processAeon(fixture.source, { validationMode: 'none', finalize: false });
    assert.equal(canonical.ok, fixture.ok, fixture.source);
    if (fixture.ok) assert.ok(canonical.canonical.text.includes(fixture.fragment), canonical.canonical.text);
    else {
      assert.ok(result.errors.some(error => error.code === 'SYNTAX_ERROR'));
      assert.equal(canonical.canonical.text, '');
    }
    for (let split = 0; split <= fixture.source.length; split += 1) {
      const stream = runtime.createAeonStream({ validationMode: 'loose' });
      assert.equal(stream.push(fixture.source.slice(0, split)).accepted, true);
      assert.equal(stream.push(fixture.source.slice(split)).accepted, true);
      assert.equal(stream.finish().accepted, true);
      while (stream.pullBatch() !== null) { /* drain provisional events */ }
      const terminal = stream.takeTerminal();
      assert.equal(terminal.status, fixture.ok ? 'accepted' : 'invalidated', `${fixture.source}, split=${split}`);
      if (!fixture.ok) assert.ok(terminal.errors.some(error => error.code === 'SYNTAX_ERROR'));
    }
  }
});

test('generated wasm preserves exact numeric clarifiers in canonical and streaming output', async () => {
  const runtime = await loadAeonWasm(readFileSync(resolve(packageRoot, 'pkg/aeon_wasm_bg.wasm')));
  for (const { raw, normalized } of numericClarifiers) {
    const source = `x:custom[${raw}]=${raw}`;
    const result = runtime.processAeon(source, { validationMode: 'loose', finalize: false });
    assert.deepEqual(result.errors, []);
    assert.equal(result.events[0]?.datatype, `custom[${normalized}]`);
    const canonical = runtime.processAeon(source, { validationMode: 'none', finalize: false });
    assert.deepEqual(canonical.errors, []);
    assert.ok(canonical.canonical.text.includes(`custom[${normalized}]`), canonical.canonical.text);
    for (let split = 0; split <= source.length; split += 1) {
      const stream = runtime.createAeonStream({ validationMode: 'loose' });
      assert.equal(stream.push(source.slice(0, split)).accepted, true);
      assert.equal(stream.push(source.slice(split)).accepted, true);
      assert.equal(stream.finish().accepted, true);
      const events: EventSummary[] = [];
      for (let batch = stream.pullBatch(); batch !== null; batch = stream.pullBatch()) events.push(...batch.events);
      assert.equal(events[0]?.datatype, `custom[${normalized}]`, `${raw}, split=${split}`);
      assert.equal(stream.takeTerminal().status, 'accepted', `${raw}, split=${split}`);
    }
  }
});

test('generated wasm retains quoted datatype whitespace across every chunk split', async () => {
  const runtime = await loadAeonWasm(readFileSync(resolve(packageRoot, 'pkg/aeon_wasm_bg.wasm')));
  for (const clarifier of ['"in review"', "'a b'", '"a,b"', '"雪 space"']) {
    const source = `v:custom[${clarifier}] = |yes|`;
    const expectedDatatype = `custom[${clarifier}]`;
    const result = runtime.processAeon(source, { validationMode: 'loose', finalize: false });
    assert.deepEqual(result.errors, []);
    assert.equal(result.events[0]?.datatype, expectedDatatype);
    for (let split = 0; split <= source.length; split += 1) {
      const stream = runtime.createAeonStream({ validationMode: 'loose' });
      assert.equal(stream.push(source.slice(0, split)).accepted, true);
      assert.equal(stream.push(source.slice(split)).accepted, true);
      assert.equal(stream.finish().accepted, true);
      const events: EventSummary[] = [];
      for (let batch = stream.pullBatch(); batch !== null; batch = stream.pullBatch()) events.push(...batch.events);
      assert.equal(events[0]?.datatype, expectedDatatype, `${source}, split=${split}`);
      assert.equal(stream.takeTerminal().status, 'accepted', `${source}, split=${split}`);
    }
  }
});

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
