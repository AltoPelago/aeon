#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { resolveCTSPath } from './repo-paths.mjs';

function parseArgs(argv) {
  const out = { sut: '', cts: '', lane: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--sut' && i + 1 < argv.length) out.sut = argv[++i];
    else if (a === '--cts' && i + 1 < argv.length) out.cts = argv[++i];
    else if (a === '--lane' && i + 1 < argv.length) out.lane = argv[++i];
  }
  return out;
}

function fail(msg) {
  console.error(`ERROR: ${msg}`);
  process.exit(3);
}

function normalizeSpan(span) {
  if (!span || typeof span !== 'object') return null;
  const start = span.start?.offset;
  const end = span.end?.offset;
  if (typeof start !== 'number' || typeof end !== 'number') return null;
  return [start, end];
}

function normalizeDiagnostics(errors) {
  if (!Array.isArray(errors)) return [];
  return errors.map((e) => ({
    code: String(e?.code ?? ''),
    path: e?.path == null ? null : normalizePath(String(e.path)),
    phase: e?.phase ?? e?.phaseLabel ?? null,
    span: normalizeSpan(e?.span),
  }));
}

function normalizeFinalizeDiagnostics(meta, key) {
  const entries = meta && typeof meta === 'object' ? meta[key] : null;
  if (!Array.isArray(entries)) return [];
  return entries.map((e) => ({
    code: String(e?.code ?? ''),
    path: e?.path == null ? null : normalizePath(String(e.path)),
    phase: e?.phase ?? e?.phaseLabel ?? null,
    span: normalizeSpan(e?.span),
    message: typeof e?.message === 'string' ? e.message : '',
  }));
}

function normalizeCoreBindings(events) {
  if (!Array.isArray(events)) return [];
  return events.map((e) => ({
    path: normalizePath(String(e?.path ?? '')),
    datatype: typeof e?.datatype === 'string' ? e.datatype : null,
    kind: 'binding',
  }));
}

function normalizeAesEvents(events) {
  if (!Array.isArray(events)) return [];
  return events.map((e) => ({
    path: normalizePath(String(e?.path ?? '')),
    datatype: typeof e?.datatype === 'string' ? e.datatype : null,
    value_kind: typeof e?.value?.type === 'string' ? e.value.type : null,
    reference:
      e?.value?.type === 'CloneReference' || e?.value?.type === 'PointerReference'
        ? (typeof e.value.path === 'string' ? normalizePath(e.value.path) : (e.value.path ?? null))
        : null,
  }));
}

