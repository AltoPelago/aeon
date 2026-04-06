/**
 * @aeos/core - Validate Tests
 *
 * Phase 0/1 tests: envelope shape and basic contract.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { validate } from './validate.js';
import type { AES } from './types/aes.js';
import type { SchemaV1 } from './types/schema.js';
import { ErrorCodes } from './diag/codes.js';

describe('validate()', () => {
    describe('Phase 0: Guardrails', () => {
        it('returns a valid envelope shape', () => {
            const aes: AES = [];
            const schema: SchemaV1 = { rules: [] };

            const result = validate(aes, schema);

            // Envelope must have all required keys
            assert.strictEqual(typeof result.ok, 'boolean');
            assert.ok(Array.isArray(result.errors));
            assert.ok(Array.isArray(result.warnings));
            assert.strictEqual(typeof result.guarantees, 'object');
            assert.ok(result.guarantees !== null);
        });

        it('does NOT include aes in output', () => {
            const aes: AES = [];
            const schema: SchemaV1 = { rules: [] };

            const result = validate(aes, schema);

            // Result must NOT contain 'aes' key (forbidden leakage)
            assert.strictEqual('aes' in result, false);
        });

        it('does not mutate input AES', () => {
            const aes: AES = [];
            const schema: SchemaV1 = { rules: [] };

            // Freeze to detect mutation attempts
            Object.freeze(aes);
            Object.freeze(schema);
            Object.freeze(schema.rules);

            // Should not throw
            const result = validate(aes, schema);
            assert.strictEqual(result.ok, true);
        });
    });

    describe('Phase 1: Envelope', () => {
        it('returns ok=true with empty AES and empty schema', () => {
            const aes: AES = [];
            const schema: SchemaV1 = { rules: [] };

            const result = validate(aes, schema);

            assert.strictEqual(result.ok, true);
            assert.strictEqual(result.errors.length, 0);
            assert.strictEqual(result.warnings.length, 0);
            assert.deepStrictEqual(result.guarantees, {});
        });

        it('returns empty arrays for errors/warnings when passing', () => {
            const aes: AES = [];
            const schema: SchemaV1 = { rules: [] };

            const result = validate(aes, schema);

            assert.deepStrictEqual(result.errors, []);
            assert.deepStrictEqual(result.warnings, []);
        });

        it('detects duplicate bindings (Phase 2)', () => {
            const aes: AES = [
                {
                    path: { segments: [{ type: 'root' }, { type: 'member', key: 'a' }] },
                    key: 'a',
                    value: { type: 'StringLiteral', value: 'x', raw: '"x"', delimiter: '"', span: [1, 2] },
                    span: [1, 2],
                },
                {
                    path: { segments: [{ type: 'root' }, { type: 'member', key: 'a' }] },
                    key: 'a',
                    value: { type: 'StringLiteral', value: 'y', raw: '"y"', delimiter: '"', span: [3, 4] },
                    span: [3, 4],
                },
            ] as unknown as AES;

            const schema: SchemaV1 = { rules: [] };

            const result = validate(aes, schema);

            assert.strictEqual(result.ok, false);
            assert.ok(result.errors.length >= 1);
            assert.ok(result.errors.some(e => e.code === ErrorCodes.DUPLICATE_BINDING));
        });

        it('does not enforce forward-reference legality (Core-owned)', () => {
            const aes: AES = [
                {
                    path: { segments: [{ type: 'root' }, { type: 'member', key: 'a' }] },
                    key: 'a',
                    value: { type: 'ObjectNode', bindings: [
                        { key: 'ref', value: { type: 'CloneReference', path: ['b'], span: [1,2] }, attributes: [], span: [1,2], type: 'Binding' }
                    ], attributes: [], span: [1,2] },
                    span: [1, 2],
                },
                {
                    path: { segments: [{ type: 'root' }, { type: 'member', key: 'b' }] },
                    key: 'b',
                    value: { type: 'StringLiteral', value: 'later', raw: '"later"', delimiter: '"', span: [3, 4] },
                    span: [3, 4],
                },
            ] as unknown as AES;

            const schema: SchemaV1 = { rules: [] };

            const result = validate(aes, schema);

            assert.strictEqual(result.ok, true);
            assert.strictEqual(result.errors.length, 0);
        });

        it('reports both Phase 2 and Phase 3 errors together', () => {
            const aes: AES = [
                {
                    path: { segments: [{ type: 'root' }, { type: 'member', key: 'x' }] },
                    key: 'x',
                    value: { type: 'StringLiteral', value: 'one', raw: '"one"', delimiter: '"', span: [1, 2] },
                    span: [1, 2],
                },
                {
                    path: { segments: [{ type: 'root' }, { type: 'member', key: 'x' }] },
                    key: 'x',
                    value: { type: 'StringLiteral', value: 'two', raw: '"two"', delimiter: '"', span: [3, 4] },
                    span: [3, 4],
                },
            ] as unknown as AES;

            const schema: SchemaV1 = {
                rules: [
                    { path: '$.a', constraints: { type: 'StringLiteral' } },
                    { path: '$.a', constraints: { type: 'StringLiteral' } },
                ],
            };

            const result = validate(aes, schema);

            assert.strictEqual(result.ok, false);
            assert.ok(result.errors.some(e => e.code === ErrorCodes.DUPLICATE_BINDING));
            assert.ok(result.errors.some(e => e.code === ErrorCodes.DUPLICATE_RULE_PATH));
        });

        it('does not enforce missing-reference target legality (Core-owned)', () => {
            const aes: AES = [
                {
                    path: { segments: [{ type: 'root' }, { type: 'member', key: 'a' }] },
                    key: 'a',
                    value: { type: 'CloneReference', path: ['nope'], span: [5, 6] },
                    span: [1, 2],
                },
            ] as unknown as AES;

            const schema: SchemaV1 = { rules: [] };

            const result = validate(aes, schema);

            assert.strictEqual(result.ok, true);
            assert.strictEqual(result.errors.length, 0);
        });

        it('accepts clone references to existing attribute targets', () => {
            const aes: AES = [
                {
                    path: { segments: [{ type: 'root' }, { type: 'member', key: 'a' }] },
                    key: 'a',
                    value: {
                        type: 'ObjectNode',
                        bindings: [],
                        attributes: [
                            {
                                type: 'Attribute',
                                entries: [
                                    ['ns', {
                                        value: { type: 'StringLiteral', value: 'alto.v1', raw: '"alto.v1"', delimiter: '"', span: [2, 3] },
                                        datatype: null,
                                    }],
                                ],
                                span: [2, 3],
                            },
                        ],
                        span: [1, 3],
                    },
                    span: [1, 3],
                },
                {
                    path: { segments: [{ type: 'root' }, { type: 'member', key: 'v' }] },
                    key: 'v',
                    value: { type: 'CloneReference', path: ['a', { type: 'attr', key: 'ns' }], span: [4, 8] },
                    span: [4, 8],
                },
            ] as unknown as AES;

            const schema: SchemaV1 = { rules: [] };
            const result = validate(aes, schema);

            assert.strictEqual(result.ok, true);
            assert.strictEqual(result.errors.length, 0);
        });

        it('accepts pointer references to existing attribute targets', () => {
            const aes: AES = [
                {
                    path: { segments: [{ type: 'root' }, { type: 'member', key: 'a' }] },
                    key: 'a',
                    value: {
                        type: 'ObjectNode',
                        bindings: [],
                        attributes: [
                            {
                                type: 'Attribute',
                                entries: [
                                    ['ns', {
                                        value: { type: 'StringLiteral', value: 'alto.v1', raw: '"alto.v1"', delimiter: '"', span: [2, 3] },
                                        datatype: null,
                                    }],
                                ],
                                span: [2, 3],
                            },
                        ],
                        span: [1, 3],
                    },
                    span: [1, 3],
                },
                {
                    path: { segments: [{ type: 'root' }, { type: 'member', key: 'v' }] },
                    key: 'v',
                    value: { type: 'PointerReference', path: ['a', { type: 'attr', key: 'ns' }], span: [4, 8] },
                    span: [4, 8],
                },
            ] as unknown as AES;

            const schema: SchemaV1 = { rules: [] };
            const result = validate(aes, schema);

            assert.strictEqual(result.ok, true);
            assert.strictEqual(result.errors.length, 0);
        });

        it('can require a binding to be any reference', () => {
            const aes: AES = [
                {
                    path: { segments: [{ type: 'root' }, { type: 'member', key: 'ref' }] },
                    key: 'ref',
                    value: { type: 'CloneReference', path: ['source'], span: [1, 4] },
                    span: [1, 4],
                },
            ] as unknown as AES;

            const schema: SchemaV1 = {
                rules: [
                    { path: '$.ref', constraints: { reference: 'require' } },
                ],
            };

            const result = validate(aes, schema);

            assert.strictEqual(result.ok, true);
            assert.strictEqual(result.errors.length, 0);
        });

        it('can require a pointer reference specifically', () => {
            const aes: AES = [
                {
                    path: { segments: [{ type: 'root' }, { type: 'member', key: 'ref' }] },
                    key: 'ref',
                    value: { type: 'PointerReference', path: ['source'], span: [1, 4] },
                    span: [1, 4],
                },
            ] as unknown as AES;

            const schema: SchemaV1 = {
                rules: [
                    { path: '$.ref', constraints: { reference: 'require', reference_kind: 'pointer' } },
                ],
            };

            const result = validate(aes, schema);

            assert.strictEqual(result.ok, true);
            assert.strictEqual(result.errors.length, 0);
        });

        it('rejects non-reference values when a reference is required', () => {
            const aes: AES = [
                {
                    path: { segments: [{ type: 'root' }, { type: 'member', key: 'ref' }] },
                    key: 'ref',
                    value: { type: 'StringLiteral', value: 'nope', raw: '"nope"', delimiter: '"', span: [1, 4] },
                    span: [1, 4],
                },
            ] as unknown as AES;

            const schema: SchemaV1 = {
                rules: [
                    { path: '$.ref', constraints: { reference: 'require' } },
                ],
            };

            const result = validate(aes, schema);

            assert.strictEqual(result.ok, false);
            assert.ok(result.errors.some((e) => e.code === ErrorCodes.REFERENCE_REQUIRED));
        });

        it('rejects the wrong reference kind when pointer is required', () => {
            const aes: AES = [
                {
                    path: { segments: [{ type: 'root' }, { type: 'member', key: 'ref' }] },
                    key: 'ref',
                    value: { type: 'CloneReference', path: ['source'], span: [1, 4] },
                    span: [1, 4],
                },
            ] as unknown as AES;

            const schema: SchemaV1 = {
                rules: [
                    { path: '$.ref', constraints: { reference: 'require', reference_kind: 'pointer' } },
                ],
            };

            const result = validate(aes, schema);

            assert.strictEqual(result.ok, false);
            assert.ok(result.errors.some((e) => e.code === ErrorCodes.REFERENCE_KIND_MISMATCH));
        });

        it('can forbid references for a specific binding', () => {
            const aes: AES = [
                {
                    path: { segments: [{ type: 'root' }, { type: 'member', key: 'ref' }] },
                    key: 'ref',
                    value: { type: 'CloneReference', path: ['source'], span: [1, 4] },
                    span: [1, 4],
                },
            ] as unknown as AES;

            const schema: SchemaV1 = {
                rules: [
                    { path: '$.ref', constraints: { reference: 'forbid' } },
                ],
            };

            const result = validate(aes, schema);

            assert.strictEqual(result.ok, false);
            assert.ok(result.errors.some((e) => e.code === ErrorCodes.REFERENCE_FORBIDDEN));
        });

        it('can forbid references schema-wide', () => {
            const aes: AES = [
                {
                    path: { segments: [{ type: 'root' }, { type: 'member', key: 'ref' }] },
                    key: 'ref',
                    value: { type: 'PointerReference', path: ['source'], span: [1, 4] },
                    span: [1, 4],
                },
            ] as unknown as AES;

            const schema: SchemaV1 = {
                reference_policy: 'forbid',
                rules: [],
            };

            const result = validate(aes, schema);

            assert.strictEqual(result.ok, false);
            assert.ok(result.errors.some((e) => e.code === ErrorCodes.REFERENCE_FORBIDDEN));
        });

        it('keeps open-world validation as the default', () => {
            const aes: AES = [
                {
                    path: { segments: [{ type: 'root' }, { type: 'member', key: 'a' }] },
                    key: 'a',
                    value: { type: 'StringLiteral', value: 'hello', raw: '"hello"', delimiter: '"', span: [1, 2] },
                    span: [1, 2],
                },
                {
                    path: { segments: [{ type: 'root' }, { type: 'member', key: 'b' }] },
                    key: 'b',
                    value: { type: 'StringLiteral', value: 'extra', raw: '"extra"', delimiter: '"', span: [3, 4] },
                    span: [3, 4],
                },
            ] as unknown as AES;

            const schema: SchemaV1 = {
                rules: [{ path: '$.a', constraints: { required: true, type: 'StringLiteral' } }],
            };

            const result = validate(aes, schema);
            assert.strictEqual(result.ok, true);
            assert.strictEqual(result.errors.length, 0);
        });

        it('rejects unexpected top-level bindings in closed-world mode', () => {
            const aes: AES = [
                {
                    path: { segments: [{ type: 'root' }, { type: 'member', key: 'a' }] },
                    key: 'a',
                    value: { type: 'StringLiteral', value: 'hello', raw: '"hello"', delimiter: '"', span: [1, 2] },
                    span: [1, 2],
                },
                {
                    path: { segments: [{ type: 'root' }, { type: 'member', key: 'b' }] },
                    key: 'b',
                    value: { type: 'StringLiteral', value: 'extra', raw: '"extra"', delimiter: '"', span: [3, 4] },
                    span: [3, 4],
                },
            ] as unknown as AES;

            const schema: SchemaV1 = {
                world: 'closed',
                rules: [{ path: '$.a', constraints: { required: true, type: 'StringLiteral' } }],
            };

            const result = validate(aes, schema);
            assert.strictEqual(result.ok, false);
            assert.ok(result.errors.some((e) => e.code === ErrorCodes.UNEXPECTED_BINDING));
        });

        it('rejects unexpected nested bindings in closed-world mode', () => {
            const aes: AES = [
                {
                    path: { segments: [{ type: 'root' }, { type: 'member', key: 'config' }] },
                    key: 'config',
                    value: { type: 'ObjectNode', bindings: [], attributes: [], span: [1, 10] },
                    span: [1, 10],
                },
                {
                    path: { segments: [{ type: 'root' }, { type: 'member', key: 'config' }, { type: 'member', key: 'host' }] },
                    key: 'host',
                    value: { type: 'StringLiteral', value: 'localhost', raw: '"localhost"', delimiter: '"', span: [11, 12] },
                    span: [11, 12],
                },
                {
                    path: { segments: [{ type: 'root' }, { type: 'member', key: 'config' }, { type: 'member', key: 'port' }] },
                    key: 'port',
                    value: { type: 'NumberLiteral', value: '5432', raw: '5432', span: [13, 14] },
                    span: [13, 14],
                },
            ] as unknown as AES;

            const schema: SchemaV1 = {
                world: 'closed',
                rules: [
                    { path: '$.config', constraints: { type: 'ObjectNode' } },
                    { path: '$.config.host', constraints: { type: 'StringLiteral' } },
                ],
            };

            const result = validate(aes, schema);
            assert.strictEqual(result.ok, false);
            assert.ok(result.errors.some((e) => e.code === ErrorCodes.UNEXPECTED_BINDING && e.path === '$.config.port'));
        });

        it('allows indexed list descendants matched by wildcard rules in closed-world mode', () => {
            const aes: AES = [
                {
                    path: { segments: [{ type: 'root' }, { type: 'member', key: 'message' }] },
                    key: 'message',
                    value: { type: 'ObjectNode', bindings: [], attributes: [], span: [1, 2] },
                    span: [1, 2],
                },
                {
                    path: { segments: [{ type: 'root' }, { type: 'member', key: 'message' }, { type: 'member', key: 'points' }] },
                    key: 'points',
                    value: {
                        type: 'ListNode',
                        elements: [
                            { type: 'ObjectNode', bindings: [], attributes: [], span: [3, 4] },
                            { type: 'ObjectNode', bindings: [], attributes: [], span: [5, 6] },
                        ],
                        span: [3, 6],
                    },
                    span: [3, 6],
                },
                {
                    path: { segments: [{ type: 'root' }, { type: 'member', key: 'message' }, { type: 'member', key: 'points' }, { type: 'index', index: 0 }] },
                    key: '0',
                    value: { type: 'ObjectNode', bindings: [], attributes: [], span: [7, 8] },
                    span: [7, 8],
                },
                {
                    path: {
                        segments: [
                            { type: 'root' },
                            { type: 'member', key: 'message' },
                            { type: 'member', key: 'points' },
                            { type: 'index', index: 0 },
                            { type: 'member', key: 'x' },
                        ],
                    },
                    key: 'x',
                    value: { type: 'NumberLiteral', value: '10', raw: '10', span: [9, 10] },
                    span: [9, 10],
                },
                {
                    path: {
                        segments: [
                            { type: 'root' },
                            { type: 'member', key: 'message' },
                            { type: 'member', key: 'points' },
                            { type: 'index', index: 0 },
                            { type: 'member', key: 'y' },
                        ],
                    },
                    key: 'y',
                    value: { type: 'NumberLiteral', value: '20', raw: '20', span: [11, 12] },
                    span: [11, 12],
                },
                {
                    path: { segments: [{ type: 'root' }, { type: 'member', key: 'message' }, { type: 'member', key: 'points' }, { type: 'index', index: 1 }] },
                    key: '1',
                    value: { type: 'ObjectNode', bindings: [], attributes: [], span: [13, 14] },
                    span: [13, 14],
                },
                {
                    path: {
                        segments: [
                            { type: 'root' },
                            { type: 'member', key: 'message' },
                            { type: 'member', key: 'points' },
                            { type: 'index', index: 1 },
                            { type: 'member', key: 'x' },
                        ],
                    },
                    key: 'x',
                    value: { type: 'NumberLiteral', value: '30', raw: '30', span: [15, 16] },
                    span: [15, 16],
                },
                {
                    path: {
                        segments: [
                            { type: 'root' },
                            { type: 'member', key: 'message' },
                            { type: 'member', key: 'points' },
                            { type: 'index', index: 1 },
                            { type: 'member', key: 'y' },
                        ],
                    },
                    key: 'y',
                    value: { type: 'NumberLiteral', value: '40', raw: '40', span: [17, 18] },
                    span: [17, 18],
                },
            ] as unknown as AES;

            const schema: SchemaV1 = {
                world: 'closed',
                rules: [
                    { path: '$.message', constraints: { type: 'ObjectNode' } },
                    { path: '$.message.points', constraints: { type: 'ListNode' } },
                    { path: '$.message.points[*]', constraints: { type: 'ObjectNode' } },
                    { path: '$.message.points[*].x', constraints: { type: 'NumberLiteral' } },
                    { path: '$.message.points[*].y', constraints: { type: 'NumberLiteral' } },
                ],
            };

            const result = validate(aes, schema);
            assert.strictEqual(result.ok, true);
            assert.strictEqual(result.errors.length, 0);
        });

        it('does not enforce forward attribute-reference legality (Core-owned)', () => {
            const aes: AES = [
                {
                    path: { segments: [{ type: 'root' }, { type: 'member', key: 'v' }] },
                    key: 'v',
                    value: { type: 'CloneReference', path: ['a', { type: 'attr', key: 'ns' }], span: [1, 4] },
                    span: [1, 4],
                },
                {
                    path: { segments: [{ type: 'root' }, { type: 'member', key: 'a' }] },
                    key: 'a',
                    value: {
                        type: 'ObjectNode',
                        bindings: [],
                        attributes: [
                            {
                                type: 'Attribute',
                                entries: [
                                    ['ns', {
                                        value: { type: 'StringLiteral', value: 'alto.v1', raw: '"alto.v1"', delimiter: '"', span: [6, 7] },
                                        datatype: null,
                                    }],
                                ],
                                span: [6, 7],
                            },
                        ],
                        span: [5, 7],
                    },
                    span: [5, 7],
                },
            ] as unknown as AES;

            const schema: SchemaV1 = { rules: [] };
            const result = validate(aes, schema);

            assert.strictEqual(result.ok, true);
            assert.strictEqual(result.errors.length, 0);
        });
    });

    describe('optional trailing separator delimiter policy', () => {
        const schema: SchemaV1 = { rules: [] };
        const aesWithTrailingDelimiter: AES = [
            {
                path: { segments: [{ type: 'root' }, { type: 'member', key: 'line' }] },
                key: 'line',
                datatype: 'set[|]',
                value: { type: 'SeparatorLiteral', value: '0|0|0|', raw: '^0|0|0|', span: [1, 8] },
                span: [1, 8],
            },
        ] as unknown as AES;

        it('is off by default (no warning/error)', () => {
            const result = validate(aesWithTrailingDelimiter, schema);
            assert.strictEqual(result.ok, true);
            assert.strictEqual(result.errors.length, 0);
            assert.strictEqual(result.warnings.length, 0);
        });

        it('emits warning when policy is warn', () => {
            const result = validate(aesWithTrailingDelimiter, schema, { trailingSeparatorDelimiterPolicy: 'warn' });
            assert.strictEqual(result.ok, true);
            assert.strictEqual(result.errors.length, 0);
            assert.ok(result.warnings.some((w) => w.code === ErrorCodes.TRAILING_SEPARATOR_DELIMITER));
        });

        it('emits error when policy is error', () => {
            const result = validate(aesWithTrailingDelimiter, schema, { trailingSeparatorDelimiterPolicy: 'error' });
            assert.strictEqual(result.ok, false);
            assert.ok(result.errors.some((e) => e.code === ErrorCodes.TRAILING_SEPARATOR_DELIMITER));
        });
    });
});
