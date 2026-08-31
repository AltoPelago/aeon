import test from 'node:test';
import assert from 'node:assert/strict';
import { formatDatatypeAnnotation } from './datatype.js';

test('formats simple canonical datatype annotation', () => {
    assert.equal(formatDatatypeAnnotation({
        type: 'TypeAnnotation',
        name: 'int32',
        genericArgs: [],
        clarifiers: [],
        span: {
            start: { line: 1, column: 1, offset: 0 },
            end: { line: 1, column: 1, offset: 0 },
        },
    }), ':int32');
});

test('formats generic canonical datatype annotation with string clarifiers', () => {
    assert.equal(formatDatatypeAnnotation({
        type: 'TypeAnnotation',
        name: 'tuple',
        genericArgs: ['int32', 'string'],
        clarifiers: ['|'],
        span: {
            start: { line: 1, column: 1, offset: 0 },
            end: { line: 1, column: 1, offset: 0 },
        },
    }), ':tuple<int32, string>["|"]');
});

test('formats multiple clarifier values in one bracket segment', () => {
    assert.equal(formatDatatypeAnnotation({
        type: 'TypeAnnotation',
        name: 'dim',
        genericArgs: [],
        clarifiers: ['x', 'y'],
        span: {
            start: { line: 1, column: 1, offset: 0 },
            end: { line: 1, column: 1, offset: 0 },
        },
    }), ':dim["x", "y"]');
});
