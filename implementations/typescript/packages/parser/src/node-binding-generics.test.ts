import assert from 'node:assert/strict';
import test from 'node:test';
import fixtures from '../../../../../test-fixtures/node-binding-generics.json' with { type: 'json' };
import { tokenize } from '@altopelago/aeon-lexer';
import { parse } from './parser.js';

for (const fixture of fixtures) {
    test(`binding-side node generic arguments: ${fixture.source}`, () => {
        const lexed = tokenize(fixture.source);
        assert.deepEqual(lexed.errors, []);
        const parsed = parse(lexed.tokens);
        assert.deepEqual(parsed.errors, []);
    });
}
