import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compile, compileToTelex, formatPath } from './index.js';

const cases = JSON.parse(readFileSync(new URL('../../../../../test-fixtures/empty-keys.json', import.meta.url), 'utf8')) as { id: string; source: string; paths?: string[]; error?: string }[];
for (const fixture of cases) {
    test(`empty keys: ${fixture.id}`, () => {
        const result = compile(fixture.source);
        if (fixture.error) {
            assert.ok(result.errors.some(error => error.code === fixture.error), JSON.stringify(result.errors));
        } else {
            assert.deepEqual(result.errors, []);
            assert.deepEqual(result.events.map(event => formatPath(event.path)), fixture.paths);
            const transport = compileToTelex(fixture.source);
            assert.deepEqual(transport.compile.errors, []);
            assert.ok(transport.telex?.includes('.[""]'));
        }
    });
}