function normalizePath(value) {
  let normalized = value.trim();
  normalized = normalized.replace(/\$\.\[/g, '$[');
  normalized = normalized.replace(/\[\$"([^"\\]*(?:\\.[^"\\]*)*)"\]/g, '["$1"]');
  normalized = normalized.replace(/\$\["([^"\\]*(?:\\.[^"\\]*)*)"\]/g, (_m, key) => {
    return isIdentifier(key) ? `$.${key}` : `$["${key}"]`;
  });
  normalized = normalized.replace(/\.\["([^"\\]*(?:\\.[^"\\]*)*)"\]/g, (_m, key) => {
    return isIdentifier(key) ? `.${key}` : `.["${key}"]`;
  });
  normalized = normalized.replace(/\[(\d+)\]/g, (_m, digits) => `[${String(Number(digits))}]`);
  return normalized;
}

function isIdentifier(value) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

function compareExpectedDiagnostics(expected, actual) {
  const failures = [];
  const used = new Set();
  for (const exp of expected ?? []) {
    const idx = actual.findIndex((a, i) => {
      if (used.has(i)) return false;
      if (String(a.code) !== String(exp.code)) return false;
      if ('path' in exp) {
        if ((a.path ?? null) !== (exp.path == null ? null : normalizePath(String(exp.path)))) return false;
      }
      if ('phase' in exp && exp.phase != null && (a.phase ?? null) !== exp.phase) return false;
      if ('phaseLabel' in exp && exp.phaseLabel != null && (a.phase ?? null) !== exp.phaseLabel) return false;
      return true;
    });
    if (idx < 0) {
      failures.push(`Missing expected diagnostic ${String(exp.code)} at ${String(exp.path)}`);
      continue;
    }
    used.add(idx);
    if (exp.span) {
      const got = actual[idx]?.span ?? null;
      if (!got || got[0] !== exp.span[0] || got[1] !== exp.span[1]) {
        failures.push(`Span mismatch for ${String(exp.code)} at ${String(exp.path)}`);
      }
    }
  }
  return failures;
}

function compareExpectedArray(expected, actual, label) {
  const failures = [];
  if (!Array.isArray(expected)) return failures;
  if (actual.length !== expected.length) {
    failures.push(`${label} length mismatch: expected ${expected.length}, got ${actual.length}`);
    return failures;
  }
  for (let i = 0; i < expected.length; i += 1) {
    const exp = expected[i];
    const got = actual[i];
    for (const k of Object.keys(exp)) {
      const ev = (k === 'path' || k === 'reference') && typeof exp[k] === 'string'
        ? normalizePath(exp[k])
        : exp[k];
      const gv = (k === 'path' || k === 'reference') && typeof got?.[k] === 'string'
        ? normalizePath(got[k])
        : got?.[k];
      if (JSON.stringify(ev) !== JSON.stringify(gv)) {
        failures.push(`${label}[${i}].${k} mismatch: expected ${JSON.stringify(ev)}, got ${JSON.stringify(gv)}`);
      }
    }
  }
  return failures;
}

function normalizePathsDeep(value, keyHint = null) {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizePathsDeep(entry, keyHint));
  }
  if (!value || typeof value !== 'object') {
    if ((keyHint === 'path' || keyHint === 'reference') && typeof value === 'string') {
      return normalizePath(value);
    }
    return value;
  }
  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    out[key] = normalizePathsDeep(entry, key);
  }
  return out;
}

function compareExpectedSubset(expected, actual, label) {
  const failures = [];

  function visit(exp, got, pathLabel) {
    if (Array.isArray(exp)) {
      if (!Array.isArray(got)) {
        failures.push(`${pathLabel} mismatch: expected array, got ${JSON.stringify(got)}`);
        return;
      }
      if (got.length !== exp.length) {
        failures.push(`${pathLabel} length mismatch: expected ${exp.length}, got ${got.length}`);
        return;
      }
      for (let i = 0; i < exp.length; i += 1) {
        visit(exp[i], got[i], `${pathLabel}[${i}]`);
      }
      return;
    }
    if (exp && typeof exp === 'object') {
      if (!got || typeof got !== 'object' || Array.isArray(got)) {
        failures.push(`${pathLabel} mismatch: expected object, got ${JSON.stringify(got)}`);
        return;
      }
      for (const key of Object.keys(exp)) {
        visit(exp[key], got[key], `${pathLabel}.${key}`);
      }
      return;
    }
    const normalizedExp = normalizePathsDeep(exp, pathLabel.split('.').at(-1) ?? null);
    const normalizedGot = normalizePathsDeep(got, pathLabel.split('.').at(-1) ?? null);
    if (JSON.stringify(normalizedExp) !== JSON.stringify(normalizedGot)) {
      failures.push(`${pathLabel} mismatch: expected ${JSON.stringify(normalizedExp)}, got ${JSON.stringify(normalizedGot)}`);
    }
  }

  visit(expected, actual, label);
  return failures;
}

async function runInspect({ sutPath, source, mode, datatypePolicy, rich, maxAttributeDepth, maxSeparatorDepth, maxGenericDepth }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-cts-source-'));
  const file = path.join(dir, 'input.aeon');
  fs.writeFileSync(file, source, 'utf8');

  const isJs = sutPath.endsWith('.js') || sutPath.endsWith('.mjs') || sutPath.endsWith('.cjs');
  const command = isJs ? process.execPath : sutPath;
  const args = isJs ? [sutPath, 'inspect', file, '--json'] : ['inspect', file, '--json'];
  if (mode === 'transport') args.push('--loose');
  else args.push('--strict');
  if (rich) args.push('--rich');
  if (datatypePolicy) args.push('--datatype-policy', datatypePolicy);
  if (Number.isInteger(maxAttributeDepth)) args.push('--max-attribute-depth', String(maxAttributeDepth));
  if (Number.isInteger(maxSeparatorDepth)) args.push('--max-separator-depth', String(maxSeparatorDepth));
  if (Number.isInteger(maxGenericDepth)) args.push('--max-generic-depth', String(maxGenericDepth));

  const { stdout, stderr, code } = await spawnCaptured(command, args, { trimStdout: true });

  fs.rmSync(dir, { recursive: true, force: true });

  try {
    return { ok: true, parse: JSON.parse(stdout), stderr, code };
  } catch {
    if (code !== 0) {
      return { ok: false, parse: null, stderr: `${stderr}\nSUT exited ${code} without valid JSON envelope`, code };
    }
    return { ok: false, parse: null, stderr: `${stderr}\nInvalid JSON: ${stdout}`, code };
  }
}

async function runFinalize({ sutPath, source, mode, datatypePolicy, scope, materialization, includePaths, outputMode }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-cts-finalize-'));
  const file = path.join(dir, 'input.aeon');
  fs.writeFileSync(file, source, 'utf8');

  const isJs = sutPath.endsWith('.js') || sutPath.endsWith('.mjs') || sutPath.endsWith('.cjs');
  const command = isJs ? process.execPath : sutPath;
  const formatFlag = outputMode === 'map' ? '--map' : '--json';
  const args = isJs ? [sutPath, 'finalize', file, formatFlag] : ['finalize', file, formatFlag];
  args.push(mode === 'transport' ? '--loose' : '--strict');
  if (datatypePolicy) args.push('--datatype-policy', datatypePolicy);
  if (scope) args.push('--scope', scope);
  if (materialization === 'projected') {
    args.push('--projected');
    for (const includePath of includePaths ?? []) {
      args.push('--include-path', includePath);
    }
  }

  const { stdout, stderr, code } = await spawnCaptured(command, args, { trimStdout: true });

  fs.rmSync(dir, { recursive: true, force: true });

  try {
    return { ok: true, parse: JSON.parse(stdout), stderr, code };
  } catch {
    if (code !== 0) {
      return { ok: false, parse: null, stderr: `${stderr}\nSUT exited ${code} without valid JSON envelope`, code };
    }
    return { ok: false, parse: null, stderr: `${stderr}\nInvalid JSON: ${stdout}`, code };
  }
}

async function runFmt({ sutPath, source }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-cts-fmt-'));
  const file = path.join(dir, 'input.aeon');
  fs.writeFileSync(file, source, 'utf8');

  const isJs = sutPath.endsWith('.js') || sutPath.endsWith('.mjs') || sutPath.endsWith('.cjs');
  const command = isJs ? process.execPath : sutPath;
  const args = isJs ? [sutPath, 'fmt', file] : ['fmt', file];

  const { stdout, stderr, code } = await spawnCaptured(command, args);

  fs.rmSync(dir, { recursive: true, force: true });

  const errors = code === 0
    ? []
    : stdout
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const match = /^(.*?)(?:\s+\[([A-Z0-9_]+)\])(?:\s+path=(\S+))?(?:\s+span=(\S+))?$/u.exec(line);
          return {
            code: match?.[2] ?? '',
            message: match?.[1]?.trim() ?? line,
            path: match?.[3] ?? '$',
            span: parseCliSpan(source, match?.[4]),
          };
        });

  return { ok: true, stdout, stderr, errors };
}

