#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

export const AEONITE_CTS_ROOT_ENV = 'AEONITE_CTS_ROOT';
export const AEON_TOOLING_ROOT_ENV = 'AEON_TOOLING_ROOT';
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

export function getAeonToolingRoot() {
  const publicDefault = path.resolve(getFamilyRoot(), 'altopelago', 'aeon-tooling');
  return process.env[AEON_TOOLING_ROOT_ENV]
    || process.env[AEON_TOOLING_PRIVATE_ROOT_ENV]
    || (fs.existsSync(publicDefault)
      ? publicDefault
      : path.resolve(getFamilyRoot(), 'altopelago', 'aeon-tooling-private'));
}

export function getAeonToolingPrivateRoot() {
  return getAeonToolingRoot();
}

export function getAeoniteSpecsRoot() {
  return process.env[AEONITE_SPECS_ROOT_ENV]
    || path.resolve(getFamilyRoot(), 'aeonite-org', 'aeonite-specs');
}

export function withRepoPathEnv(baseEnv = process.env) {
  return {
    ...baseEnv,
    [AEONITE_CTS_ROOT_ENV]: getAeoniteCtsRoot(),
    [AEON_TOOLING_ROOT_ENV]: getAeonToolingRoot(),
    [AEON_TOOLING_PRIVATE_ROOT_ENV]: getAeonToolingRoot(),
    [AEONITE_SPECS_ROOT_ENV]: getAeoniteSpecsRoot(),
  };
}

export function resolveCTSPath(candidate, cwd = process.cwd()) {
  if (!candidate) return getAeoniteCtsRoot();

  const resolved = path.resolve(cwd, candidate);
  const normalized = candidate.replaceAll('\\', '/');
  const parts = normalized.split('/');
  const ctsIndex = parts.lastIndexOf('cts');
  if (ctsIndex === -1) return fs.existsSync(resolved) ? candidate : candidate;

  const remainder = parts.slice(ctsIndex + 1).join('/');
  return path.resolve(getAeoniteCtsRoot(), remainder);
}
