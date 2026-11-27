import assert from 'node:assert/strict';
import test from 'node:test';
import fixtures from '../../../../../test-fixtures/node-binding-generics-tagged-nodes.json' with { type: 'json' };
import { tokenize } from '@altopelago/aeon-lexer';
import { parse } from './parser.js';

for (const fixture of fixtures) {
    test(`node datatype generic arguments: ${fixture.source}`, () => {
        const lexed = tokenize(fixture.source);
        assert.deepEqual(lexed.errors, []);
        const parsed = parse(lexed.tokens, { maxAttributeDepth: 2 });
        assert.deepEqual(parsed.errors, []);
    });
}