async function spawnCaptured(command, args, options = {}) {
  const { trimStdout = false } = options;
  return await new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    const err = [];
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    child.stdout.on('data', (d) => out.push(Buffer.from(d)));
    child.stderr.on('data', (d) => err.push(Buffer.from(d)));
    child.on('error', (error) => {
      finish({
        code: -1,
        stdout: '',
        stderr: `Failed to spawn SUT: ${error.message}`,
      });
    });
    child.on('close', (code) => {
      const stdout = Buffer.concat(out).toString('utf8');
      finish({
        code,
        stdout: trimStdout ? stdout.trim() : stdout,
        stderr: Buffer.concat(err).toString('utf8'),
      });
    });
  });
}

function normalizeGenericDiagnostics(stderr) {
  const text = String(stderr ?? '').trim();
  if (!text) return [];
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => ({ message: line }));
}

function normalizeCanonicalText(text) {
  return String(text).replace(/\r\n/g, '\n').trimEnd();
}

function parseCliSpan(source, encodedSpan) {
  if (typeof encodedSpan !== 'string' || encodedSpan === '?:?-?:?') return null;
  const match = /^(\d+):(\d+)-(\d+):(\d+)$/u.exec(encodedSpan);
  if (!match) return null;

  const startLine = Number(match[1]);
  const startColumn = Number(match[2]);
  const endLine = Number(match[3]);
  const endColumn = Number(match[4]);
  const normalizedSource = String(source).replace(/\r\n/g, '\n');
  const lineStarts = [0];

  for (let i = 0; i < normalizedSource.length; i += 1) {
    if (normalizedSource[i] === '\n') {
      lineStarts.push(i + 1);
    }
  }

  function toOffset(line, column) {
    if (!Number.isInteger(line) || !Number.isInteger(column) || line < 1 || column < 1) return null;
    const lineStart = lineStarts[line - 1];
    if (lineStart == null) return null;
    return lineStart + column - 1;
  }

  const start = toOffset(startLine, startColumn);
  const end = toOffset(endLine, endColumn);
  if (start == null || end == null) return null;
  return [start, end];
}

