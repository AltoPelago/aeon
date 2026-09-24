import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const sourceToolPath = fileURLToPath(new URL('../scripts/version.mjs', import.meta.url));
const transactionDirectory = '.aeon-version-transaction';
const rustPackages = [
  { dependency: 'aeon-aeos', package: 'altopelago-aeon-aeos' },
  { dependency: 'aeon-annotations', package: 'aeon-annotations' },
  { dependency: 'aeon-canonical', package: 'aeon-canonical' },
  { dependency: 'aeon-cli', package: 'aeon-cli' },
  { dependency: 'aeon-core', package: 'altopelago-aeon-core' },
  { dependency: 'aeon-finalize', package: 'altopelago-aeon-finalize' },
  { dependency: 'aeon-sdk', package: 'altopelago-aeon' },
  { dependency: 'aeon-wasm', package: 'aeon-wasm' },
];
const rustLockPackages = [...rustPackages.map(({ package: packageName }) => packageName), 'aeon-python'];

function rustDependencyLine({ dependency, package: packageName }, version) {
  const packageClause = dependency === packageName ? '' : `package = "${packageName}", `;
  return `${dependency} = { ${packageClause}path = "crates/${dependency}", version = "${version}" }`;
}

function fixtureSources(version = '1.2.3') {
  const sources = new Map();
  const put = (relativePath, source) => sources.set(relativePath, source);
  put('CHANGELOG.md', `# Changelog\n\n## Unreleased\n\n## ${version} - 2026-09-14\n`);
  put('conformance/cts-claims.json', `${JSON.stringify({
    claim_format: 'aeonite.cts-claims.v1',
    claim_sets: ['typescript', 'rust', 'python'].map((implementation) => ({
      implementation,
      implementation_version: version,
      claims: [],
    })),
  }, null, 2)}\n`);
  put('VERSIONING.md', [
    `- TypeScript: \`${version}\``,
    `- Python: \`${version}\``,
    `- Rust: \`${version}\``,
    '',
    `For example, after the TypeScript \`${version}\` release commit is merged to \`main\`:`,
    '',
    '```sh',
    `git tag -s typescript/v${version} -m "AEON TypeScript packages ${version}"`,
    `git tag -v typescript/v${version}`,
    `git push origin typescript/v${version}`,
    '```',
    '',
    `- TypeScript implementation/package line: \`${version}\``,
    `- Python implementation/package line: \`${version}\``,
    `- Rust implementation/package line: \`${version}\``,
    '',
  ].join('\n'));
  put('docs/release-strategy.md', [
    `- \`release/typescript/${version}\``,
    `- \`release/rust/${version}\``,
    `- \`release/python/${version}\``,
    `- \`hotfix/typescript/${version}\``,
    `- \`typescript/v${version}\``,
    `- \`rust/v${version}\``,
    `- \`python/v${version}\``,
    '',
  ].join('\n'));
  put('implementations/typescript/README.md', `Current package line: \`${version}\`.\n`);
  put('implementations/typescript/packages/cli/README.md', `npx @altopelago/aeon-cli@${version} check document.aeon\n`);
  put('implementations/typescript/packages/core/src/index.ts', `export const VERSION = '${version}';\n`);
  for (const [directory, name] of [
    ['core', '@altopelago/aeon-core'],
    ['sdk', '@altopelago/aeon-sdk'],
    ['wasm', '@altopelago/aeon-wasm'],
  ]) {
    put(
      `implementations/typescript/packages/${directory}/package.json`,
      `${JSON.stringify({ name, version, description: 'formatting survives' }, null, 2)}\n`,
    );
  }
  put(
    'implementations/typescript/tools/cts-runner/package.json',
    `${JSON.stringify({ name: '@altopelago/aeon-cts-runner', version, private: true }, null, 2)}\n`,
  );
  put(
    'implementations/typescript/packages/wasm/pkg/package.json',
    `${JSON.stringify({ name: 'aeon-wasm', version, files: ['aeon_wasm.js'] }, null, 2)}\n`,
  );
  put('implementations/rust/Cargo.toml', [
    '[workspace]',
    '',
    '[workspace.package]',
    `version = "${version}"`,
    '',
    '[workspace.dependencies]',
    ...rustPackages.map((packageInfo) => rustDependencyLine(packageInfo, version)),
    '',
  ].join('\n'));
  put('implementations/rust/Cargo.lock', [
    '# generated',
    ...rustLockPackages.flatMap((packageName) => [
      '',
      '[[package]]',
      `name = "${packageName}"`,
      `version = "${version}"`,
    ]),
    '',
  ].join('\n'));
  put('implementations/rust/fuzz/Cargo.lock', [
    '# generated',
    '',
    '[[package]]',
    'name = "altopelago-aeon-core"',
    `version = "${version}"`,
    '',
  ].join('\n'));
  put('implementations/rust/README.md', `Current crate/workspace line: \`${version}\`.\n`);
  put('implementations/python/pyproject.toml', `[project]\nname = "aeon-python"\nversion = "${version}"\n`);
  put('implementations/rust/crates/aeon-python/pyproject.toml', `[project]\nname = "altopelago-aeon"\nversion = "${version}"\n`);
  put('implementations/python/README.md', `Current package line: \`${version}\`.\n`);
  put('implementations/python/src/aeon/cli.py', `def main():\n    print("aeon-python ${version}")\n`);
  return sources;
}

