#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const phaseFuzzDir = path.resolve(here, '../../../implementations/typescript/tools/phase-fuzz');
const distEntry = path.join(phaseFuzzDir, 'dist/index.js');
const args = process.argv.slice(2);

const build = spawnSync('pnpm', ['build'], {
    cwd: phaseFuzzDir,
    stdio: 'inherit',
});

if ((build.status ?? 1) !== 0) {
    process.exit(build.status ?? 1);
}

const run = spawnSync('node', [distEntry, '--lane', 'incremental', '--profile', 'ci', '--seed', '1337', ...args], {
    cwd: phaseFuzzDir,
    stdio: 'inherit',
});

process.exit(run.status ?? 1);

