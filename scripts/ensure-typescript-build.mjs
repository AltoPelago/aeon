#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..');
const tsRoot = path.join(repoRoot, 'implementations', 'typescript');

const requiredOutputs = [
  path.join(tsRoot, 'packages', 'cli', 'dist', 'main.js'),
  path.join(tsRoot, 'packages', 'aeos', 'dist', 'bin', 'aeos-validator.js'),
  path.join(tsRoot, 'tools', 'cts-runner', 'dist', 'index.js'),
  path.join(tsRoot, 'tools', 'annotation-cts-runner', 'dist', 'index.js'),
];

const missing = requiredOutputs.filter((file) => !fs.existsSync(file));

if (missing.length > 0) {
  console.error('Missing built TypeScript artifacts in aeon.');
  console.error('Run `pnpm install` and `pnpm build` in `implementations/typescript` before running CTS or package tests.');
  for (const file of missing) {
    console.error(`- ${path.relative(repoRoot, file)}`);
  }
  process.exit(1);
}
