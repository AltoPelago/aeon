#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import process from 'node:process';

import initWasm, {
    AeonStream,
} from '../implementations/typescript/packages/wasm/pkg/aeon_wasm.js';

const args = parseArgs(process.argv.slice(2));
const input = readFileSync(args.input);
const wasmBytes = readFileSync(new URL(
    '../implementations/typescript/packages/wasm/pkg/aeon_wasm_bg.wasm',
    import.meta.url,
));
const exports = await initWasm({ module_or_path: wasmBytes });
const memoryAfterInitialization = exports.memory.buffer.byteLength;

const cases = [];
for (const batchEvents of args.batchEvents) {
    const memoryBeforeCase = exports.memory.buffer.byteLength;
    for (let index = 0; index < args.warmup; index += 1) {
        runStream(batchEvents);
    }
    const memoryAfterWarmup = exports.memory.buffer.byteLength;
    const samples = [];
    for (let index = 0; index < args.iterations; index += 1) {
        samples.push(runStream(batchEvents));
    }
    const memoryAfterMeasurements = exports.memory.buffer.byteLength;
    const retentionProbe = createRetentionProbe();
    runStream(batchEvents, retentionProbe.observe);
    const retention = retentionProbe.report();
    cases.push({
        batch_events: batchEvents,
        max_pending_batches: args.pendingBatches,
        chunk_bytes: args.chunkBytes,
        iterations: args.iterations,
        warmup: args.warmup,
        output: {
            batches: samples[0].batches,
            events: samples[0].events,
            batch_json_bytes: samples[0].batchJsonBytes,
            boundary_crossings: samples[0].boundaryCrossings,
        },
        total: summarize(samples.map((sample) => sample.totalNs)),
        phases: {
            push_parse_and_progress_return: summarize(
                samples.map((sample) => sample.pushNs),
            ),
            batch_materialize_serialize_and_return: summarize(
                samples.map((sample) => sample.pullNs),
            ),
            javascript_json_parse: summarize(samples.map((sample) => sample.jsonParseNs)),
            javascript_event_adaptation: summarize(
                samples.map((sample) => sample.adaptationNs),
            ),
            finish_and_terminal: summarize(samples.map((sample) => sample.terminalNs)),
        },
        linear_memory_bytes: {
            before_case: memoryBeforeCase,
            after_warmup: memoryAfterWarmup,
            after_measurements: memoryAfterMeasurements,
            peak_during_retention_probe: retention.peak_linear_memory_bytes,
            after_retention_probe: exports.memory.buffer.byteLength,
            growth_from_initialization: exports.memory.buffer.byteLength
                - memoryAfterInitialization,
        },
        retention,
    });
}

process.stdout.write(`${JSON.stringify({
    schema: 'aeon.sofia.wasm-stream-boundary.v2',
    input: args.input,
    input_bytes: input.byteLength,
    wasm_bytes: wasmBytes.byteLength,
    representation: 'bounded JSON event-summary batches',
    timing: 'median wall-clock nanoseconds after warmup',
    phase_model: {
        parser: 'push calls include Rust parsing/validation, progress-envelope serialization, and the WASM string return',
        serialization_and_transfer: 'pull calls include Rust batch materialization, JSON serialization, and the WASM string return',
        javascript_deserialization: 'JSON.parse is timed separately for progress, batch, and terminal envelopes',
        javascript_adaptation: 'the already normalized typed event-summary array is passed through after JSON.parse',
        retention_probe: 'one additional untimed stream samples live Rust state and linear-memory capacity after each operation; diagnostic calls are excluded from timing samples',
    },
    memory_after_initialization_bytes: memoryAfterInitialization,
    cases,
}, null, 2)}\n`);

function runStream(batchEvents, observeRetention = undefined) {
    const stream = new AeonStream(JSON.stringify({
        validationMode: 'strict',
        maxBatchEvents: batchEvents,
        maxPendingBatches: args.pendingBatches,
    }));
    observeRetention?.('after-construction', stream);
    const counters = {
        pushNs: 0,
        pullNs: 0,
        jsonParseNs: 0,
        adaptationNs: 0,
        terminalNs: 0,
        batches: 0,
        events: 0,
        batchJsonBytes: 0,
        boundaryCrossings: 0,
        sink: 0,
    };

    const started = performance.now();
    for (let offset = 0; offset < input.byteLength; offset += args.chunkBytes) {
        const chunk = input.subarray(offset, Math.min(input.byteLength, offset + args.chunkBytes));
        let accepted = false;
        while (!accepted) {
            const callStarted = performance.now();
            const raw = stream.push(chunk);
            counters.pushNs += elapsedNanoseconds(callStarted);
            counters.boundaryCrossings += 1;
            observeRetention?.('after-push', stream);
            const parseStarted = performance.now();
            const progress = JSON.parse(raw);
            counters.jsonParseNs += elapsedNanoseconds(parseStarted);
            accepted = progress.accepted;
            if (!accepted) pullOne(stream, counters, observeRetention);
        }
        pullAll(stream, counters, observeRetention);
    }

    let acceptedFinish = false;
    while (!acceptedFinish) {
        const finishStarted = performance.now();
        const raw = stream.finish();
        counters.terminalNs += elapsedNanoseconds(finishStarted);
        counters.boundaryCrossings += 1;
        observeRetention?.('after-finish', stream);
        const parseStarted = performance.now();
        const progress = JSON.parse(raw);
        counters.jsonParseNs += elapsedNanoseconds(parseStarted);
        acceptedFinish = progress.accepted;
        if (!acceptedFinish) pullOne(stream, counters, observeRetention);
    }
    pullAll(stream, counters, observeRetention);

    const terminalStarted = performance.now();
    const rawTerminal = stream.takeTerminal();
    counters.terminalNs += elapsedNanoseconds(terminalStarted);
    counters.boundaryCrossings += 1;
    observeRetention?.('after-terminal', stream);
    const terminalParseStarted = performance.now();
    const terminal = JSON.parse(rawTerminal);
    counters.jsonParseNs += elapsedNanoseconds(terminalParseStarted);
    assert.equal(terminal.status, 'accepted');
    assert.equal(terminal.eventCount, counters.events);
    const totalNs = elapsedNanoseconds(started);
    stream.free();
    assert.equal(counters.events > 0, true);
    assert.notEqual(counters.sink, Number.MIN_SAFE_INTEGER);

    return { ...counters, totalNs };
}

