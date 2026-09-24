#!/usr/bin/env node

import { constants as fsConstants } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rmdir,
  unlink,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const transactionRelativePath = '.aeon-version-transaction';
const transactionPath = path.join(repositoryRoot, transactionRelativePath);
const journalPath = path.join(transactionPath, 'journal.json');
const journalNextPath = path.join(transactionPath, 'journal.next');
const validTracks = new Set(['typescript', 'rust', 'python', 'all']);
const concreteTracks = ['typescript', 'rust', 'python'];
const transactionStates = new Set(['staging', 'prepared', 'committed']);
const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

const sharedRelativePaths = [
  'CHANGELOG.md',
  'conformance/cts-claims.json',
  'VERSIONING.md',
  'docs/release-strategy.md',
];
const typescriptFixedRelativePaths = [
  'implementations/typescript/README.md',
  'implementations/typescript/packages/cli/README.md',
  'implementations/typescript/packages/core/src/index.ts',
  'implementations/typescript/packages/wasm/pkg/package.json',
];
const rustRelativePaths = [
  'implementations/rust/Cargo.toml',
  'implementations/rust/Cargo.lock',
  'implementations/rust/fuzz/Cargo.lock',
  'implementations/rust/README.md',
];
const pythonRelativePaths = [
  'implementations/python/pyproject.toml',
  'implementations/python/README.md',
  'implementations/python/src/aeon/cli.py',
  'implementations/rust/crates/aeon-python/pyproject.toml',
];
const rustWorkspacePackages = [
  { dependency: 'aeon-aeos', package: 'altopelago-aeon-aeos' },
  { dependency: 'aeon-annotations', package: 'aeon-annotations' },
  { dependency: 'aeon-canonical', package: 'aeon-canonical' },
  { dependency: 'aeon-cli', package: 'aeon-cli' },
  { dependency: 'aeon-core', package: 'altopelago-aeon-core' },
  { dependency: 'aeon-finalize', package: 'altopelago-aeon-finalize' },
  { dependency: 'aeon-sdk', package: 'altopelago-aeon' },
  { dependency: 'aeon-wasm', package: 'aeon-wasm' },
];

function rustWorkspaceDependencyLine({ dependency, package: packageName }, version) {
  const packageClause = dependency === packageName ? '' : `package = "${packageName}", `;
  return `${dependency} = { ${packageClause}path = "crates/${dependency}", version = "${version}" }`;
}

function fail(message) {
  console.error(`Version validation failed: ${message}`);
  process.exitCode = 1;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function semverParts(version) {
  const withoutBuild = version.split('+', 1)[0];
  const separator = withoutBuild.indexOf('-');
  const core = (separator === -1 ? withoutBuild : withoutBuild.slice(0, separator))
    .split('.')
    .map((part) => BigInt(part));
  const prerelease = separator === -1 ? null : withoutBuild.slice(separator + 1).split('.');
  return { core, prerelease };
}

function compareSemver(left, right) {
  const a = semverParts(left);
  const b = semverParts(right);
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index] < b.core[index]) return -1;
    if (a.core[index] > b.core[index]) return 1;
  }
  if (a.prerelease === null && b.prerelease === null) return 0;
  if (a.prerelease === null) return 1;
  if (b.prerelease === null) return -1;
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = a.prerelease[index];
    const rightPart = b.prerelease[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;
    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) return BigInt(leftPart) < BigInt(rightPart) ? -1 : 1;
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

async function exists(file) {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function immediatePackageManifests(relativeDirectory) {
  const directory = path.join(repositoryRoot, relativeDirectory);
  const entries = await readdir(directory, { withFileTypes: true });
  const manifests = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const relativeManifest = path.posix.join(relativeDirectory, entry.name, 'package.json');
    if (await exists(path.join(repositoryRoot, relativeManifest))) manifests.push(relativeManifest);
  }
  return manifests;
}

const typescriptManifestRelativePaths = [
  ...await immediatePackageManifests('implementations/typescript/packages'),
  ...await immediatePackageManifests('implementations/typescript/tools'),
].sort();

