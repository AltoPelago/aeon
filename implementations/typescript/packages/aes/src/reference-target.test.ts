import { describe, it } from 'node:test';
import assert from 'node:assert';
import { formatReferenceTargetPath } from './reference-target.js';

describe('Reference target formatting', () => {
    it('formats member-only references as canonical paths', () => {
        assert.strictEqual(formatReferenceTargetPath(['config', 'db', 'host']), '$.config.db.host');
    });

    it('formats indexed references with bracket notation', () => {
        assert.strictEqual(formatReferenceTargetPath(['items', 1]), '$.items[1]');
    });

    it('formats root index references', () => {
        assert.strictEqual(formatReferenceTargetPath([0]), '$[0]');
    });

    it('formats attribute reference segments', () => {
        assert.strictEqual(
            formatReferenceTargetPath(['a', { type: 'attr', key: 'meta' }, { type: 'attr', key: 'x.y' }]),
            '$.a@meta@["x.y"]'
        );
    });
});
