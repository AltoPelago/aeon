#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageRoot = join(workspaceRoot, 'packages');
const dependencyFields = ['dependencies', 'optionalDependencies', 'peerDependencies'];
const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');
const provenance = !args.has('--no-provenance');
const tempRoot = mkdtempSync(join(tmpdir(), 'aeon-npm-publish-'));
const artifactsDir = join(tempRoot, 'artifacts');
const npmCache = join(tempRoot, 'npm-cache');

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: workspaceRoot,
    encoding: 'utf8',
    stdio: 'inherit',
    ...options,
  });
}

function packageTarballName(packageJson) {
  const packageName = packageJson.name.startsWith('@')
    ? packageJson.name.slice(1).replace('/', '-')
    : packageJson.name;
  return `${packageName}-${packageJson.version}.tgz`;
}

function discoverPackages() {
  return readdirSync(packageRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const dir = join(packageRoot, entry.name);
      const manifest = readJson(join(dir, 'package.json'));
      return { dir, manifest };
    })
    .filter(({ manifest }) => manifest.private !== true);
}

function sortByLocalDependencies(packages) {
  const byName = new Map(packages.map((pkg) => [pkg.manifest.name, pkg]));
  const visiting = new Set();
  const visited = new Set();
  const ordered = [];

  function visit(pkg) {
    const name = pkg.manifest.name;
    if (visited.has(name)) {
      return;
    }
    if (visiting.has(name)) {
      throw new Error(`Cycle in local package dependencies at ${name}`);
    }
    visiting.add(name);

    for (const field of dependencyFields) {
      for (const dependencyName of Object.keys(pkg.manifest[field] ?? {})) {
        const localDependency = byName.get(dependencyName);
        if (localDependency) {
          visit(localDependency);
        }
      }
    }

    visiting.delete(name);
    visited.add(name);
    ordered.push(pkg);
  }

  for (const pkg of packages.sort((a, b) => a.manifest.name.localeCompare(b.manifest.name))) {
    visit(pkg);
  }

  return ordered;
}

try {
  const packages = sortByLocalDependencies(discoverPackages());
  console.log(`Publishing ${packages.length} packages${dryRun ? ' (dry run)' : ''}...`);

  for (const { dir, manifest } of packages) {
    const tarball = join(artifactsDir, packageTarballName(manifest));
    console.log(`\n${manifest.name}`);
    run('pnpm', ['--dir', dir, 'pack', '--pack-destination', artifactsDir]);

    const publishArgs = ['publish', tarball, '--access', 'public'];
    if (provenance) {
      publishArgs.push('--provenance');
    }
    if (dryRun) {
      publishArgs.push('--dry-run');
    }
    run('npm', publishArgs, {
      env: {
        ...process.env,
        npm_config_audit: 'false',
        npm_config_fund: 'false',
        npm_config_update_notifier: 'false',
        npm_config_cache: npmCache,
      },
    });
    console.log(`  published ${relative(workspaceRoot, tarball)}`);
  }
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