function pullAll(stream, counters, observeRetention) {
    while (pullOne(stream, counters, observeRetention)) {
        // Pulling until empty is the consumer-side backpressure release.
    }
}

function pullOne(stream, counters, observeRetention) {
    const pullStarted = performance.now();
    const raw = stream.pullBatch();
    counters.pullNs += elapsedNanoseconds(pullStarted);
    counters.boundaryCrossings += 1;
    observeRetention?.('after-pull', stream);
    const parseStarted = performance.now();
    const batch = JSON.parse(raw);
    counters.jsonParseNs += elapsedNanoseconds(parseStarted);
    if (batch === null) return false;

    counters.batches += 1;
    counters.events += batch.events.length;
    counters.batchJsonBytes += Buffer.byteLength(raw, 'utf8');
    const adaptationStarted = performance.now();
    const normalized = batch.events;
    counters.adaptationNs += elapsedNanoseconds(adaptationStarted);
    counters.sink += normalized.length + (normalized[0]?.path.length ?? 0);
    return true;
}

function createRetentionProbe() {
    let observations = 0;
    let peakLinearMemoryBytes = exports.memory.buffer.byteLength;
    let peakPoint;
    let peakSnapshot;
    let afterCompletion;
    const fieldPeaks = {};

    return {
        observe(point, stream) {
            const snapshot = JSON.parse(stream.retentionSnapshot());
            observations += 1;
            peakLinearMemoryBytes = Math.max(
                peakLinearMemoryBytes,
                exports.memory.buffer.byteLength,
            );
            for (const [field, value] of Object.entries(snapshot)) {
                if (typeof value === 'number') {
                    fieldPeaks[field] = Math.max(fieldPeaks[field] ?? 0, value);
                }
            }
            if (
                peakSnapshot === undefined
                || snapshot.accountedShallowBytes > peakSnapshot.accountedShallowBytes
            ) {
                peakPoint = point;
                peakSnapshot = snapshot;
            }
            if (point === 'after-terminal') afterCompletion = snapshot;
        },
        report() {
            assert.notEqual(peakSnapshot, undefined);
            assert.notEqual(afterCompletion, undefined);
            assert.equal(afterCompletion.accountedShallowBytes, 0);
            assert.equal(afterCompletion.readyEventCount, 0);
            assert.equal(afterCompletion.stagedEventCount, 0);
            return {
                method: 'operation-boundary snapshots from the live Rust compiler; accounted shallow bytes exclude allocator overhead and unobservable nested capacity',
                observations,
                peak_linear_memory_bytes: peakLinearMemoryBytes,
                peak_live_retention: {
                    point: peakPoint,
                    snapshot: peakSnapshot,
                },
                numeric_field_peaks: fieldPeaks,
                after_completion: afterCompletion,
            };
        },
    };
}

function parseArgs(raw) {
    let inputPath;
    let iterations = 10;
    let warmup = 2;
    let chunkBytes = 64 * 1024;
    let pendingBatches = 2;
    let batchEvents = [128, 256, 512, 1024];
    for (let index = 0; index < raw.length; index += 1) {
        const value = raw[index];
        if (value === '--iterations') {
            iterations = positiveInteger(raw[++index], '--iterations');
        } else if (value === '--warmup') {
            warmup = nonNegativeInteger(raw[++index], '--warmup');
        } else if (value === '--chunk-bytes') {
            chunkBytes = positiveInteger(raw[++index], '--chunk-bytes');
        } else if (value === '--pending-batches') {
            pendingBatches = positiveInteger(raw[++index], '--pending-batches');
        } else if (value === '--batch-events') {
            batchEvents = raw[++index].split(',').map((entry) =>
                positiveInteger(entry, '--batch-events'));
        } else if (value.startsWith('-')) {
            throw new Error(`unknown option: ${value}`);
        } else if (inputPath === undefined) {
            inputPath = value;
        } else {
            throw new Error('only one input path may be supplied');
        }
    }
    if (inputPath === undefined) {
        throw new Error(
            'usage: bench-sofia-wasm-stream.mjs [options] <input>',
        );
    }
    return {
        input: inputPath,
        iterations,
        warmup,
        chunkBytes,
        pendingBatches,
        batchEvents,
    };
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

function elapsedNanoseconds(started) {
    return Math.round((performance.now() - started) * 1_000_000);
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
