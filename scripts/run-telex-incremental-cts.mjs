#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function option(name) {
    const index = process.argv.indexOf(name);
    if (index === -1 || !process.argv[index + 1]) {
        throw new Error(`${name} requires a path`);
    }
    return path.resolve(process.argv[index + 1]);
}

function limitOptions(vector) {
    if (vector.input.limits === undefined) return {};
    const names = {
        max_input_bytes: 'maxInputBytes',
        max_line_bytes: 'maxLineBytes',
        max_fields_per_event: 'maxFieldsPerEvent',
        max_events: 'maxEvents',
        max_decoded_payload_bytes: 'maxDecodedPayloadBytes',
        max_path_depth: 'maxPathDepth',
        max_path_characters: 'maxPathCharacters',
        max_generic_depth: 'maxGenericDepth',
        max_generic_arguments: 'maxGenericArguments',
        max_clarifier_values: 'maxClarifierValues',
        max_datatype_components: 'maxDatatypeComponents',
    };
    return {
        limits: Object.fromEntries(Object.entries(vector.input.limits).map(([name, value]) => {
            const target = names[name];
            if (target === undefined) throw new Error(`Unknown Telex CTS limit: ${name}`);
            return [target, value];
        })),
    };
}

function capture(operation) {
    try {
        return { ok: true, value: operation() };
    } catch (error) {
        assert.ok(error instanceof Error, `Expected Error, received ${String(error)}`);
        return {
            ok: false,
            error: {
                name: error.name,
                message: error.message,
                code: error.code,
                line: error.line,
                counter: error.counter,
                observed: error.observed,
                limit: error.limit,
            },
        };
    }
}

function assertSamePhysicalResult(actual, expected) {
    assert.equal(actual.ok, expected.ok);
    if (actual.ok) {
        assert.deepEqual(actual.value, expected.value);
        return;
    }
    if (expected.error.counter === 'max_input_bytes') {
        assert.deepEqual(
            {
                ...actual.error,
                message: undefined,
                observed: undefined,
            },
            {
                ...expected.error,
                message: undefined,
                observed: undefined,
            },
        );
        return;
    }
    assert.deepEqual(actual.error, expected.error);
}

async function main() {
    const manifestPath = option('--cts');
    const modulePath = option('--module');
    const incremental = await import(pathToFileURL(modulePath).href);
    const oneShotPath = path.resolve(path.dirname(modulePath), 'telex.js');
    const oneShot = await import(pathToFileURL(oneShotPath).href);
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    assert.equal(manifest.meta.format, 'telex.aes');
    assert.equal(manifest.meta.format_version, '1');

    let vectors = 0;
    let splitRuns = 0;
    for (const suiteRef of manifest.suites) {
        const suitePath = path.resolve(path.dirname(manifestPath), suiteRef.file);
        const suite = JSON.parse(await readFile(suitePath, 'utf8'));
        assert.equal(suite.id, suiteRef.id);
        for (const vector of suite.tests) {
            const options = limitOptions(vector);
            const semanticOptions = {
                ...options,
                registeredFields: vector.input.registered_fields ?? [],
            };
            const bytes = new TextEncoder().encode(vector.input.telex);
            const expectedPhysical = capture(() => oneShot.parseTelex(vector.input.telex, options));
            const expectedSemantic = vector.operation === 'validate' && expectedPhysical.ok
                ? oneShot.validateTelex(vector.input.telex, semanticOptions)
                : undefined;

            for (let split = 0; split <= bytes.byteLength; split += 1) {
                try {
                    const actualPhysical = capture(() => (
                        incremental.parseTelexInChunks(bytes, [split], options)
                    ));
                    assertSamePhysicalResult(actualPhysical, expectedPhysical);
                    if (expectedSemantic !== undefined) {
                        const actual = incremental.validateTelexInChunks(
                            bytes,
                            [split],
                            semanticOptions,
                        );
                        assert.deepEqual(actual.validation, expectedSemantic);
                    }
                    splitRuns += 1;
                } catch (error) {
                    throw new Error(`${vector.id} at byte split ${split}: ${error.message}`, { cause: error });
                }
            }
            vectors += 1;
        }
    }
    process.stdout.write(
        `Incremental Telex CTS differential passed: ${vectors} vector(s), ${splitRuns} split run(s)\n`,
    );
}

main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
});
