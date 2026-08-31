import { describe, it } from 'node:test';
import assert from 'node:assert';
import { formatDatatypeAnnotation } from './datatype.js';

describe('Datatype annotation formatting', () => {
    it('formats simple datatype name', () => {
        assert.strictEqual(formatDatatypeAnnotation({
            type: 'TypeAnnotation',
            name: 'int32',
            genericArgs: [],
            clarifiers: [],
            span: {
                start: { line: 1, column: 1, offset: 0 },
                end: { line: 1, column: 1, offset: 0 },
            },
        }), 'int32');
    });

    it('formats datatype with generics and string clarifiers', () => {
        assert.strictEqual(formatDatatypeAnnotation({
            type: 'TypeAnnotation',
            name: 'tuple',
            genericArgs: ['int32', 'string'],
            clarifiers: ['|'],
            span: {
                start: { line: 1, column: 1, offset: 0 },
                end: { line: 1, column: 1, offset: 0 },
            },
        }), 'tuple<int32, string>["|"]');
    });

    it('formats multiple clarifier values in one bracket', () => {
        assert.strictEqual(formatDatatypeAnnotation({
            type: 'TypeAnnotation',
            name: 'grid',
            genericArgs: [],
            clarifiers: ['|', '>'],
            span: {
                start: { line: 1, column: 1, offset: 0 },
                end: { line: 1, column: 1, offset: 0 },
            },
        }), 'grid["|", ">"]');
    });

    it('formats radix datatype with bracket base metadata', () => {
        assert.strictEqual(formatDatatypeAnnotation({
            type: 'TypeAnnotation',
            name: 'radix',
            genericArgs: [],
            clarifiers: [10],
            span: {
                start: { line: 1, column: 1, offset: 0 },
                end: { line: 1, column: 1, offset: 0 },
            },
        }), 'radix[10]');
    });
});
