import { performance } from 'node:perf_hooks';
import { buildAnnotationStreamFromSource } from '../dist/index.js';
import { compile } from '../../core/dist/index.js';

const SIZES = [1000, 2000, 4000, 8000];
const ITERATIONS = 5;
const RATIO_LIMIT = 2.6;

function makeCommentRich(count) {
  const lines = ['/# top doc #/'];
  for (let index = 0; index < count; index += 1) {
    lines.push(`k${index}:number = ${index} /? hint-${index} ?/`);
  }
  return `${lines.join('\n')}\n`;
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const mid = Math.floor(sorted.length / 2);
  return sorted[mid];
}

function medianRuntimeMs(source) {
  const compiled = compile(source, { emitAnnotations: false });
  if ((compiled.errors?.length ?? 0) > 0) {
    throw new Error(`fixture failed to compile: ${compiled.errors.map((error) => error.code).join(',')}`);
  }

  const samples = [];
  for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
    const start = performance.now();
    buildAnnotationStreamFromSource(source, compiled.events);
    samples.push(performance.now() - start);
  }
  return median(samples);
}

const results = SIZES.map((size) => {
  const source = makeCommentRich(size);
  return {
    size,
    bytes: Buffer.byteLength(source, 'utf8'),
    medianMs: medianRuntimeMs(source),
  };
});

console.log('TypeScript annotation perf regression check');
console.log('size\tbytes\tmedian_ms\tratio_vs_prev');

let previous = null;
const violations = [];
for (const result of results) {
  let ratioText = '-';
  if (previous !== null) {
    const ratio = previous > 0 ? result.medianMs / previous : Number.POSITIVE_INFINITY;
    ratioText = ratio.toFixed(2);
    if (ratio > RATIO_LIMIT) {
      violations.push(`${result.size} comments grew ${ratio.toFixed(2)}x over previous size`);
    }
  }
  console.log(`${result.size}\t${result.bytes}\t${result.medianMs.toFixed(3)}\t${ratioText}`);
  previous = result.medianMs;
}

if (violations.length > 0) {
  console.error(`\nFAIL: annotation runtime scaling exceeded threshold (${RATIO_LIMIT.toFixed(2)}x)`);
  for (const violation of violations) {
    console.error(`- ${violation}`);
  }
  process.exit(1);
}

console.log(`\nOK: all growth ratios stayed <= ${RATIO_LIMIT.toFixed(2)}x`);
