/**
 * @aeos/core - Schema Index Tests
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { buildRuleIndex } from './schemaIndex.js';
import { createDiagContext } from '../diag/emit.js';
import { ErrorCodes } from '../diag/codes.js';
import type { SchemaV1 } from '../types/schema.js';

describe('buildRuleIndex()', () => {
    it('builds index from valid schema', () => {
        const schema: SchemaV1 = {
            rules: [
                { path: '$.a', constraints: { type: 'IntegerLiteral' } },
                { path: '$.b', constraints: { required: true } },
            ],
        };
        const ctx = createDiagContext();

        const index = buildRuleIndex(schema, ctx);

        assert.strictEqual(index.size, 2);
        assert.strictEqual(index.get('$.a')?.constraints.type, 'IntegerLiteral');
        assert.strictEqual(index.get('$.b')?.constraints.required, true);
        assert.strictEqual(ctx.errors.length, 0);
    });

    it('returns empty index for empty rules', () => {
        const schema: SchemaV1 = { rules: [] };
        const ctx = createDiagContext();

        const index = buildRuleIndex(schema, ctx);

        assert.strictEqual(index.size, 0);
        assert.strictEqual(ctx.errors.length, 0);
    });

    it('emits error for missing path', () => {
        const schema = {
            rules: [
                { constraints: { type: 'StringLiteral' } } as any,
            ],
        } as SchemaV1;
        const ctx = createDiagContext();

        const index = buildRuleIndex(schema, ctx);

        assert.strictEqual(index.size, 0);
        assert.strictEqual(ctx.errors.length, 1);
        assert.strictEqual(ctx.errors[0]?.code, ErrorCodes.RULE_MISSING_PATH);
    });

    it('emits error for duplicate rule paths', () => {
        const schema: SchemaV1 = {
            rules: [
                { path: '$.a', constraints: { type: 'IntegerLiteral' } },
                { path: '$.a', constraints: { type: 'StringLiteral' } },
            ],
        };
        const ctx = createDiagContext();

        const index = buildRuleIndex(schema, ctx);

        // First one should be indexed, second rejected
        assert.strictEqual(index.size, 1);
        assert.strictEqual(ctx.errors.length, 1);
        assert.strictEqual(ctx.errors[0]?.code, ErrorCodes.DUPLICATE_RULE_PATH);
    });

    it('emits error for unknown constraint key', () => {
        const schema = {
            rules: [
                { path: '$.a', constraints: { unknown_key: true } as any },
            ],
        } as SchemaV1;
        const ctx = createDiagContext();

        const index = buildRuleIndex(schema, ctx);

        assert.strictEqual(index.size, 0);
        assert.strictEqual(ctx.errors.length, 1);
        assert.strictEqual(ctx.errors[0]?.code, ErrorCodes.UNKNOWN_CONSTRAINT_KEY);
    });

    it('accepts valid reference constraint combinations', () => {
        const schema: SchemaV1 = {
            reference_policy: 'allow',
            rules: [
                { path: '$.ref', constraints: { reference: 'require', reference_kind: 'either' } },
                { path: '$.ptr', constraints: { reference: 'require', reference_kind: 'pointer', type: 'PointerReference' } },
                { path: '$.literal', constraints: { reference: 'forbid', type: 'StringLiteral' } },
            ],
        };
        const ctx = createDiagContext();

        const index = buildRuleIndex(schema, ctx);

        assert.strictEqual(index.size, 3);
        assert.strictEqual(ctx.errors.length, 0);
    });

    it('rejects reference_kind without reference=require', () => {
        const schema: SchemaV1 = {
            rules: [
                { path: '$.a', constraints: { reference_kind: 'clone' } },
            ],
        };
        const ctx = createDiagContext();

        const index = buildRuleIndex(schema, ctx);

        assert.strictEqual(index.size, 0);
        assert.strictEqual(ctx.errors[0]?.code, ErrorCodes.INVALID_REFERENCE_CONSTRAINT);
    });

    it('rejects contradictory reference constraints', () => {
        const schema: SchemaV1 = {
            rules: [
                { path: '$.a', constraints: { reference: 'forbid', type: 'CloneReference' } },
            ],
        };
        const ctx = createDiagContext();

        const index = buildRuleIndex(schema, ctx);

        assert.strictEqual(index.size, 0);
        assert.strictEqual(ctx.errors[0]?.code, ErrorCodes.INVALID_REFERENCE_CONSTRAINT);
    });

    it('rejects rules that conflict with schema-wide reference_policy=forbid', () => {
        const schema: SchemaV1 = {
            reference_policy: 'forbid',
            rules: [
                { path: '$.a', constraints: { reference: 'require' } },
            ],
        };
        const ctx = createDiagContext();

        const index = buildRuleIndex(schema, ctx);

        assert.strictEqual(index.size, 0);
        assert.strictEqual(ctx.errors[0]?.code, ErrorCodes.INVALID_REFERENCE_CONSTRAINT);
    });
});
