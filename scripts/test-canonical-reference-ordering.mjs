#!/usr/bin/env node
// Explicit API conformance check for the experimental TypeScript/Rust contracts.
// Historical CLI/CTS claims and default canonical bytes are not changed.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { getRepoRoot, resolveCTSPath } from './repo-paths.mjs';
import renderingFixtures from '../test-fixtures/canonical-rendering-boundaries.json' with { type: 'json' };
import numericClarifiers from '../test-fixtures/numeric-clarifiers.json' with { type: 'json' };
import genericArguments from '../test-fixtures/datatype-generic-arguments.json' with { type: 'json' };

const root = getRepoRoot();
const manifestPath = path.resolve(resolveCTSPath('cts/canonical/v1/canonical-reference-ordering-cts.v1.next.json'));
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
assert.equal(manifest.meta.snapshot_id, 'canonical-reference-ordering-next-cts-v1-snapshot-0.1');
assert.equal(manifest.meta.lane, 'canonical');
assert.equal(manifest.meta.sut_protocol, 'cts.protocol.v1');
assert.equal(manifest.meta.status, 'experimental');
const load = packageName => import(pathToFileURL(path.join(root, 'implementations/typescript/packages', packageName, 'dist/index.js')).href);
const backend = process.argv[2] ?? 'typescript';
assert.ok(['typescript', 'rust'].includes(backend), 'backend must be typescript or rust');
const rustAdapter = path.join(root, 'implementations/rust/target/debug/examples/reference_ordering');
if (backend === 'rust') {
  execFileSync('cargo', ['build', '--locked', '-p', 'aeon-canonical', '--example', 'reference_ordering'], {
    cwd: path.join(root, 'implementations/rust'), stdio: 'inherit',
  });
}
const canonicalize = backend === 'typescript' ? (await load('canonical')).canonicalize
  : (source, options = {}) => JSON.parse(execFileSync(rustAdapter, [], { input: JSON.stringify({ source, max_attribute_depth: options.maxAttributeDepth ?? 1 }), encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }));
const { tokenize } = await load('lexer');
const { parse } = await load('parser');
const { emitEvents, resolvePaths, validateReferences, adaptTypeScriptAssignmentEventsToPortableAes } = await load('aes');
const options = { ordering: 'reference-safe-v1' };
const normalizeText = text => text.replace(/\r\n?/g, '\n').trimEnd();

function graph(source, includeHeaders, maxAttributeDepth = 1) {
  const lexed = tokenize(source);
  assert.deepEqual(lexed.errors, [], 'Core lexer legality');
  const parsed = parse(lexed.tokens, { maxAttributeDepth });
  assert.deepEqual(parsed.errors, [], 'Core parser legality');
  assert.ok(parsed.document);
  const emitted = emitEvents(resolvePaths(parsed.document, { indexedPaths: true }));
  assert.deepEqual(emitted.errors, [], 'Core path legality');
  assert.deepEqual(validateReferences(emitted.events, { maxAttributeDepth }).errors, [], 'Core reference legality');
  return adaptTypeScriptAssignmentEventsToPortableAes(emitted.events, { includeHeaders }).events
    .map(({ span: _span, origin: _origin, ...entry }) => JSON.stringify(entry.kind === 'RadixLiteral'
      ? { ...entry, value: entry.value.replace(/_/g, '') } : entry))
    .sort();
}

function checkDiagnostics(expected, actual) {
  // CTS diagnostics are an expected subset, not necessarily a complete list
  // of lexer/parser recovery errors. Match each expectation only once.
  const used = new Set();
  for (const diagnostic of expected) {
    const index = actual.findIndex((entry, i) => !used.has(i) && entry.code === diagnostic.code
      && (!('path' in diagnostic) || (entry.path ?? '$') === diagnostic.path)
      && (diagnostic.phase == null || entry.phase === diagnostic.phase));
    assert.ok(index >= 0, `missing diagnostic ${diagnostic.code}`);
    used.add(index);
    if (diagnostic.span) assert.deepEqual([actual[index].span.start.offset, actual[index].span.end.offset], diagnostic.span);
  }
}