const allRelativePaths = [...new Set([
  ...sharedRelativePaths,
  ...typescriptFixedRelativePaths,
  ...typescriptManifestRelativePaths,
  ...rustRelativePaths,
  ...pythonRelativePaths,
])].sort();

const targets = allRelativePaths.map((relativePath) => {
  const id = `target-${createHash('sha256').update(relativePath).digest('hex').slice(0, 24)}`;
  return {
    id,
    label: relativePath,
    relativePath,
    path: path.join(repositoryRoot, relativePath),
    next: path.join(transactionPath, `${id}.next`),
    backup: path.join(transactionPath, `${id}.backup`),
    restore: path.join(transactionPath, `${id}.restore`),
  };
});
const targetById = new Map(targets.map((target) => [target.id, target]));
const targetByRelativePath = new Map(targets.map((target) => [target.relativePath, target]));
if (targetById.size !== targets.length || targetByRelativePath.size !== targets.length) {
  throw new Error('Version transaction target registry contains a duplicate identifier or path');
}

async function unlinkIfPresent(file) {
  try {
    await unlink(file);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

async function assertRegularFile(file, label) {
  const metadata = await lstat(file);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be a regular file and must not be a symbolic link`);
  }
  return metadata;
}

async function assertTransactionDirectory() {
  const metadata = await lstat(transactionPath);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`${transactionRelativePath} must be a directory and must not be a symbolic link`);
  }
}

async function assertKnownTransactionArtifacts() {
  const knownArtifacts = new Set([
    path.basename(journalPath),
    path.basename(journalNextPath),
    ...targets.flatMap((target) => [
      path.basename(target.next),
      path.basename(target.backup),
      path.basename(target.restore),
    ]),
  ]);
  const unknown = (await readdir(transactionPath))
    .filter((artifact) => !knownArtifacts.has(artifact));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown recovery artifacts are present (${unknown.join(', ')}); preserve ${transactionRelativePath} for manual inspection`,
    );
  }
}

