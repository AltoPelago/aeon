#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rustCrate = resolve(packageRoot, '../../../rust/crates/aeon-wasm');
const outDir = resolve(packageRoot, 'pkg');
const wrapperManifestPath = resolve(packageRoot, 'package.json');
const generatedManifestPath = resolve(outDir, 'package.json');
const expectedWasmPackVersion = 'wasm-pack 0.14.0';

if (!existsSync(resolve(rustCrate, 'Cargo.toml'))) {
  console.error(`Rust WASM crate not found: ${rustCrate}`);
  process.exit(1);
}

const wasmPack = spawnSync('wasm-pack', ['--version'], {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
});

if (wasmPack.error?.code === 'ENOENT') {
  console.error('wasm-pack is required to build @altopelago/aeon-wasm.');
  console.error('Install it with `cargo install wasm-pack --version 0.14.0 --locked --force`.');
  process.exit(1);
}

if (wasmPack.status !== 0) {
  process.stderr.write(wasmPack.stderr);
  process.exit(wasmPack.status ?? 1);
}

const actualWasmPackVersion = wasmPack.stdout.trim();
if (actualWasmPackVersion !== expectedWasmPackVersion) {
  console.error(
    `Expected ${expectedWasmPackVersion}; found ${actualWasmPackVersion || 'an unknown version'}.`,
  );
  console.error('Install it with `cargo install wasm-pack --version 0.14.0 --locked --force`.');
  process.exit(1);
}

const result = spawnSync(
  'wasm-pack',
  [
    'build',
    rustCrate,
    '--target',
    'web',
    '--out-dir',
    outDir,
    '--out-name',
    'aeon_wasm',
    '--release',
  ],
  { stdio: 'inherit' },
);

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

rmSync(resolve(outDir, '.gitignore'), { force: true });

const wrapperManifest = JSON.parse(readFileSync(wrapperManifestPath, 'utf8'));
if (typeof wrapperManifest.version !== 'string' || wrapperManifest.version.length === 0) {
  console.error(`WASM wrapper version is missing from ${wrapperManifestPath}.`);
  process.exit(1);
}

const generatedManifest = JSON.parse(readFileSync(generatedManifestPath, 'utf8'));
generatedManifest.version = wrapperManifest.version;
writeFileSync(generatedManifestPath, `${JSON.stringify(generatedManifest, null, 2)}\n`, 'utf8');
