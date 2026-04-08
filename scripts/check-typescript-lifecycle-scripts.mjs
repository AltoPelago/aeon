#!/usr/bin/env node
/**
 * Purpose: fail if TypeScript workspace packages define npm lifecycle scripts with install-time execution risk.
 * Run from: anywhere inside this git repo.
 * Example:
 *   node ./scripts/check-typescript-lifecycle-scripts.mjs
 */

import fs from 'node:fs';
import path from 'node:path';

const guardedScripts = new Set([
  'preinstall',
  'install',
  'postinstall',
  'prepublish',
  'prepublishOnly',
  'prepare',
]);
const allowedScriptsByPackage = new Map([
  [
    path.join('implementations', 'typescript', 'tools', 'annotation-cts-runner', 'package.json'),
    new Set(['prepare', 'prepublishOnly']),
  ],
]);

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const tsRoot = path.join(repoRoot, 'implementations', 'typescript');

function findPackageJsonFiles(rootDir) {
  const out = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.git')) {
        continue;
      }
      const next = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(next);
      } else if (entry.isFile() && entry.name === 'package.json') {
        out.push(next);
      }
    }
  }
  return out.sort();
}

const packageFiles = findPackageJsonFiles(path.join(tsRoot, 'packages'))
  .concat(findPackageJsonFiles(path.join(tsRoot, 'tools')));

const violations = [];
for (const packageFile of packageFiles) {
  const parsed = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
  const scripts = parsed.scripts && typeof parsed.scripts === 'object' ? parsed.scripts : {};
  for (const scriptName of Object.keys(scripts)) {
    if (!guardedScripts.has(scriptName)) {
      continue;
    }
    const allowedScripts = allowedScriptsByPackage.get(path.relative(repoRoot, packageFile)) ?? new Set();
    if (!allowedScripts.has(scriptName)) {
      violations.push({
        packageFile: path.relative(repoRoot, packageFile),
        scriptName,
      });
    }
  }
}

if (violations.length > 0) {
  console.error('Unexpected TypeScript lifecycle scripts detected:');
  for (const violation of violations) {
    console.error(`- ${violation.packageFile}: scripts.${violation.scriptName}`);
  }
  console.error('Additions must be explicitly reviewed and allowlisted in scripts/check-typescript-lifecycle-scripts.mjs.');
  process.exit(1);
}

console.log('No unexpected TypeScript lifecycle scripts detected.');