function createFixture(t, version = '1.2.3') {
  const root = mkdtempSync(join(tmpdir(), 'aeon-version-tool-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sources = fixtureSources(version);
  for (const [relativePath, source] of sources) {
    const file = join(root, relativePath);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, source);
  }
  mkdirSync(join(root, 'scripts'), { recursive: true });
  copyFileSync(sourceToolPath, join(root, 'scripts', 'version.mjs'));
  return { root, sources };
}

function runVersion(root, args) {
  return spawnSync(process.execPath, [join(root, 'scripts', 'version.mjs'), ...args], {
    cwd: root,
    encoding: 'utf8',
  });
}

function readSources(root, paths) {
  return new Map([...paths].map((relativePath) => [
    relativePath,
    readFileSync(join(root, relativePath), 'utf8'),
  ]));
}

function targetId(sources, relativePath) {
  assert.equal(sources.has(relativePath), true);
  return `target-${createHash('sha256').update(relativePath).digest('hex').slice(0, 24)}`;
}

function createTransaction(root, sources, state, selectedPaths) {
  const transaction = join(root, transactionDirectory);
  mkdirSync(transaction);
  const ids = selectedPaths.map((relativePath) => targetId(sources, relativePath));
  writeFileSync(
    join(transaction, 'journal.json'),
    `${JSON.stringify({ schemaVersion: 1, state, targets: ids })}\n`,
  );
  for (let index = 0; index < selectedPaths.length; index += 1) {
    writeFileSync(join(transaction, `${ids[index]}.backup`), sources.get(selectedPaths[index]));
  }
  return transaction;
}

test('version check accepts aligned implementation tracks', (t) => {
  const { root } = createFixture(t);
  const result = runVersion(root, ['check']);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /typescript=1\.2\.3 rust=1\.2\.3 python=1\.2\.3/);
});

test('version set updates only the selected TypeScript track', (t) => {
  const { root } = createFixture(t);
  const result = runVersion(root, ['set', 'typescript', '1.3.0']);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(readFileSync(join(root, 'implementations/typescript/packages/core/package.json'))).version, '1.3.0');
  assert.equal(JSON.parse(readFileSync(join(root, 'implementations/typescript/tools/cts-runner/package.json'))).version, '1.3.0');
  assert.equal(JSON.parse(readFileSync(join(root, 'implementations/typescript/packages/wasm/pkg/package.json'))).version, '1.3.0');
  assert.match(readFileSync(join(root, 'implementations/typescript/packages/core/src/index.ts'), 'utf8'), /1\.3\.0/);
  assert.deepEqual(
    JSON.parse(readFileSync(join(root, 'conformance/cts-claims.json'))).claim_sets.map((claimSet) => claimSet.implementation_version),
    ['1.3.0', '1.2.3', '1.2.3'],
  );
  assert.match(readFileSync(join(root, 'implementations/rust/Cargo.toml'), 'utf8'), /1\.2\.3/);
  assert.match(readFileSync(join(root, 'implementations/python/pyproject.toml'), 'utf8'), /1\.2\.3/);
  assert.equal(existsSync(join(root, transactionDirectory)), false);
});

