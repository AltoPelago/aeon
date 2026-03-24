#!/usr/bin/env node

import path from 'node:path';

export const AEONITE_CTS_ROOT_ENV = 'AEONITE_CTS_ROOT';
export const AEON_TOOLING_PRIVATE_ROOT_ENV = 'AEON_TOOLING_PRIVATE_ROOT';
export const AEONITE_SPECS_ROOT_ENV = 'AEONITE_SPECS_ROOT';

export function getRepoRoot() {
  return path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
}

export function getFamilyRoot() {
  return path.resolve(getRepoRoot(), '..', '..');
}

export function getAeoniteCtsRoot() {
  return process.env[AEONITE_CTS_ROOT_ENV]
    || path.resolve(getFamilyRoot(), 'aeonite-org', 'aeonite-cts', 'cts');
}

export function getAeonToolingPrivateRoot() {
  return process.env[AEON_TOOLING_PRIVATE_ROOT_ENV]
    || path.resolve(getFamilyRoot(), 'altopelago', 'aeon-tooling-private');
}

export function getAeoniteSpecsRoot() {
  return process.env[AEONITE_SPECS_ROOT_ENV]
    || path.resolve(getFamilyRoot(), 'aeonite-org', 'aeonite-specs');
}

export function withRepoPathEnv(baseEnv = process.env) {
  return {
    ...baseEnv,
    [AEONITE_CTS_ROOT_ENV]: getAeoniteCtsRoot(),
    [AEON_TOOLING_PRIVATE_ROOT_ENV]: getAeonToolingPrivateRoot(),
    [AEONITE_SPECS_ROOT_ENV]: getAeoniteSpecsRoot(),
  };
}

export function resolveCTSPath(candidate, cwd = process.cwd()) {
  if (!candidate) return getAeoniteCtsRoot();

  const resolved = path.resolve(cwd, candidate);
  const normalized = candidate.replaceAll('\\', '/');
  const marker = '/cts/';
  const idx = normalized.lastIndexOf(marker);
  if (idx === -1) return candidate;

  const remainder = normalized.slice(idx + marker.length);
  return path.resolve(getAeoniteCtsRoot(), remainder);
}
