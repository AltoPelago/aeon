#!/usr/bin/env node

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { getRepoRoot, resolveCTSPath } from './repo-paths.mjs';

const args = parseArgs(process.argv.slice(2));
if (!args.cts) {
  fail('Usage: node scripts/run-wasm-core-cts.mjs --cts <core manifest>');
}

const manifestPath = path.resolve(resolveCTSPath(args.cts, process.cwd()));
const manifest = readJson(manifestPath);
if (manifest?.meta?.sut_protocol !== 'cts.protocol.v1' || manifest?.meta?.lane !== 'core') {
  fail(`Manifest ${manifestPath} is not a Core cts.protocol.v1 manifest`);
}

const repoRoot = getRepoRoot();
const wasmPackageRoot = path.join(repoRoot, 'implementations/typescript/packages/wasm');
const { loadAeonWasm } = await import(pathToFileURL(path.join(wasmPackageRoot, 'dist/index.js')).href);
const wasmBytes = fs.readFileSync(path.join(wasmPackageRoot, 'pkg/aeon_wasm_bg.wasm'));
const runtime = await loadAeonWasm(wasmBytes);

let passed = 0;
let failed = 0;
let excluded = 0;

console.log(`Running generated WASM Core CTS (${manifest.meta.snapshot_id ?? manifest.meta.version})`);
for (const suiteRef of manifest.suites ?? []) {
  const suitePath = path.resolve(path.dirname(manifestPath), suiteRef.file);
  const suiteBytes = fs.readFileSync(suitePath);
  if (suiteRef.content_sha256) {
    const actualDigest = createHash('sha256').update(suiteBytes).digest('hex');
    if (actualDigest !== suiteRef.content_sha256) {
      fail(`Suite digest mismatch for ${suiteRef.file}: expected ${suiteRef.content_sha256}, got ${actualDigest}`);
    }
  }
  const suite = JSON.parse(suiteBytes.toString('utf8'));
  const excludedTests = new Set(suiteRef.exclude_tests ?? []);
  console.log(`\n--- Suite: ${suite.title} ---`);
  for (const vector of suite.tests ?? []) {
    if (excludedTests.has(vector.id)) {
      excluded += 1;
      continue;
    }
    const actual = runVector(runtime, vector);
    const failures = compareVector(vector, actual);
    if (failures.length === 0) {
      passed += 1;
      console.log(`✅ ${vector.id}: PASS`);
      continue;
    }
    failed += 1;
    console.log(`❌ ${vector.id}: FAIL`);
    for (const failure of failures) console.log(`   - ${failure}`);
    if (actual.errors.length > 0) {
      console.log(`   - actual errors: ${actual.errors.map((error) => `${error.code}@${error.path ?? '$'}`).join(', ')}`);
    }
  }
}

console.log(`\nGenerated WASM Core CTS: pass=${passed} fail=${failed} manifest-excluded=${excluded}`);
process.exitCode = failed === 0 ? 0 : 1;

function runVector(runtimeValue, vector) {
  const result = runtimeValue.processAeon(String(vector.input?.source ?? ''), {
    ...toWasmOptions(vector.input ?? {}),
    finalize: false,
  });
  return {
    ok: result.ok,
    errors: result.errors.map(normalizeDiagnostic),
    warnings: result.warnings.map(normalizeDiagnostic),
    bindings: result.ok ? normalizeBindings(result.events) : [],
  };
}

function toWasmOptions(input) {
  const sourceOptions = input.options ?? {};
  const limits = sourceOptions.limits ?? {};
  const structure = limits.structure ?? {};
  const aeonFormat = limits.formats?.aeon ?? {};
  const processing = limits.processing ?? {};
  const mode = sourceOptions.effective_mode ?? 'declared';
  const output = {
    validationMode: mode === 'transport' ? 'loose' : mode,
  };
  const datatypePolicy = sourceOptions.datatype_policy
    ?? (sourceOptions.rich === true ? 'allow_custom' : undefined);
  setDefined(output, 'datatypePolicy', datatypePolicy);
  setDefined(output, 'maxInputBytes', aeonFormat.max_input_bytes);
  setDefined(output, 'maxEvents', sourceOptions.max_events ?? processing.max_events);
  setDefined(output, 'maxAttributeDepth', sourceOptions.max_attribute_depth ?? structure.max_attribute_depth);
  setDefined(output, 'maxSeparatorDepth', sourceOptions.max_separator_depth);
  setDefined(output, 'maxClarifierValues', structure.max_clarifier_values);
  setDefined(output, 'maxGenericDepth', sourceOptions.max_generic_depth ?? structure.max_generic_depth);
  setDefined(output, 'maxGenericArguments', structure.max_generic_arguments);
  setDefined(output, 'maxDatatypeComponents', structure.max_datatype_components);
  setDefined(output, 'maxValueNestingDepth', structure.max_value_nesting_depth);
  setDefined(output, 'maxPathDepth', structure.max_path_depth);
  setDefined(output, 'maxStringCodepoints', structure.max_string_codepoints);
  setDefined(output, 'maxKeySegmentCodepoints', structure.max_key_segment_codepoints);
  setDefined(output, 'maxListItems', structure.max_list_items);
  setDefined(output, 'maxTupleItems', structure.max_tuple_items);
  setDefined(output, 'maxPathCharacters', structure.max_path_characters);
  setDefined(output, 'maxNumericLiteralCharacters', aeonFormat.max_numeric_literal_characters);
  setDefined(output, 'maxStructuredCommentCharacters', aeonFormat.max_structured_comment_characters);
  return output;
}

