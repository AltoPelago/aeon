#!/usr/bin/env node

import fs from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import {
  getAeonToolingPrivateRoot,
  resolveCTSPath,
  withRepoPathEnv,
} from './repo-paths.mjs';

const siblingRunner = path.resolve(
  getAeonToolingPrivateRoot(),
  'scripts',
  'cts-source-lane-runner.mjs',
);

const args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--cts' && i + 1 < args.length) {
    args[i + 1] = resolveCTSPath(args[i + 1], process.cwd());
    break;
  }
}

if (!fs.existsSync(siblingRunner)) {
  console.error(`ERROR: Missing sibling CTS lane runner at ${siblingRunner}`);
  process.exit(3);
}

const child = spawn(process.execPath, [siblingRunner, ...args], {
  stdio: 'inherit',
  env: withRepoPathEnv(),
});
child.on('close', (code) => process.exit(code ?? 1));
