import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { lintManifest } from './lint.js';

function resolveSiblingCtsManifest(relativePath: string): string {
    const envRoot = process.env.AEONITE_CTS_ROOT;
    return envRoot
        ? path.resolve(envRoot, relativePath)
        : path.resolve('../../../../cts', relativePath);
}

test('accepts existing core CTS manifest', () => {
    const result = lintManifest(resolveSiblingCtsManifest('core/v1/core-cts.v1.json'));
    assert.equal(result.ok, true);
    assert.equal(result.issues.length, 0);
});

test('reports missing suite files', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-cts-author-'));
    const manifest = path.join(dir, 'manifest.json');
    fs.writeFileSync(manifest, JSON.stringify({
        meta: { version: '0.1.0' },
        suites: [{ id: 'missing', file: 'suites/missing.json' }],
    }, null, 2));

    const result = lintManifest(manifest);
    assert.equal(result.ok, false);
    assert.ok(result.issues.some((issue) => issue.message.includes(`references missing file 'suites/missing.json'`)));
});

test('reports duplicate test ids across suites', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-cts-author-'));
    fs.mkdirSync(path.join(dir, 'suites'));
    const manifest = path.join(dir, 'manifest.json');
    const suiteA = path.join(dir, 'suites', '01-a.json');
    const suiteB = path.join(dir, 'suites', '02-b.json');

    fs.writeFileSync(suiteA, JSON.stringify({
        id: 'a',
        title: 'A',
        tests: [{ id: 'dup', description: 'x', input: {}, expected: {} }],
    }, null, 2));
    fs.writeFileSync(suiteB, JSON.stringify({
        id: 'b',
        title: 'B',
        tests: [{ id: 'dup', description: 'y', input: {}, expected: {} }],
    }, null, 2));
    fs.writeFileSync(manifest, JSON.stringify({
        meta: { version: '0.1.0' },
        suites: [
            { id: 'a', file: 'suites/01-a.json' },
            { id: 'b', file: 'suites/02-b.json' },
        ],
    }, null, 2));

    const result = lintManifest(manifest);
    assert.equal(result.ok, false);
    assert.ok(result.issues.some((issue) => issue.message.includes(`Duplicate test id 'dup'`)));
});

test('reports missing spec refs', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-cts-author-'));
    fs.mkdirSync(path.join(dir, 'suites'));
    const manifest = path.join(dir, 'manifest.json');
    const suite = path.join(dir, 'suites', '01-a.json');

    fs.writeFileSync(suite, JSON.stringify({
        id: 'a',
        title: 'A',
        meta: { spec_refs: ['specs/does-not-exist.md'] },
        tests: [{ id: 'ok', description: 'x', input: {}, expected: {} }],
    }, null, 2));
    fs.writeFileSync(manifest, JSON.stringify({
        meta: { version: '0.1.0' },
        suites: [{ id: 'a', file: 'suites/01-a.json' }],
    }, null, 2));

    const result = lintManifest(manifest);
    assert.equal(result.ok, false);
    assert.ok(result.issues.some((issue) => issue.message.includes('Referenced spec path does not exist')));
});
