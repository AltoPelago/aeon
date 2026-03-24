import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { getConfiguredDiagnostics } from './validation.js';

function writeFile(dir: string, name: string, contents: string): string {
    const file = path.join(dir, name);
    fs.writeFileSync(file, contents, 'utf-8');
    return file;
}

function sha256(file: string): string {
    return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

test('reports unknown schema contract ids from trusted registry', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-lsp-validation-'));
    const registryPath = writeFile(dir, 'registry.json', JSON.stringify({ contracts: [] }, null, 2));

    const diagnostics = getConfiguredDiagnostics('app = { name = "demo" }\n', null, {
        contractRegistry: registryPath,
        schema: 'aeon.missing.schema.v1',
    });

    assert.ok(diagnostics.some((diag) => diag.code === 'CONTRACT_UNKNOWN_SCHEMA_ID'));
});

test('reports contract hash mismatches fail-closed', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-lsp-validation-'));
    const schemaPath = writeFile(dir, 'schema.json', JSON.stringify({
        schema_id: 'aeon.demo.schema.v1',
        schema_version: '1.0.0',
        rules: [],
    }, null, 2));
    const registryPath = writeFile(dir, 'registry.json', JSON.stringify({
        contracts: [{
            id: 'aeon.demo.schema.v1',
            kind: 'schema',
            version: '1.0.0',
            path: './schema.json',
            sha256: '0'.repeat(64),
            status: 'active',
        }],
    }, null, 2));

    const diagnostics = getConfiguredDiagnostics('app = { name = "demo" }\n', null, {
        contractRegistry: registryPath,
        schema: 'aeon.demo.schema.v1',
    });

    assert.ok(fs.existsSync(schemaPath));
    assert.ok(diagnostics.some((diag) => diag.code === 'CONTRACT_ARTIFACT_HASH_MISMATCH'));
});

test('validates against a trusted registry schema and surfaces schema errors', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-lsp-validation-'));
    const schemaPath = writeFile(dir, 'schema.json', JSON.stringify({
        schema_id: 'aeon.demo.schema.v1',
        schema_version: '1.0.0',
        rules: [
            { path: '$.app.name', constraints: { type: 'StringLiteral', required: true } },
            { path: '$.app.port', constraints: { type: 'NumberLiteral', required: true } },
        ],
    }, null, 2));
    const registryPath = writeFile(dir, 'registry.json', JSON.stringify({
        contracts: [{
            id: 'aeon.demo.schema.v1',
            kind: 'schema',
            version: '1.0.0',
            path: './schema.json',
            sha256: sha256(schemaPath),
            status: 'active',
        }],
    }, null, 2));

    const diagnostics = getConfiguredDiagnostics('app = { name = "demo" }\n', null, {
        contractRegistry: registryPath,
        schema: 'aeon.demo.schema.v1',
    });

    assert.ok(diagnostics.some((diag) => diag.code === 'missing_required_field'));
});

test('accepts datatype_rules in schema contracts and enforces gp-style numeric semantics', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-lsp-validation-'));
    const schemaPath = writeFile(dir, 'schema.json', JSON.stringify({
        schema_id: 'aeon.demo.schema.v1',
        schema_version: '1.0.0',
        rules: [],
        datatype_rules: {
            uint: { type: 'IntegerLiteral', sign: 'unsigned' },
        },
    }, null, 2));
    const registryPath = writeFile(dir, 'registry.json', JSON.stringify({
        contracts: [{
            id: 'aeon.demo.schema.v1',
            kind: 'schema',
            version: '1.0.0',
            path: './schema.json',
            sha256: sha256(schemaPath),
            status: 'active',
        }],
    }, null, 2));

    const diagnostics = getConfiguredDiagnostics('value:uint = -1\n', null, {
        contractRegistry: registryPath,
        schema: 'aeon.demo.schema.v1',
    });

    assert.ok(diagnostics.some((diag) => diag.code === 'numeric_form_violation'));
});

test('accepts closed-world schema contracts and rejects unexpected bindings', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-lsp-validation-'));
    const schemaPath = writeFile(dir, 'schema.json', JSON.stringify({
        schema_id: 'aeon.demo.schema.v1',
        schema_version: '1.0.0',
        world: 'closed',
        rules: [
            { path: '$.app', constraints: { type: 'ObjectNode' } },
            { path: '$.app.name', constraints: { type: 'StringLiteral', required: true } },
        ],
    }, null, 2));
    const registryPath = writeFile(dir, 'registry.json', JSON.stringify({
        contracts: [{
            id: 'aeon.demo.schema.v1',
            kind: 'schema',
            version: '1.0.0',
            path: './schema.json',
            sha256: sha256(schemaPath),
            status: 'active',
        }],
    }, null, 2));

    const diagnostics = getConfiguredDiagnostics('app = { name = "demo", port = 8080 }\n', null, {
        contractRegistry: registryPath,
        schema: 'aeon.demo.schema.v1',
    });

    assert.ok(diagnostics.some((diag) => diag.code === 'unexpected_binding'));
});
