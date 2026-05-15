#!/usr/bin/env node
/**
 * Purpose: ensure TypeScript dependency graph changes are accompanied by a pnpm lockfile update.
 * Run from: anywhere inside this git repo.
 * Example: node ./scripts/check-typescript-lockfile.mjs <base-sha> <head-sha>
 */

import { execFileSync } from 'node:child_process';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const [baseSha, headSha] = process.argv.slice(2);

if (!baseSha || !headSha) {
  console.error('Usage: node ./scripts/check-typescript-lockfile.mjs <base-sha> <head-sha>');
  process.exit(2);
}

const lockfilePath = 'implementations/typescript/pnpm-lock.yaml';
const dependencyFields = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
  'packageManager',
  'pnpm',
  'resolutions',
  'overrides',
];

function git(args) {
  return execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trimEnd();
}

function tryGit(args) {
  try {
    return git(args);
  } catch {
    return null;
  }
}

function changedFiles(pathspecs) {
  const output = git(['diff', '--name-only', baseSha, headSha, '--', ...pathspecs]);
  return output.split('\n').map((line) => line.trim()).filter(Boolean);
}

function readPackageJsonAt(revision, relativePath) {
  const raw = tryGit(['show', `${revision}:${relativePath}`]);
  return raw ? JSON.parse(raw) : null;
}

function dependencySurfaceChanged(relativePath) {
  const before = readPackageJsonAt(baseSha, relativePath);
  const after = readPackageJsonAt(headSha, relativePath);

  if (!before || !after) {
    return true;
  }

  return dependencyFields.some((field) => {
    const beforeValue = before[field] ?? null;
    const afterValue = after[field] ?? null;
    return JSON.stringify(beforeValue) !== JSON.stringify(afterValue);
  });
}

const manifestChanges = changedFiles([
  'implementations/typescript/package.json',
  'implementations/typescript/pnpm-workspace.yaml',
  'implementations/typescript/packages/**/package.json',
  'implementations/typescript/tools/**/package.json',
]);

const requiresLockfile = manifestChanges.some((file) => {
  if (file === 'implementations/typescript/pnpm-workspace.yaml') {
    return true;
  }
  if (file.endsWith('/package.json')) {
    return dependencySurfaceChanged(file);
  }
  return false;
});

if (!requiresLockfile) {
  echo('No TypeScript dependency-surface changes detected.');
  process.exit(0);
}

if (changedFiles([lockfilePath]).length > 0) {
  echo('TypeScript lockfile updated alongside dependency-surface changes.');
  process.exit(0);
}

console.error(`TypeScript dependency surface changed without a matching pnpm lockfile update.
Please run \`pnpm install\` or \`pnpm update\` in \`implementations/typescript\` and commit the resulting
\`${lockfilePath}\` changes.`);
process.exit(1);

function echo(message) {
  console.log(message);
}
