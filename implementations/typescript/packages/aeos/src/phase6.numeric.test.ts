/**
 * @aeos/core - Phase 6 Numeric Form Tests (draft)
 *
 * These tests mirror the CTS Phase 6 cases and are intended to be
 * enabled once Phase 6 numeric-form validation is implemented.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { validate } from './validate.js';
import { ErrorCodes } from './diag/codes.js';
import type { AES } from './types/aes.js';
import type { SchemaV1 } from './types/schema.js';

describe('Phase 6: Numeric Form (draft tests)', () => {
    it('unsigned sign violation (negative value for unsigned)', () => {
        const aes: AES = [
            {
                path: { segments: [{ type: 'root' }, { type: 'member', key: 'n' }] },
                key: 'n',
                value: { type: 'NumberLiteral', raw: '-1', value: '-1', span: [20, 21] },
                span: [20, 21],
            },
        ] as unknown as AES;

        const schema: SchemaV1 = { rules: [{ path: '$.n', constraints: { type: 'IntegerLiteral', sign: 'unsigned' } }] };

        const result = validate(aes, schema);

        assert.strictEqual(result.ok, false);
        assert.ok(result.errors.some(e => e.code === ErrorCodes.NUMERIC_FORM_VIOLATION || e.code === 'numeric_form_violation'));
    });

    it('min_digits violation (literal shorter than min_digits)', () => {
        const aes: AES = [
            {
                path: { segments: [{ type: 'root' }, { type: 'member', key: 'p' }] },
                key: 'p',
                value: { type: 'NumberLiteral', raw: '12', value: '12', span: [22, 23] },
                span: [22, 23],
            },
        ] as unknown as AES;

        const schema: SchemaV1 = { rules: [{ path: '$.p', constraints: { type: 'IntegerLiteral', min_digits: 3 } }] };

        const result = validate(aes, schema);

        assert.strictEqual(result.ok, false);
        assert.ok(result.errors.some(e => e.code === ErrorCodes.NUMERIC_FORM_VIOLATION || e.code === 'numeric_form_violation'));
    });

    it('max_digits violation (literal longer than max_digits)', () => {
        const aes: AES = [
            {
                path: { segments: [{ type: 'root' }, { type: 'member', key: 'q' }] },
                key: 'q',
                value: { type: 'NumberLiteral', raw: '12345', value: '12345', span: [24, 25] },
                span: [24, 25],
            },
        ] as unknown as AES;

        const schema: SchemaV1 = { rules: [{ path: '$.q', constraints: { type: 'IntegerLiteral', max_digits: 2 } }] };

        const result = validate(aes, schema);

        assert.strictEqual(result.ok, false);
        assert.ok(result.errors.some(e => e.code === ErrorCodes.NUMERIC_FORM_VIOLATION || e.code === 'numeric_form_violation'));
    });

    it('numeric pass case (meets sign and digit constraints)', () => {
        const aes: AES = [
            {
                path: { segments: [{ type: 'root' }, { type: 'member', key: 'r' }] },
                key: 'r',
                value: { type: 'NumberLiteral', raw: '123', value: '123', span: [26, 27] },
                span: [26, 27],
            },
        ] as unknown as AES;

        const schema: SchemaV1 = { rules: [{ path: '$.r', constraints: { type: 'IntegerLiteral', sign: 'unsigned', min_digits: 1, max_digits: 5 } }] };

        const result = validate(aes, schema);

        assert.strictEqual(result.ok, true);
        assert.strictEqual(result.errors.length, 0);
    });

    it('datatype_rules reject negative uint values', () => {
        const aes: AES = [
            {
                path: { segments: [{ type: 'root' }, { type: 'member', key: 'n' }] },
                key: 'n',
                datatype: 'uint',
                value: { type: 'NumberLiteral', raw: '-1', value: '-1', span: [20, 21] },
                span: [20, 21],
            },
        ] as unknown as AES;

        const schema: SchemaV1 = {
            rules: [],
            datatype_rules: {
                uint: { type: 'IntegerLiteral', sign: 'unsigned' },
            },
        };

        const result = validate(aes, schema);

        assert.strictEqual(result.ok, false);
        assert.ok(result.errors.some(e => e.code === ErrorCodes.NUMERIC_FORM_VIOLATION || e.code === 'numeric_form_violation'));
    });

    it('datatype_rules reject out-of-range int32 values', () => {
        const aes: AES = [
            {
                path: { segments: [{ type: 'root' }, { type: 'member', key: 'n' }] },
                key: 'n',
                datatype: 'int32',
                value: { type: 'NumberLiteral', raw: '2147483648', value: '2147483648', span: [30, 40] },
                span: [30, 40],
            },
        ] as unknown as AES;

        const schema: SchemaV1 = {
            rules: [],
            datatype_rules: {
                int32: {
                    type: 'IntegerLiteral',
                    min_value: '-2147483648',
                    max_value: '2147483647',
                },
            },
        };

        const result = validate(aes, schema);

        assert.strictEqual(result.ok, false);
        assert.ok(result.errors.some(e => e.code === ErrorCodes.NUMERIC_FORM_VIOLATION || e.code === 'numeric_form_violation'));
    });

    it('datatype_rules distinguish integer and float forms', () => {
        const aes: AES = [
            {
                path: { segments: [{ type: 'root' }, { type: 'member', key: 'n' }] },
                key: 'n',
                datatype: 'float32',
                value: { type: 'NumberLiteral', raw: '10', value: '10', span: [50, 52] },
                span: [50, 52],
            },
        ] as unknown as AES;

        const schema: SchemaV1 = {
            rules: [],
            datatype_rules: {
                float32: { type: 'FloatLiteral' },
            },
        };

        const result = validate(aes, schema);

        assert.strictEqual(result.ok, false);
        assert.ok(result.errors.some(e => e.code === ErrorCodes.TYPE_MISMATCH || e.code === 'type_mismatch'));
    });
});
