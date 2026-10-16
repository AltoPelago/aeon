import { describe, it } from 'node:test';
import assert from 'node:assert';
import { formatDatatypeAnnotation } from './datatype.js';

it('preserves exact numeric clarifiers from a serialized AST', () => {
    assert.strictEqual(formatDatatypeAnnotation({ name: 'custom', clarifiers: [
        { type: 'NumberLiteral', value: '9007199254740993' }, '9007199254740993',
    ] }), 'custom[9007199254740993, "9007199254740993"]');
});

describe('Finalize datatype formatting', () => {
    it('formats simple datatype name', () => {
        assert.strictEqual(formatDatatypeAnnotation({
            name: 'int32',
            genericArgs: [],
            clarifiers: [],
        }), 'int32');
    });

    it('formats datatype with generic args and string clarifiers', () => {
        assert.strictEqual(formatDatatypeAnnotation({
            name: 'tuple',
            genericArgs: ['int32', 'string'],
            clarifiers: ['|'],
        }), 'tuple<int32, string>["|"]');
    });

    it('formats radix datatype with bracket base metadata', () => {
        assert.strictEqual(formatDatatypeAnnotation({
            name: 'radix',
            genericArgs: [],
            clarifiers: [10],
        }), 'radix[10]');
    });

    it('tolerates minimal or null datatype metadata objects', () => {
        assert.strictEqual(formatDatatypeAnnotation({
            name: 'int32',
            genericArgs: null,
            separators: null,
        }), 'int32');
        assert.strictEqual(formatDatatypeAnnotation(null), '');
    });
});
