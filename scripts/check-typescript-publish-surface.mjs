#!/usr/bin/env node
/**
 * Purpose: enforce focused review for high-risk TypeScript publish-surface changes.
 * Run from: anywhere inside this git repo.
 * Example:
 *   node ./scripts/check-typescript-publish-surface.mjs <base-sha> <head-sha>
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

const [baseSha, headSha] = process.argv.slice(2);
if (!baseSha || !headSha) {
  console.error('Usage: node ./scripts/check-typescript-publish-surface.mjs <base-sha> <head-sha>');
  process.exit(2);
}

const highRiskFiles = new Set([
  'implementations/typescript/package.json',
  'implementations/typescript/pnpm-workspace.yaml',
  'implementations/typescript/.npmrc',
]);
const policyDocs = new Set([
  'README.md',
  'RELEASING.md',
  'VERSIONING.md',
  'docs/release-strategy.md',
]);

const firstWavePackageJsons = new Set([
  'implementations/typescript/packages/lexer/package.json',
  'implementations/typescript/packages/parser/package.json',
  'implementations/typescript/packages/aes/package.json',
  'implementations/typescript/packages/annotation-stream/package.json',
  'implementations/typescript/packages/core/package.json',
  'implementations/typescript/packages/finalize/package.json',
  'implementations/typescript/packages/canonical/package.json',
  'implementations/typescript/packages/runtime/package.json',
  'implementations/typescript/packages/aeos/package.json',
]);

const publishFields = [
  'name',
  'version',
  'private',
  'files',
  'bin',
  'exports',
  'publishConfig',
  'main',
  'module',
  'types',
  'typesVersions',
  'license',
  'engines',
];

function git(args) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trimEnd();
}

function tryGit(args) {
  try {
    return git(args);
  } catch {
    return null;
  }
}

function readPackageJsonAt(revision, relativePath) {
  const raw = tryGit(['show', `${revision}:${relativePath}`]);
  return raw ? JSON.parse(raw) : null;
}

const changedFiles = git(['diff', '--name-only', baseSha, headSha])
  .split('\n')
  .map((line) => line.trim())
  .filter(Boolean);
const hasExplicitReleasePolicyChange = changedFiles.some((file) => policyDocs.has(file));

const violations = [];

for (const file of changedFiles) {
  if (highRiskFiles.has(file)) {
    if (!hasExplicitReleasePolicyChange) {
      violations.push({
        file,
        reason: 'central TypeScript publish control file changed without a matching release-policy doc update',
      });
    }
    continue;
  }

  if (!file.startsWith('implementations/typescript/') || !file.endsWith('/package.json')) {
    continue;
  }

  if (firstWavePackageJsons.has(file)) {
    continue;
  }

  const basePkg = readPackageJsonAt(baseSha, file);
  const headPkg = readPackageJsonAt(headSha, file);
  const changedPublishFields = publishFields.filter((field) => {
    const before = basePkg?.[field] ?? null;
    const after = headPkg?.[field] ?? null;
    return JSON.stringify(before) !== JSON.stringify(after);
  });

  if (changedPublishFields.length > 0) {
    violations.push({
      file,
      reason: `non-first-wave package manifest changed publish-facing fields: ${changedPublishFields.join(', ')}`,
    });
  }
}

if (violations.length > 0) {
  console.error('TypeScript publish guard rejected this change set:');
  for (const violation of violations) {
    console.error(`- ${violation.file}: ${violation.reason}`);
  }
  console.error('If this publish-surface change is intentional, handle it as an explicit release-policy change first by updating RELEASING.md, VERSIONING.md, README.md, or docs/release-strategy.md.');
  process.exit(1);
}

console.log('No blocked TypeScript publish-surface changes detected.');