test('version set all updates TypeScript, Rust, and Python together', (t) => {
  const { root } = createFixture(t);
  const result = runVersion(root, ['set', 'all', '1.3.0']);

  assert.equal(result.status, 0, result.stderr);
  assert.match(readFileSync(join(root, 'implementations/rust/Cargo.toml'), 'utf8'), /version = "1\.3\.0"/);
  assert.match(readFileSync(join(root, 'implementations/rust/Cargo.lock'), 'utf8'), /version = "1\.3\.0"/);
  assert.match(
    readFileSync(join(root, 'implementations/rust/Cargo.lock'), 'utf8'),
    /name = "aeon-python"\nversion = "1\.3\.0"/,
  );
  assert.match(readFileSync(join(root, 'implementations/python/pyproject.toml'), 'utf8'), /version = "1\.3\.0"/);
  assert.match(readFileSync(join(root, 'implementations/rust/crates/aeon-python/pyproject.toml'), 'utf8'), /version = "1\.3\.0"/);
  assert.match(readFileSync(join(root, 'implementations/python/src/aeon/cli.py'), 'utf8'), /1\.3\.0/);
  assert.deepEqual(
    JSON.parse(readFileSync(join(root, 'conformance/cts-claims.json'))).claim_sets.map((claimSet) => claimSet.implementation_version),
    ['1.3.0', '1.3.0', '1.3.0'],
  );
  assert.match(readFileSync(join(root, 'VERSIONING.md'), 'utf8'), /TypeScript: `1\.3\.0`/);
  assert.doesNotMatch(readFileSync(join(root, 'VERSIONING.md'), 'utf8'), /1\.2\.3/);
});

test('version set permits an exact idempotent rerun', (t) => {
  const { root, sources } = createFixture(t);
  const result = runVersion(root, ['set', 'all', '1.2.3']);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /already 1\.2\.3/);
  assert.deepEqual(readSources(root, sources.keys()), sources);
});

test('version set permits an exact rerun before the new changelog heading exists', (t) => {
  const { root, sources } = createFixture(t);
  const first = runVersion(root, ['set', 'typescript', '1.3.0']);
  assert.equal(first.status, 0, first.stderr);
  const updated = readSources(root, sources.keys());

  const check = runVersion(root, ['check']);
  assert.equal(check.status, 1);
  assert.match(check.stderr, /CHANGELOG\.md must have exactly one dated release heading for 1\.3\.0/);

  const rerun = runVersion(root, ['set', 'typescript', '1.3.0']);
  assert.equal(rerun.status, 0, rerun.stderr);
  assert.match(rerun.stdout, /already 1\.3\.0/);
  assert.deepEqual(readSources(root, sources.keys()), updated);

  const nextBump = runVersion(root, ['set', 'typescript', '1.4.0']);
  assert.equal(nextBump.status, 1);
  assert.match(nextBump.stderr, /CHANGELOG\.md must have exactly one dated release heading for 1\.3\.0/);
  assert.deepEqual(readSources(root, sources.keys()), updated);
});

test('version set rejects invalid input, downgrades, and equal-precedence build changes', (t) => {
  const { root, sources } = createFixture(t);
  for (const version of ['v1.3.0', '1.2.2', '1.2.3+replacement']) {
    const result = runVersion(root, ['set', 'typescript', version]);
    assert.equal(result.status, 1);
    assert.deepEqual(readSources(root, sources.keys()), sources);
  }
});

test('version check rejects a mismatched workspace manifest and missing changelog heading', (t) => {
  const { root } = createFixture(t);
  const sdkPath = join(root, 'implementations/typescript/packages/sdk/package.json');
  writeFileSync(sdkPath, readFileSync(sdkPath, 'utf8').replace('1.2.3', '1.2.4'));
  writeFileSync(join(root, 'CHANGELOG.md'), '# Changelog\n\n## Unreleased\n');
  const result = runVersion(root, ['check']);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /sdk\/package\.json version 1\.2\.4 does not match TypeScript 1\.2\.3/);
  assert.match(result.stderr, /CHANGELOG\.md must have exactly one dated release heading/);
});

