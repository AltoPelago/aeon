import { describe, it } from 'node:test';
import assert from 'node:assert';
import { formatDatatypeAnnotation } from './datatype.js';

describe('Finalize datatype formatting', () => {
    it('formats simple datatype name', () => {
        assert.strictEqual(formatDatatypeAnnotation({
            name: 'int32',
            genericArgs: [],
            separators: [],
        }), 'int32');
    });

    it('formats datatype with generic args and separators', () => {
        assert.strictEqual(formatDatatypeAnnotation({
            name: 'tuple',
            genericArgs: ['int32', 'string'],
            separators: ['|'],
        }), 'tuple<int32, string>[|]');
    });
});
