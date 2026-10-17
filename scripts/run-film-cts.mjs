#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
    const filmNames = {
        max_input_bytes: 'maxInputBytes',
        max_record_bytes: 'maxRecordBytes',
        max_field_bytes: 'maxFieldBytes',
        max_buffered_bytes: 'maxBufferedBytes',
    };
    const aesNames = {
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
    const filmLimits = {};
    const aesLimits = {};
    for (const [name, value] of Object.entries(vector.input.limits ?? {})) {
        if (filmNames[name] !== undefined) {
            filmLimits[filmNames[name]] = value;
        } else if (aesNames[name] !== undefined) {
            aesLimits[aesNames[name]] = value;
        } else {
            throw new Error(`Unknown Film CTS limit: ${name}`);
        }
    }
    return {
        registeredFields: vector.input.registered_fields ?? [],
        filmLimits,
        aesLimits,
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

function checkRead(read, vector, codec) {
    if (vector.expected.ok === false) {
        assert.throws(read, (error) => {
            assert.ok(error instanceof codec.FilmDecodeError);
            const expected = vector.expected.error;
            if (expected.code !== undefined) assert.equal(error.code, expected.code);
            if (expected.stage !== undefined) assert.equal(error.stage, expected.stage);
            if (expected.diagnostic_codes !== undefined) {
                assert.deepEqual(error.diagnostics.map(({ code }) => code).sort(),
                    [...expected.diagnostic_codes].sort());
            }
            return true;
        });
        return undefined;
    }
    const stream = read();
    if (vector.operation === 'decode' && vector.expected.stream !== undefined) {
        assert.deepEqual(streamForCts(stream), vector.expected.stream);
    } else if (vector.operation === 'encode') {
        assert.deepEqual(streamForCts(stream), vector.input.stream);
    } else if (vector.operation === 'transcode') {
        assert.deepEqual(streamForCts(stream), streamForCts(codec.parseTelex(vector.input.telex)));
    }
    return stream;
}

async function main() {
    const manifestPath = option('--cts');
    const modulePath = option('--module');
    const codec = await import(pathToFileURL(modulePath).href);
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    assert.equal(manifest.meta.format, 'film.aes');
    assert.equal(manifest.meta.format_version, '1');
    assert.equal(manifest.meta.snapshot_id, 'film-cts-v1-snapshot-0.4');

    let directDecode = 0;
    let producerFixtures = 0;
    let encoderOnly = 0;
    let incrementalVectors = 0;
    let incrementalSplits = 0;
    for (const suiteRef of manifest.suites) {
        const suitePath = path.resolve(path.dirname(manifestPath), suiteRef.file);
        const suiteBytes = await readFile(suitePath);
        assert.equal(createHash('sha256').update(suiteBytes).digest('hex'), suiteRef.content_sha256,
            `${suiteRef.id}: suite digest differs from the immutable manifest`);
        const suite = JSON.parse(suiteBytes.toString('utf8'));
        assert.equal(suite.id, suiteRef.id);
        const excluded = new Set(suiteRef.exclude_tests ?? []);
        const vectors = suite.tests.filter((vector) => !excluded.has(vector.id));
        for (const vector of vectors) {
            if (vector.operation === 'encode' && vector.expected.film_hex === undefined) {
                assert.equal(vector.expected.ok, false, `${vector.id}: missing positive producer bytes`);
                encoderOnly += 1;
                continue;
            }
            if (vector.operation === 'decode') directDecode += 1;
            else producerFixtures += 1;
            const filmHex = vector.operation === 'decode'
                ? vector.input.film_hex
                : vector.expected.film_hex;
            assert.notEqual(filmHex, undefined, `${vector.operation} vector does not provide Film bytes for reader verification`);
            try {
                const bytes = fromHex(filmHex);
                const options = vectorOptions(vector);
                const expected = checkRead(() => codec.decodeFilm(bytes, options), vector, codec);
                if (suiteRef.id === 'next-film-logical-generic-depth') {
                    for (let split = 0; split <= bytes.length; split += 1) {
                        const actual = checkRead(() => {
                            const decoder = new codec.IncrementalFilmDecoder(options);
                            const first = decoder.push(bytes.subarray(0, split));
                            assert.notEqual(first.status, 'complete');
                            const final = decoder.push(bytes.subarray(split), { final: true });
                            assert.equal(final.status, 'complete');
                            return final.stream;
                        }, vector, codec);
                        assert.deepEqual(actual, expected, `incremental split=${split}`);
                        incrementalSplits += 1;
                    }
                    incrementalVectors += 1;
                }
            } catch (error) {
                throw new Error(`${vector.id}: ${error.message}`, { cause: error });
            }
        }
    }
    assert.deepEqual({ directDecode, producerFixtures, encoderOnly, incrementalVectors }, {
        directDecode: 103, producerFixtures: 13, encoderOnly: 12, incrementalVectors: 34,
    });
    process.stdout.write(`Film reader CTS passed: ${directDecode} decode + ${producerFixtures} producer fixtures; `
        + `${encoderOnly} encoder-only negatives skipped; ${incrementalVectors} incremental vectors / ${incrementalSplits} splits\n`);
}

main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
});
