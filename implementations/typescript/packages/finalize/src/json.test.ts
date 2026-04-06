import { describe, it } from 'node:test';
import assert from 'node:assert';
import { finalizeJson, finalizeLinkedJson } from './json.js';
import { tokenize } from '@aeon/lexer';
import { parse } from '@aeon/parser';
import { resolvePaths, emitEvents } from '@aeon/aes';

function compileToEvents(input: string, _legacySyntaxFlag: boolean = false, maxAttributeDepth: number = 1) {
    const lexed = tokenize(input);
    assert.deepStrictEqual(lexed.errors, []);

    const ast = parse(lexed.tokens, { maxAttributeDepth });
    assert.deepStrictEqual(ast.errors, []);
    if (!ast.document) throw new Error('Parse failed');
    const resolved = resolvePaths(ast.document, { indexedPaths: true });
    assert.deepStrictEqual(resolved.errors, []);
    const emitted = emitEvents(resolved, { recovery: true });
    assert.deepStrictEqual(emitted.errors, []);
    return emitted.events;
}

function compileHeader(input: string) {
    const tokens = tokenize(input).tokens;
    const ast = parse(tokens);
    if (!ast.document?.header) throw new Error('Header parse failed');
    return {
        fields: ast.document.header.fields,
        span: ast.document.header.span,
        form: ast.document.header.form,
    };
}

