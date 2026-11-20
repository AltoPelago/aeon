import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual, parseArgs } from 'node:util';
import { adaptTypeScriptAssignmentEventsToPortableAes } from '../../../../implementations/typescript/packages/aes/dist/index.js';
import { canonicalize } from '../../../../implementations/typescript/packages/canonical/dist/index.js';
import { compile } from '../../../../implementations/typescript/packages/core/dist/index.js';
import { buildReferencePairModel, renderReferencePair } from './generators/depth-tree.js';

const property = 'reference-layout-canonical-graph-v1';
const generator = '52-cards-reference-pairs-v1';
const maxPairs = 128;
const python = process.env.PYTHON ?? 'python3';
const pythonAdapter = fileURLToPath(new URL('./evaluation/reference-pairs.py', import.meta.url));
const rustExample = process.platform === 'win32' ? 'reference_pairs.exe' : 'reference_pairs';
const rustAdapter = fileURLToPath(new URL(`../../../../implementations/rust/target/debug/examples/${rustExample}`, import.meta.url));
const { values: args } = parseArgs({
    options: {
        seed: { type: 'string', default: '1729' },
        count: { type: 'string', default: '32' },
        'case-index': { type: 'string' },
        'check-detector': { type: 'boolean' },
    },
});

function integerOption(name, lower, upper) {
    const raw = args[name];
    const value = Number(raw);
    assert.ok(/^\d+$/.test(raw) && value >= lower && value <= upper, `--${name} must be an integer from ${lower} to ${upper}`);
    return value;
}

function compileGraph(source) {
    const result = compile(source);
    if (result.errors.length) return { errors: result.errors };
    const records = adaptTypeScriptAssignmentEventsToPortableAes(result.events, {
        includeHeaders: true,
        headerFieldNames: result.header ? [...result.header.fields.keys()] : [],
    }).events;
    return { errors: [], records };
}

function inspectTypeScript(source) {
    const authored = compileGraph(source);
    const canonical = canonicalize(source);
    const result = { authored, canonical };
    if (!canonical.errors.length) {
        result.reparsed = compileGraph(canonical.text);
        result.fixed = canonicalize(canonical.text);
    }
    return result;
}

function sortedGraph(records) {
    const address = (record) => record.header !== undefined ? `header:${record.header}` : `body:${record.path}`;
    return records.map(({ span: _span, origin: _origin, ...record }) => record)
        .sort((left, right) => {
            const a = address(left);
            const b = address(right);
            return a < b ? -1 : a > b ? 1 : 0;
        });
}

function graphMismatch(expected, actual) {
    const at = expected.findIndex((record, index) => !isDeepStrictEqual(record, actual[index]));
    const index = at === -1 ? expected.length : at;
    if (at === -1 && expected.length === actual.length) return null;
    return { expected: expected[index] ?? null, actual: actual[index] ?? null, expectedSize: expected.length, actualSize: actual.length };
}

function checkRuntime(runtime, pair, expected) {
    for (const [variant, sample] of pair.entries()) {
        for (const stage of ['authored', 'canonical', 'reparsed', 'fixed']) {
            if (sample[stage].errors.length) {
                return { runtime, variant, kind: `${stage}-rejected`, errors: sample[stage].errors };
            }
        }
        for (const stage of ['authored', 'reparsed']) {
            const mismatch = graphMismatch(expected, sortedGraph(sample[stage].records));
            if (mismatch) return { runtime, variant, kind: `${stage}-graph`, ...mismatch };
        }
        if (sample.canonical.text !== sample.fixed.text) {
            return { runtime, variant, kind: 'fixed-point-bytes', expected: sample.canonical.text, actual: sample.fixed.text };
        }
    }
    const [base, layout] = pair.map((sample) => sample.canonical.text);
    if (base !== layout) return { runtime, kind: 'pair-bytes', expected: base, actual: layout };
    return null;
}

function runAdapter(command, options, input) {
    return JSON.parse(execFileSync(command, options, {
        input,
        encoding: 'utf8',
        timeout: 30_000,
        maxBuffer: 8 * 1024 * 1024,
    }));
}

