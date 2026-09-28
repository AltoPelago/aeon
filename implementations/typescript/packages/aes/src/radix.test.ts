import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    AEON_RADIX_MAX_BASE,
    AEON_RADIX_MIN_BASE,
    aeonRadixBaseFromDatatype,
    aeonRadixDigitValue,
    aeonRadixScale,
} from './radix.js';

describe('AEON radix utilities', () => {
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
