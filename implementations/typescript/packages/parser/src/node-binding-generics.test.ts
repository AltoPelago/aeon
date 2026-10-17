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
        assert.equal(parsed.errors.length === 0, fixture.ok, JSON.stringify(parsed.errors));
        if (!fixture.ok) assert.ok(parsed.errors.some(error => error.code === 'SYNTAX_ERROR'));
    });
}

test('invalid node claims retain later bindings during parser recovery', () => {
    const parsed = parse(tokenize('bad:node<radix[2]> = <tag>\ngood = 1').tokens);
    assert.ok(parsed.errors.some(error => error.code === 'SYNTAX_ERROR'));
    assert.ok(parsed.document?.bindings.some(binding => binding.key === 'good'));
});