function loadManifest(ctsPath) {
  const full = path.resolve(process.cwd(), ctsPath);
  const manifest = JSON.parse(fs.readFileSync(full, 'utf8'));
  if (manifest?.meta?.sut_protocol !== 'cts.protocol.v1') {
    fail(`Manifest ${full} missing sut_protocol=cts.protocol.v1`);
  }
  return { full, manifest };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.sut || !args.cts || !args.lane) {
    fail('Usage: node scripts/cts-source-lane-runner.mjs --sut <path> --cts <manifest> --lane <core|aes|canonical|finalize-json|finalize-map|inspect-json>');
  }
  if (args.lane !== 'core' && args.lane !== 'aes' && args.lane !== 'canonical' && args.lane !== 'finalize-json' && args.lane !== 'finalize-map' && args.lane !== 'inspect-json') {
    fail(`Unsupported lane: ${args.lane}`);
  }

  const ctsPath = resolveCTSPath(args.cts, process.cwd());
  const { full: manifestPath, manifest } = loadManifest(ctsPath);
  let pass = 0;
  let failCount = 0;
  console.log(`Running ${args.lane.toUpperCase()} CTS (protocol=${manifest.meta.sut_protocol}) against SUT: ${args.sut}`);

  for (const suiteRef of manifest.suites ?? []) {
    const suitePath = path.resolve(path.dirname(manifestPath), suiteRef.file);
    const suite = JSON.parse(fs.readFileSync(suitePath, 'utf8'));
    console.log(`\n--- Suite: ${suite.title} ---`);
    for (const test of suite.tests ?? []) {
      const source = String(test.input?.source ?? '');
      const mode = String(test.input?.mode ?? 'strict');
      const datatypePolicy = test.input?.options?.datatype_policy;
      const rich = Boolean(test.input?.options?.rich);
      const maxAttributeDepth = Number.isInteger(test.input?.options?.max_attribute_depth) ? test.input.options.max_attribute_depth : undefined;
      const maxSeparatorDepth = Number.isInteger(test.input?.options?.max_separator_depth) ? test.input.options.max_separator_depth : undefined;
      const maxGenericDepth = Number.isInteger(test.input?.options?.max_generic_depth) ? test.input.options.max_generic_depth : undefined;
      let errors = [];
      let warnings = [];
      let ok = false;
      let result;

      if (args.lane === 'canonical') {
        const formatted = await runFmt({ sutPath: args.sut, source });
        if (!formatted.ok) {
          console.error(`❌ ${test.id}: harness failure`);
          if (formatted.stderr) console.error(formatted.stderr.trim());
          process.exit(3);
        }

        errors = formatted.errors;
        warnings = [];
        ok = errors.length === 0;
        result = {
          canonical_text: ok ? normalizeCanonicalText(formatted.stdout) : '',
        };
      } else if (args.lane === 'finalize-json' || args.lane === 'finalize-map') {
        const finalized = await runFinalize({
          sutPath: args.sut,
          source,
          mode,
          datatypePolicy: typeof datatypePolicy === 'string' ? datatypePolicy : undefined,
          scope: typeof test.input?.options?.scope === 'string' ? test.input.options.scope : 'payload',
          materialization: typeof test.input?.options?.materialization === 'string' ? test.input.options.materialization : 'all',
          includePaths: Array.isArray(test.input?.options?.include_paths) ? test.input.options.include_paths : [],
          outputMode: args.lane === 'finalize-map' ? 'map' : 'json',
        });
        if (!finalized.ok || !finalized.parse) {
          console.error(`❌ ${test.id}: harness failure`);
          if (finalized.stderr) console.error(finalized.stderr.trim());
          process.exit(3);
        }

        errors = normalizeFinalizeDiagnostics(finalized.parse.meta, 'errors');
        warnings = normalizeFinalizeDiagnostics(finalized.parse.meta, 'warnings');
        ok = errors.length === 0;
        result = args.lane === 'finalize-map'
          ? { entries: finalized.parse.document?.entries ?? [] }
          : { document: finalized.parse.document ?? null };
      } else if (args.lane === 'inspect-json') {
        const inspect = await runInspect({
          sutPath: args.sut,
          source,
          mode,
          datatypePolicy: typeof datatypePolicy === 'string' ? datatypePolicy : undefined,
          rich,
          maxAttributeDepth,
          maxSeparatorDepth,
          maxGenericDepth,
        });
        if (!inspect.ok || !inspect.parse) {
          console.error(`❌ ${test.id}: harness failure`);
          if (inspect.stderr) console.error(inspect.stderr.trim());
          process.exit(3);
        }

        errors = normalizeDiagnostics(inspect.parse.errors);
        warnings = [];
        ok = errors.length === 0;
        result = {
          events: normalizePathsDeep(inspect.parse.events ?? []),
        };
      } else {
        const inspect = await runInspect({
          sutPath: args.sut,
          source,
          mode,
          datatypePolicy: typeof datatypePolicy === 'string' ? datatypePolicy : undefined,
          rich,
          maxAttributeDepth,
          maxSeparatorDepth,
          maxGenericDepth,
        });
        if (!inspect.ok || !inspect.parse) {
          console.error(`❌ ${test.id}: harness failure`);
          if (inspect.stderr) console.error(inspect.stderr.trim());
          process.exit(3);
        }

        errors = normalizeDiagnostics(inspect.parse.errors);
        warnings = [];
        ok = errors.length === 0;
        result =
          args.lane === 'core'
            ? {
                parse_ok: ok,
                bindings: ok ? normalizeCoreBindings(inspect.parse.events) : [],
              }
            : {
                events: ok ? normalizeAesEvents(inspect.parse.events) : [],
              };
      }

      const failures = [];
      if (ok !== Boolean(test.expected?.ok)) {
        failures.push(`ok mismatch: expected ${Boolean(test.expected?.ok)}, got ${ok}`);
      }
      failures.push(...compareExpectedDiagnostics(test.expected?.errors ?? [], errors));
      failures.push(...compareExpectedDiagnostics(test.expected?.warnings ?? [], warnings));

      if (args.lane === 'core') {
        if (test.expected?.result && 'parse_ok' in test.expected.result) {
          if (Boolean(test.expected.result.parse_ok) !== result.parse_ok) {
            failures.push(`result.parse_ok mismatch: expected ${Boolean(test.expected.result.parse_ok)}, got ${result.parse_ok}`);
          }
        }
        failures.push(...compareExpectedArray(test.expected?.result?.bindings, result.bindings, 'bindings'));
      } else if (args.lane === 'canonical') {
        const expectedText = test.expected?.result?.canonical_text;
        if (typeof expectedText === 'string') {
          const normalizedExpected = normalizeCanonicalText(expectedText);
          if (normalizedExpected !== result.canonical_text) {
            failures.push(`canonical_text mismatch: expected ${JSON.stringify(normalizedExpected)}, got ${JSON.stringify(result.canonical_text)}`);
          }
        }
      } else if (args.lane === 'finalize-json') {
        if ('document' in (test.expected?.result ?? {})) {
          const expectedDocument = test.expected.result.document;
          if (JSON.stringify(expectedDocument) !== JSON.stringify(result.document)) {
            failures.push(`document mismatch: expected ${JSON.stringify(expectedDocument)}, got ${JSON.stringify(result.document)}`);
          }
        }
      } else if (args.lane === 'finalize-map') {
        failures.push(...compareExpectedArray(test.expected?.result?.entries, result.entries, 'entries'));
      } else if (args.lane === 'inspect-json') {
        if ('events' in (test.expected?.result ?? {})) {
          failures.push(...compareExpectedSubset(test.expected.result.events, result.events, 'events'));
        }
      } else {
        failures.push(...compareExpectedArray(test.expected?.result?.events, result.events, 'events'));
      }

      if (failures.length > 0) {
        failCount += 1;
        console.log(`❌ ${test.id}: FAIL`);
        for (const failure of failures) console.log(`   - ${failure}`);
      } else {
        pass += 1;
        console.log(`✅ ${test.id}: PASS`);
      }
    }
  }
  console.log(`\nSummary: pass=${pass} fail=${failCount}`);
  process.exit(failCount > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(3);
});
