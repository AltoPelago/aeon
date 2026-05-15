#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rustCrate = resolve(packageRoot, '../../../rust/crates/aeon-wasm');
const outDir = resolve(packageRoot, 'pkg');

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
  console.error('Install it with `cargo install wasm-pack` or your preferred package manager.');
  process.exit(1);
}

if (wasmPack.status !== 0) {
  process.stderr.write(wasmPack.stderr);
  process.exit(wasmPack.status ?? 1);
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
