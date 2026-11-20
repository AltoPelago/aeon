import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
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
const rustWorkspace = fileURLToPath(new URL('../../../../implementations/rust/', import.meta.url));
const rustAdapter = process.env.AEON_52_CARDS_RUST_ADAPTER;
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

function graphByAddress(records) {
    const entries = new Map();
    for (const { span: _span, origin: _origin, ...record } of records) {
        const address = record.header !== undefined ? `header:${record.header}` : `body:${record.path}`;
        const group = entries.get(address) ?? [];
        group.push(record);
        entries.set(address, group);
    }
    return { entries, size: records.length };
}

function graphMismatch(expected, actual) {
    const addresses = [...new Set([...expected.entries.keys(), ...actual.entries.keys()])].sort();
    const show = (group) => group?.length === 1 ? group[0] : group ?? null;
    for (const address of addresses) {
        const wanted = expected.entries.get(address);
        const observed = actual.entries.get(address);
        if (!isDeepStrictEqual(wanted, observed)) {
            return { address, expected: show(wanted), actual: show(observed), expectedSize: expected.size, actualSize: actual.size };
        }
    }
    return null;
}

function checkRuntime(runtime, pair, expected) {
    for (const [variant, sample] of pair.entries()) {
        for (const stage of ['authored', 'canonical', 'reparsed', 'fixed']) {
            if (sample[stage].errors.length) {
                return { runtime, variant, kind: `${stage}-rejected`, errors: sample[stage].errors };
            }
        }
        for (const stage of ['authored', 'reparsed']) {
            const mismatch = graphMismatch(expected, graphByAddress(sample[stage].records));
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

function runAdapter(command, options, input, cwd) {
    return JSON.parse(execFileSync(command, options, {
        cwd,
        input,
        encoding: 'utf8',
        timeout: 30_000,
        maxBuffer: 8 * 1024 * 1024,
    }));
}

function runRust(input) {
    if (rustAdapter) return runAdapter(resolve(rustAdapter), [], input);
    return runAdapter(
        'cargo', ['run', '--locked', '--offline', '--quiet', '-p', 'aeon-canonical', '--example', 'reference_pairs'],
        input, rustWorkspace,
    );
}

function evaluate(pairs, inspectRust = runRust) {
    const input = JSON.stringify(pairs.map(({ sources }) => sources));
    const pythonResult = runAdapter(python, ['-I', '-B', pythonAdapter], input);
    const rustResult = inspectRust(input);
    const results = pairs.map(({ sources, expectedGraph }, index) => {
        const expected = graphByAddress(expectedGraph);
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
        const authoredAccepted = new Map(runtimes.map(([name, pair]) =>
            [name, pair.every(({ authored }) => !authored.errors.length)]));
        return { failures, authoredAccepted };
    });
    return { pythonVersion: pythonResult.version, rustVersion: rustResult.version, results };
}

function canonicalSections(text, model) {
    // The pilot renders bare, distinct root keys. Keep the entire affected
    // binding so identical line edits at different positions cannot match.
    const keys = ['aeon:header', `a${model.index}`, `z${model.index}`];
    if (model.competitor !== null) keys.push(`m${model.index}`);
    const anchors = [...text.matchAll(/^[ \t]*(aeon:header|[amz]\d+)(?=[ \t:@=])/gm)];
    if (!isDeepStrictEqual(anchors.map((match) => match[1]).sort(), keys.sort())) return null;
    return [
        text.slice(0, anchors[0].index),
        ...anchors.map(({ index }, next) => text.slice(index, anchors[next + 1]?.index)),
    ];
}

function differingSections(expected, actual, model) {
    const wanted = canonicalSections(expected, model);
    const observed = canonicalSections(actual, model);
    if (!wanted || !observed) return [expected, actual];
    const limit = Math.min(wanted.length, observed.length);
    let start = 0;
    while (start < limit && wanted[start] === observed[start]) start += 1;
    let tail = 0;
    while (start + tail < limit && wanted[wanted.length - 1 - tail] === observed[observed.length - 1 - tail]) tail += 1;
    return [wanted.slice(start, wanted.length - tail), observed.slice(start, observed.length - tail)];
}

function failureWitness(failure, model) {
    if (failure.errors) {
        // Source positions can move when an unrelated binding is removed.
        return failure.errors.map(({ code, path, phase, message }) => ({ code, path, phase, message }));
    }
    if (failure.address !== undefined) return [failure.address, failure.expected, failure.actual];
    return differingSections(failure.expected, failure.actual, model);
}

function minimize(model, failure, render, evaluatePairs = evaluate) {
    let smallest = model;
    let pair = render(model);
    const witness = failureWitness(failure, model);
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
        const [result] = evaluatePairs([candidatePair]).results;
        const inputsAccepted = [...result.authoredAccepted].every(([runtime, accepted]) =>
            accepted || (failure.kind === 'authored-rejected' && runtime === failure.runtime));
        const repeated = result.failures.find((observed) =>
            observed.kind === failure.kind && observed.runtime === failure.runtime && observed.variant === failure.variant
            && isDeepStrictEqual(failureWitness(observed, candidate), witness));
        if (inputsAccepted && repeated) {
            smallest = candidate;
            pair = candidatePair;
            failure = repeated;
        }
    }
    return { model: smallest, ...pair, failure };
}

function withRustControl(changeBase) {
    return (pairs) => evaluate(pairs, (input) => {
        const result = runRust(input);
        for (const [base] of result.pairs) changeBase(base);
        return result;
    });
}

function checkReductionControls(model) {
    const competitorPath = `$.m${model.index}`;
    const labelPath = `$.z${model.index}.@.label`;
    const markerPath = `$.z${model.index}.@.marker`;
    const unrelatedMismatch = withRustControl(({ authored: { records } }) => {
        for (const record of records) {
            if (record.path === competitorPath || record.path === labelPath) record.value += ' wrong';
        }
    });
    const authoredRejection = withRustControl(({ authored }) => {
        const code = authored.records.some(({ path }) => path === markerPath)
            ? 'PILOT_REJECTION' : 'PILOT_DIFFERENT_REJECTION';
        authored.errors.push({ code, path: `$.a${model.index}`, message: 'Injected authored diagnostic' });
    });
    const movingByteMismatch = withRustControl(({ authored, fixed }) => {
        const key = authored.records.some(({ path }) => path === competitorPath) ? `z${model.index}` : `a${model.index}`;
        const binding = new RegExp(`^${key}[:@][^\\n]*\\n[\\s\\S]*?^}`, 'm');
        assert.match(fixed.text, binding);
        fixed.text = fixed.text.replace(binding, '$& ');
    });
    const pair = renderReferencePair(model);

    const [graphResult] = unrelatedMismatch([pair]).results;
    const [graphFailure] = graphResult.failures;
    assert.equal(graphFailure.expected.path, competitorPath);
    const reducedGraph = minimize(model, graphFailure, renderReferencePair, unrelatedMismatch);
    assert.equal(reducedGraph.model.competitor, model.competitor, 'keep the binding with the reported mismatch');
    assert.equal(reducedGraph.model.marker, null, 'remove an unrelated attribute');
    assert.deepEqual(failureWitness(reducedGraph.failure, reducedGraph.model), failureWitness(graphFailure, model));

    const [rejectionResult] = authoredRejection([pair]).results;
    const [rejection] = rejectionResult.failures;
    assert.equal(rejection.kind, 'authored-rejected');
    const reducedRejection = minimize(model, rejection, renderReferencePair, authoredRejection);
    assert.equal(reducedRejection.model.competitor, null, 'reduce when the other runtimes accept both inputs');
    assert.equal(reducedRejection.model.marker, model.marker, 'keep the attribute required by the original diagnostic');
    assert.deepEqual(failureWitness(reducedRejection.failure, reducedRejection.model), failureWitness(rejection, model));

    const [byteResult] = movingByteMismatch([pair]).results;
    const [byteFailure] = byteResult.failures;
    assert.equal(byteFailure.kind, 'fixed-point-bytes');
    const reducedBytes = minimize(model, byteFailure, renderReferencePair, movingByteMismatch);
    assert.equal(reducedBytes.model.competitor, model.competitor, 'keep the binding context of the original byte mismatch');
    assert.deepEqual(failureWitness(reducedBytes.failure, reducedBytes.model), failureWitness(byteFailure, model));
}

const seed = integerOption('seed', 0, 0xffffffff);
const count = integerOption('count', 1, maxPairs);
const indexes = args['case-index'] === undefined
    ? Array.from({ length: count }, (_, index) => index)
    : [integerOption('case-index', 0, maxPairs - 1)];
const models = indexes.map((index) => buildReferencePairModel(seed, index));
const pairs = models.map(renderReferencePair);
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
        checkReductionControls(model);
        console.log(`52-Cards detector control: all three runtimes detected the wrong reference kind and the Rust failure was reduced (seed ${seed}, case ${model.index}).`);
        console.log('52-Cards reduction controls: graph mismatch, authored diagnostic, and byte mismatch location preserved.');
    }
}