async function writeDurableNew(file, source, mode) {
  const handle = await open(file, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, mode);
  try {
    await handle.writeFile(source);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncFile(file) {
  const handle = await open(file, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeJournal(state, targetIds) {
  await unlinkIfPresent(journalNextPath);
  await writeDurableNew(
    journalNextPath,
    `${JSON.stringify({ schemaVersion: 1, state, targets: targetIds })}\n`,
    0o600,
  );
  await rename(journalNextPath, journalPath);
}

async function readJournal() {
  if (!await exists(journalPath)) return null;
  let journal;
  try {
    await assertRegularFile(journalPath, 'Version recovery journal');
    journal = JSON.parse(await readFile(journalPath, 'utf8'));
  } catch (error) {
    throw new Error(
      `Recovery journal is unreadable; preserve ${transactionRelativePath} for manual inspection: ${errorMessage(error)}`,
    );
  }
  const ids = journal?.targets;
  const idsValid = Array.isArray(ids)
    && ids.length > 0
    && new Set(ids).size === ids.length
    && ids.every((id) => typeof id === 'string' && targetById.has(id));
  if (journal?.schemaVersion !== 1 || !transactionStates.has(journal.state) || !idsValid) {
    throw new Error(
      `Recovery journal has an unsupported shape; preserve ${transactionRelativePath} for manual inspection`,
    );
  }
  return journal;
}

async function cleanupTransaction() {
  for (const target of targets) {
    await unlinkIfPresent(target.next);
    await unlinkIfPresent(target.restore);
    await unlinkIfPresent(target.backup);
  }
  await unlinkIfPresent(journalNextPath);
  await unlinkIfPresent(journalPath);
  try {
    await rmdir(transactionPath);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

async function restorePreparedTransaction(selectedTargets) {
  for (const target of selectedTargets) {
    if (!await exists(target.backup)) {
      throw new Error(`Recovery backup is missing for ${target.label}`);
    }
    await assertRegularFile(target.backup, `Recovery backup for ${target.label}`);
    const backup = await readFile(target.backup);
    let current = null;
    if (await exists(target.path)) {
      await assertRegularFile(target.path, target.label);
      current = await readFile(target.path);
    }
    if (current !== null && current.equals(backup)) continue;
    await unlinkIfPresent(target.restore);
    const metadata = await lstat(target.backup);
    await writeDurableNew(target.restore, backup, metadata.mode);
    await rename(target.restore, target.path);
  }
}

async function recoverVersionTransaction() {
  if (!await exists(transactionPath)) return null;
  await assertTransactionDirectory();
  await assertKnownTransactionArtifacts();
  const journal = await readJournal();
  if (journal === null) {
    const artifacts = await readdir(transactionPath);
    await cleanupTransaction();
    return artifacts.length === 0 ? 'empty' : 'staging';
  }

  const selectedTargets = journal.targets.map((id) => targetById.get(id));
  if (journal.state === 'prepared') await restorePreparedTransaction(selectedTargets);
  if (journal.state === 'committed') {
    for (const target of selectedTargets) await assertRegularFile(target.path, target.label);
  }
  await cleanupTransaction();
  return journal.state;
}

async function assertNoPendingTransaction() {
  if (await exists(transactionPath)) {
    throw new Error(
      'An interrupted version transaction is present; ensure no other version command is running, then run `npm run version:recover`',
    );
  }
}

function parseJsonSource(source, label) {
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${errorMessage(error)}`);
  }
}

async function loadSources() {
  const sources = new Map();
  for (const target of targets) {
    await assertRegularFile(target.path, target.label);
    sources.set(target.relativePath, await readFile(target.path, 'utf8'));
  }
  return sources;
}

function matches(source, pattern) {
  return [...source.matchAll(pattern)].map((match) => match);
}

function singleCapturedValue(source, pattern, label) {
  const found = matches(source, pattern);
  if (found.length !== 1) throw new Error(`${label} must occur exactly once`);
  return found[0][1];
}

function replacePattern(source, pattern, replacement, label, expectedCount = 1) {
  const found = matches(source, pattern);
  if (found.length !== expectedCount) {
    throw new Error(`${label} must occur exactly ${expectedCount} time(s); found ${found.length}`);
  }
  return source.replace(pattern, replacement);
}

function replaceLiteral(source, current, next, label, expectedCount = 1) {
  return replacePattern(
    source,
    new RegExp(escapeRegExp(current), 'g'),
    () => next,
    label,
    expectedCount,
  );
}

function jsonVersion(source, label) {
  const manifest = parseJsonSource(source, label);
  const lineVersion = singleCapturedValue(
    source,
    /^(?: {2}|\t)"version"\s*:\s*"([^"]+)"/gm,
    `${label} top-level version field`,
  );
  if (manifest.version !== lineVersion) {
    throw new Error(`${label} parsed version does not match its top-level version field`);
  }
  return manifest.version;
}

function replaceJsonVersion(source, current, next, label) {
  const parsed = jsonVersion(source, label);
  if (parsed !== current) throw new Error(`${label} version ${parsed} does not match ${current}`);
  return replacePattern(
    source,
    new RegExp(`^((?: {2}|\\t)"version"\\s*:\\s*")${escapeRegExp(current)}(".*)$`, 'gm'),
    `$1${next}$2`,
    `${label} top-level version field`,
  );
}

function ctsClaimVersions(source) {
  const label = 'conformance/cts-claims.json';
  const document = parseJsonSource(source, label);
  if (!Array.isArray(document.claim_sets)) {
    throw new Error(`${label} claim_sets must be an array`);
  }
  const versions = {};
  for (const track of concreteTracks) {
    const claimSets = document.claim_sets.filter((claimSet) => claimSet?.implementation === track);
    if (claimSets.length !== 1) {
      throw new Error(`${label} must contain exactly one ${track} claim set`);
    }
    const version = claimSets[0].implementation_version;
    if (typeof version !== 'string' || !semverPattern.test(version)) {
      throw new Error(`${label} ${track} implementation_version must be valid SemVer`);
    }
    versions[track] = version;
  }
  return versions;
}

function replaceCtsClaimVersion(source, track, current, next) {
  const versions = ctsClaimVersions(source);
  if (versions[track] !== current) {
    throw new Error(
      `conformance/cts-claims.json ${track} implementation_version ${versions[track]} does not match ${current}`,
    );
  }
  return replacePattern(
    source,
    new RegExp(`("implementation"\\s*:\\s*"${track}"\\s*,\\s*"implementation_version"\\s*:\\s*")${escapeRegExp(current)}(")`, 'g'),
    `$1${next}$2`,
    `conformance/cts-claims.json ${track} implementation_version`,
  );
}

function currentVersions(sources) {
  const versions = {
    typescript: jsonVersion(
      sources.get('implementations/typescript/packages/core/package.json'),
      'implementations/typescript/packages/core/package.json',
    ),
    rust: singleCapturedValue(
      sources.get('implementations/rust/Cargo.toml'),
      /^version = "([^"]+)"$/gm,
      'implementations/rust/Cargo.toml workspace package version',
    ),
    python: singleCapturedValue(
      sources.get('implementations/python/pyproject.toml'),
      /^version = "([^"]+)"$/gm,
      'implementations/python/pyproject.toml project version',
    ),
  };
  for (const [track, version] of Object.entries(versions)) {
    if (!semverPattern.test(version)) throw new Error(`${track} has invalid SemVer version ${JSON.stringify(version)}`);
  }
  return versions;
}

function expectLiteral(problems, source, literal, label, count = 1) {
  const found = source.split(literal).length - 1;
  if (found !== count) problems.push(`${label} must occur exactly ${count} time(s); found ${found}`);
}

function cargoLockVersionProblems(problems, source, relativePath, names, version) {
  for (const name of names) {
    const pattern = new RegExp(
      `\\[\\[package\\]\\]\\nname = "${escapeRegExp(name)}"\\nversion = "([^"]+)"`,
      'g',
    );
    const found = matches(source, pattern);
    if (found.length !== 1) {
      problems.push(`${relativePath} package ${name} must occur exactly once`);
    } else if (found[0][1] !== version) {
      problems.push(`${relativePath} package ${name} version ${found[0][1]} does not match ${version}`);
    }
  }
}

function releaseHeadingProblem(changelog, version) {
  const found = matches(
    changelog,
    new RegExp(`^## ${escapeRegExp(version)} - \\d{4}-\\d{2}-\\d{2}$`, 'gm'),
  );
  return found.length === 1
    ? null
    : `CHANGELOG.md must have exactly one dated release heading for ${version}`;
}

function releaseHeadingProblems(sources, versions) {
  const changelog = sources.get('CHANGELOG.md');
  return [...new Set(Object.values(versions))]
    .map((version) => releaseHeadingProblem(changelog, version))
    .filter((problem) => problem !== null);
}

function consistencyProblems(sources, versions, { requireReleaseHeadings = true } = {}) {
  const problems = [];
  try {
    const claimedVersions = ctsClaimVersions(sources.get('conformance/cts-claims.json'));
    for (const track of concreteTracks) {
      if (claimedVersions[track] !== versions[track]) {
        problems.push(
          `conformance/cts-claims.json ${track} implementation_version ${claimedVersions[track]} does not match ${versions[track]}`,
        );
      }
    }
  } catch (error) {
    problems.push(errorMessage(error));
  }
  for (const relativePath of typescriptManifestRelativePaths) {
    try {
      const version = jsonVersion(sources.get(relativePath), relativePath);
      if (version !== versions.typescript) {
        problems.push(`${relativePath} version ${version} does not match TypeScript ${versions.typescript}`);
      }
    } catch (error) {
      problems.push(errorMessage(error));
    }
  }
  try {
    const generated = jsonVersion(
      sources.get('implementations/typescript/packages/wasm/pkg/package.json'),
      'implementations/typescript/packages/wasm/pkg/package.json',
    );
    if (generated !== versions.typescript) {
      problems.push(`generated WASM package version ${generated} does not match TypeScript ${versions.typescript}`);
    }
  } catch (error) {
    problems.push(errorMessage(error));
  }

  const coreSource = sources.get('implementations/typescript/packages/core/src/index.ts');
  expectLiteral(problems, coreSource, `export const VERSION = '${versions.typescript}';`, 'TypeScript Core VERSION');
  expectLiteral(problems, sources.get('implementations/typescript/README.md'), `Current package line: \`${versions.typescript}\`.`, 'TypeScript README current line');
  expectLiteral(problems, sources.get('implementations/typescript/packages/cli/README.md'), `@altopelago/aeon-cli@${versions.typescript}`, 'TypeScript CLI README pinned version');

  const rustToml = sources.get('implementations/rust/Cargo.toml');
  for (const packageInfo of rustWorkspacePackages) {
    expectLiteral(
      problems,
      rustToml,
      rustWorkspaceDependencyLine(packageInfo, versions.rust),
      `Rust workspace dependency ${packageInfo.dependency}`,
    );
  }
  cargoLockVersionProblems(
    problems,
    sources.get('implementations/rust/Cargo.lock'),
    'implementations/rust/Cargo.lock',
    rustWorkspacePackages.map(({ package: packageName }) => packageName),
    versions.rust,
  );
  cargoLockVersionProblems(
    problems,
    sources.get('implementations/rust/fuzz/Cargo.lock'),
    'implementations/rust/fuzz/Cargo.lock',
    ['altopelago-aeon-core'],
    versions.rust,
  );
  expectLiteral(problems, sources.get('implementations/rust/README.md'), `Current crate/workspace line: \`${versions.rust}\`.`, 'Rust README current line');

  expectLiteral(problems, sources.get('implementations/python/README.md'), `Current package line: \`${versions.python}\`.`, 'Python README current line');
  expectLiteral(problems, sources.get('implementations/python/src/aeon/cli.py'), `print("aeon-python ${versions.python}")`, 'Python CLI version');
  try {
    const nativeVersion = singleCapturedValue(
      sources.get('implementations/rust/crates/aeon-python/pyproject.toml'),
      /^version = "([^"]+)"$/gm,
      'native Python project version',
    );
    if (nativeVersion !== versions.python) {
      problems.push(`native Python project version ${nativeVersion} does not match Python ${versions.python}`);
    }
  } catch (error) {
    problems.push(errorMessage(error));
  }

  const versioning = sources.get('VERSIONING.md');
  expectLiteral(problems, versioning, `- TypeScript: \`${versions.typescript}\``, 'VERSIONING TypeScript line');
  expectLiteral(problems, versioning, `- Rust: \`${versions.rust}\``, 'VERSIONING Rust line');
  expectLiteral(problems, versioning, `- Python: \`${versions.python}\``, 'VERSIONING Python line');
  expectLiteral(problems, versioning, `- TypeScript implementation/package line: \`${versions.typescript}\``, 'VERSIONING TypeScript baseline');
  expectLiteral(problems, versioning, `- Rust implementation/package line: \`${versions.rust}\``, 'VERSIONING Rust baseline');
  expectLiteral(problems, versioning, `- Python implementation/package line: \`${versions.python}\``, 'VERSIONING Python baseline');
  expectLiteral(problems, versioning, `after the TypeScript \`${versions.typescript}\` release`, 'VERSIONING TypeScript tag example introduction');
  expectLiteral(problems, versioning, `typescript/v${versions.typescript}`, 'VERSIONING TypeScript tag examples', 3);
  expectLiteral(problems, versioning, `AEON TypeScript packages ${versions.typescript}`, 'VERSIONING TypeScript tag message');

  const strategy = sources.get('docs/release-strategy.md');
  for (const track of concreteTracks) {
    expectLiteral(problems, strategy, `release/${track}/${versions[track]}`, `release-strategy ${track} release branch`);
    expectLiteral(problems, strategy, `${track}/v${versions[track]}`, `release-strategy ${track} tag`);
  }
  expectLiteral(problems, strategy, `hotfix/typescript/${versions.typescript}`, 'release-strategy TypeScript hotfix branch');

  if (requireReleaseHeadings) problems.push(...releaseHeadingProblems(sources, versions));
  return problems;
}

