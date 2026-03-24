import { describe, it } from 'node:test';
import assert from 'node:assert';
import { tokenize } from '@aeon/lexer';
import { parse } from './parser.js';
import { resolveCanonicalPaths } from './path-resolver.js';

describe('Path Resolution — Phase 4', () => {
    it('resolveCanonicalPaths is a non-throwing passthrough shim', () => {
        const tokens = tokenize('title = "Example"').tokens;
        const result = parse(tokens);
        assert.ok(result.document, 'expected document from parser');
        const resolved = resolveCanonicalPaths(result.document!);
        assert.equal(resolved, result.document);
    });
});
