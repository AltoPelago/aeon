import { describe, it } from 'node:test';
import assert from 'node:assert';
import { resolveRefs } from './resolve.js';
import { tokenize } from '@altopelago/aeon-lexer';
import { parse } from '@altopelago/aeon-parser';
import { resolvePaths, emitEvents, formatPath, validateReferences } from './index.js';

function compileToEvents(input: string, _legacySyntaxFlag: boolean = false) {
    const lexed = tokenize(input);
    assert.deepStrictEqual(lexed.errors, []);
    const ast = parse(lexed.tokens, { maxAttributeDepth: 2 });
    assert.deepStrictEqual(ast.errors, []);
    if (!ast.document) throw new Error('Parse failed');
    const resolved = resolvePaths(ast.document, { indexedPaths: true });
    const emitted = emitEvents(resolved, { recovery: true });
    return emitted.events;
}

describe('Reference Resolution (Resolved AES)', () => {
    for (const mode of ['strict', 'loose'] as const) {
        for (const [name, source, expected] of [
            ['binding attribute', 'x@{y=0}=1\nz=~x.@.y', '0'],
            ['quoted attribute', 'x@{"y.z"=2}=1\nz=~x.@.["y.z"]', '2'],
            ['member under attribute', 'x@{y={leaf=3}}=1\nz=~x.@.y.leaf', '3'],
            ['index under attribute', 'x@{y=[4,5]}=1\nz=~x.@.y[1]', '5'],
            ['nested attribute', 'x@{y@{leaf=6}=0}=1\nz=~x.@.y.@.leaf', '6'],
            ['attribute clone chain', 'x@{a=7,b=~x.@.a}=1\nz=~x.@.b', '7'],
            ['own already available metadata', 'x@{y=8}=~x.@.y\nz=~x', '8'],
            ['anonymous item metadata', 'x=[@{y=9}=1]\nz=~x[0].@.y', '9'],
            ['header descendant after root collision', 'aeon:header={x={leaf=10}}\n"aeon:x"=2\nz=~["aeon:x"].leaf', '10'],
            ['header descendant metadata after root collision', 'aeon:header={x={leaf@{y=11}=0}}\n"aeon:x"=2\nz=~["aeon:x"].leaf.@.y', '11'],
            ['body metadata over header metadata', 'aeon:header={x@{y=1}=0}\n"aeon:x"@{y=12}=2\nz=~["aeon:x"].@.y', '12'],
            ['literal attribute-like member key', 'x={"a.@.b"=13}\nz=~x.["a.@.b"]', '13'],
        ] as const) {
            it(`resolves ${name} in ${mode} mode`, () => {
                const events = compileToEvents(source);
                assert.deepStrictEqual(validateReferences(events, { maxAttributeDepth: 2 }).errors, []);
                const result = resolveRefs(events, { mode });
                assert.deepStrictEqual(result.meta?.errors ?? [], []);
                assert.deepStrictEqual(result.meta?.warnings ?? [], []);
                const value = result.aes.find(event => event.key === 'z')?.value;
                assert.strictEqual(value?.type, 'NumberLiteral');
                if (value?.type !== 'NumberLiteral') assert.fail('Expected resolved number');
                assert.strictEqual(value.value, expected);
                assert.deepStrictEqual(resolveRefs(result.aes, { mode }).aes, result.aes);
            });
        }

        for (const [name, source, code] of [
            ['missing attribute', 'x=1\nz=~x.@.missing', 'RESOLVE_MISSING_TARGET'],
            ['forward attribute', 'z=~x.@.y\nx@{y=0}=1', 'RESOLVE_FORWARD_REFERENCE'],
            ['forward sibling metadata', 'x@{a=~x.@.b,b=0}=1', 'RESOLVE_FORWARD_REFERENCE'],
            ['self metadata', 'x@{a=~x.@.a}=1', 'RESOLVE_SELF_REFERENCE'],
            ['metadata referring to its owner', 'x@{a=~x}=1', 'RESOLVE_SELF_REFERENCE'],
            ['shadowed header metadata', 'aeon:header={x@{y=0}=1}\n"aeon:x"=2\nz=~["aeon:x"].@.y', 'RESOLVE_MISSING_TARGET'],
        ] as const) {
            it(`retains ${name} diagnostics in ${mode} mode`, () => {
                const result = resolveRefs(compileToEvents(source), { mode });
                const diagnostics = mode === 'strict' ? result.meta?.errors : result.meta?.warnings;
                assert.ok(diagnostics?.some(diagnostic => diagnostic.code === code));
                assert.strictEqual(result.aes.length === 0, mode === 'strict');
            });
        }
    }

    it('preserves typed targets and strips identities when cloning attribute payloads', () => {
        const events = compileToEvents(String.raw`x@{y = <tag\HEAD\@{role\ROLE\ = "button"}(\CHILD\:string = "v")>}=1
z=~x.@.y`);
        const result = resolveRefs(events);
        assert.deepStrictEqual(result.meta?.errors ?? [], []);
        const value = result.aes.find(event => event.key === 'z')?.value;
        assert.strictEqual(value?.type, 'NodeLiteral');
        if (value?.type !== 'NodeLiteral') assert.fail('Expected cloned node');
        assert.strictEqual(value.structuralId, null);
        assert.strictEqual(value.attributes[0]?.entries.get('role')?.structuralId, null);
        assert.strictEqual(value.children[0]?.type, 'TypedValue');
        if (value.children[0]?.type !== 'TypedValue') assert.fail('Expected typed child');
        assert.strictEqual(value.children[0].structuralId, null);
        assert.strictEqual(value.children[0].datatype?.name, 'string');
    });

    it('preserves pointer references to attributes rather than cloning them', () => {
        const result = resolveRefs(compileToEvents('x@{y=0}=1\nz=~>x.@.y'));
        assert.deepStrictEqual(result.meta?.errors ?? [], []);
        assert.strictEqual(result.aes.find(event => event.key === 'z')?.value.type, 'PointerReference');
    });

    it('applies reference depth limits to attribute clone chains', () => {
        const result = resolveRefs(compileToEvents('x@{a=0,b=~x.@.a}=1\nz=~x.@.b'), {
            maxReferenceDepth: 1,
        });
        assert.deepStrictEqual(result.aes, []);
        assert.ok(result.meta?.errors?.some(error => error.code === 'RESOLVE_REFERENCE_DEPTH_EXCEEDED'));
    });

    it('resolves clone references to terminal values', () => {
        const events = compileToEvents('a = 1\nb = ~a');
        const result = resolveRefs(events, { mode: 'strict' });
        assert.strictEqual(result.aes.length, 2);
        assert.strictEqual(result.aes[1]!.value.type, 'NumberLiteral');
        assert.strictEqual((result.aes[1]!.value as any).raw, '1');
    });

    it('does not duplicate structural identities when materializing clones', () => {
        const events = compileToEvents(String.raw`original\ORIGINAL\@{meta\META\ = "x"} = <tag\HEAD\@{role\ROLE\ = "button"}(\CHILD\:string = "v")>
copy\COPY\ = ~original`);
        const result = resolveRefs(events, { mode: 'strict' });
        const original = result.aes.find((event) => event.key === 'original');
        const copy = result.aes.find((event) => event.key === 'copy');

        assert.strictEqual(original?.structuralId, 'ORIGINAL');
        assert.strictEqual(original?.annotations?.get('meta')?.structuralId, 'META');
        assert.strictEqual(copy?.structuralId, 'COPY');
        assert.strictEqual(copy?.value.type, 'NodeLiteral');
        if (copy?.value.type !== 'NodeLiteral') assert.fail('Expected cloned NodeLiteral');
        assert.strictEqual(copy.value.structuralId, null);
        assert.strictEqual(copy.value.attributes[0]?.entries.get('role')?.structuralId, null);
        assert.strictEqual(copy.value.children[0]?.type, 'TypedValue');
        if (copy.value.children[0]?.type !== 'TypedValue') assert.fail('Expected headed child');
        assert.strictEqual(copy.value.children[0].structuralId, null);
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

    it('fails closed when clone resolution exceeds maxReferenceDepth', () => {
        const events = compileToEvents('a = 1\nb = ~a\nc = ~b');
        const result = resolveRefs(events, { mode: 'strict', maxReferenceDepth: 0 });

        assert.strictEqual(result.aes.length, 0);
        assert.ok(result.meta?.errors?.some((error) => error.code === 'RESOLVE_REFERENCE_DEPTH_EXCEEDED'));
    });
});