function updateSource(updates, relativePath, transform) {
  const current = updates.get(relativePath);
  if (current === undefined) throw new Error(`Unknown version target ${relativePath}`);
  updates.set(relativePath, transform(current));
}

function updateTypeScript(updates, current, next) {
  updateSource(updates, 'conformance/cts-claims.json', (source) => replaceCtsClaimVersion(source, 'typescript', current, next));
  for (const relativePath of typescriptManifestRelativePaths) {
    updateSource(updates, relativePath, (source) => replaceJsonVersion(source, current, next, relativePath));
  }
  const generated = 'implementations/typescript/packages/wasm/pkg/package.json';
  updateSource(updates, generated, (source) => replaceJsonVersion(source, current, next, generated));
  updateSource(updates, 'implementations/typescript/packages/core/src/index.ts', (source) => replaceLiteral(source, `export const VERSION = '${current}';`, `export const VERSION = '${next}';`, 'TypeScript Core VERSION'));
  updateSource(updates, 'implementations/typescript/README.md', (source) => replaceLiteral(source, `Current package line: \`${current}\`.`, `Current package line: \`${next}\`.`, 'TypeScript README current line'));
  updateSource(updates, 'implementations/typescript/packages/cli/README.md', (source) => replaceLiteral(source, `@altopelago/aeon-cli@${current}`, `@altopelago/aeon-cli@${next}`, 'TypeScript CLI README pinned version'));
  updateSource(updates, 'VERSIONING.md', (source) => {
    let result = replaceLiteral(source, `- TypeScript: \`${current}\``, `- TypeScript: \`${next}\``, 'VERSIONING TypeScript line');
    result = replaceLiteral(result, `- TypeScript implementation/package line: \`${current}\``, `- TypeScript implementation/package line: \`${next}\``, 'VERSIONING TypeScript baseline');
    result = replaceLiteral(result, `after the TypeScript \`${current}\` release`, `after the TypeScript \`${next}\` release`, 'VERSIONING TypeScript example introduction');
    result = replaceLiteral(result, `typescript/v${current}`, `typescript/v${next}`, 'VERSIONING TypeScript tag examples', 3);
    return replaceLiteral(result, `AEON TypeScript packages ${current}`, `AEON TypeScript packages ${next}`, 'VERSIONING TypeScript tag message');
  });
  updateSource(updates, 'docs/release-strategy.md', (source) => {
    let result = replaceLiteral(source, `release/typescript/${current}`, `release/typescript/${next}`, 'release-strategy TypeScript release branch');
    result = replaceLiteral(result, `hotfix/typescript/${current}`, `hotfix/typescript/${next}`, 'release-strategy TypeScript hotfix branch');
    return replaceLiteral(result, `typescript/v${current}`, `typescript/v${next}`, 'release-strategy TypeScript tag');
  });
}

