#!/usr/bin/env node

import assert from 'node:assert/strict';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import {
    Worker,
    isMainThread,
    parentPort,
} from 'node:worker_threads';
import {
    IncrementalAesAccumulator,
    IncrementalTelexDecoder,
    validateTelexInChunks,
} from '../implementations/typescript/packages/aes/dist/telex-incremental-internal.js';
import {
    encodeTelex,
    validateTelex,
} from '../implementations/typescript/packages/aes/dist/index.js';

const EVENT_COUNT = 100_000;
const CHUNK_BYTES = 65_536;
const WARMUPS = positiveIntegerEnvironment('AES_PIPELINE_BENCH_WARMUPS', 2);
const ITERATIONS = positiveIntegerEnvironment('AES_PIPELINE_BENCH_ITERATIONS', 9);
let sink = 0;

async function main() {
    const records = buildRecords(EVENT_COUNT);
    const options = { maxListItems: EVENT_COUNT };
    const text = encodeTelex(records, options);
    const bytes = new TextEncoder().encode(text);
    const splitPoints = chunkBoundaries(bytes.byteLength, CHUNK_BYTES);
    assert.equal(validateTelex(text, options).valid, true);
    assert.equal(validateTelexInChunks(bytes, splitPoints, options).validation.valid, true);

    const workerA = new SemanticWorkerClient();
    const workerB = new SemanticWorkerClient();
    try {
        const oneShotMs = measure(ITERATIONS, WARMUPS, () => {
            const result = validateTelex(text, options);
            assert.equal(result.valid, true);
            return result.diagnostics.length;
        });
        const sequentialMs = measure(ITERATIONS, WARMUPS, () => {
            const result = validateTelexInChunks(bytes, splitPoints, options);
            assert.equal(result.validation.valid, true);
            return result.records.length;
        });
        const t1Ms = await measureAsync(ITERATIONS, WARMUPS, async () => {
            const result = await runCapacityOnePipeline(workerA, bytes, options);
            assert.equal(result.validation.valid, true);
            return result.recordCount;
        });
        const t2Ms = await measureAsync(ITERATIONS, WARMUPS, async () => {
            const results = await Promise.all([
                runCapacityOnePipeline(workerA, bytes, options),
                runCapacityOnePipeline(workerB, bytes, options),
            ]);
            assert.ok(results.every(({ validation }) => validation.valid));
            return results.reduce((total, result) => total + result.recordCount, 0);
        });

        const output = {
            metadata: {
                generated_at: new Date().toISOString(),
                node: process.version,
                platform: `${process.platform}/${process.arch}`,
                cpu: os.cpus()[0]?.model ?? 'unknown',
                logical_cpus: os.cpus().length,
                events_per_stream: EVENT_COUNT,
                input_bytes_per_stream: bytes.byteLength,
                chunk_bytes: CHUNK_BYTES,
                warmups: WARMUPS,
                iterations: ITERATIONS,
                timing: 'median wall-clock time; warmups excluded',
            },
            one_shot: rate(EVENT_COUNT, oneShotMs, oneShotMs),
            sequential_incremental: rate(EVENT_COUNT, sequentialMs, oneShotMs),
            t1_capacity_one: rate(EVENT_COUNT, t1Ms, oneShotMs),
            t2_two_lanes: rate(EVENT_COUNT * 2, t2Ms, oneShotMs),
        };
        process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    } finally {
        await Promise.all([workerA.close(), workerB.close()]);
    }
    if (sink === Number.MIN_SAFE_INTEGER) process.stderr.write('unreachable\n');
}

