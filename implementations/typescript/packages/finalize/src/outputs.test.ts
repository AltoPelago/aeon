import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createDefaultOutputRegistry, finalizeWithProfile } from './outputs.js';
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

describe('Finalization (Output Profiles)', () => {
    it('resolves built-in profiles', () => {
        const registry = createDefaultOutputRegistry();
        const events = compileToEvents('name = "AEON"');
        const result = finalizeWithProfile(events, { profile: 'json', registry });
        assert.ok(result.document);
    });

    it('reports unknown profile', () => {
        const events = compileToEvents('name = "AEON"');
        const result = finalizeWithProfile(events, { profile: 'missing' as const });
        assert.ok(result.meta?.errors && result.meta.errors.length > 0);
    });
});
