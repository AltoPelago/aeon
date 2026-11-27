import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveCTSPath } from './repo-paths.mjs';

const coreManifest = resolveCTSPath('cts/core/v1/core-node-model-revision-cts.v1.next.json');
execFileSync(process.execPath, [
  fileURLToPath(new URL('./run-wasm-core-cts.mjs', import.meta.url)), '--cts', coreManifest,
], { stdio: 'inherit' });

const manifestPath = resolveCTSPath('cts/canonical/v1/canonical-node-model-revision-cts.v1.next.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
assert.equal(manifest.meta.lane, 'canonical');
assert.equal(manifest.meta.sut_protocol, 'cts.protocol.v1');
assert.ok(manifest.suites.length, 'canonical CTS must select at least one suite');

const packageUrl = new URL('../implementations/typescript/packages/wasm/', import.meta.url);
const { loadAeonWasm } = await import(new URL('dist/index.js', packageUrl));
const runtime = await loadAeonWasm(readFileSync(new URL('pkg/aeon_wasm_bg.wasm', packageUrl)));
let passed = 0;
for (const suiteRef of manifest.suites) {
  const bytes = readFileSync(resolve(dirname(manifestPath), suiteRef.file));
  if (suiteRef.content_sha256) {
    assert.equal(createHash('sha256').update(bytes).digest('hex'), suiteRef.content_sha256, suiteRef.file);
  }
  const excluded = new Set(suiteRef.exclude_tests ?? []);
  for (const vector of JSON.parse(bytes.toString('utf8')).tests) {
    if (excluded.has(vector.id)) continue;
    const { source, options = {} } = vector.input;
    const runtimeOptions = {
      ordering: options.ordering,
      maxAttributeDepth: options.max_attribute_depth,
      maxOrderingEdges: options.max_ordering_edges,
    };
    const result = runtime.canonicalize(source, runtimeOptions);
    const { ok, errors, warnings, result: expected } = vector.expected;
    assert.equal(result.errors.length === 0, ok, vector.id);
    assert.deepEqual(warnings, [], vector.id);
    assert.equal(result.errors.length, errors.length, vector.id);
    for (const [index, error] of errors.entries()) {
      for (const [field, value] of Object.entries(error)) {
        assert.deepEqual(result.errors[index]?.[field], value, vector.id + ' ' + field);
      }
    }
    assert.equal(result.text, expected.canonical_text ?? '', vector.id);
    if (ok) {
      assert.deepEqual(runtime.canonicalize(result.text, runtimeOptions), result, vector.id + ' fixed point');
    }
    passed++;
    console.log('PASS ' + vector.id);
  }
}
assert.ok(passed, 'canonical CTS must exercise at least one vector');
console.log('Generated WASM canonical CTS passed ' + passed + ' vectors');
