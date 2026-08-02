#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { getAeoniteCtsRoot, getRepoRoot } from './repo-paths.mjs';

const root = getRepoRoot();
const ctsRoot = resolve(readArg('--cts-root') ?? getAeoniteCtsRoot());
const claimsPath = resolve(readArg('--claims') ?? resolve(root, 'conformance', 'cts-claims.json'));

const errors = [];

if (!existsSync(claimsPath)) {
  fail(`claims file does not exist: ${claimsPath}`);
}
if (!existsSync(ctsRoot)) {
  fail(`CTS root does not exist: ${ctsRoot}`);
}

const claimsDocument = readJson(claimsPath, 'claims file');
const snapshotIds = readCtsSnapshotIds(ctsRoot);
const claims = collectClaims(claimsDocument);

if (claimsDocument.claim_format !== 'aeonite.cts-claims.v1') {
  errors.push(`claim_format must be "aeonite.cts-claims.v1"`);
}
if (typeof claimsDocument.cts_protocol !== 'string' || claimsDocument.cts_protocol.length === 0) {
  errors.push('cts_protocol must be a non-empty string');
}

claims.forEach((claim, index) => validateClaim(claim, index, snapshotIds, errors));

if (errors.length > 0) {
  console.error(`CTS claim validation failed: ${errors.length} issue(s)`);
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`CTS claim validation passed: claims=${claims.length} cts_snapshots=${snapshotIds.size}`);

function readArg(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  return process.argv[index + 1] ?? null;
}

function readJson(file, label) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    fail(`invalid JSON in ${label}: ${file}: ${error.message}`);
  }
}

function collectClaims(document) {
  if (Array.isArray(document.claims)) return document.claims;
  if (!Array.isArray(document.claim_sets)) {
    errors.push('claims document must contain claims or claim_sets');
    return [];
  }
  return document.claim_sets.flatMap((claimSet, claimSetIndex) => {
    if (!claimSet || typeof claimSet !== 'object') {
      errors.push(`claim_sets[${claimSetIndex}] must be an object`);
      return [];
    }
    if (typeof claimSet.implementation !== 'string' || claimSet.implementation.length === 0) {
      errors.push(`claim_sets[${claimSetIndex}].implementation must be a non-empty string`);
    }
    if (!Array.isArray(claimSet.claims)) {
      errors.push(`claim_sets[${claimSetIndex}].claims must be a list`);
      return [];
    }
    return claimSet.claims.map((claim) => ({ ...claim, __claimSetIndex: claimSetIndex }));
  });
}

function validateClaim(claim, index, knownSnapshotIds, output) {
  if (!claim || typeof claim !== 'object') {
    output.push(`claims[${index}] must be an object`);
    return;
  }
  if (typeof claim.surface !== 'string' || claim.surface.length === 0) {
    output.push(`claims[${index}].surface must be a non-empty string`);
  }
  if (typeof claim.snapshot_id !== 'string' || claim.snapshot_id.length === 0) {
    output.push(`claims[${index}].snapshot_id must be a non-empty string`);
  } else if (!knownSnapshotIds.has(claim.snapshot_id)) {
    output.push(`claims[${index}].snapshot_id is not present in CTS manifests: ${claim.snapshot_id}`);
  }
  if (!['claimed', 'experimental', 'advisory'].includes(claim.status)) {
    output.push(`claims[${index}].status must be one of claimed, experimental, advisory`);
  }
  if (claim.command !== undefined && (typeof claim.command !== 'string' || claim.command.length === 0)) {
    output.push(`claims[${index}].command must be a non-empty string when present`);
  }
}

function readCtsSnapshotIds(rootDir) {
  const ids = new Set();
  for (const file of walkJsonFiles(rootDir)) {
    const manifest = readJson(file, 'CTS manifest');
    if (Array.isArray(manifest.suites) && typeof manifest.meta?.snapshot_id === 'string') {
      ids.add(manifest.meta.snapshot_id);
    }
  }
  return ids;
}

function walkJsonFiles(dir) {
  const output = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) output.push(...walkJsonFiles(fullPath));
    else if (entry.isFile() && entry.name.endsWith('.json')) output.push(fullPath);
  }
  return output;
}

function fail(message) {
  console.error(`CTS claim validation failed: ${message}`);
  process.exit(1);
}
