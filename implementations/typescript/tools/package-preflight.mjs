#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageRoot = join(workspaceRoot, 'packages');
const tempRoot = mkdtempSync(join(tmpdir(), 'aeon-package-preflight-'));
const artifactsDir = join(tempRoot, 'artifacts');
const dependencyFields = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
];
const lifecycleScripts = [
  'preinstall',
  'install',
  'postinstall',
  'prepublish',
  'prepublishOnly',
  'prepare',
];

let failures = 0;

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: workspaceRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
}

function tarEntries(tarball) {
  return run('tar', ['-tf', tarball]).trim().split('\n').filter(Boolean);
}

function tarReadJson(tarball, path) {
  return JSON.parse(run('tar', ['-xOf', tarball, path]));
}

function collectExportPaths(value, paths = []) {
  if (typeof value === 'string') {
    paths.push(value);
  } else if (value && typeof value === 'object') {
    for (const child of Object.values(value)) {
      collectExportPaths(child, paths);
    }
  }
  return paths;
}

function packageTarballName(packageJson) {
  const packageName = packageJson.name.startsWith('@')
    ? packageJson.name.slice(1).replace('/', '-')
    : packageJson.name;
  return `${packageName}-${packageJson.version}.tgz`;
}

function check(condition, message) {
  if (!condition) {
    failures += 1;
    console.error(`  - ${message}`);
  }
}

function auditDependencies(packageJson) {
  for (const field of dependencyFields) {
    const dependencies = packageJson[field] ?? {};
    for (const [name, version] of Object.entries(dependencies)) {
      check(
        typeof version === 'string' && !version.includes('workspace:'),
        `${field}.${name} still uses ${version}`,
      );
      check(
        typeof version === 'string' && !/^(file|link|portal):/.test(version),
        `${field}.${name} still uses local range ${version}`,
      );
      check(
        typeof version === 'string' && !version.startsWith('/'),
        `${field}.${name} uses absolute path ${version}`,
      );
    }
  }
}

function auditPackageMetadata(packageJson) {
  check(typeof packageJson.description === 'string' && packageJson.description.length > 0, 'manifest is missing description');
  check(packageJson.license === 'MIT', `manifest license is ${packageJson.license ?? 'missing'}`);
  check(packageJson.sideEffects === false, 'manifest must declare sideEffects=false');
  check(packageJson.engines?.node === '>=20.0.0', 'manifest must declare engines.node >=20.0.0');
  check(packageJson.publishConfig?.access === 'public', 'manifest must declare publishConfig.access=public');
  check(packageJson.repository?.type === 'git', 'manifest repository.type must be git');
  check(packageJson.repository?.url === 'git+https://github.com/AltoPelago/aeon.git', 'manifest repository.url must point at AltoPelago/aeon');
  check(
    typeof packageJson.repository?.directory === 'string' &&
      packageJson.repository.directory.startsWith('implementations/typescript/packages/'),
    'manifest repository.directory must point at its package directory',
  );
  check(packageJson.bugs?.url === 'https://github.com/AltoPelago/aeon/issues', 'manifest bugs.url must point at the issue tracker');
  check(
    typeof packageJson.homepage === 'string' &&
      packageJson.homepage.startsWith('https://github.com/AltoPelago/aeon/tree/main/implementations/typescript/packages/'),
    'manifest homepage must point at its package README',
  );
  check(
    Array.isArray(packageJson.keywords) &&
      ['aeon', 'aeonite', 'typescript'].every((keyword) => packageJson.keywords.includes(keyword)),
    'manifest keywords must include aeon, aeonite, and typescript',
  );

  for (const scriptName of lifecycleScripts) {
    check(!packageJson.scripts?.[scriptName], `manifest must not include lifecycle script ${scriptName}`);
  }
}

function auditEntryPaths(packageJson, entries) {
  const packed = new Set(entries);
  const expected = [];
  const packedTests = entries.filter((entry) => /\/dist\/.*\.test\.(d\.ts|js)(\.map)?$/.test(entry));

  if (typeof packageJson.main === 'string') {
    expected.push(packageJson.main);
  }
  if (typeof packageJson.types === 'string') {
    expected.push(packageJson.types);
  }
  if (packageJson.bin && typeof packageJson.bin === 'object') {
    expected.push(...Object.values(packageJson.bin));
  }
  if (packageJson.exports) {
    expected.push(...collectExportPaths(packageJson.exports));
  }

  for (const path of new Set(expected)) {
    if (!path.startsWith('./')) {
      continue;
    }
    const packedPath = `package/${path.slice(2)}`;
    check(packed.has(packedPath), `packed manifest references missing ${path}`);
  }

  if (packageJson.name === '@altopelago/aeon-wasm') {
    check(
      packed.has('package/pkg/aeon_wasm_bg.wasm'),
      '@altopelago/aeon-wasm tarball is missing pkg/aeon_wasm_bg.wasm',
    );
  }

  check(
    packedTests.length === 0,
    `tarball includes compiled test artifacts: ${packedTests.join(', ')}`,
  );
  check(packed.has('package/LICENSE'), 'tarball is missing LICENSE');
  check(packed.has('package/README.md'), 'tarball is missing README.md');
}

function discoverPackages() {
  return readdirSync(packageRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const dir = join(packageRoot, entry.name);
      const packageJsonPath = join(dir, 'package.json');
      return {
        dir,
        sourceManifest: readJson(packageJsonPath),
      };
    })
    .filter(({ sourceManifest }) => sourceManifest.private !== true)
    .sort((a, b) => a.sourceManifest.name.localeCompare(b.sourceManifest.name));
}

try {
  const packages = discoverPackages();
  console.log(`Packing ${packages.length} publishable packages with pnpm...`);

  for (const packageInfo of packages) {
    const { dir, sourceManifest } = packageInfo;
    const packageName = sourceManifest.name;
    const tarball = join(artifactsDir, packageTarballName(sourceManifest));

    console.log(`\n${packageName}`);
    run('pnpm', [
      '--dir',
      dir,
      'pack',
      '--pack-destination',
      artifactsDir,
    ]);

    const entries = tarEntries(tarball);
    const packedManifest = tarReadJson(tarball, 'package/package.json');
    check(packedManifest.name === sourceManifest.name, `packed name is ${packedManifest.name}`);
    check(
      packedManifest.version === sourceManifest.version,
      `packed version is ${packedManifest.version}`,
    );
    auditPackageMetadata(packedManifest);
    auditDependencies(packedManifest);
    auditEntryPaths(packedManifest, entries);
    console.log(`  packed ${relative(workspaceRoot, tarball)}`);
  }

  if (failures > 0) {
    console.error(`\nPackage preflight failed with ${failures} issue(s).`);
    process.exitCode = 1;
  } else {
    console.log('\nPackage preflight passed.');
  }
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
