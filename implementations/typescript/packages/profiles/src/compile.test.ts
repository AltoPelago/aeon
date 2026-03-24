import test from 'node:test';
import assert from 'node:assert/strict';
import { compile } from './compile.js';
import { createDefaultRegistry, createRegistry } from './registry.js';
import type { Profile } from './types.js';

const sourceOk = 'ok';
const sourceError = 'error';

const dummyProfile: Profile = {
    id: 'test.profile',
    version: '1',
    compile(input, ctx) {
        if (input === sourceError) {
            ctx.error({ message: 'synthetic error', code: 'TEST_ERROR' });
            return [{ path: {} as any, key: 'x', value: {} as any, span: {} as any }];
        }
        return [{ path: {} as any, key: 'x', value: {} as any, span: {} as any }];
    },
};

function createTestRegistry() {
    return createRegistry().register(dummyProfile);
}

test('compile returns AES for registered profile', () => {
    const result = compile(sourceOk, {
        profile: 'test.profile',
        registry: createTestRegistry(),
        mode: 'strict',
    });

    assert.equal(result.aes.length > 0, true);
    assert.equal(result.meta?.errors, undefined);
    assert.equal(result.meta?.profileId, 'test.profile');
});

test('compile fails with unknown profile', () => {
    const result = compile(sourceOk, {
        profile: 'unknown.profile',
        registry: createTestRegistry(),
        mode: 'strict',
    });

    assert.equal(result.aes.length, 0);
    assert.equal(result.meta?.errors?.length ? result.meta.errors.length > 0 : false, true);
});

test('compile in strict mode fails closed on errors', () => {
    const result = compile(sourceError, {
        profile: 'test.profile',
        registry: createTestRegistry(),
        mode: 'strict',
    });

    assert.equal(result.aes.length, 0);
    assert.equal(result.meta?.errors?.length ? result.meta.errors.length > 0 : false, true);
});

test('compile in loose mode returns events even with errors', () => {
    const result = compile(sourceError, {
        profile: 'test.profile',
        registry: createTestRegistry(),
        mode: 'loose',
    });

    assert.equal(result.aes.length, 1);
    assert.equal(result.meta?.errors?.length ? result.meta.errors.length > 0 : false, true);
});

test('compile rejects string input that exceeds maxInputBytes', () => {
    const result = compile('012345', {
        profile: 'test.profile',
        registry: createTestRegistry(),
        mode: 'strict',
        maxInputBytes: 4,
    });

    assert.equal(result.aes.length, 0);
    assert.ok(result.meta?.errors?.some((diag) => diag.code === 'INPUT_SIZE_EXCEEDED'));
});

test('processors run in deterministic order', () => {
    const profile: Profile = {
        id: 'ordered.profile',
        compile() {
            return [{ path: {} as any, key: 'a', value: {} as any, span: {} as any }];
        },
        processors: [
            {
                id: 'b',
                order: 1,
                apply(aes) {
                    return [...aes, { path: {} as any, key: 'b', value: {} as any, span: {} as any }];
                },
            },
            {
                id: 'a',
                order: 1,
                apply(aes) {
                    return [...aes, { path: {} as any, key: 'c', value: {} as any, span: {} as any }];
                },
            },
            {
                id: 'z',
                order: 0,
                apply(aes) {
                    return [...aes, { path: {} as any, key: 'd', value: {} as any, span: {} as any }];
                },
            },
        ],
    };

    const result = compile('ok', {
        profile,
        registry: createRegistry().register(profile),
        mode: 'strict',
    });

    const keys = result.aes.map((e) => e.key);
    assert.deepEqual(keys, ['a', 'd', 'c', 'b']);
});

test('processor errors fail closed in strict mode', () => {
    const profile: Profile = {
        id: 'error.profile',
        compile() {
            return [{ path: {} as any, key: 'a', value: {} as any, span: {} as any }];
        },
        processors: [
            {
                id: 'err',
                apply(aes, ctx) {
                    ctx.error({ message: 'processor error', code: 'PROC_ERROR' });
                    return aes;
                },
            },
        ],
    };

    const result = compile('ok', {
        profile,
        registry: createRegistry().register(profile),
        mode: 'strict',
    });

    assert.equal(result.aes.length, 0);
    assert.equal(result.meta?.errors?.length ? result.meta.errors.length > 0 : false, true);
});

test('compile forwards depth policy knobs into CompileCtx', () => {
    let observedAttr = -1;
    let observedSep = -1;
    let observedGeneric = -1;
    let observedDatatypePolicy: 'reserved_only' | 'allow_custom' | undefined = 'reserved_only';

    const profile: Profile = {
        id: 'policy.profile',
        compile(_input, ctx) {
            observedAttr = ctx.maxAttributeDepth;
            observedSep = ctx.maxSeparatorDepth;
            observedGeneric = ctx.maxGenericDepth;
            observedDatatypePolicy = ctx.datatypePolicy;
            return [{ path: {} as any, key: 'a', value: {} as any, span: {} as any }];
        },
    };

    const result = compile('ok', {
        profile,
        registry: createRegistry().register(profile),
        mode: 'strict',
        datatypePolicy: 'allow_custom',
        maxAttributeDepth: 8,
        maxSeparatorDepth: 8,
        maxGenericDepth: 8,
    });

    assert.equal(result.aes.length, 1);
    assert.equal(observedAttr, 8);
    assert.equal(observedSep, 8);
    assert.equal(observedGeneric, 8);
    assert.equal(observedDatatypePolicy, 'allow_custom');
});

test('default registry includes aeon.gp.profile.v1 alias', () => {
    const registry = createDefaultRegistry();
    assert.equal(registry.has('aeon.gp.profile.v1'), true);
});

test('default core profile parses introducer node syntax', () => {
    const result = compile('view:node = <panel("hello")>', {
        profile: 'aeon.gp.profile.v1',
        registry: createDefaultRegistry(),
        mode: 'strict',
    });
    assert.equal(result.meta?.errors?.length ?? 0, 0);
    assert.equal(result.aes.length, 1);
});
