#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import {
    canonicalizeTelex,
    checkTelexCompleteness,
    encodeTelex,
    parseTelex,
    validateTelex,
    validateTelexRecords,
} from '../implementations/typescript/packages/aes/dist/index.js';
import { loadAeonWasm } from '../implementations/typescript/packages/wasm/dist/index.js';

const encoder = new TextEncoder();
const wasmBytes = readFileSync(new URL(
    '../implementations/typescript/packages/wasm/pkg/aeon_wasm_bg.wasm',
    import.meta.url,
));
const wasmRuntime = await loadAeonWasm(wasmBytes);
let sink = 0;

const cases = [
    { name: 'small', events: 100, iterations: 1_000, warmups: 20 },
    { name: 'medium', events: 10_000, iterations: 30, warmups: 3 },
    { name: 'limit-scale', events: 100_000, iterations: 3, warmups: 1 },
];

function buildRecords(eventCount) {
    assert.ok(eventCount >= 1 && eventCount <= 100_000);
    const records = [{
        path: '$.items',
        kind: 'ListNode',
        datatype: 'list',
        generics: [{ datatype: 'string', generics: [], clarifiers: [] }],
        clarifiers: [],
    }];
    for (let index = 0; index < eventCount - 1; index += 1) {
        const path = `$.items[${index}]`;
        switch (index % 4) {
            case 0:
                records.push({ path, kind: 'StringLiteral', value: `value-${index}-café` });
                break;
            case 1:
                records.push({ path, kind: 'NumberLiteral', datatype: 'int', generics: [], clarifiers: [], value: String(index) });
                break;
            case 2:
                records.push({ path, kind: 'BooleanLiteral', value: index % 8 === 2 ? 'true' : 'false' });
                break;
            default:
                records.push({ path, kind: 'CloneReference', value: '$.items[0]' });
                break;
        }
    }
    return records;
}

function median(values) {
    const sorted = [...values].sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
        ? (sorted[middle - 1] + sorted[middle]) / 2
        : sorted[middle];
}

function measure(iterations, warmups, operation) {
    for (let index = 0; index < warmups; index += 1) operation();
    const samples = [];
    for (let index = 0; index < iterations; index += 1) {
        const start = performance.now();
        const result = operation();
        samples.push(performance.now() - start);
        sink ^= typeof result === 'string' ? result.length : result.length ?? Number(result.valid);
    }
    return median(samples);
}

function rate(bytes, events, milliseconds) {
    const seconds = milliseconds / 1_000;
    return {
        median_ms: Number(milliseconds.toFixed(3)),
        mb_per_second: Number((bytes / 1_000_000 / seconds).toFixed(2)),
        events_per_second: Math.round(events / seconds),
    };
}

function ratio(left, right) {
    return Number((left / right).toFixed(3));
}

function fnv1a32(bytes) {
    let hash = 0x811c9dc5;
    for (const byte of bytes) hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
    return hash.toString(16).padStart(8, '0');
}

