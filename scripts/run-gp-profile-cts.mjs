#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { getAeoniteSpecsRoot, getRepoRoot, resolveCTSPath } from './repo-paths.mjs';

const root = getRepoRoot();
const manifestPath = resolveCTSPath('cts/profile/v1/gp-profile-cts.v1.next.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const profile = manifest.meta.profile;
assert.equal(manifest.meta.lane, 'profile');
assert.equal(manifest.meta.sut_protocol, 'cts.protocol.v1');
assert.equal(profile, 'aeon.gp.profile.v1');

const { compile, createProfile, loadProfileContract } = await import('../implementations/typescript/packages/profiles/dist/index.js');
const { formatPath } = await import('../implementations/typescript/packages/aes/dist/index.js');
const { tokenize, TokenType } = await import('../implementations/typescript/packages/lexer/dist/index.js');
const { loadAeonWasm } = await import('../implementations/typescript/packages/wasm/dist/index.js');
const wasm = await loadAeonWasm(readFileSync(join(root, 'implementations/typescript/packages/wasm/pkg/aeon_wasm_bg.wasm')));

const contractsRoot = join(getAeoniteSpecsRoot(), 'resources/contracts/v1');
const registry = JSON.parse(readFileSync(join(contractsRoot, 'registry.json'), 'utf8'));
const entry = registry.contracts.find(item => item.kind === 'profile' && item.id === profile);
assert.ok(entry, `Missing official ${profile} contract`);
assert.equal(entry.status, 'active');
assert.equal(entry.path, `profiles/${profile}.aeon`);
const profileSource = readFileSync(join(contractsRoot, entry.path));
assert.equal(createHash('sha256').update(profileSource).digest('hex'), entry.sha256, `${profile} artifact hash`);
const policy = loadProfileContract(profileSource.toString('utf8'));
assert.equal(policy.id, profile);
assert.equal(policy.version, entry.version);
const loadedProfile = createProfile(policy);

function runTypeScript(source, mode, profile) {
  const result = compile(source, {
    profile,
    effectiveMode: mode,
    datatypePolicy: mode === 'strict' ? 'reserved_only' : 'allow_custom',
  });
  return {
    errors: result.meta?.errors ?? [],
    warnings: result.meta?.warnings ?? [],
    bindings: result.aes.filter(event => event.sourcePlane !== 'header')
      .map(event => ({ path: formatPath(event.path), datatype: event.datatype ?? null, kind: 'binding' })),
  };
}

const runtimes = {
  TypeScript: (source, mode) => runTypeScript(source, mode, profile),
  'TypeScript (official artifact)': (source, mode) => runTypeScript(source, mode, loadedProfile),
  WASM(source, mode) {
    // The WASM API selects GP from the header. The manifest supplies this
    // trusted selection and suite sources supply only document bodies.
    const result = wasm.processAeon(`aeon:mode = "${mode}"\naeon:profile = "${profile}"\n${source}`, {
      validationMode: 'declared',
      finalize: false,
    });
    return {
      errors: result.errors,
      warnings: result.warnings,
      bindings: result.events.map(event => ({ path: event.path, datatype: event.datatype ?? null, kind: 'binding' })),
    };
  },
};

const openingTokens = new Set([TokenType.LeftBrace, TokenType.LeftBracket, TokenType.LeftParen, TokenType.LeftAngle]);
const closingTokens = new Set([TokenType.RightBrace, TokenType.RightBracket, TokenType.RightParen, TokenType.RightAngle]);
const runnerHeaderFields = new Set(['header', 'mode', 'profile']);

function hasAuthoredRunnerHeader(source) {
  const { tokens } = tokenize(source);
  let depth = 0;
  for (const [index, token] of tokens.entries()) {
    if (openingTokens.has(token.type)) depth += 1;
    if (closingTokens.has(token.type)) depth = Math.max(0, depth - 1);
    if (depth !== 0 || token.type !== TokenType.Identifier || token.value !== 'aeon') continue;
    const colon = tokens[index + 1];
    const field = tokens[index + 2];
    const equals = tokens[index + 3];
    if (colon?.type === TokenType.Colon && field?.type === TokenType.Identifier
      && runnerHeaderFields.has(field.value) && equals?.type === TokenType.Equals) return true;
  }
  return false;
}

let passed = 0;
let failed = 0;
for (const selection of manifest.suites) {
  const suite = JSON.parse(readFileSync(join(dirname(manifestPath), selection.file), 'utf8'));
  const excluded = new Set(selection.exclude_tests ?? []);
  for (const vector of suite.tests) {
    if (excluded.has(vector.id)) continue;
    const { source, mode = 'transport' } = vector.input;
    assert.equal(hasAuthoredRunnerHeader(source), false, `${vector.id} supplies a header owned by the runner`);
    for (const [name, run] of Object.entries(runtimes)) {
      const label = `${name} ${vector.id}`;
      try {
        const result = run(source, mode);
        const diagnostics = entries => entries.map(({ code, path }) => ({ code, path }));
        assert.equal(result.errors.length === 0, vector.expected.ok);
        assert.deepEqual(diagnostics(result.errors), vector.expected.errors);
        assert.deepEqual(diagnostics(result.warnings), vector.expected.warnings);
        if (vector.expected.result.bindings) {
          assert.deepEqual(result.bindings, vector.expected.result.bindings);
        }
        passed += 1;
      } catch (error) {
        console.error(`${label}: ${error.message}`);
        failed += 1;
      }
    }
  }
}
console.log(`GP profile CTS (${manifest.meta.snapshot_id}): pass=${passed} fail=${failed}`);
process.exitCode = failed ? 1 : 0;
