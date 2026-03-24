import test from 'node:test';
import assert from 'node:assert/strict';
import { formatReferencePath } from './reference-path.js';

test('formats canonical reference member paths', () => {
    assert.equal(formatReferencePath(['a', 'b', 'c']), 'a.b.c');
});

test('formats canonical reference indexed paths', () => {
    assert.equal(formatReferencePath(['items', 1, 'name']), 'items[1].name');
});

test('formats quoted member and attribute segments', () => {
    assert.equal(
        formatReferencePath(['a.b', { type: 'attr', key: 'x.y' }, 'z w']),
        '["a.b"]@["x.y"].["z w"]'
    );
});

test('escapes backslashes inside quoted path segments', () => {
    assert.equal(
        formatReferencePath(['slash\\key', { type: 'attr', key: 'x\\y' }]),
        '["slash\\\\key"]@["x\\\\y"]'
    );
});
