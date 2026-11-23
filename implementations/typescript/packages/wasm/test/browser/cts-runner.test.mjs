import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { loadAeonWasm } from '../../dist/index.js';

const packageRoot = fileURLToPath(new URL('../../', import.meta.url));
const repoRoot = resolve(packageRoot, '../../../..');
const runtime = await loadAeonWasm(readFileSync(join(packageRoot, 'pkg/aeon_wasm_bg.wasm')));
const source = 'value =\n';
const observed = runtime.processAeon(source, { validationMode: 'declared', finalize: false });
assert.equal(observed.ok, false);
assert.ok(observed.errors.length > 0);
assert.equal(typeof observed.errors[0].phase, 'string');
assert.ok(observed.errors[0].phase.length > 0);

function runControl(phaseLabel) {
  const directory = mkdtempSync(join(tmpdir(), 'aeon-wasm-cts-label-'));
  try {
    const suite = {
      id: 'diagnostic-phase-control',
      tests: [{
        id: 'phase-label-witness',
        input: { source },
        expected: {
          ok: false,
          errors: [{ code: observed.errors[0].code, phaseLabel }],
          warnings: [],
          result: { parse_ok: false },
        },
      }],
    };
    const bytes = JSON.stringify(suite);
    writeFileSync(join(directory, 'suite.json'), bytes);
    const manifest = {
      meta: { lane: 'core', version: '0.0.0', sut_protocol: 'cts.protocol.v1' },
      suites: [{
        id: suite.id,
        file: 'suite.json',
        content_sha256: createHash('sha256').update(bytes).digest('hex'),
      }],
    };
    const path = join(directory, 'manifest.json');
    writeFileSync(path, JSON.stringify(manifest));
    return spawnSync(process.execPath, [
      join(repoRoot, 'scripts/run-wasm-core-cts.mjs'), '--cts', path,
    ], { cwd: repoRoot, encoding: 'utf8', timeout: 30_000 });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('WASM CTS accepts the phase label observed from its actual runtime', () => {
  const result = runControl(observed.errors[0].phase);
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /pass=1 fail=0/);
});

test('WASM CTS rejects a contradicted phase label with the same diagnostic code', () => {
  const result = runControl('deliberately-incorrect-verifier-control');
  assert.ifError(result.error);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /pass=0 fail=1/);
});
