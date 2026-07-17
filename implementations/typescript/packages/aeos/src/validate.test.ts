/**
 * @altopelago/aeos-core - Validate Tests
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

        it('escapes quoted canonical-path segments in diagnostics', () => {
            const aes: AES = [
                {
                    path: { segments: [{ type: 'root' }, { type: 'member', key: 'bad\\key"' }] },
                    key: 'bad\\key"',
                    value: { type: 'StringLiteral', value: 'x', raw: '"x"', delimiter: '"', span: [1, 2] },
                    span: [1, 2],
                },
                {
                    path: { segments: [{ type: 'root' }, { type: 'member', key: 'bad\\key"' }] },
                    key: 'bad\\key"',
                    value: { type: 'StringLiteral', value: 'y', raw: '"y"', delimiter: '"', span: [3, 4] },
                    span: [3, 4],
                },
            ] as unknown as AES;

            const schema: SchemaV1 = { rules: [] };

            const result = validate(aes, schema);

            assert.strictEqual(result.ok, false);
            assert.equal(result.errors[0]?.path, '$.["bad\\\\key\\""]');
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

        it('accepts temporal literal type constraints', () => {
            const aes: AES = [
                {
                    path: { segments: [{ type: 'root' }, { type: 'member', key: 'date' }] },
                    key: 'date',
                    value: { type: 'DateLiteral', value: '2026-05-25', raw: '@2026-05-25', span: [1, 2] },
                    span: [1, 2],
                },
                {
                    path: { segments: [{ type: 'root' }, { type: 'member', key: 'time' }] },
                    key: 'time',
                    value: { type: 'TimeLiteral', value: '12:34:56', raw: '@12:34:56', span: [3, 4] },
                    span: [3, 4],
                },
                {
                    path: { segments: [{ type: 'root' }, { type: 'member', key: 'datetime' }] },
                    key: 'datetime',
                    value: { type: 'DateTimeLiteral', value: '2026-05-25T12:34:56Z', raw: '@2026-05-25T12:34:56Z', span: [5, 6] },
                    span: [5, 6],
                },
                {
                    path: { segments: [{ type: 'root' }, { type: 'member', key: 'zrut' }] },
                    key: 'zrut',
                    value: { type: 'ZRUTDateTimeLiteral', value: '2026-05-25T12:34:56&local', raw: '@2026-05-25T12:34:56&local', span: [7, 8] },
                    span: [7, 8],
                },
            ] as unknown as AES;

            const schema: SchemaV1 = {
                rules: [
                    { path: '$.date', constraints: { type: 'DateLiteral' } },
                    { path: '$.time', constraints: { type: 'TimeLiteral' } },
                    { path: '$.datetime', constraints: { type: 'DateTimeLiteral' } },
                    { path: '$.zrut', constraints: { type: 'ZRUTDateTimeLiteral' } },
                ],
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

        it('allows indexed list descendants matched by SANSA selector rules in closed-world mode', () => {
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
                    { selector: '$.message.points.*', constraints: { type: 'ObjectNode' } },
                    { selector: '$.message.points.*.x', constraints: { type: 'NumberLiteral' } },
                    { selector: '$.message.points.*.y', constraints: { type: 'NumberLiteral' } },
                ],
            };

            const result = validate(aes, schema);
            assert.strictEqual(result.ok, true);
            assert.strictEqual(result.errors.length, 0);
        });

        it('applies SANSA direct-expansion item rules without requiring a placeholder path', () => {
            const aes: AES = [
                {
                    path: { segments: [{ type: 'root' }, { type: 'member', key: 'contact' }] },
                    key: 'contact',
                    value: { type: 'ObjectNode', bindings: [], attributes: [], span: [1, 2] },
                    span: [1, 2],
                },
                {
                    path: { segments: [{ type: 'root' }, { type: 'member', key: 'contact' }, { type: 'member', key: 'measurements' }] },
                    key: 'measurements',
                    value: { type: 'ListNode', elements: [], attributes: [], span: [3, 8] },
                    span: [3, 8],
                },
                {
                    path: { segments: [{ type: 'root' }, { type: 'member', key: 'contact' }, { type: 'member', key: 'measurements' }, { type: 'index', index: 0 }] },
                    key: '0',
                    value: { type: 'NumberLiteral', value: '3', raw: '3', span: [4, 5] },
                    span: [4, 5],
                },
            ] as unknown as AES;

            const schema: SchemaV1 = {
                rules: [
                    { selector: '$.contact.measurements.*', constraints: { required: true, type: 'NumberLiteral' } },
                ],
            };

            const result = validate(aes, schema);
            assert.strictEqual(result.ok, true);
            assert.strictEqual(result.errors.length, 0);
        });

        it('checks SANSA direct-expansion item rules against each matching indexed path', () => {
            const aes: AES = [
                {
                    path: { segments: [{ type: 'root' }, { type: 'member', key: 'contact' }, { type: 'member', key: 'measurements' }] },
                    key: 'measurements',
                    value: { type: 'ListNode', elements: [], attributes: [], span: [1, 4] },
                    span: [1, 4],
                },
                {
                    path: { segments: [{ type: 'root' }, { type: 'member', key: 'contact' }, { type: 'member', key: 'measurements' }, { type: 'index', index: 0 }] },
                    key: '0',
                    value: { type: 'StringLiteral', value: 'bad', raw: '"bad"', delimiter: '"', span: [2, 3] },
                    span: [2, 3],
                },
            ] as unknown as AES;

            const schema: SchemaV1 = {
                rules: [
                    { selector: '$.contact.measurements.*', constraints: { required: true, type: 'NumberLiteral' } },
                ],
            };

            const result = validate(aes, schema);
            assert.strictEqual(result.ok, false);
            assert.ok(result.errors.some((error) => error.code === ErrorCodes.TYPE_MISMATCH && error.path === '$.contact.measurements[0]'));
            assert.ok(!result.errors.some((error) => error.code === ErrorCodes.MISSING_REQUIRED_FIELD && error.path === '$.contact.measurements.*'));
        });

        it('enforces node<T> child intent with indexed child rules', () => {
            const aes: AES = [
                {
                    path: { segments: [{ type: 'root' }, { type: 'member', key: 'title' }] },
                    key: 'title',
                    datatype: 'node',
                    value: {
                        type: 'NodeLiteral',
                        tag: 'title',
                        datatype: 'node<string>',
                        children: [],
                        attributes: [],
                        span: [1, 4],
                    },
                    span: [1, 4],
                },
                {
                    path: { segments: [{ type: 'root' }, { type: 'member', key: 'title' }, { type: 'index', index: 0 }] },
                    key: '0',
                    value: { type: 'NodeLiteral', tag: 'span', children: [], attributes: [], span: [2, 3] },
                    span: [2, 3],
                },
            ] as unknown as AES;

            const schema: SchemaV1 = {
                rules: [
                    { selector: '$.title.*', constraints: { type: 'StringLiteral' } },
                ],
            };

            const result = validate(aes, schema);
            assert.strictEqual(result.ok, false);
            assert.ok(result.errors.some((error) => error.code === ErrorCodes.TYPE_MISMATCH && error.path === '$.title[0]'));
        });

        it('allows SANSA selector paths to accept any matching constraint branch', () => {
            const aes: AES = [
                {
                    path: { segments: [{ type: 'root' }, { type: 'member', key: 'page' }, { type: 'index', index: 0 }] },
                    key: '0',
                    value: { type: 'StringLiteral', value: 'Intro', raw: '"Intro"', delimiter: '"', span: [1, 2] },
                    span: [1, 2],
                },
                {
                    path: { segments: [{ type: 'root' }, { type: 'member', key: 'page' }, { type: 'index', index: 1 }] },
                    key: '1',
                    value: { type: 'NodeLiteral', tag: 'section', children: [], attributes: [], span: [3, 4] },
                    span: [3, 4],
                },
            ] as unknown as AES;

            const schema: SchemaV1 = {
                rules: [
                    {
                        selector: '$.page.*',
                        constraints: {
                            required: true,
                            any_of: [
                                { type: 'StringLiteral' },
                                { type: 'NodeLiteral' },
                            ],
                        },
                    },
                ],
            };

            const result = validate(aes, schema);
            assert.strictEqual(result.ok, true);
            assert.strictEqual(result.errors.length, 0);
        });

        it('applies selector rules at an exact wildcard member depth', () => {
            const aes: AES = [
                {
                    path: { segments: [{ type: 'root' }, { type: 'member', key: 'app' }, { type: 'member', key: 'contact' }] },
                    key: 'contact',
                    value: { type: 'ObjectNode', bindings: [], attributes: [], span: [1, 2] },
                    span: [1, 2],
                },
                {
                    path: { segments: [{ type: 'root' }, { type: 'member', key: 'contact' }] },
                    key: 'contact',
                    value: { type: 'StringLiteral', value: 'root', raw: '"root"', delimiter: '"', span: [3, 4] },
                    span: [3, 4],
                },
            ] as unknown as AES;

            const schema: SchemaV1 = {
                rules: [
                    { selector: '$.*.contact', constraints: { required: true, type: 'ObjectNode' } },
                ],
            };

            const result = validate(aes, schema);
            assert.strictEqual(result.ok, true);
            assert.strictEqual(result.errors.length, 0);
        });

        it('enforces object<T> member intent with selector rules', () => {
            const aes: AES = [
                {
                    path: { segments: [{ type: 'root' }, { type: 'member', key: 'scores' }] },
                    key: 'scores',
                    datatype: 'object<number>',
                    value: { type: 'ObjectNode', bindings: [], attributes: [], span: [1, 2] },
                    span: [1, 2],
                },
                {
                    path: { segments: [{ type: 'root' }, { type: 'member', key: 'scores' }, { type: 'member', key: 'alice' }] },
                    key: 'alice',
                    datatype: 'number',
                    value: { type: 'NumberLiteral', value: '10', raw: '10', span: [3, 4] },
                    span: [3, 4],
                },
                {
                    path: { segments: [{ type: 'root' }, { type: 'member', key: 'scores' }, { type: 'member', key: 'bob' }] },
                    key: 'bob',
                    datatype: 'string',
                    value: { type: 'StringLiteral', value: 'twelve', raw: '"twelve"', delimiter: '"', span: [5, 6] },
                    span: [5, 6],
                },
            ] as unknown as AES;

            const schema: SchemaV1 = {
                rules: [
                    { path: '$.scores', constraints: { type: 'ObjectNode', datatype: 'object<number>' } },
                    { selector: '$.scores.*', constraints: { type: 'NumberLiteral' } },
                ],
            };

            const result = validate(aes, schema);
            assert.strictEqual(result.ok, false);
            assert.ok(result.errors.some((error) => error.code === ErrorCodes.TYPE_MISMATCH && error.path === '$.scores.bob'));
        });

        it('applies recursive selector rules at any descendant depth', () => {
            const aes: AES = [
                {
                    path: { segments: [{ type: 'root' }, { type: 'member', key: 'profile' }, { type: 'member', key: 'billing' }, { type: 'member', key: 'contact' }] },
                    key: 'contact',
                    value: { type: 'StringLiteral', value: 'Tom', raw: '"Tom"', delimiter: '"', span: [1, 2] },
                    span: [1, 2],
                },
            ] as unknown as AES;

            const schema: SchemaV1 = {
                rules: [
                    { selector: '$.**.contact', constraints: { required: true, type: 'StringLiteral' } },
                ],
            };

            const result = validate(aes, schema);
            assert.strictEqual(result.ok, true);
            assert.strictEqual(result.errors.length, 0);
        });

        it('expands SANSA selectors with semantic datatype filters', () => {
            const aes: AES = [
                {
                    path: { segments: [{ type: 'root' }, { type: 'member', key: 'inventory' }, { type: 'member', key: 'items' }, { type: 'index', index: 0 }, { type: 'member', key: 'sku' }] },
                    key: 'sku',
                    datatype: 'string',
                    value: { type: 'StringLiteral', value: 'A1', raw: '"A1"', delimiter: '"', span: [1, 2] },
                    span: [1, 2],
                },
                {
                    path: { segments: [{ type: 'root' }, { type: 'member', key: 'inventory' }, { type: 'member', key: 'items' }, { type: 'index', index: 0 }, { type: 'member', key: 'qty' }] },
                    key: 'qty',
                    datatype: 'number',
                    value: { type: 'NumberLiteral', value: '3', raw: '3', span: [3, 4] },
                    span: [3, 4],
                },
            ] as unknown as AES;

            const schema: SchemaV1 = {
                rules: [
                    { selector: '$.inventory.**#number', constraints: { type: 'NumberLiteral' } },
                ],
            };

            const result = validate(aes, schema);
            assert.strictEqual(result.ok, true);
            assert.strictEqual(result.errors.length, 0);
        });

        it('expands SANSA selectors with representation kind filters', () => {
            const aes: AES = [
                {
                    path: { segments: [{ type: 'root' }, { type: 'member', key: 'inventory' }, { type: 'member', key: 'items' }, { type: 'index', index: 0 }, { type: 'member', key: 'sku' }] },
                    key: 'sku',
                    datatype: 'string',
                    value: { type: 'StringLiteral', value: 'A1', raw: '"A1"', delimiter: '"', span: [1, 2] },
                    span: [1, 2],
                },
                {
                    path: { segments: [{ type: 'root' }, { type: 'member', key: 'inventory' }, { type: 'member', key: 'items' }, { type: 'index', index: 0 }, { type: 'member', key: 'qty' }] },
                    key: 'qty',
                    datatype: 'number',
                    value: { type: 'NumberLiteral', value: '3', raw: '3', span: [3, 4] },
                    span: [3, 4],
                },
            ] as unknown as AES;

            const schema: SchemaV1 = {
                rules: [
                    { selector: '$.inventory.items.*.*%stringLiteral', constraints: { type: 'StringLiteral' } },
                ],
            };

            const result = validate(aes, schema);
            assert.strictEqual(result.ok, true);
            assert.strictEqual(result.errors.length, 0);
        });

        it('expands SANSA name-pattern selectors with question-mark wildcards', () => {
            const aes: AES = [
                {
                    path: { segments: [{ type: 'root' }, { type: 'member', key: 'inventory' }, { type: 'member', key: 'item_a' }] },
                    key: 'item_a',
                    value: { type: 'StringLiteral', value: 'A', raw: '"A"', delimiter: '"', span: [1, 2] },
                    span: [1, 2],
                },
                {
                    path: { segments: [{ type: 'root' }, { type: 'member', key: 'inventory' }, { type: 'member', key: 'item_backup' }] },
                    key: 'item_backup',
                    value: { type: 'StringLiteral', value: 'old', raw: '"old"', delimiter: '"', span: [3, 4] },
                    span: [3, 4],
                },
                {
                    path: { segments: [{ type: 'root' }, { type: 'member', key: 'inventory' }, { type: 'member', key: 'status' }] },
                    key: 'status',
                    value: { type: 'NumberLiteral', value: '1', raw: '1', span: [5, 6] },
                    span: [5, 6],
                },
            ] as unknown as AES;

            const schema: SchemaV1 = {
                rules: [
                    { selector: '$.inventory.("item?*")', constraints: { type: 'StringLiteral' } },
                ],
            };

            const result = validate(aes, schema);
            assert.strictEqual(result.ok, true);
            assert.strictEqual(result.errors.length, 0);
        });

        it('reports a required selector when no path matches', () => {
            const aes: AES = [
                {
                    path: { segments: [{ type: 'root' }, { type: 'member', key: 'profile' }] },
                    key: 'profile',
                    value: { type: 'ObjectNode', bindings: [], attributes: [], span: [1, 2] },
                    span: [1, 2],
                },
            ] as unknown as AES;

            const schema: SchemaV1 = {
                rules: [
                    { selector: '$.*.contact', constraints: { required: true, type: 'ObjectNode' } },
                ],
            };

            const result = validate(aes, schema);
            assert.strictEqual(result.ok, false);
            assert.ok(result.errors.some((error) => error.code === ErrorCodes.MISSING_REQUIRED_FIELD && error.path === '$.*.contact'));
        });

        it('uses selector rules for closed-world allowance', () => {
            const aes: AES = [
                {
                    path: { segments: [{ type: 'root' }, { type: 'member', key: 'app' }, { type: 'member', key: 'contact' }] },
                    key: 'contact',
                    value: { type: 'ObjectNode', bindings: [], attributes: [], span: [1, 2] },
                    span: [1, 2],
                },
            ] as unknown as AES;

            const schema: SchemaV1 = {
                world: 'closed',
                rules: [
                    { selector: '$.*.contact', constraints: { type: 'ObjectNode' } },
                ],
            };

            const result = validate(aes, schema);
            assert.strictEqual(result.ok, true);
            assert.strictEqual(result.errors.length, 0);
        });

        it('uses SANSA selector filters for closed-world allowance', () => {
            const aes: AES = [
                {
                    path: { segments: [{ type: 'root' }, { type: 'member', key: 'inventory' }, { type: 'member', key: 'count' }] },
                    key: 'count',
                    datatype: 'number',
                    value: { type: 'NumberLiteral', value: '3', raw: '3', span: [1, 2] },
                    span: [1, 2],
                },
            ] as unknown as AES;

            const schema: SchemaV1 = {
                world: 'closed',
                rules: [
                    { selector: '$.inventory.**#number', constraints: { type: 'NumberLiteral' } },
                ],
            };

            const result = validate(aes, schema);
            assert.strictEqual(result.ok, true);
            assert.strictEqual(result.errors.length, 0);
        });

        it('accepts indexed node-child paths in explicit rules', () => {
            const aes: AES = [
                {
                    path: { segments: [{ type: 'root' }, { type: 'member', key: 'page' }] },
                    key: 'page',
                    value: { type: 'NodeLiteral', tag: 'page', children: [{ type: 'NumberLiteral', value: '3', raw: '3', span: [2, 3] }], attributes: [], span: [1, 3] },
                    span: [1, 3],
                },
                {
                    path: { segments: [{ type: 'root' }, { type: 'member', key: 'page' }, { type: 'index', index: 0 }] },
                    key: '0',
                    value: { type: 'NumberLiteral', value: '3', raw: '3', span: [2, 3] },
                    span: [2, 3],
                },
            ] as unknown as AES;

            const schema: SchemaV1 = {
                rules: [
                    { path: '$.page', constraints: { type: 'NodeLiteral' } },
                    { path: '$.page[0]', constraints: { type: 'NumberLiteral' } },
                ],
            };

            const result = validate(aes, schema);
            assert.strictEqual(result.ok, true);
            assert.strictEqual(result.errors.length, 0);
        });

        it('rejects indexed node-child type mismatches', () => {
            const aes: AES = [
                {
                    path: { segments: [{ type: 'root' }, { type: 'member', key: 'page' }] },
                    key: 'page',
                    value: { type: 'NodeLiteral', tag: 'page', children: [{ type: 'NumberLiteral', value: '3', raw: '3', span: [2, 3] }], attributes: [], span: [1, 3] },
                    span: [1, 3],
                },
                {
                    path: { segments: [{ type: 'root' }, { type: 'member', key: 'page' }, { type: 'index', index: 0 }] },
                    key: '0',
                    value: { type: 'NumberLiteral', value: '3', raw: '3', span: [2, 3] },
                    span: [2, 3],
                },
            ] as unknown as AES;

            const schema: SchemaV1 = {
                rules: [
                    { path: '$.page[0]', constraints: { type: 'StringLiteral' } },
                ],
            };

            const result = validate(aes, schema);
            assert.strictEqual(result.ok, false);
            assert.ok(result.errors.some((e) => e.code === ErrorCodes.TYPE_MISMATCH && e.path === '$.page[0]'));
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

        it('validates direct SANSA attribute-space paths', () => {
            const aes: AES = [
                {
                    path: { segments: [{ type: 'root' }, { type: 'member', key: 'value' }] },
                    key: 'value',
                    value: { type: 'NumberLiteral', value: '3', raw: '3', span: [1, 4] },
                    annotations: new Map([
                        ['unit', {
                            value: { type: 'StringLiteral', value: 'cm', raw: '"cm"', delimiter: '"', span: [2, 3] },
                            datatype: 'string',
                        }],
                    ]),
                    span: [1, 4],
                },
            ] as unknown as AES;

            const result = validate(aes, {
                rules: [
                    { path: '$.value.@.unit', constraints: { type: 'NumberLiteral', required: true } },
                ],
            });

            assert.strictEqual(result.ok, false);
            assert.ok(result.errors.some((e) => e.code === ErrorCodes.TYPE_MISMATCH && e.path === '$.value.@.unit'));
        });

        it('expands SANSA selectors through attribute-space segments', () => {
            const aes: AES = [
                {
                    path: { segments: [{ type: 'root' }, { type: 'member', key: 'value' }] },
                    key: 'value',
                    value: { type: 'NumberLiteral', value: '3', raw: '3', span: [1, 4] },
                    annotations: new Map([
                        ['unit', {
                            value: { type: 'StringLiteral', value: 'cm', raw: '"cm"', delimiter: '"', span: [2, 3] },
                            datatype: 'string',
                        }],
                    ]),
                    span: [1, 4],
                },
            ] as unknown as AES;

            const result = validate(aes, {
                rules: [
                    { selector: '$.*.@.unit', constraints: { type: 'NumberLiteral', required: true } },
                ],
            });

            assert.strictEqual(result.ok, false);
            assert.ok(result.errors.some((e) => e.code === ErrorCodes.TYPE_MISMATCH && e.path === '$.value.@.unit'));
        });

        it('requires attribute entries when declared in schema', () => {
            const aes: AES = [
                {
                    path: { segments: [{ type: 'root' }, { type: 'member', key: 'value' }] },
                    key: 'value',
                    value: { type: 'NumberLiteral', value: '3', raw: '3', span: [1, 2] },
                    span: [1, 2],
                },
            ] as unknown as AES;

            const schema: SchemaV1 = {
                rules: [
                    {
                        path: '$.value',
                        constraints: {
                            type: 'NumberLiteral',
                            attributes: {
                                unit: { required: true, type: 'StringLiteral', datatype: 'string' },
                            },
                        },
                    },
                ],
            };

            const result = validate(aes, schema);
            assert.strictEqual(result.ok, false);
            assert.ok(result.errors.some((e) => e.code === ErrorCodes.MISSING_REQUIRED_FIELD && e.path === '$.value.@.unit'));
        });

        it('checks attribute entry type and datatype', () => {
            const aes: AES = [
                {
                    path: { segments: [{ type: 'root' }, { type: 'member', key: 'value' }] },
                    key: 'value',
                    value: { type: 'NumberLiteral', value: '3', raw: '3', span: [1, 4] },
                    annotations: new Map([
                        ['unit', {
                            value: { type: 'StringLiteral', value: 'cm', raw: '"cm"', delimiter: '"', span: [2, 3] },
                            datatype: 'symbol',
                        }],
                    ]),
                    span: [1, 4],
                },
            ] as unknown as AES;

            const schema: SchemaV1 = {
                rules: [
                    {
                        path: '$.value',
                        constraints: {
                            attributes: {
                                unit: { type: 'NumberLiteral', datatype: 'string' },
                            },
                        },
                    },
                ],
            };

            const result = validate(aes, schema);
            assert.strictEqual(result.ok, false);
            assert.ok(result.errors.some((e) => e.code === ErrorCodes.TYPE_MISMATCH && e.path === '$.value.@.unit'));
        });

        it('rejects unexpected attribute entries when closed_attributes is true', () => {
            const aes: AES = [
                {
                    path: { segments: [{ type: 'root' }, { type: 'member', key: 'value' }] },
                    key: 'value',
                    value: { type: 'NumberLiteral', value: '3', raw: '3', span: [1, 4] },
                    annotations: new Map([
                        ['unit', {
                            value: { type: 'StringLiteral', value: 'cm', raw: '"cm"', delimiter: '"', span: [2, 3] },
                            datatype: 'string',
                        }],
                        ['extra', {
                            value: { type: 'StringLiteral', value: 'x', raw: '"x"', delimiter: '"', span: [3, 4] },
                            datatype: 'string',
                        }],
                    ]),
                    span: [1, 4],
                },
            ] as unknown as AES;

            const schema: SchemaV1 = {
                rules: [
                    {
                        path: '$.value',
                        constraints: {
                            attributes: {
                                unit: { type: 'StringLiteral' },
                            },
                            closed_attributes: true,
                        },
                    },
                ],
            };

            const result = validate(aes, schema);
            assert.strictEqual(result.ok, false);
            assert.ok(result.errors.some((e) => e.code === ErrorCodes.UNEXPECTED_ATTRIBUTE_ENTRY && e.path === '$.value.@.extra'));
        });

        it('lets attributes inherit closed-world schema rules', () => {
            const aes: AES = [
                {
                    path: { segments: [{ type: 'root' }, { type: 'member', key: 'value' }] },
                    key: 'value',
                    value: { type: 'NumberLiteral', value: '3', raw: '3', span: [1, 4] },
                    annotations: new Map([
                        ['unit', {
                            value: { type: 'StringLiteral', value: 'cm', raw: '"cm"', delimiter: '"', span: [2, 3] },
                            datatype: 'string',
                        }],
                        ['extra', {
                            value: { type: 'StringLiteral', value: 'x', raw: '"x"', delimiter: '"', span: [3, 4] },
                            datatype: 'string',
                        }],
                    ]),
                    span: [1, 4],
                },
            ] as unknown as AES;

            const schema: SchemaV1 = {
                world: 'closed',
                attribute_policy: 'inherit_world',
                rules: [
                    {
                        path: '$.value',
                        constraints: {
                            type: 'NumberLiteral',
                            attributes: {
                                unit: { type: 'StringLiteral' },
                            },
                        },
                    },
                ],
            };

            const result = validate(aes, schema);
            assert.strictEqual(result.ok, false);
            assert.ok(!result.errors.some((e) => e.code === ErrorCodes.UNEXPECTED_ATTRIBUTE_ENTRY && e.path === '$.value.@.unit'));
            assert.ok(result.errors.some((e) => e.code === ErrorCodes.UNEXPECTED_ATTRIBUTE_ENTRY && e.path === '$.value.@.extra'));
        });

        it('uses inherit_world as the default attribute policy in closed-world schemas', () => {
            const aes: AES = [
                {
                    path: { segments: [{ type: 'root' }, { type: 'member', key: 'value' }] },
                    key: 'value',
                    value: { type: 'NumberLiteral', value: '3', raw: '3', span: [1, 4] },
                    annotations: new Map([
                        ['extra', {
                            value: { type: 'StringLiteral', value: 'x', raw: '"x"', delimiter: '"', span: [3, 4] },
                            datatype: 'string',
                        }],
                    ]),
                    span: [1, 4],
                },
            ] as unknown as AES;

            const schema: SchemaV1 = {
                world: 'closed',
                rules: [
                    {
                        path: '$.value',
                        constraints: {
                            type: 'NumberLiteral',
                        },
                    },
                ],
            };

            const result = validate(aes, schema);
            assert.strictEqual(result.ok, false);
            assert.ok(result.errors.some((e) => e.code === ErrorCodes.UNEXPECTED_ATTRIBUTE_ENTRY && e.path === '$.value.@.extra'));
        });

        it('forbids all attributes when schema attribute_policy is forbid', () => {
            const aes: AES = [
                {
                    path: { segments: [{ type: 'root' }, { type: 'member', key: 'value' }] },
                    key: 'value',
                    value: { type: 'NumberLiteral', value: '3', raw: '3', span: [1, 4] },
                    annotations: new Map([
                        ['unit', {
                            value: { type: 'StringLiteral', value: 'cm', raw: '"cm"', delimiter: '"', span: [2, 3] },
                            datatype: 'string',
                        }],
                    ]),
                    span: [1, 4],
                },
            ] as unknown as AES;

            const schema: SchemaV1 = {
                attribute_policy: 'forbid',
                rules: [
                    {
                        path: '$.value',
                        constraints: {
                            type: 'NumberLiteral',
                            attributes: {
                                unit: { type: 'StringLiteral' },
                            },
                        },
                    },
                ],
            };

            const result = validate(aes, schema);
            assert.strictEqual(result.ok, false);
            assert.ok(result.errors.some((e) => e.code === ErrorCodes.UNEXPECTED_ATTRIBUTE_ENTRY && e.path === '$.value.@.unit'));
        });

        it('recurses into nested attribute entries', () => {
            const aes: AES = [
                {
                    path: { segments: [{ type: 'root' }, { type: 'member', key: 'value' }] },
                    key: 'value',
                    value: { type: 'NumberLiteral', value: '3', raw: '3', span: [1, 5] },
                    annotations: new Map([
                        ['meta', {
                            value: { type: 'ObjectNode', bindings: [], attributes: [], span: [2, 4] },
                            annotations: new Map([
                                ['label', {
                                    value: { type: 'NumberLiteral', value: '7', raw: '7', span: [3, 4] },
                                    datatype: 'n',
                                }],
                            ]),
                        }],
                    ]),
                    span: [1, 5],
                },
            ] as unknown as AES;

            const schema: SchemaV1 = {
                rules: [
                    {
                        path: '$.value',
                        constraints: {
                            attributes: {
                                meta: {
                                    attributes: {
                                        label: { type: 'StringLiteral' },
                                    },
                                },
                            },
                        },
                    },
                ],
            };

            const result = validate(aes, schema);
            assert.strictEqual(result.ok, false);
            assert.ok(result.errors.some((e) => e.code === ErrorCodes.TYPE_MISMATCH && e.path === '$.value.@.meta.@.label'));
        });

        it('applies datatype_rules to attribute entries automatically', () => {
            const aes: AES = [
                {
                    path: { segments: [{ type: 'root' }, { type: 'member', key: 'value' }] },
                    key: 'value',
                    value: { type: 'NumberLiteral', value: '3', raw: '3', span: [1, 4] },
                    annotations: new Map([
                        ['unit', {
                            value: { type: 'NumberLiteral', value: '-7', raw: '-7', span: [2, 3] },
                            datatype: 'uint',
                        }],
                    ]),
                    span: [1, 4],
                },
            ] as unknown as AES;

            const schema: SchemaV1 = {
                rules: [
                    {
                        path: '$.value',
                        constraints: {
                            attributes: {
                                unit: {},
                            },
                        },
                    },
                ],
                datatype_rules: {
                    uint: { type: 'NumberLiteral', sign: 'unsigned' },
                },
            };

            const result = validate(aes, schema);
            assert.strictEqual(result.ok, false);
            assert.ok(result.errors.some((e) => e.code === ErrorCodes.NUMERIC_FORM_VIOLATION && e.path === '$.value.@.unit'));
        });
    });

    describe('symbolic literal form constraints', () => {
        it('validates min and max digits for hex and radix literals while treating separators as string-like', () => {
            const aes: AES = [
                {
                    path: { segments: [{ type: 'root' }, { type: 'member', key: 'hex' }] },
                    key: 'hex',
                    datatype: null,
                    value: { type: 'HexLiteral', value: 'FF', raw: '#FF', span: [1, 4] },
                    span: [1, 4],
                },
                {
                    path: { segments: [{ type: 'root' }, { type: 'member', key: 'radix' }] },
                    key: 'radix',
                    datatype: null,
                    value: { type: 'RadixLiteral', value: 'ABC', raw: '%ABC', span: [5, 9] },
                    span: [5, 9],
                },
                {
                    path: { segments: [{ type: 'root' }, { type: 'member', key: 'sep' }] },
                    key: 'sep',
                    datatype: 'sep[|]',
                    value: { type: 'SeparatorLiteral', value: '0|0|0', raw: '^0|0|0', span: [10, 16] },
                    span: [10, 16],
                },
            ] as unknown as AES;

            const schema: SchemaV1 = {
                rules: [
                    { path: '$.hex', constraints: { type: 'HexLiteral', min_digits: 2, max_digits: 2 } },
                    { path: '$.radix', constraints: { type: 'RadixLiteral', min_digits: 4 } },
                    { path: '$.sep', constraints: { type: 'SeparatorLiteral', max_digits: 2, max_length: 4 } },
                ],
            };

            const result = validate(aes, schema);
            assert.strictEqual(result.ok, false);
            assert.ok(result.errors.some((e) => e.code === ErrorCodes.NUMERIC_FORM_VIOLATION && e.path === '$.radix'));
            assert.ok(result.errors.some((e) => e.code === ErrorCodes.STRING_LENGTH_VIOLATION && e.path === '$.sep'));
            assert.ok(!result.errors.some((e) => e.code === ErrorCodes.NUMERIC_FORM_VIOLATION && e.path === '$.sep'));
            assert.ok(!result.errors.some((e) => e.path === '$.hex'));
        });

        it('applies datatype rule patterns to separator literals', () => {
            const aes: AES = [
                {
                    path: { segments: [{ type: 'root' }, { type: 'member', key: 'ip' }] },
                    key: 'ip',
                    datatype: 'kadot',
                    value: { type: 'SeparatorLiteral', value: '198.0.126.255', raw: '^198.0.126.255', span: [1, 15] },
                    span: [1, 15],
                },
                {
                    path: { segments: [{ type: 'root' }, { type: 'member', key: 'dimensions' }] },
                    key: 'dimensions',
                    datatype: 'kadot',
                    value: { type: 'SeparatorLiteral', value: '300x250', raw: '^300x250', span: [16, 24] },
                    span: [16, 24],
                },
            ] as unknown as AES;

            const result = validate(aes, {
                rules: [
                    { path: '$.ip', constraints: {} },
                    { path: '$.dimensions', constraints: {} },
                ],
                datatype_rules: {
                    kadot: {
                        type: 'SeparatorLiteral',
                        pattern: '^[0-9.]+$',
                    },
                },
            });

            assert.strictEqual(result.ok, false);
            assert.ok(!result.errors.some((e) => e.path === '$.ip'));
            assert.ok(result.errors.some((e) => e.code === ErrorCodes.PATTERN_MISMATCH && e.path === '$.dimensions'));
        });

        it('validates unsigned form for radix literals', () => {
            const aes: AES = [
                {
                    path: { segments: [{ type: 'root' }, { type: 'member', key: 'radix' }] },
                    key: 'radix',
                    datatype: null,
                    value: { type: 'RadixLiteral', value: '-ABC', raw: '%-ABC', span: [1, 6] },
                    span: [1, 6],
                },
            ] as unknown as AES;

            const result = validate(aes, {
                rules: [{ path: '$.radix', constraints: { type: 'RadixLiteral', sign: 'unsigned' } }],
            });
            assert.strictEqual(result.ok, false);
            assert.ok(result.errors.some((e) => e.code === ErrorCodes.NUMERIC_FORM_VIOLATION && e.path === '$.radix'));
        });

        it('validates exact radix for radix literals', () => {
            const aes: AES = [
                {
                    path: { segments: [{ type: 'root' }, { type: 'member', key: 'binary' }] },
                    key: 'binary',
                    datatype: 'radix[2]',
                    value: { type: 'RadixLiteral', value: '1010', raw: '%1010', span: [1, 6] },
                    span: [1, 6],
                },
                {
                    path: { segments: [{ type: 'root' }, { type: 'member', key: 'badBinary' }] },
                    key: 'badBinary',
                    datatype: 'radix[2]',
                    value: { type: 'RadixLiteral', value: '1050', raw: '%1050', span: [7, 12] },
                    span: [7, 12],
                },
            ] as unknown as AES;

            const result = validate(aes, {
                rules: [
                    { path: '$.binary', constraints: { type: 'RadixLiteral', radix: 2 } },
                    { path: '$.badBinary', constraints: { type: 'RadixLiteral', radix: 2 } },
                ],
            });
            assert.strictEqual(result.ok, false);
            assert.ok(!result.errors.some((e) => e.path === '$.binary'));
            assert.ok(result.errors.some((e) => e.code === ErrorCodes.NUMERIC_FORM_VIOLATION && e.path === '$.badBinary'));
        });

        it('requires radix literals to declare the constrained radix unless relaxed', () => {
            const aes: AES = [
                {
                    path: { segments: [{ type: 'root' }, { type: 'member', key: 'unspecified' }] },
                    key: 'unspecified',
                    value: { type: 'RadixLiteral', value: '1010', raw: '%1010', span: [1, 6] },
                    span: [1, 6],
                },
                {
                    path: { segments: [{ type: 'root' }, { type: 'member', key: 'mismatch' }] },
                    key: 'mismatch',
                    datatype: 'radix[4]',
                    value: { type: 'RadixLiteral', value: '1010', raw: '%1010', span: [7, 12] },
                    span: [7, 12],
                },
                {
                    path: { segments: [{ type: 'root' }, { type: 'member', key: 'alias' }] },
                    key: 'alias',
                    datatype: 'radix2',
                    value: { type: 'RadixLiteral', value: '1010', raw: '%1010', span: [13, 18] },
                    span: [13, 18],
                },
            ] as unknown as AES;

            const result = validate(aes, {
                rules: [
                    { path: '$.unspecified', constraints: { type: 'RadixLiteral', radix: 2 } },
                    { path: '$.mismatch', constraints: { type: 'RadixLiteral', radix: 2 } },
                    { path: '$.alias', constraints: { type: 'RadixLiteral', radix: 2 } },
                ],
            });
            assert.strictEqual(result.ok, false);
            assert.ok(result.errors.some((e) => e.code === ErrorCodes.NUMERIC_FORM_VIOLATION && e.path === '$.unspecified'));
            assert.ok(result.errors.some((e) => e.code === ErrorCodes.NUMERIC_FORM_VIOLATION && e.path === '$.mismatch'));
            assert.ok(!result.errors.some((e) => e.path === '$.alias'));

            const relaxed = validate([aes[0]!] as unknown as AES, {
                rules: [{ path: '$.unspecified', constraints: { type: 'RadixLiteral', radix: 2, allow_unspecified_radix: true } }],
            });
            assert.strictEqual(relaxed.ok, true);
        });
    });

    describe('optional trailing separator delimiter policy', () => {
        const schema: SchemaV1 = { rules: [] };
        const aesWithTrailingDelimiter: AES = [
            {
                path: { segments: [{ type: 'root' }, { type: 'member', key: 'line' }] },
                key: 'line',
                datatype: 'sep[|]',
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

    describe('reference target and resolved-form constraints', () => {
        it('matches canonicalized reference_target_pattern for quoted and attribute segments', () => {
            const aes: AES = [
                {
                    path: { segments: [{ type: 'root' }, { type: 'member', key: 'postcode' }] },
                    key: 'postcode',
                    value: { type: 'CloneReference', path: ['safe keys', { type: 'attr', key: 'ns' }], span: [0, 12] },
                    span: [0, 12],
                },
            ] as unknown as AES;

            const schema: SchemaV1 = {
                rules: [
                    {
                        path: '$.postcode',
                        constraints: {
                            reference_target_pattern: '^\\$\\.\\["safe keys"\\]\\.@\\.ns$',
                        },
                    },
                ],
            };

            const result = validate(aes, schema);
            assert.strictEqual(result.ok, true);
        });

        it('fails when reference target path falls outside the allowed domain', () => {
            const aes: AES = [
                {
                    path: { segments: [{ type: 'root' }, { type: 'member', key: 'postcode' }] },
                    key: 'postcode',
                    value: { type: 'CloneReference', path: ['ages', 3], span: [0, 18] },
                    span: [0, 18],
                },
            ] as unknown as AES;

            const schema: SchemaV1 = {
                rules: [
                    {
                        path: '$.postcode',
                        constraints: {
                            reference: 'require',
                            reference_kind: 'clone',
                            reference_target_pattern: '^\\$\\.postcodes\\[\\d+\\]$',
                        },
                    },
                ],
            };

            const result = validate(aes, schema);
            assert.strictEqual(result.ok, false);
            assert.ok(result.errors.some((e) => e.code === ErrorCodes.REFERENCE_TARGET_MISMATCH && e.path === '$.postcode'));
        });

        it('resolves transitive reference chains for type and pattern checks when enabled', () => {
            const aes: AES = [
                {
                    path: { segments: [{ type: 'root' }, { type: 'member', key: 'a' }] },
                    key: 'a',
                    value: { type: 'StringLiteral', value: 'ok', raw: '"ok"' },
                    span: [0, 4],
                },
                {
                    path: { segments: [{ type: 'root' }, { type: 'member', key: 'b' }] },
                    key: 'b',
                    value: { type: 'CloneReference', path: ['a'], span: [5, 9] },
                    span: [5, 9],
                },
                {
                    path: { segments: [{ type: 'root' }, { type: 'member', key: 'c' }] },
                    key: 'c',
                    value: { type: 'CloneReference', path: ['b'], span: [10, 14] },
                    span: [10, 14],
                },
            ] as unknown as AES;

            const schema: SchemaV1 = {
                rules: [
                    {
                        path: '$.c',
                        constraints: {
                            type: 'StringLiteral',
                            pattern: 'ok',
                            resolve_reference_form: true,
                        },
                    },
                ],
            };

            const result = validate(aes, schema);
            assert.strictEqual(result.ok, true);
        });

        it('returns a schema diagnostic instead of throwing for invalid any_of pattern regex', () => {
            const aes: AES = [
                {
                    path: { segments: [{ type: 'root' }, { type: 'member', key: 'name' }] },
                    key: 'name',
                    value: { type: 'StringLiteral', value: 'Alice', raw: '"Alice"' },
                    span: [0, 14],
                },
            ] as unknown as AES;

            const schema: SchemaV1 = {
                rules: [
                    {
                        path: '$.name',
                        constraints: {
                            any_of: [
                                { type: 'StringLiteral', pattern: '[' },
                            ],
                        },
                    },
                ],
            };

            assert.doesNotThrow(() => validate(aes, schema));
            const result = validate(aes, schema);
            assert.strictEqual(result.ok, false);
            assert.ok(result.errors.some((e) => e.code === ErrorCodes.UNKNOWN_CONSTRAINT_KEY));
        });

        it('returns a schema diagnostic instead of throwing for invalid attribute pattern regex', () => {
            const aes: AES = [
                {
                    path: { segments: [{ type: 'root' }, { type: 'member', key: 'name' }] },
                    key: 'name',
                    value: { type: 'StringLiteral', value: 'Alice', raw: '"Alice"' },
                    annotations: new Map([
                        ['label', {
                            value: { type: 'StringLiteral', value: 'friend', raw: '"friend"', span: [5, 13] },
                            datatype: 'string',
                        }],
                    ]),
                    span: [0, 14],
                },
            ] as unknown as AES;

            const schema: SchemaV1 = {
                rules: [
                    {
                        path: '$.name',
                        constraints: {
                            attributes: {
                                label: { type: 'StringLiteral', pattern: '[' },
                            },
                        },
                    },
                ],
            };

            assert.doesNotThrow(() => validate(aes, schema));
            const result = validate(aes, schema);
            assert.strictEqual(result.ok, false);
            assert.ok(result.errors.some((e) => e.code === ErrorCodes.UNKNOWN_CONSTRAINT_KEY));
        });

        it('keeps missing targets and cycles Core-owned when resolve_reference_form is enabled', () => {
            const missingTargetAes: AES = [
                {
                    path: { segments: [{ type: 'root' }, { type: 'member', key: 'postcode' }] },
                    key: 'postcode',
                    value: { type: 'CloneReference', path: ['missing'], span: [0, 9] },
                    span: [0, 9],
                },
            ] as unknown as AES;

            const cyclicAes: AES = [
                {
                    path: { segments: [{ type: 'root' }, { type: 'member', key: 'a' }] },
                    key: 'a',
                    value: { type: 'CloneReference', path: ['b'], span: [0, 4] },
                    span: [0, 4],
                },
                {
                    path: { segments: [{ type: 'root' }, { type: 'member', key: 'b' }] },
                    key: 'b',
                    value: { type: 'CloneReference', path: ['a'], span: [5, 9] },
                    span: [5, 9],
                },
            ] as unknown as AES;

            const missingSchema: SchemaV1 = {
                rules: [
                    {
                        path: '$.postcode',
                        constraints: {
                            type: 'IntegerLiteral',
                            min_value: '1000',
                            max_value: '9999',
                            resolve_reference_form: true,
                        },
                    },
                ],
            };
            const cycleSchema: SchemaV1 = {
                rules: [
                    {
                        path: '$.a',
                        constraints: {
                            type: 'IntegerLiteral',
                            min_value: '1000',
                            max_value: '9999',
                            resolve_reference_form: true,
                        },
                    },
                ],
            };

            assert.strictEqual(validate(missingTargetAes, missingSchema).ok, true);
            assert.strictEqual(validate(cyclicAes, cycleSchema).ok, true);
        });

        it('allows nullable typed fields and constrains null sentinel values', () => {
            const aes: AES = [
                {
                    path: { segments: [{ type: 'root' }, { type: 'member', key: 'name' }] },
                    key: 'name',
                    value: { type: 'NullLiteral', value: 'none', raw: '!none', span: [1, 6] },
                    span: [1, 6],
                },
                {
                    path: { segments: [{ type: 'root' }, { type: 'member', key: 'reason' }] },
                    key: 'reason',
                    value: { type: 'NullLiteral', value: 'notApplicable', raw: '!notApplicable', span: [8, 22] },
                    span: [8, 22],
                },
            ] as unknown as AES;

            const passing = validate(aes, {
                rules: [
                    { path: '$.name', constraints: { type: 'StringLiteral', nullable: true, null_value: 'none' } },
                    { path: '$.reason', constraints: { type: 'StringLiteral', nullable: true, null_value: 'notApplicable' } },
                ],
            });
            assert.strictEqual(passing.ok, true);

            const failing = validate(aes, {
                rules: [
                    { path: '$.name', constraints: { type: 'StringLiteral', nullable: true, null_value: 'notApplicable' } },
                ],
            });
            assert.strictEqual(failing.ok, false);
            assert.ok(failing.errors.some(e => e.code === ErrorCodes.NULL_VALUE_MISMATCH));
        });

        it('allows multiple accepted null sentinel values', () => {
            const aes: AES = [
                {
                    path: { segments: [{ type: 'root' }, { type: 'member', key: 'reason' }] },
                    key: 'reason',
                    value: { type: 'NullLiteral', value: 'notApplicable', raw: '!notApplicable', span: [1, 15] },
                    span: [1, 15],
                },
            ] as unknown as AES;

            const passing = validate(aes, {
                rules: [
                    { path: '$.reason', constraints: { type: 'StringLiteral', nullable: true, null_values: ['none', 'notApplicable'] } },
                ],
            });
            assert.strictEqual(passing.ok, true);

            const failing = validate(aes, {
                rules: [
                    { path: '$.reason', constraints: { type: 'StringLiteral', nullable: true, null_values: ['none', 'tombstone'] } },
                ],
            });
            assert.strictEqual(failing.ok, false);
            assert.ok(failing.errors.some(e => e.code === ErrorCodes.NULL_VALUE_MISMATCH));
        });

        it('allows infinity and NaN as explicit numeric widenings', () => {
            const aes: AES = [
                {
                    path: { segments: [{ type: 'root' }, { type: 'member', key: 'max' }] },
                    key: 'max',
                    value: { type: 'InfinityLiteral', value: 'Infinity', raw: 'Infinity', span: [1, 9] },
                    span: [1, 9],
                },
                {
                    path: { segments: [{ type: 'root' }, { type: 'member', key: 'sample' }] },
                    key: 'sample',
                    value: { type: 'NaNLiteral', value: 'NaN', raw: 'NaN', span: [11, 14] },
                    span: [11, 14],
                },
            ] as unknown as AES;

            const passing = validate(aes, {
                rules: [
                    { path: '$.max', constraints: { type: 'NumberLiteral', allow_infinity: true } },
                    { path: '$.sample', constraints: { type: 'NumberLiteral', allow_nan: true } },
                ],
            });
            assert.strictEqual(passing.ok, true);

            const failing = validate(aes, {
                rules: [
                    { path: '$.max', constraints: { type: 'NumberLiteral' } },
                    { path: '$.sample', constraints: { type: 'NumberLiteral' } },
                ],
            });
            assert.strictEqual(failing.ok, false);
            assert.ok(failing.errors.every(e => e.code === ErrorCodes.TYPE_MISMATCH));
        });

        it('validates toggle lexical pair constraints', () => {
            const aes: AES = [
                {
                    path: { segments: [{ type: 'root' }, { type: 'member', key: 'enabled' }] },
                    key: 'enabled',
                    value: { type: 'ToggleLiteral', value: 'yes', raw: 'yes', span: [1, 4] },
                    span: [1, 4],
                },
                {
                    path: { segments: [{ type: 'root' }, { type: 'member', key: 'visible' }] },
                    key: 'visible',
                    value: { type: 'ToggleLiteral', value: 'on', raw: 'on', span: [6, 8] },
                    span: [6, 8],
                },
            ] as unknown as AES;

            const result = validate(aes, {
                rules: [
                    { path: '$.enabled', constraints: { type: 'ToggleLiteral', toggle_pair: 'yes_no' } },
                    { path: '$.visible', constraints: { type: 'ToggleLiteral', toggle_pair: 'yes_no' } },
                ],
            });

            assert.strictEqual(result.ok, false);
            assert.deepStrictEqual(result.errors.map(error => error.code), [ErrorCodes.TOGGLE_PAIR_MISMATCH]);
        });

        it('validates min and max children on containers', () => {
            const aes: AES = [
                {
                    path: { segments: [{ type: 'root' }, { type: 'member', key: 'app' }] },
                    key: 'app',
                    value: {
                        type: 'ObjectNode',
                        bindings: [
                            { type: 'Binding', key: 'a', value: { type: 'StringLiteral', value: 'a', raw: '"a"', span: [1, 2] }, attributes: [], span: [1, 2] },
                            { type: 'Binding', key: 'b', value: { type: 'StringLiteral', value: 'b', raw: '"b"', span: [3, 4] }, attributes: [], span: [3, 4] },
                        ],
                        attributes: [],
                        span: [0, 5],
                    },
                    span: [0, 5],
                },
            ] as unknown as AES;

            assert.strictEqual(validate(aes, {
                rules: [{ path: '$.app', constraints: { type: 'ObjectNode', min_children: 1, max_children: 2 } }],
            }).ok, true);

            const result = validate(aes, {
                rules: [{ path: '$.app', constraints: { type: 'ObjectNode', max_children: 1 } }],
            });

            assert.strictEqual(result.ok, false);
            assert.ok(result.errors.some(error => error.code === ErrorCodes.CONTAINER_CARDINALITY_MISMATCH));
        });
    });
});
