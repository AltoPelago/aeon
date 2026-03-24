import { describe, it } from 'node:test';
import assert from 'node:assert';
import { tokenize } from '@aeon/lexer';
import { parse } from '@aeon/parser';
import { resolvePaths, formatPath, formatNormalizedPath, DuplicateCanonicalPathError } from './paths.js';

describe('Canonical Path Resolution', () => {
    // Helper to parse and resolve paths
    function resolve(input: string) {
        const tokens = tokenize(input).tokens;
        const ast = parse(tokens);
        if (!ast.document) {
            throw new Error('Parse failed');
        }
        return resolvePaths(ast.document);
    }

    // ============================================
    // PATH DERIVATION TESTS
    // ============================================

    describe('header fields', () => {
        it('should resolve shorthand header fields as bindings under root', () => {
            const result = resolve('aeon:version = 2.0\naeon:mode = "strict"\na = 1');

            assert.strictEqual(result.errors.length, 0);
            const paths = result.bindings.map(b => formatPath(b.path));
            assert.ok(paths.includes('$.["aeon:version"]'));
            assert.ok(paths.includes('$.["aeon:mode"]'));
            assert.ok(paths.includes('$.a'));
        });

        it('should resolve structured header fields as aeon:* bindings', () => {
            const result = resolve('aeon:header = { version = 2.0, profile = "core" }\na = 1');

            assert.strictEqual(result.errors.length, 0);
            const paths = result.bindings.map(b => formatPath(b.path));
            assert.ok(paths.includes('$.["aeon:version"]'));
            assert.ok(paths.includes('$.["aeon:profile"]'));
            assert.ok(paths.includes('$.a'));
        });

        it('should format escaped keys using dot+bracket form', () => {
            const result = resolve('aeon:version = 2.0');
            assert.strictEqual(result.errors.length, 0);
            assert.strictEqual(formatPath(result.bindings[0]!.path), '$.["aeon:version"]');
        });
    });

    describe('top-level bindings', () => {
        it('should resolve single top-level binding to $.key', () => {
            const result = resolve('a = 1');

            assert.strictEqual(result.errors.length, 0);
            assert.strictEqual(result.bindings.length, 1);
            assert.strictEqual(formatPath(result.bindings[0]!.path), '$.a');
        });

        it('should resolve multiple top-level bindings', () => {
            const result = resolve('a = 1\nb = 2\nc = 3');

            assert.strictEqual(result.errors.length, 0);
            assert.strictEqual(result.bindings.length, 3);
            assert.strictEqual(formatPath(result.bindings[0]!.path), '$.a');
            assert.strictEqual(formatPath(result.bindings[1]!.path), '$.b');
            assert.strictEqual(formatPath(result.bindings[2]!.path), '$.c');
        });
    });

    describe('normalized paths', () => {
        it('should drop root marker for normalized top-level path', () => {
            const result = resolve('a = 1');
            assert.strictEqual(result.errors.length, 0);
            assert.strictEqual(formatNormalizedPath(result.bindings[0]!.path), 'a');
        });

        it('should normalize indexed paths using wildcard segments', () => {
            const tokens = tokenize('contacts = [{ email = "a" }, { email = "b" }]').tokens;
            const ast = parse(tokens);
            assert.ok(ast.document);
            const result = resolvePaths(ast.document!, { indexedPaths: true });

            assert.strictEqual(result.errors.length, 0);
            const normalized = result.bindings.map((b) => formatNormalizedPath(b.path));
            assert.ok(normalized.includes('contacts[*].email'));
        });

        it('should preserve quoted member rendering for non-bare keys', () => {
            const result = resolve('"a.b" = 2');
            assert.strictEqual(result.errors.length, 0);
            assert.strictEqual(formatNormalizedPath(result.bindings[0]!.path), '["a.b"]');
        });
    });

    describe('nested objects', () => {
        it('should resolve single-level nested binding', () => {
            const result = resolve('a = { b = 1 }');

            assert.strictEqual(result.errors.length, 0);
            // Should have both $.a and $.a.b
            const paths = result.bindings.map(b => formatPath(b.path));
            assert.ok(paths.includes('$.a'));
            assert.ok(paths.includes('$.a.b'));
        });

        it('should resolve deeply nested bindings', () => {
            const result = resolve('a = { b = { c = 1 } }');

            assert.strictEqual(result.errors.length, 0);
            const paths = result.bindings.map(b => formatPath(b.path));
            assert.ok(paths.includes('$.a'));
            assert.ok(paths.includes('$.a.b'));
            assert.ok(paths.includes('$.a.b.c'));
        });

        it('should resolve multiple keys in nested object', () => {
            const result = resolve('config = { host = "localhost", port = 8080 }');

            assert.strictEqual(result.errors.length, 0);
            const paths = result.bindings.map(b => formatPath(b.path));
            assert.ok(paths.includes('$.config'));
            assert.ok(paths.includes('$.config.host'));
            assert.ok(paths.includes('$.config.port'));
        });
    });

    describe('list handling', () => {
        it('should NOT generate paths for list elements', () => {
            const result = resolve('items = [1, 2, 3]');

            assert.strictEqual(result.errors.length, 0);
            // Only $.items, no $.items[0] etc.
            assert.strictEqual(result.bindings.length, 1);
            assert.strictEqual(formatPath(result.bindings[0]!.path), '$.items');
        });

        it('should resolve bindings inside objects within lists', () => {
            const result = resolve('a = [ { b = 1 } ]');

            assert.strictEqual(result.errors.length, 0);
            const paths = result.bindings.map(b => formatPath(b.path));
            // Should have $.a and $.a.b (no indexing!)
            assert.ok(paths.includes('$.a'));
            assert.ok(paths.includes('$.a.b'));
            // Should NOT have indexed paths
            assert.ok(!paths.some(p => p.includes('[')));
        });

        it('should resolve multiple objects in list', () => {
            const result = resolve('items = [ { x = 1 }, { y = 2 } ]');

            assert.strictEqual(result.errors.length, 0);
            const paths = result.bindings.map(b => formatPath(b.path));
            // Both x and y should be under $.items
            assert.ok(paths.includes('$.items'));
            assert.ok(paths.includes('$.items.x'));
            assert.ok(paths.includes('$.items.y'));
        });

        it('should emit indexed element paths in core v1 indexed mode', () => {
            const tokens = tokenize('items = [1, 2, 3]').tokens;
            const ast = parse(tokens);
            assert.ok(ast.document);
            const result = resolvePaths(ast.document!, { indexedPaths: true });

            assert.strictEqual(result.errors.length, 0);
            const paths = result.bindings.map((b) => formatPath(b.path));
            assert.ok(paths.includes('$.items'));
            assert.ok(paths.includes('$.items[0]'));
            assert.ok(paths.includes('$.items[1]'));
            assert.ok(paths.includes('$.items[2]'));
        });
    });

    // ============================================
    // DUPLICATE PATH DETECTION
    // ============================================

    describe('duplicate canonical path detection', () => {
        it('should detect duplicate paths in nested objects', () => {
            // Two bindings resolving to same path
            const result = resolve('a = { b = 1 }\na = { b = 2 }');

            assert.ok(result.errors.length > 0);
            assert.strictEqual(result.errors[0]!.code, 'DUPLICATE_CANONICAL_PATH');
        });

        it('should detect duplicate top-level bindings', () => {
            const result = resolve('a = 1\na = 2');

            assert.ok(result.errors.length > 0);
            assert.strictEqual(result.errors[0]!.code, 'DUPLICATE_CANONICAL_PATH');
        });

        it('should keep only the first occurrence of a duplicate path', () => {
            const result = resolve('a = 1\na = 2');

            const paths = result.bindings.map(b => formatPath(b.path));
            assert.deepStrictEqual(paths, ['$.a']);
        });

        it('should allow same key in different parent paths', () => {
            const result = resolve('a = { x = 1 }\nb = { x = 2 }');

            // $.a.x and $.b.x are different, so no error
            assert.strictEqual(result.errors.length, 0);
        });
    });

    // ============================================
    // SPAN TRACKING
    // ============================================

    describe('span tracking', () => {
        it('should include span on resolved bindings', () => {
            const result = resolve('a = 1');

            assert.ok(result.bindings[0]!.span);
            assert.strictEqual(result.bindings[0]!.span.start.line, 1);
        });

        it('should include spans on duplicate path errors', () => {
            const result = resolve('a = 1\na = 2');

            assert.ok(result.errors[0]!.span);
            const err = result.errors[0] as DuplicateCanonicalPathError;
            assert.ok(err.firstOccurrence);
        });
    });

    // ============================================
    // REFERENCE HANDLING
    // ============================================

    describe('reference handling', () => {
        it('should resolve bindings with reference values', () => {
            const result = resolve('a = 1\nb = ~a');

            assert.strictEqual(result.errors.length, 0);
            const paths = result.bindings.map(b => formatPath(b.path));
            assert.ok(paths.includes('$.a'));
            assert.ok(paths.includes('$.b'));
        });
    });
});
