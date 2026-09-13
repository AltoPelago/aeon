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

function vectorOptions(vector) {
    const names = {
        max_input_bytes: 'maxInputBytes',
        max_record_bytes: 'maxRecordBytes',
        max_field_bytes: 'maxFieldBytes',
        max_buffered_bytes: 'maxBufferedBytes',
        max_events: 'maxEvents',
        max_path_depth: 'maxPathDepth',
        max_path_characters: 'maxPathCharacters',
        max_attribute_depth: 'maxAttributeDepth',
        max_value_nesting_depth: 'maxValueNestingDepth',
        max_string_codepoints: 'maxStringCodepoints',
        max_key_segment_codepoints: 'maxKeySegmentCodepoints',
        max_list_items: 'maxListItems',
        max_tuple_items: 'maxTupleItems',
        max_generic_depth: 'maxGenericDepth',
        max_generic_arguments: 'maxGenericArguments',
        max_clarifier_values: 'maxClarifierValues',
        max_datatype_components: 'maxDatatypeComponents',
    };
    return {
        registeredFields: vector.input.registered_fields ?? [],
        limits: Object.fromEntries(Object.entries(vector.input.limits ?? {}).map(([name, value]) => {
            const target = names[name];
            if (target === undefined) throw new Error(`Unknown Film CTS limit: ${name}`);
            return [target, value];
        })),
    };
}

function fromHex(input) {
    return Uint8Array.from(input.match(/../gu) ?? [], (pair) => Number.parseInt(pair, 16));
}

function streamForCts(stream) {
    return {
        profile: stream.profile,
        profile_explicit: stream.profileExplicit,
        projection: stream.projection,
        projection_explicit: stream.projectionExplicit,
        records: stream.records,
    };
}

async function main() {
    const manifestPath = option('--cts');
    const modulePath = option('--module');
    const codec = await import(pathToFileURL(modulePath).href);
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    assert.equal(manifest.meta.format, 'film.aes');
    assert.equal(manifest.meta.format_version, '1');
    assert.equal(manifest.meta.snapshot_id, 'film-cts-v1-snapshot-0.1');

    let passed = 0;
    let encoderOnly = 0;
    for (const suiteRef of manifest.suites) {
        const suitePath = path.resolve(path.dirname(manifestPath), suiteRef.file);
        const suite = JSON.parse(await readFile(suitePath, 'utf8'));
        assert.equal(suite.id, suiteRef.id);
        for (const vector of suite.tests) {
            const filmHex = vector.operation === 'decode'
                ? vector.input.film_hex
                : vector.expected.film_hex;
            if (filmHex === undefined) {
                encoderOnly += 1;
                continue;
            }
            try {
                try {
                    const stream = codec.decodeFilm(fromHex(filmHex), vectorOptions(vector));
                    assert.notEqual(vector.expected.ok, false, 'expected Film decoding to fail');
                    if (vector.operation === 'decode' && vector.expected.stream !== undefined) {
                        assert.deepEqual(streamForCts(stream), vector.expected.stream);
                    } else if (vector.operation === 'encode') {
                        assert.deepEqual(streamForCts(stream), vector.input.stream);
                    } else if (vector.operation === 'transcode') {
                        const telex = codec.parseTelex(vector.input.telex);
                        assert.deepEqual(streamForCts(stream), streamForCts(telex));
                    }
                } catch (error) {
                    assert.equal(vector.expected.ok, false, `unexpected Film decode failure: ${error.message}`);
                    assert.ok(error instanceof codec.FilmDecodeError);
                    if (vector.expected.error.code !== undefined) {
                        assert.equal(error.code, vector.expected.error.code);
                    } else {
                        assert.equal(error.stage, 'aes');
                        assert.deepEqual(
                            error.diagnostics.map(({ code }) => code).sort(),
                            [...vector.expected.error.diagnostic_codes].sort(),
                        );
                    }
                }
                passed += 1;
            } catch (error) {
                throw new Error(`${vector.id}: ${error.message}`, { cause: error });
            }
        }
    }
    assert.equal(encoderOnly, 1);
    process.stdout.write(`Film reader CTS passed: ${passed} vector(s); ${encoderOnly} encoder-only vector skipped\n`);
}

main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
});
