import { performance } from 'node:perf_hooks';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tokenize } from '../../../../implementations/typescript/packages/lexer/dist/index.js';
import { parse } from '../../../../implementations/typescript/packages/parser/dist/index.js';
import { resolvePaths, emitEvents, validateReferences, enforceMode } from '../../../../implementations/typescript/packages/aes/dist/index.js';
import { buildAnnotationStreamFromSource } from '../../../../implementations/typescript/packages/annotation-stream/dist/index.js';
import { finalizeJson } from '../../../../implementations/typescript/packages/finalize/dist/index.js';

function ms(start) {
  return performance.now() - start;
}

function round(value) {
  return Math.round(value * 100) / 100;
}

function timed(label, fn, store) {
  const start = performance.now();
  const value = fn();
  store[label] = ms(start);
  return value;
}

function runPipeline(source, options = {}) {
  const recovery = options.recovery ?? false;
  const maxAttributeDepth = options.maxAttributeDepth ?? 1;
  const maxSeparatorDepth = options.maxSeparatorDepth ?? 1;
  const finalizeMode = options.finalizeMode ?? 'strict';
  const emitAnnotations = options.emitAnnotations ?? true;
  const times = {};

  const lex = timed('lex', () => tokenize(source, { includeComments: false }), times);
  if (lex.errors.length > 0) return { ok: false, stage: 'lex', times, errors: lex.errors };

  const parsed = timed(
    'parse',
    () => parse(lex.tokens, { maxSeparatorDepth }),
    times,
  );
  if (parsed.errors.length > 0 || !parsed.document) {
    return { ok: false, stage: 'parse', times, errors: parsed.errors };
  }

  const resolved = timed(
    'resolve',
    () => resolvePaths(parsed.document, { indexedPaths: true }),
    times,
  );
  if (resolved.errors.length > 0 && !recovery) {
    return { ok: false, stage: 'resolve', times, errors: resolved.errors };
  }

  const emitted = timed('emit', () => emitEvents(resolved, { recovery }), times);
  if (emitted.errors.length > 0 && !recovery && emitted.events.length === 0) {
    return { ok: false, stage: 'emit', times, errors: emitted.errors };
  }

  const refs = timed(
    'refValidate',
    () => validateReferences(emitted.events, { recovery, maxAttributeDepth }),
    times,
  );
  if (refs.errors.length > 0 && !recovery) {
    return { ok: false, stage: 'refValidate', times, errors: refs.errors };
  }

  const modeEnforced = timed(
    'modeEnforce',
    () => enforceMode(refs.events, parsed.document.header, { recovery }),
    times,
  );
  if (modeEnforced.errors.length > 0 && !recovery) {
    return { ok: false, stage: 'modeEnforce', times, errors: modeEnforced.errors };
  }

  const annotations = emitAnnotations
    ? timed('annotations', () => buildAnnotationStreamFromSource(source, modeEnforced.events), times)
    : [];
  if (!emitAnnotations) {
    times.annotations = 0;
  }

  const finalized = timed('finalizeJson', () => finalizeJson(modeEnforced.events, { mode: finalizeMode }), times);
  const finalizeErrors = finalized.meta?.errors?.length ?? 0;

  const total = Object.values(times).reduce((sum, value) => sum + value, 0);
  return {
    ok: true,
    times,
    total,
    counts: {
      tokens: lex.tokens.length,
      events: modeEnforced.events.length,
      annotations: annotations.length,
      finalizeErrors,
    },
  };
}

function makeFlatBindings(count) {
  let source = '';
  for (let i = 0; i < count; i += 1) {
    source += `k${i}:number = ${i}\n`;
  }
  return source;
}

function makeNested(depth) {
  const lines = [];
  for (let i = 0; i < depth; i += 1) lines.push(`${'  '.repeat(i)}n${i}:object = {`);
  lines.push(`${'  '.repeat(depth)}leaf:number = 1`);
  for (let i = depth - 1; i >= 0; i -= 1) lines.push(`${'  '.repeat(i)}}`);
  return lines.join('\n');
}

function makeListHeavy(rows) {
  const lines = [];
  for (let i = 0; i < rows; i += 1) {
    lines.push(`row${i}:nums = [${i}, ${i + 1}, ${i + 2}, ${i + 3}, ${i + 4}]`);
  }
  return lines.join('\n');
}

function makeCommentRich(rows) {
  const lines = ['/# top doc #/'];
  for (let i = 0; i < rows; i += 1) {
    lines.push(`item${i}:number = ${i} /? hint-${i} ?/`);
  }
  lines.push('/@ tail @/');
  return lines.join('\n');
}

const workloads = [
  { name: 'flat-10k', source: makeFlatBindings(10000), options: { finalizeMode: 'strict' } },
  { name: 'flat-10k-no-ann', source: makeFlatBindings(10000), options: { finalizeMode: 'strict', emitAnnotations: false } },
  { name: 'flat-50k', source: makeFlatBindings(50000), options: { finalizeMode: 'strict' } },
  { name: 'flat-50k-no-ann', source: makeFlatBindings(50000), options: { finalizeMode: 'strict', emitAnnotations: false } },
  { name: 'nested-180', source: makeNested(180), options: { finalizeMode: 'strict' } },
  { name: 'list-heavy-2500', source: makeListHeavy(2500), options: { finalizeMode: 'strict' } },
  { name: 'comment-rich-1000', source: makeCommentRich(1000), options: { finalizeMode: 'strict' } },
  { name: 'comment-rich-1000-no-ann', source: makeCommentRich(1000), options: { finalizeMode: 'strict', emitAnnotations: false } },
];

const rows = workloads.map((workload) => {
  const result = runPipeline(workload.source, workload.options);
  if (!result.ok) {
    return {
      workload: workload.name,
      ok: 'NO',
      stage: result.stage,
      errorCodes: result.errors.map((error) => error.code).join(','),
    };
  }
  return {
    workload: workload.name,
    ok: 'yes',
    totalMs: round(result.total),
    lexMs: round(result.times.lex ?? 0),
    parseMs: round(result.times.parse ?? 0),
    resolveMs: round(result.times.resolve ?? 0),
    emitMs: round(result.times.emit ?? 0),
    refMs: round(result.times.refValidate ?? 0),
    modeMs: round(result.times.modeEnforce ?? 0),
    annMs: round(result.times.annotations ?? 0),
    finalizeMs: round(result.times.finalizeJson ?? 0),
    tokens: result.counts.tokens,
    events: result.counts.events,
    annotations: result.counts.annotations,
    finalizeErrors: result.counts.finalizeErrors,
  };
});

console.table(rows);

const failures = rows.filter((row) => row.ok !== 'yes');
if (failures.length > 0) {
  console.error(`Phase timing failed: ${failures.length} workload(s) did not compile through all phases.`);
  process.exit(1);
}

function toCsv(records) {
  const headers = Object.keys(records[0] ?? {});
  const escape = (value) => {
    const text = String(value ?? '');
    if (text.includes(',') || text.includes('"') || text.includes('\n')) {
      return `"${text.replace(/"/g, '""')}"`;
    }
    return text;
  };
  return [
    headers.join(','),
    ...records.map((record) => headers.map((header) => escape(record[header])).join(',')),
  ].join('\n');
}

const resultsDir = resolve('./results');
await mkdir(resultsDir, { recursive: true });
const csvPath = resolve(resultsDir, 'phase-timing.csv');
await writeFile(csvPath, `${toCsv(rows)}\n`, 'utf8');

console.log(`Phase timing complete: ${rows.length} workload(s).`);
console.log(`CSV written: ${csvPath}`);
