import { describe, it } from 'node:test';
import assert from 'node:assert';
import { formatDatatypeAnnotation } from './datatype.js';

describe('Finalize datatype formatting', () => {
    it('formats simple datatype name', () => {
        assert.strictEqual(formatDatatypeAnnotation({
            name: 'int32',
            genericArgs: [],
            radixBase: null,
            separators: [],
        }), 'int32');
    });

    it('formats datatype with generic args and separators', () => {
        assert.strictEqual(formatDatatypeAnnotation({
            name: 'tuple',
            genericArgs: ['int32', 'string'],
            radixBase: null,
            separators: ['|'],
        }), 'tuple<int32, string>[|]');
    });

    it('formats radix datatype with bracket base metadata', () => {
        assert.strictEqual(formatDatatypeAnnotation({
            name: 'radix',
            genericArgs: [],
            radixBase: 10,
            separators: [],
        }), 'radix[10]');
    });
});