function evaluate(pairs) {
    const input = JSON.stringify(pairs.map(({ sources }) => sources));
    const pythonResult = runAdapter(python, ['-I', '-B', pythonAdapter], input);
    const rustResult = runAdapter(rustAdapter, [], input);
    const results = pairs.map(({ sources, expectedGraph }, index) => {
        const expected = sortedGraph(expectedGraph);
        const typescript = sources.map(inspectTypeScript);
        const otherRuntimes = [['Python', pythonResult.pairs[index]], ['Rust', rustResult.pairs[index]]];
        const runtimes = [['TypeScript', typescript], ...otherRuntimes];
        const failures = runtimes.map(([name, pair]) => checkRuntime(name, pair, expected)).filter(Boolean);
        if (!failures.length) {
            const reference = typescript[0].canonical.text;
            for (const [name, pair] of otherRuntimes) {
                const actual = pair[0].canonical.text;
                if (actual !== reference) {
                    failures.push({ runtime: `TypeScript/${name}`, kind: 'cross-runtime-bytes', expected: reference, actual });
                }
            }
        }
        const inputsAccepted = runtimes.every(([, pair]) => pair.every(({ authored }) => !authored.errors.length));
        return { failures, inputsAccepted };
    });
    return { pythonVersion: pythonResult.version, rustVersion: rustResult.version, results };
}

function minimize(model, failure, render) {
    let smallest = model;
    let pair = render(model);
    // Keep both reference targets, the reference-bearing list and every index
    // up to the selected target. Rerender the same reduced model twice.
    for (const change of [
        { competitor: null },
        { marker: null },
        { targetValues: model.targetValues.slice(0, model.targetIndex + 1) },
    ]) {
        const candidate = { ...smallest, ...change };
        const candidatePair = render(candidate);
        if (isDeepStrictEqual(candidatePair.sources, pair.sources)) continue;
        const [result] = evaluate([candidatePair]).results;
        const repeated = result.failures.find(({ kind, runtime, variant }) =>
            kind === failure.kind && runtime === failure.runtime && variant === failure.variant);
        if (result.inputsAccepted && repeated) {
            smallest = candidate;
            pair = candidatePair;
            failure = repeated;
        }
    }
    return { model: smallest, ...pair, failure };
}

const seed = integerOption('seed', 0, 0xffffffff);
const count = integerOption('count', 1, maxPairs);
const indexes = args['case-index'] === undefined
    ? Array.from({ length: count }, (_, index) => index)
    : [integerOption('case-index', 0, maxPairs - 1)];
const models = indexes.map((index) => buildReferencePairModel(seed, index));
const pairs = models.map(renderReferencePair);
assert.ok(existsSync(rustAdapter), 'Build the Rust adapter in implementations/rust with cargo build --locked -p aeon-canonical --example reference_pairs');
const { pythonVersion, rustVersion, results } = evaluate(pairs);
const failed = results.findIndex(({ failures }) => failures.length > 0);
const context = { property, generator, seed, node: process.version, python: pythonVersion, rust: rustVersion };

if (failed !== -1) {
    const [failure] = results[failed].failures;
    const model = models[failed];
    const original = { model, ...pairs[failed], failure };
    const minimized = minimize(model, failure, renderReferencePair);
    console.error(JSON.stringify({ ...context, caseIndex: model.index, original, minimized }, null, 2));
    process.exitCode = 1;
} else {
    console.log(`52-Cards paired pilot: ${pairs.length} pairs passed in TypeScript, Python ${pythonVersion}, and Rust AEON ${rustVersion} (seed ${seed}).`);
    if (args['check-detector']) {
        const wrongExpectedGraph = (model) => {
            const pair = renderReferencePair(model);
            const clone = pair.expectedGraph.find((record) => record.kind === 'CloneReference');
            clone.kind = 'PointerReference';
            return pair;
        };
        const model = models[0];
        const [control] = evaluate([wrongExpectedGraph(model)]).results;
        assert.deepEqual(control.failures.map(({ runtime, kind }) => [runtime, kind]), [
            ['TypeScript', 'authored-graph'],
            ['Python', 'authored-graph'],
            ['Rust', 'authored-graph'],
        ], 'each runtime must detect the wrong reference kind');
        const rustFailure = control.failures.find(({ runtime }) => runtime === 'Rust');
        const reduced = minimize(model, rustFailure, wrongExpectedGraph);
        assert.equal(reduced.model.competitor, null);
        assert.equal(reduced.model.marker, null);
        const [replay] = evaluate([wrongExpectedGraph(reduced.model)]).results;
        assert.deepEqual(replay.failures.find(({ runtime }) => runtime === 'Rust'), reduced.failure);
        console.log(`52-Cards detector control: all three runtimes detected the wrong reference kind and the Rust failure was reduced (seed ${seed}, case ${model.index}).`);
    }
}
