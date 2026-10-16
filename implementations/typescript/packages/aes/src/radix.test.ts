import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fixtures from '../../../../../test-fixtures/radix-bases.json' with { type: 'json' };
import {
    AEON_RADIX_MAX_BASE,
    AEON_RADIX_MIN_BASE,
    aeonRadixBaseFromDatatype,
    aeonRadixBaseFromNumber,
    resolveAeonRadixBaseFromDatatype,
    resolveAeonRadixBaseFromComponents,
    aeonRadixDigitValue,
    aeonRadixScale,
} from './radix.js';

describe('AEON radix utilities', () => {
    for (const { literal, base } of fixtures) {
        it(`resolves the exact numeric value of ${JSON.stringify(literal)}`, () => {
            assert.equal(aeonRadixBaseFromNumber(literal), base ?? undefined);
        });
    }

    it('distinguishes absent, invalid, and exact integral declarations', () => {
        assert.deepEqual(resolveAeonRadixBaseFromDatatype('radix'), { kind: 'unspecified' });
        assert.deepEqual(resolveAeonRadixBaseFromDatatype('custom[2]'), { kind: 'unspecified' });
        assert.deepEqual(resolveAeonRadixBaseFromDatatype('radix[2.0000000000000001]'), { kind: 'invalid' });
        assert.deepEqual(resolveAeonRadixBaseFromDatatype('radix[2.00]'), { kind: 'base', base: 2 });
        assert.deepEqual(resolveAeonRadixBaseFromComponents('radix', []), { kind: 'unspecified' });
        for (const clarifiers of [[{ kind: 'StringLiteral', value: '2' }], [{ kind: 'NumberLiteral', value: '2' }, { kind: 'NumberLiteral', value: '10' }]]) {
            assert.deepEqual(resolveAeonRadixBaseFromComponents('radix', clarifiers), { kind: 'invalid' });
        }
    });

    it('bounds work by input size, not by the represented exponent', () => {
        const zeros = '0'.repeat(100_000);
        assert.equal(aeonRadixBaseFromNumber(`2e${zeros}`), 2);
        assert.equal(aeonRadixBaseFromNumber(`2e${'9'.repeat(100_000)}`), undefined);
        assert.equal(aeonRadixBaseFromNumber(`2e-${'9'.repeat(100_000)}`), undefined);
        assert.equal(aeonRadixBaseFromNumber(`2${zeros}e-100000`), 2);
    });

    it('matches an independent bounded rational oracle', () => {
        for (let coefficient = 0; coefficient < 1000; coefficient += 7) {
            for (let exponent = -5; exponent <= 5; exponent += 1) {
                const numerator = BigInt(coefficient) * 10n ** BigInt(Math.max(0, exponent));
                const denominator = 10n ** BigInt(Math.max(0, -exponent));
                const quotient = numerator / denominator;
                const expected = numerator % denominator === 0n && quotient >= 2n && quotient <= 64n ? Number(quotient) : undefined;
                assert.equal(aeonRadixBaseFromNumber(`${coefficient}e${exponent}`), expected);
            }
        }
    });
    it('maps the complete case-sensitive base-64 digit alphabet', () => {
        assert.equal(AEON_RADIX_MIN_BASE, 2);
        assert.equal(AEON_RADIX_MAX_BASE, 64);
        assert.equal(aeonRadixDigitValue('0'), 0);
        assert.equal(aeonRadixDigitValue('9'), 9);
        assert.equal(aeonRadixDigitValue('A'), 10);
        assert.equal(aeonRadixDigitValue('Z'), 35);
        assert.equal(aeonRadixDigitValue('a'), 36);
        assert.equal(aeonRadixDigitValue('z'), 61);
        assert.equal(aeonRadixDigitValue('&'), 62);
        assert.equal(aeonRadixDigitValue('!'), 63);
        assert.equal(aeonRadixDigitValue('/'), null);
        assert.equal(aeonRadixDigitValue('AA'), null);
    });

    it('resolves decimal, reserved aliases, and bracket bases', () => {
        assert.equal(aeonRadixBaseFromDatatype('decimal'), 10);
        assert.equal(aeonRadixBaseFromDatatype('radix2'), 2);
        assert.equal(aeonRadixBaseFromDatatype('radix6'), 6);
        assert.equal(aeonRadixBaseFromDatatype('radix8'), 8);
        assert.equal(aeonRadixBaseFromDatatype('radix12'), 12);
        assert.equal(aeonRadixBaseFromDatatype('radix[ 64 ]'), 64);
        assert.equal(aeonRadixBaseFromDatatype('radix[1]'), undefined);
        assert.equal(aeonRadixBaseFromDatatype('radix[65]'), undefined);
        assert.equal(aeonRadixBaseFromDatatype('radix16'), undefined);
        assert.equal(aeonRadixBaseFromDatatype(undefined), undefined);
    });

    it('reports representation-preserving fractional scale', () => {
        assert.equal(aeonRadixScale('19.9900', 10), 4);
        assert.equal(aeonRadixScale('19.99', 10), 2);
        assert.equal(aeonRadixScale('101', 2), 0);
        assert.equal(aeonRadixScale('-.0_0', 2), 2);
        assert.equal(aeonRadixScale('A.0', 10), null);
        assert.equal(aeonRadixScale('1.', 10), null);
    });
});
