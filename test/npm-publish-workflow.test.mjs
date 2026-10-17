import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const workflow = readFileSync(new URL('../.github/workflows/npm-publish.yml', import.meta.url), 'utf8');
const consumer = workflow.split('\n  published-smoke:\n')[1];

function step(name) {
  const block = consumer.split('\n      - name: ').find(block => block.startsWith(`${name}\n`));
  assert.ok(block, `Missing workflow step: ${name}`);
  const script = block.split('        run: |\n')[1];
  assert.ok(script, `Missing literal shell script: ${name}`);
  return { block, script: script.trimEnd().split('\n').map(line => {
    assert.ok(line === '' || line.startsWith('          '));
    return line.slice(10);
  }).join('\n') };
}

const install = step('Install exact registry packages with propagation retries');
const smoke = step('Exercise installed public API once');

// Execute the workflow's actual shell, not a second implementation of its loop.
// Only npm, the clock, sleep and GNU timeout are simulated: no network or waits.
function runConsumer(t, { failures = 0, smokeStatus = 0, hung = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'aeon-npm-workflow-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const npm = join(bin, 'npm');
  writeFileSync(npm, `#!${process.execPath}
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
const args = process.argv.slice(2);
const events = process.env.TEST_NPM_EVENTS;
const previous = existsSync(events) ? readFileSync(events, 'utf8').trim().split('\\n').filter(Boolean).map(JSON.parse) : [];
appendFileSync(events, JSON.stringify(args) + '\\n');
if (args[0] === 'init') process.exit(0);
if (args[0] !== 'install') throw Error('Unexpected npm command: ' + args[0]);
const attempt = previous.filter(args => args[0] === 'install').length + 1;
if (attempt <= Number(process.env.TEST_FAILURES)) {
  console.error('npm error code ETARGET: release version not visible');
  process.exit(1);
}
`, { mode: 0o755 });
  // Node treats extensionless executables as CommonJS unless explicitly marked.
  writeFileSync(join(bin, 'package.json'), '{"type":"module"}\n');
  chmodSync(npm, 0o755);
  const eventsFile = join(root, 'npm-events');
  const timeoutFile = join(root, 'timeouts');
  const smokeFile = join(root, 'smoke');
  const script = `set -euo pipefail
TEST_SECONDS=0
timeout() {
  printf '%s\\n' "$1 $2" >> "$TEST_TIMEOUTS"
  duration="\${2%s}"
  shift 2
  if [ "$TEST_HUNG" = true ]; then
    TEST_SECONDS=$((TEST_SECONDS + duration))
    return 124
  fi
  "$@"
}
sleep() { TEST_SECONDS=$((TEST_SECONDS + $1)); }
node() {
  printf 'smoke\\n' >> "$TEST_SMOKE"
  return "$TEST_SMOKE_STATUS"
}
${install.script.replaceAll(/\bSECONDS\b/g, 'TEST_SECONDS')}
${smoke.script}
`;
  const result = spawnSync('bash', ['-c', script], {
    cwd: root,
    encoding: 'utf8',
    timeout: 15000,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      RUNNER_TEMP: root,
      VERSION: '1.2.3',
      TEST_FAILURES: String(failures),
      TEST_HUNG: String(hung),
      TEST_SMOKE_STATUS: String(smokeStatus),
      TEST_NPM_EVENTS: eventsFile,
      TEST_TIMEOUTS: timeoutFile,
      TEST_SMOKE: smokeFile,
    },
  });
  assert.ifError(result.error);
  function lines(file) {
    try { return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  }
  return {
    ...result,
    installs: lines(eventsFile).map(JSON.parse).filter(args => args[0] === 'install'),
    timeouts: lines(timeoutFile),
    smokeCalls: lines(smokeFile).length,
  };
}

test('immediate availability installs the complete exact public set and runs smoke once', t => {
  const result = runConsumer(t);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.installs.length, 1);
  assert.equal(result.smokeCalls, 1);
  const packageRoot = new URL('../implementations/typescript/packages/', import.meta.url);
  const expected = readdirSync(packageRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => JSON.parse(readFileSync(new URL(`${entry.name}/package.json`, packageRoot), 'utf8')))
    .filter(pkg => pkg.private !== true)
    .map(pkg => `${pkg.name}@1.2.3`).sort();
  assert.equal(expected.length, 17);
  assert.deepEqual(result.installs[0].filter(arg => arg.startsWith('@')).sort(), expected);
});

test('delayed metadata recovers with a fresh cache and online checks on every attempt', t => {
  const result = runConsumer(t, { failures: 3 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.installs.length, 4);
  assert.equal(result.smokeCalls, 1);
  const caches = result.installs.map(args => args.find(arg => arg.startsWith('--cache=')));
  assert.equal(new Set(caches).size, 4);
  for (const args of result.installs) {
    for (const option of ['--prefer-online', '--registry=https://registry.npmjs.org',
      '--fetch-retries=0', '--fetch-timeout=15000', '--ignore-scripts']) {
      assert.ok(args.includes(option), `Missing ${option}`);
    }
  }
  assert.ok(result.timeouts.every(value => value === '--kill-after=5s 60s'));
});

test('persistent install failure exhausts the ten-minute budget without running smoke', t => {
  const result = runConsumer(t, { failures: Infinity });
  assert.equal(result.status, 1);
  // 30 instantaneous failures, separated by 20 virtual seconds, then stop.
  assert.equal(result.installs.length, 30);
  assert.equal(result.smokeCalls, 0);
  assert.match(result.stdout, /within 600 seconds/);
  assert.match(result.stdout, /rerun only the failed Clean npm consumer job/);
});

test('availability on the last attempt succeeds with only the remaining timeout', t => {
  const result = runConsumer(t, { failures: 29 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.installs.length, 30);
  assert.equal(result.timeouts.at(-1), '--kill-after=5s 20s');
  assert.equal(result.smokeCalls, 1);
});

test('hung npm processes count against the same budget and never run smoke', t => {
  const result = runConsumer(t, { hung: true });
  assert.equal(result.status, 1);
  // Seven 60-second timeouts + 20-second waits, then a final 40-second timeout.
  assert.equal(result.timeouts.length, 8);
  assert.equal(result.timeouts.at(-1), '--kill-after=5s 40s');
  assert.equal(result.smokeCalls, 0);
});

test('behavioral failure is propagated once without retrying installation or smoke', t => {
  const result = runConsumer(t, { failures: 2, smokeStatus: 42 });
  assert.equal(result.status, 42);
  assert.equal(result.installs.length, 3);
  assert.equal(result.smokeCalls, 1);
});

test('consumer stays checkout-free and read-only with a separate single-run smoke step', () => {
  assert.match(consumer, /permissions:\n      contents: read/);
  assert.doesNotMatch(consumer, /actions\/checkout|id-token: write|npm publish/);
  assert.match(install.block, /timeout-minutes: 12/);
  assert.doesNotMatch(install.script, /readAeonChecked/);
  assert.match(smoke.block, /working-directory: aeon-registry-smoke/);
  assert.doesNotMatch(smoke.script, /\b(for|while|until)\b/);
  assert.match(smoke.script, /readAeonChecked/);
});