let passed = 0;
let failed = 0;
let excluded = 0;
for (const suiteRef of manifest.suites) {
  const suiteBytes = fs.readFileSync(path.resolve(path.dirname(manifestPath), suiteRef.file));
  if (suiteRef.content_sha256) {
    assert.equal(createHash('sha256').update(suiteBytes).digest('hex'), suiteRef.content_sha256, suiteRef.file);
  }
  const suite = JSON.parse(suiteBytes);
  const exclusions = new Set(suiteRef.exclude_tests ?? []);
  for (const vector of suite.tests) {
    if (exclusions.has(vector.id)) { excluded += 1; continue; }
    try {
      const source = vector.input.source;
      const result = canonicalize(source, options);
      assert.deepEqual(vector.expected.warnings ?? [], [], 'canonical API does not emit warnings');
      assert.equal(result.errors.length === 0, vector.expected.ok, 'success status');
      checkDiagnostics(vector.expected.errors, result.errors);
      // Always inspect actual text, including failure, so partial output cannot
      // be hidden by an adapter manufacturing an empty string on error.
      if (typeof vector.expected.result.canonical_text === 'string') {
        assert.equal(normalizeText(result.text), normalizeText(vector.expected.result.canonical_text), 'canonical text');
      }
      if (vector.expected.ok) {
        const fixedPoint = canonicalize(result.text, options);
        assert.deepEqual(fixedPoint.errors, [], 'fixed point diagnostics');
        assert.equal(fixedPoint.text, result.text, 'fixed point bytes');
        const parsed = parse(tokenize(source).tokens);
        const includeHeaders = parsed.document.header !== null;
        assert.deepEqual(graph(result.text, includeHeaders), graph(source, includeHeaders), 'semantic graph preservation');
      } else {
        assert.equal(result.text, '', 'no partial text on failure');
      }
      passed += 1;
    } catch (error) {
      failed += 1;
      console.error(`${vector.id}: ${error.message}`);
    }
  }
}
console.log(`${backend} reference-safe-v1 API CTS: pass=${passed} fail=${failed} manifest-excluded=${excluded}`);
if (backend === 'rust') {
  const typescriptCanonicalize = (await load('canonical')).canonicalize;
  const sources = [];
  const renderingSources = new Map(renderingFixtures.map(fixture => [fixture.source, fixture.fragment]));
  sources.push(...renderingSources.keys());
  sources.push(...genericArguments.map(fixture => fixture.source));
  const genericSources = new Map(genericArguments.map(fixture => [fixture.source, fixture.ok]));
  for (const { raw, normalized } of numericClarifiers) {
    const numericSources = [
      `x:custom[${raw}]=${raw}`,
      `x={n:custom[${raw}]=${raw}}`,
      `x@{n:custom[${raw}]=${raw}}=0`,
      `x=[:custom[${raw}]=${raw}]`,
      `x=(:custom[${raw}]=${raw})`,
      `x=<tag(:custom[${raw}]=${raw})>`,
      `x:list<custom[${raw}]>=[${raw}]`,
      `aeon:header={x:custom[${raw}]=${raw}}`,
    ];
    for (const source of numericSources) renderingSources.set(source, `custom[${normalized}]`);
    sources.push(...numericSources);
  }
  const headers = [
    { source: 'x@{root={leaf=1}}={leaf@{meta=2}={deep=3}}', paths: ['', '.@.root.leaf', '.leaf', '.leaf.@.meta', '.leaf.deep'] },
    { source: 'x=[@{meta=1}={leaf=2},3]', paths: ['', '[0]', '[0].@.meta', '[0].leaf', '[1]'] },
    { source: 'x=(@{meta=1}={leaf=2},3)', paths: ['', '[0]', '[0].@.meta', '[0].leaf', '[1]'] },
    { source: 'x=<tag(@{meta=1}={leaf=2},3)>', paths: ['', '[0]', '[0].@.meta', '[0].leaf', '[1]'] },
  ];
  const bodies = ['0', '{}', '{leaf=0}', '{leaf@{meta=9}=0}', '{leaf={deep=9}}', '[]', '[0]', '({leaf=0})', '<tag(0)>'];
  for (const header of headers) for (const body of bodies) for (const suffix of header.paths) for (const marker of ['~', '~>']) {
    sources.push(`aeon:header={${header.source}}\n"aeon:x"=${body}\na=${marker}["aeon:x"]${suffix}`);
  }
  for (const character of ['\n', '\r', '\t', '\0', '\u000b', '\u001f', '"', '\\', '😀']) {
    const key = JSON.stringify(`z${character}key`);
    sources.push(
      `${key}=1\na=~[${key}]`,
      `holder@{${key}=1}=0\na=~>holder.@.[${key}]`,
      `holder@{meta={${key}=1,a=~holder.@.meta.[${key}]}}=0`,
      `${key}=1\na=<tag@{meta=~>[${key}]}(~[${key}])>`,
      `a=[@{${key}=1}=~a[0].@.[${key}]]`,
    );
  }
  sources.push(
    'a=<tag@{meta={copy=~a}}>',
    'a=<tag@{meta=[{copy=~a}]}(0)>',
    'z=1\na=<tag@{meta={copy=~z}}>',
    'a@{m=<tag\\HEAD\\>}=0',
    'a:custom["a,b"] = |x|',
    'a@{m:custom["in review"] = |x|}=0',
    'a=[ :custom["in review"] = |x| ]',
  );
  for (const head of ['@{meta=1}', ':custom', '\\VALUE\\', '@{meta=1}:custom']) {
    for (const value of ['1', '"text"', '> `line\\nnext`', '{z=1,a=0}', '[1,2]', '(1,2)', '<tag(1,2)>', '<tag\\HEAD\\>', '[{z=1}]']) {
      const headed = `${head} = ${value}`;
      sources.push(`a=[${headed}]`, `a=(${headed})`, `a=<tag(${headed})>`, `a@{m=[${headed}]}=0`);
    }
  }
  const parityOptions = { ...options, maxAttributeDepth: 2 };
  let parityPassed = 0;
  for (const source of sources) {
    try {
      const expected = typescriptCanonicalize(source, parityOptions);
      const actual = canonicalize(source, parityOptions);
      if (genericSources.has(source)) {
        assert.equal(expected.errors.length === 0, genericSources.get(source), 'generic type grammar');
        assert.equal(actual.errors.length === 0, genericSources.get(source), 'native generic type grammar');
      }
      if (renderingSources.has(source)) {
        assert.deepEqual(expected.errors, [], 'rendering regression must be valid input');
        assert.ok(actual.text.includes(renderingSources.get(source)), 'literal/head spelling preservation');
      }
      assert.deepEqual(actual.errors.map(error => error.code), expected.errors.map(error => error.code), 'reference diagnostics');
      assert.equal(actual.text, expected.text, 'canonical bytes');
      if (actual.errors.length === 0) {
        assert.equal(canonicalize(actual.text, parityOptions).text, actual.text, 'fixed point bytes');
        const parsed = parse(tokenize(source).tokens, { maxAttributeDepth: parityOptions.maxAttributeDepth });
        assert.deepEqual(parsed.errors, [], 'parity source parser legality');
        assert.ok(parsed.document);
        const includeHeaders = parsed.document.header !== null;
        assert.deepEqual(graph(actual.text, includeHeaders, 2), graph(source, includeHeaders, 2), 'semantic graph preservation');
      }
      parityPassed += 1;
    } catch (error) {
      failed += 1;
      if (failed <= 10) console.error(`Rust/TypeScript parity ${JSON.stringify(source)}: ${error.message.slice(0, 1200)}`);
    }
  }
  console.log(`Rust/TypeScript reference-safe-v1 parity: pass=${parityPassed} fail=${sources.length - parityPassed}`);
}
process.exitCode = failed === 0 ? 0 : 1;
