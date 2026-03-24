#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { withRepoPathEnv } from './repo-paths.mjs';

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('Usage: node scripts/run-with-repo-paths.mjs <command> [args...]');
  process.exit(2);
}

const [command, ...commandArgs] = args;
const child = spawn(command, commandArgs, {
  stdio: 'inherit',
  env: withRepoPathEnv(),
});
child.on('close', (code) => process.exit(code ?? 1));