function replaceCargoLockVersions(source, names, current, next, label) {
  let result = source;
  for (const name of names) {
    result = replacePattern(
      result,
      new RegExp(`(\\[\\[package\\]\\]\\nname = "${escapeRegExp(name)}"\\nversion = ")${escapeRegExp(current)}(")`, 'g'),
      `$1${next}$2`,
      `${label} package ${name}`,
    );
  }
  return result;
}

function updateRust(updates, current, next) {
  updateSource(updates, 'conformance/cts-claims.json', (source) => replaceCtsClaimVersion(source, 'rust', current, next));
  updateSource(updates, 'implementations/rust/Cargo.toml', (source) => {
    let result = replacePattern(source, new RegExp(`^(version = ")${escapeRegExp(current)}("$)`, 'gm'), `$1${next}$2`, 'Rust workspace package version');
    for (const packageInfo of rustWorkspacePackages) {
      result = replaceLiteral(
        result,
        rustWorkspaceDependencyLine(packageInfo, current),
        rustWorkspaceDependencyLine(packageInfo, next),
        `Rust workspace dependency ${packageInfo.dependency}`,
      );
    }
    return result;
  });
  updateSource(updates, 'implementations/rust/Cargo.lock', (source) => replaceCargoLockVersions(source, rustWorkspacePackages.map(({ package: packageName }) => packageName), current, next, 'implementations/rust/Cargo.lock'));
  updateSource(updates, 'implementations/rust/fuzz/Cargo.lock', (source) => replaceCargoLockVersions(source, ['altopelago-aeon-core'], current, next, 'implementations/rust/fuzz/Cargo.lock'));
  updateSource(updates, 'implementations/rust/README.md', (source) => replaceLiteral(source, `Current crate/workspace line: \`${current}\`.`, `Current crate/workspace line: \`${next}\`.`, 'Rust README current line'));
  updateSource(updates, 'VERSIONING.md', (source) => {
    let result = replaceLiteral(source, `- Rust: \`${current}\``, `- Rust: \`${next}\``, 'VERSIONING Rust line');
    return replaceLiteral(result, `- Rust implementation/package line: \`${current}\``, `- Rust implementation/package line: \`${next}\``, 'VERSIONING Rust baseline');
  });
  updateSource(updates, 'docs/release-strategy.md', (source) => {
    let result = replaceLiteral(source, `release/rust/${current}`, `release/rust/${next}`, 'release-strategy Rust release branch');
    return replaceLiteral(result, `rust/v${current}`, `rust/v${next}`, 'release-strategy Rust tag');
  });
}

