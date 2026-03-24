import test from 'node:test';
import assert from 'node:assert/strict';
import { formatDatatypeAnnotation } from './datatype.js';

test('formats simple canonical datatype annotation', () => {
    assert.equal(formatDatatypeAnnotation({
        type: 'TypeAnnotation',
        name: 'int32',
        genericArgs: [],
        separators: [],
        span: {
            start: { line: 1, column: 1, offset: 0 },
            end: { line: 1, column: 1, offset: 0 },
        },
    }), ':int32');
});

test('formats generic canonical datatype annotation with separators', () => {
    assert.equal(formatDatatypeAnnotation({
        type: 'TypeAnnotation',
        name: 'tuple',
        genericArgs: ['int32', 'string'],
        separators: ['|'],
        span: {
            start: { line: 1, column: 1, offset: 0 },
            end: { line: 1, column: 1, offset: 0 },
        },
    }), ':tuple<int32, string>[|]');
});

test('formats chained separator specs as repeated bracket segments', () => {
    assert.equal(formatDatatypeAnnotation({
        type: 'TypeAnnotation',
        name: 'dim',
        genericArgs: [],
        separators: ['x', 'y'],
        span: {
            start: { line: 1, column: 1, offset: 0 },
            end: { line: 1, column: 1, offset: 0 },
        },
    }), ':dim[x][y]');
});
