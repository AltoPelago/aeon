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

function syntaxFailure(error, TelexSyntaxError) {
    assert.ok(error instanceof TelexSyntaxError, `Expected TelexSyntaxError, received ${String(error)}`);
    return { code: error.code, line: error.line ?? null };
}

async function main() {
    const manifestPath = option('--cts');
    const modulePath = option('--module');
    const codec = await import(pathToFileURL(modulePath).href);
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    assert.equal(manifest.meta.format, 'telex.aes');
    assert.equal(manifest.meta.format_version, '0');

    let passed = 0;
    for (const suiteRef of manifest.suites) {
        const suitePath = path.resolve(path.dirname(manifestPath), suiteRef.file);
        const suite = JSON.parse(await readFile(suitePath, 'utf8'));
        assert.equal(suite.id, suiteRef.id);
        for (const vector of suite.tests) {
            try {
                const options = limitOptions(vector);
                if (vector.operation === 'parse') {
                    try {
                        const parsed = codec.parseTelex(vector.input.telex, options);
                        assert.notEqual(vector.expected.ok, false, 'expected parse failure');
                        assert.deepEqual({
                            ok: true,
                            version: parsed.version,
                            profile: parsed.profile,
                            profile_explicit: parsed.profileExplicit,
                            projection: parsed.projection,
                            projection_explicit: parsed.projectionExplicit,
                            canonical: parsed.canonical,
                            records: parsed.records,
                        }, vector.expected);
                    } catch (error) {
                        assert.equal(vector.expected.ok, false, `unexpected parse failure: ${error.message}`);
                        assert.deepEqual(syntaxFailure(error, codec.TelexSyntaxError), vector.expected.error);
                    }
                } else if (vector.operation === 'canonicalize') {
                    try {
                        const telex = codec.canonicalizeTelex(vector.input.telex, options);
                        assert.notEqual(vector.expected.ok, false, 'expected canonicalization failure');
                        assert.deepEqual({ ok: true, telex }, vector.expected);
                    } catch (error) {
                        assert.equal(vector.expected.ok, false, `unexpected canonicalization failure: ${error.message}`);
                        assert.deepEqual(syntaxFailure(error, codec.TelexSyntaxError), vector.expected.error);
                    }
                } else if (vector.operation === 'validate') {
                    const result = codec.validateTelex(vector.input.telex, {
                        ...options,
                        registeredFields: vector.input.registered_fields ?? [],
                    });
                    assert.deepEqual({
                        valid: result.valid,
                        profile: result.profile,
                        diagnostic_codes: result.diagnostics.map(({ code }) => code).sort(),
                    }, {
                        ...vector.expected,
                        diagnostic_codes: [...vector.expected.diagnostic_codes].sort(),
                    });
                } else {
                    throw new Error(`Unsupported Telex CTS operation: ${vector.operation}`);
                }
                passed += 1;
            } catch (error) {
                throw new Error(`${vector.id}: ${error.message}`, { cause: error });
            }
        }
    }
    process.stdout.write(`Telex CTS passed: ${passed} vector(s)\n`);
}

main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
});
