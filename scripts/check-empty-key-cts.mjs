#!/usr/bin/env node
// Development conformance for the amended empty-property and radix16 contracts. Historical
// runners, fixtures and assertions remain unchanged and are audited separately.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveCTSPath } from './repo-paths.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const workspace = path.join(root, 'implementations/typescript');
const manager = process.env.npm_execpath;
assert.ok(manager, 'Run through the pinned pnpm workspace script');
const coreDelta = [
  'core-baseline-015-strict-stale-radix-alias-reject',
  'core-addr-001b-empty-quoted-key-reject',
  'core-addr-001c-empty-quoted-path-segment-reject',
  'core-snippet-transport-003-empty-quoted-keys-reject',
];

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
    // These failures explicitly disprove the old rejection claim; they are not
    // reclassified as released CTS passes. Any other failure blocks integration.
    const actual = [...result.stdout.matchAll(/^❌ ([^\s:]+): FAIL$/gm)].map(match => match[1]);
    assert.equal(result.status, 1, label + ': unchanged historical runner must report its mismatches');
    assert.deepEqual(actual.sort(), [...expectedFailureIds].sort(), label + ': unexpected legacy delta');
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

sourceLane('Historical Core 0.5', 'core/v1/core-cts.v1.snapshot-0.5.json', 'core', coreDelta, 299);
sourceLane('Historical AES projection 0.4', 'aes/v1/aes-cts.v1.snapshot-0.4.json', 'aes',
  ['aes-baseline-009-stale-radix-alias-reject', 'aes-emission-001b-empty-quoted-key-reject'], 83);
execute('Historical WASM Core 0.5', [path.join(root, 'scripts/run-wasm-core-cts.mjs'),
  '--cts', resolveCTSPath('cts/core/v1/core-cts.v1.snapshot-0.5.json')], coreDelta, 299);

if (!process.argv.includes('--legacy-only')) {
  // Keep every unaffected existing full-target check and its original assertions.
  for (const script of ['test:cts', 'test:cts:aeos:next', 'test:cts:core:next',
    'test:cts:wasm:core:next', 'test:cts:aes:next', 'test:cts:aes:events',
    'test:cts:telex', 'test:cts:film', 'test:cts:canonical', 'test:cts:canonical:api',
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
console.log('Empty-key and radix16 development conformance verified; historical claims remain separate.');