function setDefined(target, key, value) {
  if (Number.isInteger(value) || typeof value === 'string') target[key] = value;
}

function normalizeBindings(events) {
  const byPath = new Map(events.map((event) => [normalizePath(event.path), event]));
  return events
    .filter((event) => {
      const pathValue = normalizePath(event.path);
      const match = /^(.*)\[(\d+)\]$/u.exec(pathValue);
      return match === null || byPath.get(match[1])?.valueType !== 'NodeLiteral';
    })
    .map((event) => ({
      path: normalizePath(event.path),
      datatype: typeof event.datatype === 'string' ? normalizeDatatype(event.datatype) : null,
      kind: 'binding',
    }));
}

function normalizeDiagnostic(diagnostic) {
  return {
    code: String(diagnostic?.code ?? ''),
    path: diagnostic?.path == null ? null : normalizePath(String(diagnostic.path)),
    phase: diagnostic?.phase ?? null,
    span: diagnostic?.span == null
      ? null
      : [diagnostic.span.start.offset, diagnostic.span.end.offset],
  };
}

function compareVector(vector, actual) {
  const failures = [];
  const expected = vector.expected ?? {};
  if (actual.ok !== Boolean(expected.ok)) {
    failures.push(`ok mismatch: expected ${Boolean(expected.ok)}, got ${actual.ok}`);
  }
  failures.push(...compareDiagnostics(expected.errors ?? [], actual.errors));
  failures.push(...compareDiagnostics(expected.warnings ?? [], actual.warnings));
  if (vector.assert?.no_extra_errors === true
      && actual.errors.length > (expected.errors ?? []).length) {
    failures.push(`unexpected extra errors: got ${actual.errors.length}, expected ${(expected.errors ?? []).length}`);
  }
  if ('parse_ok' in (expected.result ?? {})
      && actual.ok !== Boolean(expected.result.parse_ok)) {
    failures.push(`result.parse_ok mismatch: expected ${Boolean(expected.result.parse_ok)}, got ${actual.ok}`);
  }
  if (Array.isArray(expected.result?.bindings)) {
    failures.push(...compareArray(expected.result.bindings, actual.bindings, 'bindings'));
  }
  return failures;
}

function compareDiagnostics(expected, actual) {
  const failures = [];
  const used = new Set();
  for (const wanted of expected) {
    const index = actual.findIndex((candidate, candidateIndex) => {
      if (used.has(candidateIndex) || candidate.code !== String(wanted.code)) return false;
      if ('path' in wanted
          && (candidate.path ?? null) !== (wanted.path == null ? null : normalizePath(String(wanted.path)))) {
        return false;
      }
      if (wanted.phase != null && candidate.phase !== wanted.phase) return false;
      return true;
    });
    if (index < 0) {
      failures.push(`missing diagnostic ${String(wanted.code)} at ${String(wanted.path ?? '$')}`);
      continue;
    }
    used.add(index);
    if (Array.isArray(wanted.span)
        && JSON.stringify(actual[index].span) !== JSON.stringify(wanted.span)) {
      failures.push(`span mismatch for ${String(wanted.code)} at ${String(wanted.path ?? '$')}`);
    }
  }
  return failures;
}

function compareArray(expected, actual, label) {
  if (expected.length !== actual.length) {
    return [`${label} length mismatch: expected ${expected.length}, got ${actual.length}`];
  }
  const failures = [];
  for (let index = 0; index < expected.length; index += 1) {
    for (const [key, expectedValue] of Object.entries(expected[index])) {
      const actualValue = actual[index]?.[key];
      const wanted = key === 'path' && typeof expectedValue === 'string'
        ? normalizePath(expectedValue)
        : key === 'datatype' && typeof expectedValue === 'string'
          ? normalizeDatatype(expectedValue)
          : expectedValue;
      const got = key === 'path' && typeof actualValue === 'string'
        ? normalizePath(actualValue)
        : key === 'datatype' && typeof actualValue === 'string'
          ? normalizeDatatype(actualValue)
          : actualValue;
      if (JSON.stringify(wanted) !== JSON.stringify(got)) {
        failures.push(`${label}[${index}].${key} mismatch: expected ${JSON.stringify(wanted)}, got ${JSON.stringify(got)}`);
      }
    }
  }
  return failures;
}

function normalizePath(value) {
  let normalized = String(value).trim().replaceAll('$.[', '$[');
  normalized = normalized.replace(/\[\$"([^"\\]*(?:\\.[^"\\]*)*)"\]/gu, (_match, key) => `["${key}"]`);
  normalized = normalized.replace(/\$\["([^"\\]*(?:\\.[^"\\]*)*)"\]/gu, (_match, key) => {
    const decoded = decodeKey(key);
    return isIdentifier(decoded) ? `$.${decoded}` : `$[${JSON.stringify(decoded)}]`;
  });
  normalized = normalized.replace(/\.\["([^"\\]*(?:\\.[^"\\]*)*)"\]/gu, (_match, key) => {
    const decoded = decodeKey(key);
    return isIdentifier(decoded) ? `.${decoded}` : `.[${JSON.stringify(decoded)}]`;
  });
  return normalized.replace(/\[(\d+)\]/gu, (_match, digits) => `[${String(Number(digits))}]`);
}

function decodeKey(value) {
  try {
    return JSON.parse(`"${value}"`);
  } catch {
    return value;
  }
}

function isIdentifier(value) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/u.test(value);
}

function normalizeDatatype(value) {
  return String(value).replace(/\s+/gu, '');
}

function parseArgs(argv) {
  const output = { cts: '' };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--cts' && index + 1 < argv.length) output.cts = argv[++index];
  }
  return output;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exit(3);
}
