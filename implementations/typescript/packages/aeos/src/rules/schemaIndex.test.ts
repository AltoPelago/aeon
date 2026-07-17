/**
 * @altopelago/aeos-core - Schema Index Tests
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
        } as unknown as SchemaV1;
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
        } as unknown as SchemaV1;
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

    it('accepts nested attribute constraints', () => {
        const schema: SchemaV1 = {
            rules: [
                {
                    path: '$.value',
                    constraints: {
                        type: 'NumberLiteral',
                        attributes: {
                            unit: {
                                required: true,
                                type: 'StringLiteral',
                                datatype: 'string',
                            },
                            meta: {
                                attributes: {
                                    label: {
                                        type: 'StringLiteral',
                                    },
                                },
                            },
                        },
                        closed_attributes: true,
                    },
                },
            ],
        };
        const ctx = createDiagContext();

        const index = buildRuleIndex(schema, ctx);

        assert.strictEqual(index.size, 1);
        assert.strictEqual(ctx.errors.length, 0);
    });

    it('rejects legacy indexed wildcard selectors because selectors are SANSA-only', () => {
        const schema: SchemaV1 = {
            rules: [
                { selector: '$.items[*]', constraints: { type: 'StringLiteral' } },
            ],
        };
        const ctx = createDiagContext();

        const index = buildRuleIndex(schema, ctx);

        assert.strictEqual(index.size, 0);
        assert.strictEqual(ctx.errors[0]?.code, ErrorCodes.INVALID_SCHEMA_POLICY);
    });

    it('rejects legacy indexed wildcard paths because paths are exact only', () => {
        const schema: SchemaV1 = {
            rules: [
                { path: '$.items[*]', constraints: { type: 'StringLiteral' } },
            ],
        };
        const ctx = createDiagContext();

        const index = buildRuleIndex(schema, ctx);

        assert.strictEqual(index.size, 0);
        assert.strictEqual(ctx.errors[0]?.code, ErrorCodes.INVALID_SCHEMA_POLICY);
    });

    it('rejects unknown nested attribute constraint keys', () => {
        const schema = {
            rules: [
                {
                    path: '$.value',
                    constraints: {
                        attributes: {
                            unit: {
                                bogus: true,
                            },
                        },
                    },
                },
            ],
        } as unknown as SchemaV1;
        const ctx = createDiagContext();

        const index = buildRuleIndex(schema, ctx);

        assert.strictEqual(index.size, 0);
        assert.strictEqual(ctx.errors[0]?.code, ErrorCodes.UNKNOWN_CONSTRAINT_KEY);
        assert.strictEqual(ctx.errors[0]?.path, '$.value@unit');
    });

    it('accepts valid reference_target_pattern and resolve_reference_form constraints', () => {
        const schema: SchemaV1 = {
            rules: [
                {
                    path: '$.postcode',
                    constraints: {
                        reference: 'require',
                        reference_kind: 'clone',
                        reference_target_pattern: '^\\$\\.postcodes\\[\\d+\\]$',
                        resolve_reference_form: true,
                    },
                },
            ],
        };
        const ctx = createDiagContext();

        const index = buildRuleIndex(schema, ctx);

        assert.strictEqual(index.size, 1);
        assert.strictEqual(ctx.errors.length, 0);
    });

    it('rejects invalid reference_target_pattern regex', () => {
        const schema: SchemaV1 = {
            rules: [
                {
                    path: '$.postcode',
                    constraints: {
                        reference_target_pattern: '[',
                    },
                },
            ],
        };
        const ctx = createDiagContext();

        const index = buildRuleIndex(schema, ctx);

        assert.strictEqual(index.size, 0);
        assert.strictEqual(ctx.errors[0]?.code, ErrorCodes.INVALID_REFERENCE_CONSTRAINT);
    });

    it('rejects nested quantified reference_target_pattern regexes', () => {
        const schema: SchemaV1 = {
            rules: [
                {
                    path: '$.postcode',
                    constraints: {
                        reference_target_pattern: '^(a+)+$',
                    },
                },
            ],
        };
        const ctx = createDiagContext();

        const index = buildRuleIndex(schema, ctx);

        assert.strictEqual(index.size, 0);
        assert.strictEqual(ctx.errors[0]?.code, ErrorCodes.INVALID_REFERENCE_CONSTRAINT);
    });

    it('rejects invalid string pattern regex', () => {
        const schema: SchemaV1 = {
            rules: [
                {
                    path: '$.name',
                    constraints: {
                        type: 'StringLiteral',
                        pattern: '[',
                    },
                },
            ],
        };
        const ctx = createDiagContext();

        const index = buildRuleIndex(schema, ctx);

        assert.strictEqual(index.size, 0);
        assert.strictEqual(ctx.errors[0]?.code, ErrorCodes.UNKNOWN_CONSTRAINT_KEY);
    });

    it('accepts AEOS portable string pattern syntax', () => {
        const schema: SchemaV1 = {
            rules: [
                {
                    path: '$.code',
                    constraints: {
                        type: 'StringLiteral',
                        pattern: '^(?:[A-Z]{2}|\\d{3})-[\\w\\s]+$',
                    },
                },
            ],
        };
        const ctx = createDiagContext();

        const index = buildRuleIndex(schema, ctx);

        assert.strictEqual(index.size, 1);
        assert.strictEqual(ctx.errors.length, 0);
    });

    it('rejects lookaround string pattern regexes as non-portable', () => {
        const schema: SchemaV1 = {
            rules: [
                {
                    path: '$.name',
                    constraints: {
                        type: 'StringLiteral',
                        pattern: '^(?=safe).+$',
                    },
                },
            ],
        };
        const ctx = createDiagContext();

        const index = buildRuleIndex(schema, ctx);

        assert.strictEqual(index.size, 0);
        assert.strictEqual(ctx.errors[0]?.code, ErrorCodes.UNKNOWN_CONSTRAINT_KEY);
    });

    it('rejects backreference string pattern regexes as non-portable', () => {
        const schema: SchemaV1 = {
            rules: [
                {
                    path: '$.name',
                    constraints: {
                        type: 'StringLiteral',
                        pattern: '^(a)\\1$',
                    },
                },
            ],
        };
        const ctx = createDiagContext();

        const index = buildRuleIndex(schema, ctx);

        assert.strictEqual(index.size, 0);
        assert.strictEqual(ctx.errors[0]?.code, ErrorCodes.UNKNOWN_CONSTRAINT_KEY);
    });

    it('rejects Unicode property string pattern regexes as non-portable', () => {
        const schema: SchemaV1 = {
            rules: [
                {
                    path: '$.name',
                    constraints: {
                        type: 'StringLiteral',
                        pattern: '^\\p{Letter}+$',
                    },
                },
            ],
        };
        const ctx = createDiagContext();

        const index = buildRuleIndex(schema, ctx);

        assert.strictEqual(index.size, 0);
        assert.strictEqual(ctx.errors[0]?.code, ErrorCodes.UNKNOWN_CONSTRAINT_KEY);
    });

    it('rejects unsupported alphabetic string pattern escapes as non-portable', () => {
        const schema: SchemaV1 = {
            rules: [
                {
                    path: '$.name',
                    constraints: {
                        type: 'StringLiteral',
                        pattern: '^\\h+$',
                    },
                },
            ],
        };
        const ctx = createDiagContext();

        const index = buildRuleIndex(schema, ctx);

        assert.strictEqual(index.size, 0);
        assert.strictEqual(ctx.errors[0]?.code, ErrorCodes.UNKNOWN_CONSTRAINT_KEY);
    });

    it('rejects overlong string pattern regexes', () => {
        const schema: SchemaV1 = {
            rules: [
                {
                    path: '$.name',
                    constraints: {
                        type: 'StringLiteral',
                        pattern: 'a'.repeat(513),
                    },
                },
            ],
        };
        const ctx = createDiagContext();

        const index = buildRuleIndex(schema, ctx);

        assert.strictEqual(index.size, 0);
        assert.strictEqual(ctx.errors[0]?.code, ErrorCodes.UNKNOWN_CONSTRAINT_KEY);
    });

    it('rejects nested quantified string pattern regexes', () => {
        const schema: SchemaV1 = {
            rules: [
                {
                    path: '$.name',
                    constraints: {
                        type: 'StringLiteral',
                        pattern: '^(a+)+$',
                    },
                },
            ],
        };
        const ctx = createDiagContext();

        const index = buildRuleIndex(schema, ctx);

        assert.strictEqual(index.size, 0);
        assert.strictEqual(ctx.errors[0]?.code, ErrorCodes.UNKNOWN_CONSTRAINT_KEY);
    });

    it('rejects resolve_reference_form when it is not boolean', () => {
        const schema = {
            rules: [
                {
                    path: '$.postcode',
                    constraints: {
                        resolve_reference_form: 'yes',
                    },
                },
            ],
        } as unknown as SchemaV1;
        const ctx = createDiagContext();

        const index = buildRuleIndex(schema, ctx);

        assert.strictEqual(index.size, 0);
        assert.strictEqual(ctx.errors[0]?.code, ErrorCodes.INVALID_REFERENCE_CONSTRAINT);
    });
});
