#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function option(name) {
    const index = process.argv.indexOf(name);
    if (index === -1 || !process.argv[index + 1]) throw new Error(`${name} requires a path`);
    return path.resolve(process.argv[index + 1]);
}

async function main() {
    const manifestPath = option('--cts');
    const modulePath = option('--module');
    const aes = await import(pathToFileURL(modulePath).href);
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    assert.equal(manifest.meta.lane, 'aes-events');
    assert.equal(manifest.meta.event_contract, 'aes.events.v0');

    let passed = 0;
    for (const suiteRef of manifest.suites) {
        const suitePath = path.resolve(path.dirname(manifestPath), suiteRef.file);
        const suite = JSON.parse(await readFile(suitePath, 'utf8'));
        assert.equal(suite.id, suiteRef.id);
        for (const vector of suite.tests) {
            try {
                assert.equal(vector.operation, 'validate');
                const result = aes.validateTelexRecords(vector.input.records, {
                    ...(vector.input.profile === undefined ? {} : { profile: vector.input.profile }),
                    ...(vector.input.projection === undefined ? {} : { projection: vector.input.projection }),
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
                passed += 1;
            } catch (error) {
                throw new Error(`${vector.id}: ${error.message}`, { cause: error });
            }
        }
    }
    process.stdout.write(`AES Events CTS passed: ${passed} vector(s)\n`);
}

main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
});