function updatePython(updates, current, next) {
  updateSource(updates, 'conformance/cts-claims.json', (source) => replaceCtsClaimVersion(source, 'python', current, next));
  updateSource(updates, 'implementations/python/pyproject.toml', (source) => replacePattern(source, new RegExp(`^(version = ")${escapeRegExp(current)}("$)`, 'gm'), `$1${next}$2`, 'Python project version'));
  updateSource(updates, 'implementations/python/README.md', (source) => replaceLiteral(source, `Current package line: \`${current}\`.`, `Current package line: \`${next}\`.`, 'Python README current line'));
  updateSource(updates, 'implementations/python/src/aeon/cli.py', (source) => replaceLiteral(source, `print("aeon-python ${current}")`, `print("aeon-python ${next}")`, 'Python CLI version'));
  updateSource(updates, 'implementations/rust/crates/aeon-python/pyproject.toml', (source) => replacePattern(source, new RegExp(`^(version = ")${escapeRegExp(current)}("$)`, 'gm'), `$1${next}$2`, 'native Python project version'));
  updateSource(updates, 'VERSIONING.md', (source) => {
    let result = replaceLiteral(source, `- Python: \`${current}\``, `- Python: \`${next}\``, 'VERSIONING Python line');
    return replaceLiteral(result, `- Python implementation/package line: \`${current}\``, `- Python implementation/package line: \`${next}\``, 'VERSIONING Python baseline');
  });
  updateSource(updates, 'docs/release-strategy.md', (source) => {
    let result = replaceLiteral(source, `release/python/${current}`, `release/python/${next}`, 'release-strategy Python release branch');
    return replaceLiteral(result, `python/v${current}`, `python/v${next}`, 'release-strategy Python tag');
  });
}

