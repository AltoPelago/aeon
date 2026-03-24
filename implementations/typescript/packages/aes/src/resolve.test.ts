import { describe, it } from 'node:test';
import assert from 'node:assert';
import { resolveRefs } from './resolve.js';
import { tokenize } from '@aeon/lexer';
import { parse } from '@aeon/parser';
import { resolvePaths, emitEvents, formatPath } from './index.js';

function compileToEvents(input: string, _legacySyntaxFlag: boolean = false) {
    const tokens = tokenize(input).tokens;
    const ast = parse(tokens);
    if (!ast.document) throw new Error('Parse failed');
    const resolved = resolvePaths(ast.document, { indexedPaths: true });
    const emitted = emitEvents(resolved, { recovery: true });
    return emitted.events;
}

describe('Reference Resolution (Resolved AES)', () => {
    it('resolves clone references to terminal values', () => {
        const events = compileToEvents('a = 1\nb = ~a');
        const result = resolveRefs(events, { mode: 'strict' });
        assert.strictEqual(result.aes.length, 2);
        assert.strictEqual(result.aes[1]!.value.type, 'NumberLiteral');
        assert.strictEqual((result.aes[1]!.value as any).raw, '1');
    });

    it('preserves pointer references', () => {
        const events = compileToEvents('a = 1\nb = ~>a');
        const result = resolveRefs(events, { mode: 'strict' });
        assert.strictEqual(result.aes.length, 2);
        assert.strictEqual(result.aes[1]!.value.type, 'PointerReference');
    });

    it('resolves nested clone references inside objects', () => {
        const events = compileToEvents('base = { x = 1 }\nuse = { y = ~base.x }');
        const result = resolveRefs(events, { mode: 'strict' });
        const useEvent = result.aes.find((e) => formatPath(e.path) === '$.use');
        const useYEvent = result.aes.find((e) => formatPath(e.path) === '$.use.y');
        assert.ok(useEvent);
        assert.ok(useYEvent);
        assert.strictEqual(useEvent!.value.type, 'ObjectNode');
        assert.strictEqual(useYEvent!.value.type, 'NumberLiteral');
    });

    it('strict mode fails closed on forward references', () => {
        const events = compileToEvents('a = ~b\nb = 1');
        const result = resolveRefs(events, { mode: 'strict' });
        assert.strictEqual(result.aes.length, 0);
        assert.ok(result.meta?.errors && result.meta.errors.length > 0);
    });

    it('loose mode preserves clone reference and emits warnings', () => {
        const events = compileToEvents('a = ~b\nb = 1');
        const result = resolveRefs(events, { mode: 'loose' });
        assert.strictEqual(result.aes.length, 2);
        assert.strictEqual(result.aes[0]!.value.type, 'CloneReference');
        assert.ok(result.meta?.warnings && result.meta.warnings.length > 0);
    });

    it('resolution is idempotent', () => {
        const events = compileToEvents('a = 1\nb = ~a');
        const once = resolveRefs(events, { mode: 'strict' });
        const twice = resolveRefs(once.aes, { mode: 'strict' });
        assert.deepStrictEqual(twice.aes, once.aes);
    });

    it('resolves indexed clone references in core v1', () => {
        const events = compileToEvents('coords = [10, 20]\nsecond = ~coords[1]', true);
        const result = resolveRefs(events, { mode: 'strict' });
        const second = result.aes.find((event) => formatPath(event.path) === '$.second');
        assert.ok(second);
        assert.strictEqual(second!.value.type, 'NumberLiteral');
        assert.strictEqual((second!.value as any).raw, '20');
    });
});
