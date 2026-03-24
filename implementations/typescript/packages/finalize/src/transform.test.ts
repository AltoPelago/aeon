import { describe, it } from 'node:test';
import assert from 'node:assert';
import { finalizeNode } from './node.js';
import { transformDocument } from './transform.js';
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

describe('Finalization (Transform)', () => {
    it('transforms string values', () => {
        const events = compileToEvents('name = "aeon"');
        const document = finalizeNode(events).document;
        const transformed = transformDocument(document, {
            leave(node) {
                if (node.type === 'String') {
                    return { ...node, value: String(node.value).toUpperCase() };
                }
                return undefined;
            },
        });
        const node = transformed.root.entries.get('name');
        assert.ok(node);
        assert.strictEqual(node?.type, 'String');
        assert.strictEqual(node?.value, 'AEON');
    });
});