describe('Finalization (JSON)', () => {
    it('builds JSON output from top-level bindings', () => {
        const events = compileToEvents(
            [
                'name = "AEON"',
                'count = 3',
                'config = {',
                '  host = "localhost"',
                '  port:int32 = 5432',
                '}',
                'flags = [true, false]',
            ].join('\n')
        );
        const result = finalizeJson(events);
        assert.deepStrictEqual(result.document, {
            name: 'AEON',
            count: 3,
            config: {
                host: 'localhost',
                port: 5432,
            },
            flags: [true, false],
        });
    });

    it('records reference diagnostics and preserves tokens', () => {
        const events = compileToEvents('a = 1\nb = ~>a');
        const result = finalizeJson(events, { mode: 'strict' });
        assert.ok(result.meta?.errors && result.meta.errors.length > 0);
        assert.strictEqual(result.document.b, '~>a');
    });

    it('materializes clone references as concrete JSON values', () => {
        const events = compileToEvents('ref_source_num:number = 99\nclone001:number = ~ref_source_num');
        const result = finalizeJson(events, { mode: 'strict' });

        assert.equal(result.meta?.errors?.length ?? 0, 0);
        assert.strictEqual(result.document.ref_source_num, 99);
        assert.strictEqual(result.document.clone001, 99);
    });

    it('enforces maxMaterializedWeight for repeated clone expansion', () => {
        const events = compileToEvents([
            'big = { a = 1, b = 2, c = 3 }',
            'copy1 = ~big',
            'copy2 = ~big',
        ].join('\n'));
        const result = finalizeJson(events, { mode: 'strict', maxMaterializedWeight: 4 });

        assert.deepStrictEqual(result.document.big, { a: 1, b: 2, c: 3 });
        assert.deepStrictEqual(result.document.copy1, { a: 1, b: 2, c: 3 });
        assert.strictEqual(result.document.copy2, '~big');
        assert.ok(result.meta?.errors?.some((error) => error.code === 'REFERENCE_BUDGET_EXCEEDED'));
    });

    it('enforces maxMaterializedWeight for transitive clone chains', () => {
        const events = compileToEvents([
            'base = { a = 1, b = 2 }',
            'copy1 = ~base',
            'copy2 = ~copy1',
        ].join('\n'));
        const result = finalizeJson(events, { mode: 'strict', maxMaterializedWeight: 3 });

        assert.deepStrictEqual(result.document.base, { a: 1, b: 2 });
        assert.deepStrictEqual(result.document.copy1, { a: 1, b: 2 });
        assert.strictEqual(result.document.copy2, '~copy1');
        assert.ok(result.meta?.errors?.some((error) => error.code === 'REFERENCE_BUDGET_EXCEEDED'));
    });

    it('links pointer references as live aliases in linked JSON output', () => {
        const events = compileToEvents('a = 2\nb = ~>a');
        const result = finalizeLinkedJson(events, { mode: 'strict' });

        assert.equal(result.meta?.errors?.length ?? 0, 0);
        assert.strictEqual(result.document.a, 2);
        assert.strictEqual(result.document.b, 2);

        result.document.a = 5;
        assert.strictEqual(result.document.b, 5);

        result.document.b = 9;
        assert.strictEqual(result.document.a, 9);
    });

    it('links nested pointer references inside objects and arrays', () => {
        const events = compileToEvents('base = { count = 1 }\nitems = [~>base.count]');
        const result = finalizeLinkedJson(events, { mode: 'strict' });

        assert.equal(result.meta?.errors?.length ?? 0, 0);
        assert.deepStrictEqual(result.document.base, { count: 1 });
        assert.ok(Array.isArray(result.document.items));
        assert.strictEqual(result.document.items[0], 1);

        result.document.base.count = 7;
        assert.strictEqual(result.document.items[0], 7);

        result.document.items[0] = 11;
        assert.strictEqual(result.document.base.count, 11);
    });

    it('emits top-level attribute projection under @', () => {
        const events = compileToEvents('title@{lang="en"} = "Hello"');
        const result = finalizeJson(events, { mode: 'strict' });
        assert.deepStrictEqual(result.document, {
            title: 'Hello',
            '@': {
                title: {
                    lang: 'en',
                },
            },
        });
    });

    it('localizes nested object attributes under @', () => {
        const events = compileToEvents('a@{b=1} = { c@{d=3} = 2 }');
        const result = finalizeJson(events, { mode: 'strict' });
        assert.deepStrictEqual(result.document, {
            a: {
                c: 2,
                '@': {
                    c: {
                        d: 3,
                    },
                },
            },
            '@': {
                a: {
                    b: 1,
                },
            },
        });
    });

    it('preserves recursively nested attribute heads under @ projection', () => {
        const events = compileToEvents([
            'a@{',
            '  b@{',
            '    c@{',
            '      d = 4',
            '    } = 3',
            '  } = 2',
            '} = 1',
        ].join('\n'), false, 8);
        const result = finalizeJson(events, { mode: 'strict' });

        assert.deepStrictEqual(result.document, {
            a: 1,
            '@': {
                a: {
                    b: 2,
                    '@': {
                        b: {
                            c: 3,
                            '@': {
                                c: {
                                    d: 4,
                                },
                            },
                        },
                    },
                },
            },
        });
    });

    it('uses @ and $children for node JSON projection', () => {
        const events = compileToEvents('view = <div@{id="main"}("hello")>');
        const result = finalizeJson(events, { mode: 'strict' });
        assert.deepStrictEqual(result.document, {
            view: {
                $node: 'div',
                '@': {
                    id: 'main',
                },
                $children: ['hello'],
            },
        });
    });

    it('errors on reserved JSON projection keys', () => {
        const events = compileToEvents('"@" = 1');
        const result = finalizeJson(events, { mode: 'loose' });
        assert.ok(result.meta?.errors && result.meta.errors.length > 0);
        assert.equal(result.meta?.errors?.[0]?.message, 'Reserved key: @');
        assert.deepStrictEqual(result.document, {});
    });

    it('errors on reserved node projection keys in JSON output', () => {
        const events = compileToEvents('"$node" = 1\n"$children" = 2');
        const result = finalizeJson(events, { mode: 'strict' });
        assert.ok(result.meta?.errors && result.meta.errors.length >= 2);
        assert.equal(result.meta?.errors?.[0]?.message, 'Reserved key: $node');
        assert.deepStrictEqual(result.document, {});
    });

    it('warns on unsafe numeric range in loose mode', () => {
        const events = compileToEvents('big = 9007199254740993');
        const result = finalizeJson(events, { mode: 'loose' });
        assert.ok(result.meta?.warnings && result.meta.warnings.length > 0);
        assert.strictEqual(result.document.big, '9007199254740993');
    });

    it('materializes switch literal as JSON boolean', () => {
        const events = compileToEvents('debug = yes');
        const result = finalizeJson(events, { mode: 'loose' });
        assert.strictEqual(result.document.debug, true);
    });

    it('materializes time literal as JSON string', () => {
        const events = compileToEvents('opens = 09:30:00+02:40');
        const result = finalizeJson(events, { mode: 'loose' });
        assert.strictEqual(result.document.opens, '09:30:00+02:40');
    });

    it('strips underscore separators from finalized radix strings', () => {
        const events = compileToEvents('mask = %101_0101');
        const result = finalizeJson(events, { mode: 'strict' });
        assert.strictEqual(result.document.mask, '1010101');
    });

    it('reports radix digits that exceed the declared radix during finalization', () => {
        const events = compileToEvents('mask:radix[10] = %1A');
        const result = finalizeJson(events, { mode: 'strict' });

        assert.strictEqual(result.document.mask, '1A');
        assert.ok((result.meta?.errors?.length ?? 0) > 0);
        assert.match(result.meta?.errors?.[0]?.message ?? '', /declared radix 10/);
    });

    it('keeps declared radix validation working in full-scope nested payload output', () => {
        const events = compileToEvents('config = { mask:radix[10] = %1A }');
        const result = finalizeJson(events, { mode: 'strict', scope: 'full' });

        assert.deepStrictEqual(result.document, {
            header: {},
            payload: {
                config: {
                    mask: '1A',
                },
            },
        });
        assert.ok((result.meta?.errors?.length ?? 0) > 0);
        assert.match(result.meta?.errors?.[0]?.message ?? '', /declared radix 10/);
    });

    it('projects only whitelisted top-level and nested paths', () => {
        const events = compileToEvents('app = { name = "demo", port = 8080 }\nother = "ignore"');
        const result = finalizeJson(events, {
            mode: 'strict',
            materialization: 'projected',
            includePaths: ['$.app.name'],
        });

        assert.deepStrictEqual(result.document, {
            app: {
                name: 'demo',
            },
        });
    });

    it('projects quoted attribute paths without leaking siblings', () => {
        const events = compileToEvents('title@{"x.y"="en", tone="warm"} = "Hello"');
        const result = finalizeJson(events, {
            mode: 'strict',
            materialization: 'projected',
            includePaths: ['$.title@["x.y"]'],
        });

        assert.deepStrictEqual(result.document, {
            title: 'Hello',
            '@': {
                title: {
                    'x.y': 'en',
                },
            },
        });
    });

    it('preserves indexed unresolved reference token format in core v1', () => {
        const events = compileToEvents('items = [10, 20]\nsecond = ~>items[1]', true);
        const result = finalizeJson(events, { mode: 'strict' });

        assert.ok(result.meta?.errors && result.meta.errors.length > 0);
        assert.strictEqual(result.document.second, '~>items[1]');
    });

    it('supports header-only and full finalization scopes', () => {
        const input = 'aeon:mode = "strict"\naeon:profile = "aeon.gp.profile.v1"\nname = "AEON"';
        const events = compileToEvents(input);
        const header = compileHeader(input);

        assert.deepStrictEqual(finalizeJson(events, {
            mode: 'strict',
            scope: 'header',
            header,
        }).document, {
            mode: 'strict',
            profile: 'aeon.gp.profile.v1',
        });

        assert.deepStrictEqual(finalizeJson(events, {
            mode: 'strict',
            scope: 'full',
            header,
        }).document, {
            header: {
                mode: 'strict',
                profile: 'aeon.gp.profile.v1',
            },
            payload: {
                name: 'AEON',
            },
        });
    });

    it('rejects prototype pollution via __proto__ in strict mode', () => {
        const events = compileToEvents('"__proto__" = { polluted = "yes" }');
        const result = finalizeJson(events, { mode: 'strict' });

        assert.ok(result.meta?.errors && result.meta.errors.length > 0);
        assert.equal(result.meta?.errors?.[0]?.message, 'Reserved key: __proto__');
        assert.deepStrictEqual(result.document, {});
        assert.strictEqual(({} as any).polluted, undefined);
    });

    it('rejects prototype pollution via constructor in loose mode', () => {
        const events = compileToEvents('payload = { constructor = { polluted = "yes" } }');
        const result = finalizeJson(events, { mode: 'loose' });

        assert.ok(result.meta?.errors && result.meta.errors.length > 0);
        assert.equal(result.meta?.errors?.[0]?.message, 'Reserved key: constructor');
        assert.deepStrictEqual(result.document, { payload: {} });
        assert.strictEqual(({} as any).polluted, undefined);
    });

    it('does not traverse pointer targets through prototype chains in linked JSON', () => {
        const events = compileToEvents('base = { safe = 1 }\nlink = ~>base.__proto__.polluted');
        const result = finalizeLinkedJson(events, { mode: 'strict' });

        assert.strictEqual(result.document.link, '~>base.__proto__.polluted');
        assert.ok(result.meta?.errors?.some((error) => error.code === 'POINTER_TARGET_NOT_MATERIALIZED'));
        assert.strictEqual(({} as any).polluted, undefined);
    });
});
