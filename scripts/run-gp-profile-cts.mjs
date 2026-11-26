#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { getRepoRoot, resolveCTSPath } from './repo-paths.mjs';

const root = getRepoRoot();
const manifestPath = resolveCTSPath('cts/profile/v1/gp-profile-cts.v1.next.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const profile = manifest.meta.profile;
assert.equal(manifest.meta.lane, 'profile');
assert.equal(manifest.meta.sut_protocol, 'cts.protocol.v1');
assert.equal(profile, 'aeon.gp.profile.v1');

const { compile } = await import('../implementations/typescript/packages/profiles/dist/index.js');
const { formatPath } = await import('../implementations/typescript/packages/aes/dist/index.js');
const { loadAeonWasm } = await import('../implementations/typescript/packages/wasm/dist/index.js');
const wasm = await loadAeonWasm(readFileSync(join(root, 'implementations/typescript/packages/wasm/pkg/aeon_wasm_bg.wasm')));
const runtimes = {
  TypeScript(source, mode) {
    const result = compile(`aeon:mode = "${mode}"\n${source}`, { profile });
    return {
      errors: result.meta?.errors ?? [],
      warnings: result.meta?.warnings ?? [],
      bindings: result.aes.filter(event => event.sourcePlane !== 'header')
        .map(event => ({ path: formatPath(event.path), datatype: event.datatype ?? null, kind: 'binding' })),
    };
  },
  WASM(source, mode) {
    // The WASM API selects GP from the header. The manifest supplies this
    // trusted selection and suite sources supply only document bodies.
    const result = wasm.processAeon(`aeon:mode = "${mode}"\naeon:profile = "${profile}"\n${source}`, {
      validationMode: 'declared',
      finalize: false,
    });
    return {
      errors: result.errors,
      warnings: result.warnings,
      bindings: result.events.map(event => ({ path: event.path, datatype: event.datatype ?? null, kind: 'binding' })),
    };
  },
};

let passed = 0;
let failed = 0;
for (const selection of manifest.suites) {
  const suite = JSON.parse(readFileSync(join(dirname(manifestPath), selection.file), 'utf8'));
  const excluded = new Set(selection.exclude_tests ?? []);
  for (const vector of suite.tests) {
    if (excluded.has(vector.id)) continue;
    const { source, mode = 'transport' } = vector.input;
    assert.doesNotMatch(source, /^\s*aeon:(?:header|mode|profile)\s*=/m, vector.id);
    for (const [name, run] of Object.entries(runtimes)) {
      const label = `${name} ${vector.id}`;
      try {
        const result = run(source, mode);
        const diagnostics = entries => entries.map(({ code, path }) => ({ code, path }));
        assert.equal(result.errors.length === 0, vector.expected.ok);
        assert.deepEqual(diagnostics(result.errors), vector.expected.errors);
        assert.deepEqual(diagnostics(result.warnings), vector.expected.warnings);
        if (vector.expected.result.bindings) {
          assert.deepEqual(result.bindings, vector.expected.result.bindings);
        }
        passed += 1;
      } catch (error) {
        console.error(`${label}: ${error.message}`);
        failed += 1;
      }
    }
  }
}
console.log(`GP profile CTS (${manifest.meta.snapshot_id}): pass=${passed} fail=${failed}`);
process.exitCode = failed ? 1 : 0;
