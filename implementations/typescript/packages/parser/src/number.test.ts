import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeNumberLiteral } from './number.js';

test('normalizes number literal values to canonical finite numeric text', () => {
    const cases = new Map([
        ['+5', '5'],
        ['+.50', '0.5'],
        ['10.00', '10.0'],
        ['1.0E+03', '1e3'],
        ['1e0_1', '1e1'],
        ['0e+01', '0e0'],
        ['0e-01', '0e0'],
        ['-0e+01', '-0e0'],
        ['-0e-01', '-0e0'],
    ]);
    for (const [source, expected] of cases) {
        assert.equal(normalizeNumberLiteral(source), expected, source);
    }
});

test('normalizes a long fractional suffix in linear time', () => {
    assert.equal(normalizeNumberLiteral(`1.${'0'.repeat(100_000)}`), '1.0');
});
