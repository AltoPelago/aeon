import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalize } from './index.js';

const cases = JSON.parse(readFileSync(new URL('../../../../../test-fixtures/empty-keys.json', import.meta.url), 'utf8')) as { id: string; source: string; error?: string }[];
for (const fixture of cases.filter(fixture => !fixture.error)) {
    test(`empty keys canonical round trip: ${fixture.id}`, () => {
        const first = canonicalize(fixture.source);
        assert.deepEqual(first.errors, []);
        assert.ok(first.text.includes('""'));
        const second = canonicalize(first.text);
        assert.deepEqual(second.errors, []);
        assert.equal(second.text, first.text);
    });
}
