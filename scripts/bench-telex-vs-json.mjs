#!/usr/bin/env node

import assert from 'node:assert/strict';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import {
    encodeTelex,
    parseTelex,
    validateTelex,
    validateTelexRecords,
} from '../implementations/typescript/packages/aes/dist/index.js';

const encoder = new TextEncoder();
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

function runCase(config) {
    const records = buildRecords(config.events);
    const json = JSON.stringify(records);
    const telex = encodeTelex(records);
    const jsonBytes = encoder.encode(json).byteLength;
    const telexBytes = encoder.encode(telex).byteLength;

    const parsedJson = JSON.parse(json);
    const parsedTelex = parseTelex(telex).records;
    assert.deepEqual(parsedTelex, parsedJson);
    assert.equal(validateTelexRecords(parsedJson).valid, true);
    assert.equal(validateTelex(telex).valid, true);

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

    return {
        case: config.name,
        events: config.events,
        iterations: config.iterations,
        bytes: {
            json: jsonBytes,
            telex: telexBytes,
            telex_to_json: ratio(telexBytes, jsonBytes),
            saving_percent: Number(((1 - telexBytes / jsonBytes) * 100).toFixed(2)),
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
            telex_time_to_json: ratio(telexValidatedMs, jsonValidatedMs),
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
        timing: 'median wall-clock time; warmups excluded',
    },
    cases: cases.map(runCase),
};

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (sink === Number.MIN_SAFE_INTEGER) process.stderr.write('unreachable\n');