test('version check rejects a mismatched implementation claim version', (t) => {
  const { root } = createFixture(t);
  const claimsPath = join(root, 'conformance/cts-claims.json');
  writeFileSync(
    claimsPath,
    readFileSync(claimsPath, 'utf8').replace('"implementation_version": "1.2.3"', '"implementation_version": "1.2.2"'),
  );
  const result = runVersion(root, ['check']);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /typescript implementation_version 1\.2\.2 does not match 1\.2\.3/);
});

test('version check rejects a mismatched native Python package version', (t) => {
  const { root } = createFixture(t);
  const nativeProject = join(root, 'implementations/rust/crates/aeon-python/pyproject.toml');
  writeFileSync(nativeProject, readFileSync(nativeProject, 'utf8').replace('1.2.3', '1.2.4'));
  const result = runVersion(root, ['check']);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /native Python project version 1\.2\.4 does not match Python 1\.2\.3/);
});

test('version check rejects a mismatched native Python Cargo lock entry', (t) => {
  const { root } = createFixture(t);
  const lockPath = join(root, 'implementations/rust/Cargo.lock');
  writeFileSync(
    lockPath,
    readFileSync(lockPath, 'utf8').replace(
      'name = "aeon-python"\nversion = "1.2.3"',
      'name = "aeon-python"\nversion = "1.2.4"',
    ),
  );
  const result = runVersion(root, ['check']);

  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /implementations\/rust\/Cargo\.lock package aeon-python version 1\.2\.4 does not match 1\.2\.3/,
  );
});

test('version check rejects malformed JSON without a stack trace', (t) => {
  const { root } = createFixture(t);
  writeFileSync(join(root, 'implementations/typescript/packages/core/package.json'), '{');
  const result = runVersion(root, ['check']);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /^Version validation failed:/);
  assert.doesNotMatch(result.stderr, /\n\s+at /);
});

test('version check rejects duplicate top-level JSON version fields', (t) => {
  const { root } = createFixture(t);
  const file = join(root, 'implementations/typescript/packages/core/package.json');
  writeFileSync(file, readFileSync(file, 'utf8').replace(
    '  "version": "1.2.3",',
    '  "version": "1.2.3",\n  "version": "1.2.3",',
  ));
  const result = runVersion(root, ['check']);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /top-level version field must occur exactly once/);
});

test('version check refuses symbolic-link metadata targets', {
  skip: process.platform === 'win32',
}, (t) => {
  const { root } = createFixture(t);
  const file = join(root, 'implementations/python/pyproject.toml');
  const real = join(root, 'implementations/python/pyproject.real.toml');
  renameSync(file, real);
  symlinkSync('pyproject.real.toml', file);
  const result = runVersion(root, ['check']);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /must not be a symbolic link/);
});

test('release-tag validation matches the selected implementation track exactly', (t) => {
  const { root } = createFixture(t);
  const accepted = runVersion(root, ['check-tag', 'typescript', 'typescript/v1.2.3']);
  const rejected = runVersion(root, ['check-tag', 'typescript', 'typescript/v1.2.4']);

  assert.equal(accepted.status, 0, accepted.stderr);
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /does not match "typescript\/v1\.2\.3"/);
});

test('version commands fail closed while a transaction is pending', (t) => {
  const { root, sources } = createFixture(t);
  createTransaction(root, sources, 'staging', ['VERSIONING.md']);

  for (const args of [['check'], ['set', 'typescript', '1.3.0'], ['check-tag', 'typescript', 'typescript/v1.2.3']]) {
    const result = runVersion(root, args);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /npm run version:recover/);
  }
});

test('version recovery rolls a prepared partial update back as a set', (t) => {
  const { root, sources } = createFixture(t);
  const selected = ['VERSIONING.md', 'implementations/typescript/packages/core/package.json'];
  createTransaction(root, sources, 'prepared', selected);
  for (const relativePath of selected) {
    writeFileSync(join(root, relativePath), sources.get(relativePath).replaceAll('1.2.3', '1.3.0'));
  }
  const result = runVersion(root, ['recover']);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /restored the pre-transaction version files/);
  assert.deepEqual(readSources(root, selected), new Map(selected.map((path) => [path, sources.get(path)])));
  assert.equal(existsSync(join(root, transactionDirectory)), false);
});