async function validatedMetadata(options) {
  const sources = await loadSources();
  const versions = currentVersions(sources);
  const problems = consistencyProblems(sources, versions, options);
  if (problems.length > 0) throw new Error(problems.join('; '));
  return { sources, versions };
}

async function checkVersion(track = 'all') {
  if (!validTracks.has(track)) throw new Error(`Unknown implementation track ${JSON.stringify(track)}`);
  await assertNoPendingTransaction();
  const { versions } = await validatedMetadata();
  const selected = track === 'all' ? concreteTracks : [track];
  console.log(`Version consistency passed: ${selected.map((name) => `${name}=${versions[name]}`).join(' ')}`);
}

async function checkTag(track, tag) {
  if (!concreteTracks.includes(track)) {
    throw new Error('Tag validation requires one of: typescript, rust, python');
  }
  await assertNoPendingTransaction();
  const { versions } = await validatedMetadata();
  const expected = `${track}/v${versions[track]}`;
  if (tag !== expected) throw new Error(`Tag ${JSON.stringify(tag)} does not match ${JSON.stringify(expected)}`);
  console.log(`Release tag matches ${track} implementation version ${versions[track]}.`);
}

async function writeVersionTransaction(changedUpdates) {
  const selectedTargets = [...changedUpdates.keys()].map((relativePath) => {
    const target = targetByRelativePath.get(relativePath);
    if (!target) throw new Error(`Unknown transaction target ${relativePath}`);
    return target;
  });
  const targetIds = selectedTargets.map((target) => target.id);
  try {
    await mkdir(transactionPath, { mode: 0o700 });
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw new Error(
        'A version transaction is already present; ensure no other version command is running, then run `npm run version:recover`',
      );
    }
    throw error;
  }

  try {
    await writeJournal('staging', targetIds);
    for (const target of selectedTargets) {
      const metadata = await assertRegularFile(target.path, target.label);
      await writeDurableNew(target.next, changedUpdates.get(target.relativePath), metadata.mode);
      await copyFile(target.path, target.backup, fsConstants.COPYFILE_EXCL);
      await syncFile(target.backup);
    }
    await writeJournal('prepared', targetIds);
    for (const target of selectedTargets) await rename(target.next, target.path);
    await writeJournal('committed', targetIds);
    await cleanupTransaction();
  } catch (error) {
    let recoveredState;
    try {
      recoveredState = await recoverVersionTransaction();
    } catch (recoveryError) {
      throw new Error(`${errorMessage(error)}; automatic recovery failed: ${errorMessage(recoveryError)}`);
    }
    if (recoveredState === 'committed') return;
    throw new Error(`${errorMessage(error)}; original version files were restored`);
  }
}

