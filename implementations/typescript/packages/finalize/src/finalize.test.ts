import { describe, it } from 'node:test';
import assert from 'node:assert';
import { finalizeMap } from './finalize.js';
import { tokenize } from '@aeon/lexer';
import { parse } from '@aeon/parser';
import { resolvePaths, emitEvents } from '@aeon/aes';

function compileToEvents(input: string) {
    const tokens = tokenize(input).tokens;
    const ast = parse(tokens);
    if (!ast.document) throw new Error('Parse failed');
    const resolved = resolvePaths(ast.document);
    const emitted = emitEvents(resolved, { recovery: true });
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

describe('Finalization (Map)', () => {
    it('builds a deterministic path map', () => {
        const events = compileToEvents('a = 1\nb = "x"');
        const result = finalizeMap(events);
        assert.strictEqual(result.document.entries.size, 2);
        assert.ok(result.document.entries.has('$.a'));
        assert.ok(result.document.entries.has('$.b'));
    });

    it('strict mode records duplicate path errors', () => {
        const events = [
            ...compileToEvents('a = 1'),
            ...compileToEvents('a = 2'),
        ];
        const result = finalizeMap(events, { mode: 'strict' });
        assert.ok(result.meta?.errors && result.meta.errors.length > 0);
    });

    it('loose mode records duplicate path warnings', () => {
        const events = [
            ...compileToEvents('a = 1'),
            ...compileToEvents('a = 2'),
        ];
        const result = finalizeMap(events, { mode: 'loose' });
        assert.ok(result.meta?.warnings && result.meta.warnings.length > 0);
    });

    it('supports scoped header and full map projections', () => {
        const input = 'aeon:mode = "strict"\nname = "AEON"';
        const events = compileToEvents(input);
        const header = compileHeader(input);

        const headerOnly = finalizeMap(events, {
            scope: 'header',
            header,
        });
        assert.deepStrictEqual(Array.from(headerOnly.document.entries.keys()), ['$.mode']);

        const full = finalizeMap(events, {
            scope: 'full',
            header,
        });
        assert.deepStrictEqual(Array.from(full.document.entries.keys()), ['$.header.mode', '$.payload.name']);
    });
});
