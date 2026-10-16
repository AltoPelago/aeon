#!/usr/bin/env node
// Explicit API conformance check for the experimental TypeScript contract.
// Historical CLI/CTS claims and default canonical bytes are not changed.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { getRepoRoot, resolveCTSPath } from './repo-paths.mjs';

const root = getRepoRoot();
const manifestPath = path.resolve(resolveCTSPath('cts/canonical/v1/canonical-reference-ordering-cts.v1.next.json'));
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
assert.equal(manifest.meta.snapshot_id, 'canonical-reference-ordering-next-cts-v1-snapshot-0.1');
assert.equal(manifest.meta.lane, 'canonical');
assert.equal(manifest.meta.sut_protocol, 'cts.protocol.v1');
assert.equal(manifest.meta.status, 'experimental');
const load = packageName => import(pathToFileURL(path.join(root, 'implementations/typescript/packages', packageName, 'dist/index.js')).href);
const { canonicalize } = await load('canonical');
const { tokenize } = await load('lexer');
const { parse } = await load('parser');
const { emitEvents, resolvePaths, validateReferences, adaptTypeScriptAssignmentEventsToPortableAes } = await load('aes');
const options = { ordering: 'reference-safe-v1' };
const normalizeText = text => text.replace(/\r\n?/g, '\n').trimEnd();

function graph(source, includeHeaders) {
  const lexed = tokenize(source);
  assert.deepEqual(lexed.errors, [], 'Core lexer legality');
  const parsed = parse(lexed.tokens);
  assert.deepEqual(parsed.errors, [], 'Core parser legality');
  assert.ok(parsed.document);
  const emitted = emitEvents(resolvePaths(parsed.document, { indexedPaths: true }));
  assert.deepEqual(emitted.errors, [], 'Core path legality');
  assert.deepEqual(validateReferences(emitted.events).errors, [], 'Core reference legality');
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
console.log(`TypeScript reference-safe-v1 API CTS: pass=${passed} fail=${failed} manifest-excluded=${excluded}`);
process.exitCode = failed === 0 ? 0 : 1;
