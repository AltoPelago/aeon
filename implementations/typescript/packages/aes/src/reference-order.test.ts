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

for (const indexedPaths of [false, true]) {
    for (const fixture of [
        { id: 'header collision forward', source: 'aeon:version = 2.0\ncopy = ~["aeon:version"]\n"aeon:version" = 7', errors: ['FORWARD_REFERENCE'] },
        { id: 'header collision backward', source: 'aeon:version = 2.0\n"aeon:version" = 7\ncopy = ~["aeon:version"]', errors: [] },
        { id: 'header only', source: 'aeon:version = 2.0\ncopy = ~["aeon:version"]', errors: [] },
        { id: 'body hides header attributes', source: 'aeon:header = {version@{z = 1} = 2.0}\n"aeon:version" = 7\ncopy = ~["aeon:version"].@.z', errors: ['MISSING_REFERENCE_TARGET'] },
        { id: 'body attribute forward', source: 'aeon:header = {version@{z = 1} = 2.0}\ncopy = ~["aeon:version"].@.z\n"aeon:version"@{z = 2} = 7', errors: ['FORWARD_REFERENCE'] },
        { id: 'header attribute only', source: 'aeon:header = {version@{z = 1} = 2.0}\ncopy = ~["aeon:version"].@.z', errors: [] },
        { id: 'discarded duplicate target', source: 'a = {b = 1, b = {z = 2}}\ncopy = ~a.b.z', errors: ['MISSING_REFERENCE_TARGET'] },
        { id: 'discarded duplicate claim', source: 'a = {b = 1, b = {z = ~missing}}', errors: [] },
        { id: 'retained first duplicate', source: 'a = {b = {z = 2}, b = 1}\ncopy = ~a.b.z', errors: [] },
        { id: 'discarded duplicate metadata', source: 'a = {b = 1, b@{z = 2} = 2}\ncopy = ~a.b.@.z', errors: ['MISSING_REFERENCE_TARGET'] },
    ]) {
        test(`retained reference paths: ${fixture.id}, indexed=${indexedPaths}`, () => {
            const parsed = parse(tokenize(fixture.source).tokens);
            assert.ok(parsed.errors.every(error => error.code === 'DUPLICATE_KEY'));
            assert.ok(parsed.document);
            const emitted = emitEvents(resolvePaths(parsed.document, { indexedPaths }), { recovery: true });
            const result = validateReferences(emitted.events, { recovery: true });
            assert.deepEqual(result.errors.map(error => error.code), fixture.errors);
            assert.deepEqual(result.events, emitted.events);
            if (fixture.id === 'header collision forward' || fixture.id === 'body attribute forward') {
                const error = result.errors[0];
                assert.ok(error instanceof ForwardReferenceError);
                assert.equal(error.sourceIndex, 1);
                assert.equal(error.targetIndex, 2);
            }
            if (fixture.errors.length > 0) {
                assert.deepEqual(validateReferences(emitted.events).events, []);
            }
        });
    }
}

test('compatibility aliases cannot traverse discarded cross-item duplicate bindings', () => {
    const parsed = parse(tokenize('a = [{b = 1}, {b = {z = ~missing}}]\ncopy = ~a[1].b.z').tokens);
    assert.deepEqual(parsed.errors, []);
    assert.ok(parsed.document);
    const emitted = emitEvents(resolvePaths(parsed.document), { recovery: true });
    assert.deepEqual(emitted.errors.map(error => error.code), ['DUPLICATE_CANONICAL_PATH']);
    assert.deepEqual(validateReferences(emitted.events, { recovery: true }).errors.map(error => error.code),
        ['MISSING_REFERENCE_TARGET']);
});

test('reference target matrix preserves indexed and compatibility paths', () => {
    const cases = [
        { value: '1', targets: ['a'], aliases: [] },
        { value: '[1]', targets: ['a', 'a[0]'], aliases: [] },
        { value: '[[1]]', targets: ['a', 'a[0]', 'a[0][0]'], aliases: [] },
        { value: '(1, 2)', targets: ['a', 'a[0]', 'a[1]'], aliases: [] },
        { value: '[(1, 2)]', targets: ['a', 'a[0]', 'a[0][0]'], aliases: [] },
        { value: '{b = 1}', targets: ['a', 'a.b'], aliases: [] },
        { value: '[{b = 1}]', targets: ['a', 'a[0]', 'a[0].b'], aliases: ['a.b'] },
        { value: '[[{b = 1}]]', targets: ['a', 'a[0]', 'a[0][0]', 'a[0][0].b'], aliases: ['a.b'] },
        { value: '({b = 1}, 2)', targets: ['a', 'a[0]', 'a[1]', 'a[0].b'], aliases: [] },
        { value: '<tag({b = 1})>', targets: ['a', 'a[0]', 'a[0].b'], aliases: [] },
        { value: '[{b@{meta = 1} = 2}]', targets: ['a', 'a[0]', 'a[0].b', 'a[0].b.@.meta'], aliases: ['a.b', 'a.b.@.meta'] },
        { value: '[@{meta = 1} = {b = 2}]', targets: ['a', 'a[0]', 'a[0].b', 'a[0].@.meta'], aliases: ['a.b'] },
    ];
    const targets = ['a', 'a.b', 'a[0]', 'a[1]', 'a[0][0]', 'a[0].b', 'a[0][0].b',
        'a.b.@.meta', 'a[0].b.@.meta', 'a[0].@.meta'];
    for (const indexedPaths of [false, true]) {
        for (const fixture of cases) {
            const valid = new Set([...fixture.targets, ...(!indexedPaths ? fixture.aliases : [])]);
            for (const target of targets) {
                const source = `a = ${fixture.value}\ncopy = ~${target}`;
                const parsed = parse(tokenize(source).tokens);
                assert.deepEqual(parsed.errors, []);
                assert.ok(parsed.document);
                const emitted = emitEvents(resolvePaths(parsed.document, { indexedPaths }));
                assert.deepEqual(emitted.errors, []);
                assert.deepEqual(validateReferences(emitted.events).errors.map(error => error.code),
                    valid.has(target) ? [] : ['MISSING_REFERENCE_TARGET'],
                    `${source}, indexed=${indexedPaths}`);
            }
        }
    }
});

for (const source of [
    'a = [{ b = 1 }]\ncopy = ~a.b',
    'a = [[{ b = 1 }]]\ncopy = ~a.b',
    'a = [{ b@{z = 2} = 1 }]\ncopy = ~a.b.@.z',
    'a = [1]\ncopy = ~a[0]',
    'a = [{ b = 1 }]\ncopy = ~a[0].b',
    'a = (1, 2)\ncopy = ~a[1]',
]) {
    test(`default resolver compatibility: ${source}`, () => {
        const parsed = parse(tokenize(source).tokens);
        assert.deepEqual(parsed.errors, []);
        assert.ok(parsed.document);
        const emitted = emitEvents(resolvePaths(parsed.document));
        assert.deepEqual(emitted.errors, []);
        assert.deepEqual(validateReferences(emitted.events).errors, []);
    });
}
