#!/usr/bin/env node
// Development conformance and exact differences against immutable snapshots.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveCTSPath } from './repo-paths.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const workspace = path.join(root, 'implementations/typescript');
const manager = process.env.npm_execpath;
assert.ok(manager, 'Run through the pinned pnpm workspace script');
const genericAdmissionDelta = [
  'core-baseline-026-transport-meaningless-reserved-generic-reject',
  'core-baseline-029a-transport-reserved-child-datatype-binding-node-reject',
  'core-baseline-029b-transport-non-node-generic-node-head-reject',
  'core-custom-reject-005-generic-custom-scalar-binding-rejects',
];
const historicalCoreDelta = [
  'core-baseline-015-strict-stale-radix-alias-reject',
  'core-addr-001b-empty-quoted-key-reject',
  'core-addr-001c-empty-quoted-path-segment-reject',
  'core-snippet-transport-003-empty-quoted-keys-reject',
  ...genericAdmissionDelta,
];
const releaseCoreDelta = [
  ...genericAdmissionDelta,
  ...Array.from({ length: 19 }, (_, index) =>
    `core-node-binding-generics-${String(index + 1).padStart(3, '0')}-reject`),
];
const changedRejectionDiagnostics = new Map([
  ['core-addr-001c-empty-quoted-path-segment-reject', 'actual errors: MISSING_REFERENCE_TARGET@$'],
  ['core-node-binding-generics-008-reject', 'actual errors: DATATYPE_LITERAL_MISMATCH@$.doc'],
]);

function execute(label, args, expectedFailureIds = null, expectedCount = null) {
  const result = spawnSync(process.execPath, args, {
    cwd: workspace, encoding: 'utf8', timeout: 300_000, maxBuffer: 16 * 1024 * 1024,
  });
  process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');
  assert.ifError(result.error);
  if (expectedFailureIds === null) {
    assert.equal(result.status, 0, label);
  } else {
    const failures = [...result.stdout.matchAll(/^❌ ([^\s:]+): FAIL\n((?:   - [^\n]*\n)*)/gm)];
    assert.equal(result.status, 1, label + ': immutable snapshot must report its mismatches');
    assert.deepEqual(failures.map(match => match[1]).sort(), [...expectedFailureIds].sort(),
      label + ': unexpected snapshot delta');
    for (const [, id, details] of failures) {
      const expectation = changedRejectionDiagnostics.get(id) ?? 'ok mismatch: expected false, got true';
      assert.ok(details.split('\n').includes(`   - ${expectation}`), `${label}: unexpected outcome for ${id}`);
    }
    const summary = /(?:Summary:|Generated WASM Core CTS:) pass=(\d+) fail=(\d+)/.exec(result.stdout);
    assert.ok(summary, label + ': complete summary required');
    assert.equal(Number(summary[1]) + Number(summary[2]), expectedCount, label + ': all historical cases must run');
    assert.equal(Number(summary[2]), expectedFailureIds.length, label + ': failure count');
    console.log(`${label}: exact superseded rejection delta verified; no released conformance claim`);
  }
}

function sourceLane(label, manifest, lane, delta = null, count = null) {
  execute(label, [path.join(root, 'scripts/cts-source-lane-runner.mjs'),
    '--sut', path.join(workspace, 'packages/cli/dist/main.js'),
    '--cts', resolveCTSPath('cts/' + manifest), '--lane', lane], delta, count);
}

function wasmCore(label, manifest, delta, count) {
  execute(label, [path.join(root, 'scripts/run-wasm-core-cts.mjs'),
    '--cts', resolveCTSPath('cts/core/v1/' + manifest)], delta, count);
}

sourceLane('Historical Core 0.5', 'core/v1/core-cts.v1.snapshot-0.5.json', 'core', historicalCoreDelta, 299);
sourceLane('Historical AES projection 0.4', 'aes/v1/aes-cts.v1.snapshot-0.4.json', 'aes',
  ['aes-baseline-009-stale-radix-alias-reject', 'aes-emission-001b-empty-quoted-key-reject'], 83);
wasmCore('Historical WASM Core 0.5', 'core-cts.v1.snapshot-0.5.json', historicalCoreDelta, 299);

if (!process.argv.includes('--legacy-only')) {
  sourceLane('Released Core 0.6', 'core/v1/core-cts.v1.snapshot-0.6.json', 'core', releaseCoreDelta, 657);
  sourceLane('Released AES projection 0.6', 'aes/v1/aes-cts.v1.snapshot-0.6.json', 'aes');
  wasmCore('Released WASM Core 0.6', 'core-cts.v1.snapshot-0.6.json', releaseCoreDelta, 657);

  // Keep every unaffected existing full-target check and its original assertions.
  for (const script of ['test:cts', 'test:cts:aeos:next', 'test:cts:core:next',
    'test:cts:wasm:core:next', 'test:cts:aes:next', 'test:cts:aes:events',
    'test:cts:telex', 'test:cts:film', 'test:cts:canonical', 'test:cts:canonical:next',
    'test:cts:canonical:api', 'test:cts:gp:next',
    'test:cts:finalize:limits', 'test:cts:transport:limits', 'test:cts:sansa', 'test:cts:annotations']) {
    execute(script, [manager, 'run', script]);
  }
  for (const [runner, manifest] of [['run-aes-events-cts.mjs', 'aes/v1/aes-events-cts.v1.next.json'],
    ['run-telex-cts.mjs', 'telex/v1/telex-cts.v1.next.json'],
    ['run-film-cts.mjs', 'film/v1/film-cts.v1.next.json']]) {
    execute(manifest, [path.join(root, 'scripts', runner), '--module',
      path.join(workspace, 'packages/aes/dist/index.js'), '--cts', resolveCTSPath('cts/' + manifest)]);
  }
  // The default reference-safe profile uses its dedicated target, retaining
  // the same two established exclusions as immutable canonical API checks.
  sourceLane('Reference-ordering next', 'canonical/v1/canonical-reference-ordering-cts.v1.next.json', 'canonical');
}
console.log('Development conformance and exact immutable snapshot deltas verified.');
