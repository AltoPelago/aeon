#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import process from 'node:process';

import initWasm, {
    process_aeon as processAeonRaw,
} from '../implementations/typescript/packages/wasm/pkg/aeon_wasm.js';
import { loadAeonWasm } from '../implementations/typescript/packages/wasm/dist/index.js';

const args = parseArgs(process.argv.slice(2));
const source = readFileSync(args.input, 'utf8');
const wasmBytes = readFileSync(new URL(
    '../implementations/typescript/packages/wasm/pkg/aeon_wasm_bg.wasm',
    import.meta.url,
));

const coldStarted = performance.now();
const exports = await initWasm({ module_or_path: wasmBytes });
const coldInitializationNs = millisecondsToNanoseconds(performance.now() - coldStarted);
const memoryAfterInitialization = exports.memory.buffer.byteLength;

const optionsJson = '{}';
const rawPreflight = JSON.parse(processAeonRaw(source, optionsJson));
assert.equal(Array.isArray(rawPreflight.errors), true);
for (let index = 0; index < args.warmup; index += 1) {
    processAeonRaw(source, optionsJson);
}
const rawSamples = measure(args.iterations, () => processAeonRaw(source, optionsJson));
const memoryAfterRaw = exports.memory.buffer.byteLength;

const runtime = await loadAeonWasm(wasmBytes);
const adaptedPreflight = runtime.processAeon(source);
assert.equal(adaptedPreflight.engine, 'rust-wasm');
for (let index = 0; index < args.warmup; index += 1) {
    runtime.processAeon(source);
}
const adaptedSamples = measure(args.iterations, () => runtime.processAeon(source));
const memoryAfterAdaptation = exports.memory.buffer.byteLength;

const rawSummary = summarize(rawSamples);
const adaptedSummary = summarize(adaptedSamples);
const rawMedian = rawSummary.median_ns;
const adaptedMedian = adaptedSummary.median_ns;

process.stdout.write(`${JSON.stringify({
    schema: 'aeon.sofia.wasm-baseline.v1',
    input: args.input,
    bytes: Buffer.byteLength(source, 'utf8'),
    wasm_bytes: wasmBytes.byteLength,
    iterations: args.iterations,
    warmup: args.warmup,
    cold_initialization_ns: coldInitializationNs,
    preflight: {
        ok: rawPreflight.errors.length === 0,
        events: rawPreflight.events.length,
        errors: rawPreflight.errors.map((error) => error.code),
        raw_json_bytes: Buffer.byteLength(processAeonRaw(source, optionsJson), 'utf8'),
    },
    raw_wasm_json_envelope: {
        ...rawSummary,
        throughput_mib_per_second: throughput(source, rawMedian),
    },
    javascript_wrapper: {
        ...adaptedSummary,
        throughput_mib_per_second: throughput(source, adaptedMedian),
        median_over_raw_ratio: adaptedMedian / rawMedian,
    },
    linear_memory_bytes: {
        after_initialization: memoryAfterInitialization,
        after_raw_measurements: memoryAfterRaw,
        after_wrapper_measurements: memoryAfterAdaptation,
    },
}, null, 2)}\n`);

function parseArgs(raw) {
    let input;
    let iterations = 30;
    let warmup = 5;
    for (let index = 0; index < raw.length; index += 1) {
        const value = raw[index];
        if (value === '--iterations') {
            iterations = positiveInteger(raw[++index], '--iterations');
        } else if (value === '--warmup') {
            warmup = nonNegativeInteger(raw[++index], '--warmup');
        } else if (value.startsWith('-')) {
            throw new Error(`unknown option: ${value}`);
        } else if (input === undefined) {
            input = value;
        } else {
            throw new Error('only one input path may be supplied');
        }
    }
    if (input === undefined) {
        throw new Error('usage: bench-sofia-wasm.mjs [--iterations N] [--warmup N] <input>');
    }
    return { input, iterations, warmup };
}

function positiveInteger(raw, option) {
    const value = Number.parseInt(raw, 10);
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`${option} must be a positive integer`);
    }
    return value;
}

function nonNegativeInteger(raw, option) {
    const value = Number.parseInt(raw, 10);
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error(`${option} must be a non-negative integer`);
    }
    return value;
}

function measure(iterations, operation) {
    const samples = [];
    for (let index = 0; index < iterations; index += 1) {
        const started = performance.now();
        const result = operation();
        samples.push(millisecondsToNanoseconds(performance.now() - started));
        assert.notEqual(result, undefined);
    }
    return samples;
}

function millisecondsToNanoseconds(milliseconds) {
    return Math.round(milliseconds * 1_000_000);
}

function summarize(samples) {
    const ordered = [...samples].sort((left, right) => left - right);
    const sum = ordered.reduce((total, sample) => total + sample, 0);
    return {
        unit: 'nanoseconds',
        min_ns: ordered[0],
        median_ns: percentile(ordered, 50),
        p95_ns: percentile(ordered, 95),
        max_ns: ordered.at(-1),
        mean_ns: Math.round(sum / ordered.length),
        samples_ns: samples,
    };
}

function percentile(ordered, percentage) {
    const index = Math.max(0, Math.ceil(ordered.length * percentage / 100) - 1);
    return ordered[index];
}

function throughput(value, nanoseconds) {
    return (Buffer.byteLength(value, 'utf8') / (1024 * 1024)) / (nanoseconds / 1_000_000_000);
}