function runCase(config) {
    const records = buildRecords(config.events);
    const json = JSON.stringify(records);
    const telex = encodeTelex(records);
    const jsonBytes = encoder.encode(json).byteLength;
    const encodedTelex = encoder.encode(telex);
    const telexBytes = encodedTelex.byteLength;

    const parsedJson = JSON.parse(json);
    const parsedTelex = parseTelex(telex).records;
    assert.deepEqual(parsedTelex, parsedJson);
    assert.equal(validateTelexRecords(parsedJson).valid, true);
    assert.equal(validateTelex(telex).valid, true);
    assert.equal(wasmRuntime.validateTelex(telex).valid, true);
    assert.equal(wasmRuntime.canonicalizeTelex(telex), canonicalizeTelex(telex));
    assert.deepEqual(wasmRuntime.checkTelexCompleteness(telex), checkTelexCompleteness(telex));

    const jsonEncodeMs = measure(config.iterations, config.warmups, () => JSON.stringify(records));
    const telexEncodeMs = measure(config.iterations, config.warmups, () => encodeTelex(records));
    const jsonDecodeMs = measure(config.iterations, config.warmups, () => JSON.parse(json));
    const telexDecodeMs = measure(config.iterations, config.warmups, () => parseTelex(telex).records);
    const jsonValidatedMs = measure(config.iterations, config.warmups, () => {
        const decoded = JSON.parse(json);
        const validation = validateTelexRecords(decoded);
        assert.equal(validation.valid, true);
        return decoded;
    });
    const telexValidatedMs = measure(config.iterations, config.warmups, () => {
        const validation = validateTelex(telex);
        assert.equal(validation.valid, true);
        return validation.diagnostics;
    });
    const wasmValidatedMs = measure(config.iterations, config.warmups, () => {
        const validation = wasmRuntime.validateTelex(telex);
        assert.equal(validation.valid, true);
        return validation.diagnostics;
    });
    const telexCanonicalMs = measure(config.iterations, config.warmups, () => canonicalizeTelex(telex));
    const wasmCanonicalMs = measure(config.iterations, config.warmups, () => wasmRuntime.canonicalizeTelex(telex));
    const telexCompletenessMs = measure(config.iterations, config.warmups, () => checkTelexCompleteness(telex).missing);
    const wasmCompletenessMs = measure(config.iterations, config.warmups, () => wasmRuntime.checkTelexCompleteness(telex).missing);

    return {
        case: config.name,
        events: config.events,
        iterations: config.iterations,
        bytes: {
            json: jsonBytes,
            telex: telexBytes,
            telex_to_json: ratio(telexBytes, jsonBytes),
            saving_percent: Number(((1 - telexBytes / jsonBytes) * 100).toFixed(2)),
            fnv1a32: fnv1a32(encodedTelex),
        },
        encode: {
            json: rate(jsonBytes, config.events, jsonEncodeMs),
            telex: rate(telexBytes, config.events, telexEncodeMs),
            telex_time_to_json: ratio(telexEncodeMs, jsonEncodeMs),
        },
        decode: {
            json: rate(jsonBytes, config.events, jsonDecodeMs),
            telex: rate(telexBytes, config.events, telexDecodeMs),
            telex_time_to_json: ratio(telexDecodeMs, jsonDecodeMs),
        },
        decode_and_validate: {
            json: rate(jsonBytes, config.events, jsonValidatedMs),
            telex: rate(telexBytes, config.events, telexValidatedMs),
            wasm: rate(telexBytes, config.events, wasmValidatedMs),
            telex_time_to_json: ratio(telexValidatedMs, jsonValidatedMs),
            wasm_time_to_json: ratio(wasmValidatedMs, jsonValidatedMs),
            wasm_time_to_typescript: ratio(wasmValidatedMs, telexValidatedMs),
        },
        canonicalize: {
            typescript: rate(telexBytes, config.events, telexCanonicalMs),
            wasm: rate(telexBytes, config.events, wasmCanonicalMs),
            wasm_time_to_typescript: ratio(wasmCanonicalMs, telexCanonicalMs),
        },
        completeness: {
            typescript: rate(telexBytes, config.events, telexCompletenessMs),
            wasm: rate(telexBytes, config.events, wasmCompletenessMs),
            wasm_time_to_typescript: ratio(wasmCompletenessMs, telexCompletenessMs),
        },
    };
}

const result = {
    metadata: {
        generated_at: new Date().toISOString(),
        node: process.version,
        platform: `${process.platform}/${process.arch}`,
        cpu: os.cpus()[0]?.model ?? 'unknown',
        logical_cpus: os.cpus().length,
        comparison: 'compact JSON record array versus canonical telex.aes=0',
        wasm: 'end-to-end JavaScript to Rust/WASM to JavaScript',
        timing: 'median wall-clock time; warmups excluded',
    },
    cases: cases.map(runCase),
};

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (sink === Number.MIN_SAFE_INTEGER) process.stderr.write('unreachable\n');
