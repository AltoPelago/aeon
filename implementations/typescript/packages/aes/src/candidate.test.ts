import assert from 'node:assert/strict';
import test from 'node:test';
import type {
    CandidateAES,
    CandidateAssignmentEvent,
    CandidateAttributeEntry,
    CandidateValue,
} from './index.js';

test('exports reconstructed candidate AES types from the public package entrypoint', () => {
    const candidateValue: CandidateValue = {
        type: 'ObjectNode',
        bindings: [],
        attributes: [],
        span: [0, 0],
    };
    const candidateAttribute: CandidateAttributeEntry = {
        value: { type: 'StringLiteral', value: 'cm', raw: '"cm"', delimiter: '"', span: [0, 0] },
        datatype: 'string',
    };
    const candidateEvent: CandidateAssignmentEvent = {
        path: { segments: [{ type: 'root' }, { type: 'member', key: 'quantity' }] },
        key: 'quantity',
        value: candidateValue,
        span: [0, 0],
        datatype: 'object',
        annotations: new Map([['unit', candidateAttribute]]),
    };
    const candidateAes: CandidateAES = [candidateEvent];

    assert.equal(candidateAes[0]?.key, 'quantity');
    assert.equal(candidateAes[0]?.annotations?.get('unit')?.datatype, 'string');
});
