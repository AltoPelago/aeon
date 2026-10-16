import test from 'node:test';
import assert from 'node:assert/strict';
import fixtures from '../../../../../test-fixtures/reference-authored-order.json' with { type: 'json' };
import { tokenize } from '@altopelago/aeon-lexer';
import { parse } from '@altopelago/aeon-parser';
import { emitEvents, resolvePaths } from './index.js';
import { ForwardReferenceError, validateReferences } from './references.js';

for (const fixture of fixtures) {
    test(`authored reference order: ${fixture.id}`, () => {
        const lexed = tokenize(fixture.source);
        assert.deepEqual(lexed.errors, []);
        const parsed = parse(lexed.tokens, { maxAttributeDepth: fixture.maxAttributeDepth ?? 1 });
        assert.deepEqual(parsed.errors, []);
        assert.ok(parsed.document);
        const emitted = emitEvents(resolvePaths(parsed.document, { indexedPaths: true }));
        assert.deepEqual(emitted.errors, []);
        const options = { maxAttributeDepth: fixture.maxAttributeDepth ?? 1 };
        const result = validateReferences(emitted.events, options);
        assert.deepEqual(result.errors.map(error => error.code), fixture.errors);
        if (fixture.id === 'attribute-forward' || fixture.id === 'object-forward') {
            const error = result.errors[0];
            assert.ok(error instanceof ForwardReferenceError);
            assert.equal(error.sourceIndex, fixture.id === 'attribute-forward' ? 0 : 1);
            assert.equal(error.targetIndex, fixture.id === 'attribute-forward' ? 0 : 2);
        }
        if (fixture.errors.length > 0) {
            assert.deepEqual(result.events, []);
            const recovery = validateReferences(emitted.events, { ...options, recovery: true });
            assert.deepEqual(recovery.events, emitted.events);
            assert.deepEqual(recovery.errors.map(error => error.code), fixture.errors);
            for (const error of result.errors) {
                assert.match(fixture.source.slice(error.span.start.offset, error.span.end.offset), /^~/);
            }
        }
    });
}
