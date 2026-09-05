import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { SchemaV1 } from './types/schema.js';
import { validateTelex } from './telex.js';

const numberSchema: SchemaV1 = {
    rules: [{ path: '$.answer', constraints: { required: true, type: 'NumberLiteral' } }],
};

describe('AEOS Telex validation', () => {
    it('validates a complete Telex stream directly', () => {
        const result = validateTelex(
            'telex.aes=0\n\npath=$.answer\nkind=NumberLiteral\nvalue=42\n',
            numberSchema,
        );
        assert.equal(result.ok, true);
        assert.deepEqual(result.guarantees['$.answer'], ['present', 'integer-representable', 'float-representable']);
    });

    it('reports AES profile failures before schema validation', () => {
        const result = validateTelex(
            'telex.aes=0\n\npath=$.nested.answer\nkind=NumberLiteral\nvalue=42\n',
            numberSchema,
        );
        assert.equal(result.ok, false);
        assert.ok(result.errors.some((error) => error.code === 'AES_MISSING_PARENT'));
    });
});
