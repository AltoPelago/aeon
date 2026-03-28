#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { resolveCTSPath, withRepoPathEnv } from './repo-paths.mjs';

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('Usage: node scripts/run-with-repo-paths.mjs <command> [args...]');
  process.exit(2);
}

const [command, ...commandArgs] = args;
for (let i = 0; i < commandArgs.length; i += 1) {
  if (commandArgs[i] === '--cts' && i + 1 < commandArgs.length) {
    commandArgs[i + 1] = resolveCTSPath(commandArgs[i + 1], process.cwd());
    break;
  }
}
const child = spawn(command, commandArgs, {
  stdio: 'inherit',
  env: withRepoPathEnv(),
});
child.on('close', (code) => process.exit(code ?? 1));