test('version recovery keeps a committed update set', (t) => {
  const { root, sources } = createFixture(t);
  const selected = ['VERSIONING.md', 'implementations/typescript/packages/core/package.json'];
  const changed = new Map();
  for (const relativePath of selected) {
    const source = sources.get(relativePath).replaceAll('1.2.3', '1.3.0');
    changed.set(relativePath, source);
    writeFileSync(join(root, relativePath), source);
  }
  createTransaction(root, sources, 'committed', selected);
  const result = runVersion(root, ['recover']);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /kept the committed version files/);
  assert.deepEqual(readSources(root, selected), changed);
  assert.equal(existsSync(join(root, transactionDirectory)), false);
});

test('version recovery is harmless when no transaction exists', (t) => {
  const { root, sources } = createFixture(t);
  const result = runVersion(root, ['recover']);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /No interrupted version transaction was found/);
  assert.deepEqual(readSources(root, sources.keys()), sources);
});

test('version recovery removes known staging artifacts without a journal', (t) => {
  const { root, sources } = createFixture(t);
  const transaction = join(root, transactionDirectory);
  mkdirSync(transaction);
  writeFileSync(join(transaction, `${targetId(sources, 'VERSIONING.md')}.next`), 'staged');
  const result = runVersion(root, ['recover']);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(transaction), false);
});

test('version recovery preserves unknown artifacts for manual inspection', (t) => {
  const { root } = createFixture(t);
  const transaction = join(root, transactionDirectory);
  mkdirSync(transaction);
  writeFileSync(join(transaction, 'unexpected'), 'do not delete');
  const result = runVersion(root, ['recover']);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown recovery artifacts are present/);
  assert.equal(readFileSync(join(transaction, 'unexpected'), 'utf8'), 'do not delete');
});

test('version recovery preserves a malformed journal for manual inspection', (t) => {
  const { root } = createFixture(t);
  const transaction = join(root, transactionDirectory);
  mkdirSync(transaction);
  writeFileSync(join(transaction, 'journal.json'), '{');
  const result = runVersion(root, ['recover']);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Recovery journal is unreadable/);
  assert.equal(readFileSync(join(transaction, 'journal.json'), 'utf8'), '{');
});

test('version recovery rejects unknown journal targets without reading outside its registry', (t) => {
  const { root } = createFixture(t);
  const transaction = join(root, transactionDirectory);
  mkdirSync(transaction);
  writeFileSync(
    join(transaction, 'journal.json'),
    `${JSON.stringify({ schemaVersion: 1, state: 'prepared', targets: ['../../outside'] })}\n`,
  );
  const result = runVersion(root, ['recover']);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /unsupported shape/);
  assert.equal(existsSync(transaction), true);
});

test('version recovery refuses a prepared transaction with a missing backup', (t) => {
  const { root, sources } = createFixture(t);
  const selected = ['VERSIONING.md'];
  const transaction = createTransaction(root, sources, 'prepared', selected);
  rmSync(join(transaction, `${targetId(sources, selected[0])}.backup`));
  const result = runVersion(root, ['recover']);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Recovery backup is missing/);
  assert.equal(existsSync(transaction), true);
  assert.equal(readFileSync(join(root, selected[0]), 'utf8'), sources.get(selected[0]));
});

test('version recovery refuses a symbolic-link transaction directory', {
  skip: process.platform === 'win32',
}, (t) => {
  const { root } = createFixture(t);
  const outside = mkdtempSync(join(tmpdir(), 'aeon-version-outside-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  symlinkSync(outside, join(root, transactionDirectory), 'dir');
  const result = runVersion(root, ['recover']);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /must not be a symbolic link/);
  assert.equal(existsSync(outside), true);
});

test('version set automatically rolls back a mid-commit filesystem failure', {
  skip: process.platform === 'win32',
}, (t) => {
  const { root, sources } = createFixture(t);
  const blockedDirectory = join(root, 'implementations/typescript/tools/cts-runner');
  chmodSync(blockedDirectory, 0o555);
  let result;
  try {
    result = runVersion(root, ['set', 'typescript', '1.3.0']);
  } finally {
    chmodSync(blockedDirectory, 0o755);
  }

  assert.equal(result.status, 1);
  assert.match(result.stderr, /original version files were restored/);
  assert.deepEqual(readSources(root, sources.keys()), sources);
  assert.equal(existsSync(join(root, transactionDirectory)), false);
});