async function setVersion(track, version) {
  if (!validTracks.has(track)) throw new Error(`Unknown implementation track ${JSON.stringify(track)}`);
  if (!semverPattern.test(version)) {
    throw new Error(`Expected a SemVer version without a leading "v", received ${JSON.stringify(version)}`);
  }
  await assertNoPendingTransaction();
  const { sources, versions } = await validatedMetadata({ requireReleaseHeadings: false });
  const selected = track === 'all' ? concreteTracks : [track];
  const changing = selected.filter((name) => versions[name] !== version);
  if (changing.length === 0) {
    console.log(`${track} release metadata is already ${version}.`);
    return;
  }
  const headingProblems = releaseHeadingProblems(sources, versions);
  if (headingProblems.length > 0) throw new Error(headingProblems.join('; '));
  for (const name of changing) {
    if (compareSemver(version, versions[name]) <= 0) {
      throw new Error(
        `New ${name} version ${version} must have higher SemVer precedence than current version ${versions[name]}`,
      );
    }
  }

  const updates = new Map(sources);
  if (changing.includes('typescript')) updateTypeScript(updates, versions.typescript, version);
  if (changing.includes('rust')) updateRust(updates, versions.rust, version);
  if (changing.includes('python')) updatePython(updates, versions.python, version);
  const changedUpdates = new Map(
    [...updates].filter(([relativePath, source]) => source !== sources.get(relativePath)),
  );
  if (changedUpdates.size === 0) throw new Error('Version update produced no changed files');
  await writeVersionTransaction(changedUpdates);
  console.log(`Set ${changing.join(', ')} release metadata to ${version}.`);
  console.log('Add the dated CHANGELOG.md heading, then run `npm run version:check`.');
}

async function recoverVersion() {
  const state = await recoverVersionTransaction();
  if (state === null) {
    console.log('No interrupted version transaction was found.');
    return;
  }
  const outcome = state === 'committed'
    ? 'kept the committed version files'
    : 'restored the pre-transaction version files';
  console.log(`Recovered version transaction (${state}); ${outcome}.`);
}

const [command, ...args] = process.argv.slice(2);

try {
  if (command === 'check' && args.length <= 1) {
    await checkVersion(args[0] ?? 'all');
  } else if (command === 'check-tag' && args.length === 2) {
    await checkTag(args[0], args[1]);
  } else if (command === 'set' && args.length === 2) {
    await setVersion(args[0], args[1]);
  } else if (command === 'recover' && args.length === 0) {
    await recoverVersion();
  } else {
    throw new Error(
      'Usage: node scripts/version.mjs check [typescript|rust|python|all] | check-tag <typescript|rust|python> <tag> | set <typescript|rust|python|all> <version> | recover',
    );
  }
} catch (error) {
  fail(errorMessage(error));
}
