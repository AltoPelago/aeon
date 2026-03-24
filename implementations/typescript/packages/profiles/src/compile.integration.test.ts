import test from 'node:test';
import assert from 'node:assert/strict';
import { compile } from './compile.js';

const shouldRun = process.env.AEON_PROFILES_INTEGRATION === '1';

const source = `
config = {
  host = "localhost"
  port:int32 = 8080
}
`;

const sourceForwardRef = 'a = ~b\nb = 1';

test('integration: altopelago.core.v1 compiles AEON to AES', { skip: !shouldRun }, () => {
    const result = compile(source, {
        profile: 'altopelago.core.v1',
        mode: 'strict',
    });

    assert.equal(result.meta?.errors, undefined);
    assert.equal(result.aes.length > 0, true);
});

test('integration: strict mode fails closed on reference errors', { skip: !shouldRun }, () => {
    const result = compile(sourceForwardRef, {
        profile: 'altopelago.core.v1',
        mode: 'strict',
    });

    assert.equal(result.aes.length, 0);
    assert.equal(result.meta?.errors?.length ? result.meta.errors.length > 0 : false, true);
});

test('integration: loose mode returns events with errors', { skip: !shouldRun }, () => {
    const result = compile(sourceForwardRef, {
        profile: 'altopelago.core.v1',
        mode: 'loose',
    });

    assert.equal(result.aes.length, 2);
    assert.equal(result.meta?.errors?.length ? result.meta.errors.length > 0 : false, true);
});

test('integration: resolve refs processor rewrites clone references', { skip: !shouldRun }, async () => {
    const { createResolveRefsProcessor } = await import('./processors/resolve-refs.js');
    const profile = {
        id: 'resolve.profile',
        compile() {
            return [
                { path: { segments: [{ type: 'root' }, { type: 'member', key: 'a' }] } as any, key: 'a', value: { type: 'NumberLiteral', raw: '1', value: '1', span: {} } as any, span: {} as any },
                { path: { segments: [{ type: 'root' }, { type: 'member', key: 'b' }] } as any, key: 'b', value: { type: 'CloneReference', path: ['a'], span: {} } as any, span: {} as any },
            ];
        },
        processors: [createResolveRefsProcessor('strict')],
    };

    const result = compile('ok', {
        profile,
        mode: 'strict',
    });

    assert.equal(result.aes.length, 2);
    assert.equal(result.aes[1]!.value.type, 'NumberLiteral');
});

test('integration: json profile resolves references', { skip: !shouldRun }, () => {
    const result = compile('a = 1\nb = ~a', {
        profile: 'json',
        mode: 'strict',
    });

    assert.equal(result.aes.length, 2);
    assert.equal(result.aes[1]!.value.type, 'NumberLiteral');
});