function installSemanticWorker() {
    let accumulator;
    parentPort.on('message', ({ id, operation, context, options, firstRecord, records }) => {
        try {
            let value;
            if (operation === 'start') {
                accumulator = new IncrementalAesAccumulator(context, options);
                value = null;
            } else if (operation === 'batch') {
                if (accumulator === undefined) throw new Error('Semantic worker has not started');
                accumulator.acceptOwnedBatch(firstRecord, records);
                value = null;
            } else if (operation === 'finish') {
                if (accumulator === undefined) throw new Error('Semantic worker has not started');
                const result = accumulator.finish();
                accumulator = undefined;
                value = {
                    recordCount: result.records.length,
                    validation: result.validation,
                };
            } else {
                throw new Error(`Unknown semantic worker operation: ${String(operation)}`);
            }
            parentPort.postMessage({ id, ok: true, value });
        } catch (error) {
            parentPort.postMessage({
                id,
                ok: false,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    });
}

class SemanticWorkerClient {
    #nextId = 0;
    #pending = new Map();
    #worker = new Worker(new URL(import.meta.url));

    constructor() {
        this.#worker.on('message', ({ id, ok, value, error }) => {
            const pending = this.#pending.get(id);
            if (pending === undefined) return;
            this.#pending.delete(id);
            if (ok) pending.resolve(value);
            else pending.reject(new Error(error));
        });
        this.#worker.on('error', (error) => {
            for (const pending of this.#pending.values()) pending.reject(error);
            this.#pending.clear();
        });
    }

    request(message) {
        const id = this.#nextId;
        this.#nextId += 1;
        return new Promise((resolve, reject) => {
            this.#pending.set(id, { resolve, reject });
            this.#worker.postMessage({ id, ...message });
        });
    }

    async close() {
        await this.#worker.terminate();
    }
}

async function runCapacityOnePipeline(worker, bytes, options) {
    const decoder = new IncrementalTelexDecoder(options);
    let pendingBatch = Promise.resolve();
    let started = false;
    for (let start = 0; start < bytes.byteLength; start += CHUNK_BYTES) {
        const end = Math.min(start + CHUNK_BYTES, bytes.byteLength);
        const update = decoder.push(bytes.subarray(start, end), {
            final: end === bytes.byteLength,
        });
        if (update.context !== undefined) {
            await worker.request({
                operation: 'start',
                context: update.context,
                options,
            });
            started = true;
        }
        if (update.records.length > 0) {
            if (!started) throw new Error('Records arrived before Telex stream context');
            await pendingBatch;
            pendingBatch = worker.request({
                operation: 'batch',
                firstRecord: update.firstRecord,
                records: update.records,
            });
        }
    }
    await pendingBatch;
    if (!started) throw new Error('Telex stream context was not fixed');
    return worker.request({ operation: 'finish' });
}

function buildRecords(eventCount) {
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
                records.push({
                    path,
                    kind: 'NumberLiteral',
                    datatype: 'int',
                    generics: [],
                    clarifiers: [],
                    value: String(index),
                });
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

function chunkBoundaries(byteLength, chunkBytes) {
    const boundaries = [];
    for (let offset = chunkBytes; offset < byteLength; offset += chunkBytes) {
        boundaries.push(offset);
    }
    return boundaries;
}

function measure(iterations, warmups, operation) {
    for (let index = 0; index < warmups; index += 1) operation();
    const samples = [];
    for (let index = 0; index < iterations; index += 1) {
        const start = performance.now();
        sink ^= operation();
        samples.push(performance.now() - start);
    }
    return median(samples);
}

async function measureAsync(iterations, warmups, operation) {
    for (let index = 0; index < warmups; index += 1) await operation();
    const samples = [];
    for (let index = 0; index < iterations; index += 1) {
        const start = performance.now();
        sink ^= await operation();
        samples.push(performance.now() - start);
    }
    return median(samples);
}

function median(values) {
    const sorted = [...values].sort((left, right) => left - right);
    return sorted[Math.floor(sorted.length / 2)];
}

function rate(events, milliseconds, oneShotMilliseconds) {
    return {
        median_ms: Number(milliseconds.toFixed(3)),
        events_per_second: Math.round(events / (milliseconds / 1_000)),
        aggregate_speedup_over_one_shot: Number((
            (events / milliseconds) / (EVENT_COUNT / oneShotMilliseconds)
        ).toFixed(3)),
    };
}

function positiveIntegerEnvironment(name, fallback) {
    const raw = process.env[name];
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`${name} must be a positive integer`);
    }
    return value;
}

if (isMainThread) await main();
else installSemanticWorker();
