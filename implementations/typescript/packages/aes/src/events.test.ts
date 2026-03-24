import { describe, it } from 'node:test';
import assert from 'node:assert';
import { tokenize } from '@aeon/lexer';
import { parse } from '@aeon/parser';
import { resolvePaths, formatPath, DuplicateCanonicalPathError } from './paths.js';
import { emitEvents } from './events.js';

describe('Assignment Event Emission', () => {
    // Helper to parse, resolve, and emit events
    function emit(input: string, _legacySyntaxFlag: boolean = false) {
        const tokens = tokenize(input).tokens;
        const ast = parse(tokens, { maxAttributeDepth: 8 });
        if (!ast.document) {
            throw new Error('Parse failed');
        }
        const resolved = resolvePaths(ast.document, { indexedPaths: true });
        return emitEvents(resolved);
    }

    // ============================================
    // BASIC EVENT EMISSION
    // ============================================

    describe('simple document', () => {
        it('should emit one event per top-level binding', () => {
            const result = emit('a = 1\nb = 2');

            assert.strictEqual(result.errors.length, 0);
            assert.strictEqual(result.events.length, 2);
            assert.strictEqual(formatPath(result.events[0]!.path), '$.a');
            assert.strictEqual(formatPath(result.events[1]!.path), '$.b');
        });

        it('should preserve key name on event', () => {
            const result = emit('myKey = "value"');

            assert.strictEqual(result.events[0]!.key, 'myKey');
        });

        it('should preserve AST value node', () => {
            const result = emit('a = 42');

            assert.strictEqual(result.events[0]!.value.type, 'NumberLiteral');
        });

        it('should preserve span on event', () => {
            const result = emit('a = 1');

            assert.ok(result.events[0]!.span);
            assert.strictEqual(result.events[0]!.span.start.line, 1);
        });

        it('should include derived normalized path metadata', () => {
            const result = emit('a = 1');
            assert.strictEqual(result.events[0]!.normalizedPath, 'a');
        });
    });

    describe('headers', () => {
        it('should emit events for shorthand header fields before body bindings', () => {
            const result = emit('aeon:version = 2.0\naeon:mode = "strict"\na = 1');

            const paths = result.events.map(e => formatPath(e.path));
            assert.deepStrictEqual(paths, ['$.["aeon:version"]', '$.["aeon:mode"]', '$.a']);
        });

        it('should emit events for structured header fields as aeon:* bindings', () => {
            const result = emit('aeon:header = { version = 2.0, profile = "core" }\na = 1');

            const paths = result.events.map(e => formatPath(e.path));
            assert.deepStrictEqual(paths, ['$.["aeon:version"]', '$.["aeon:profile"]', '$.a']);
        });
    });

    describe('nested objects', () => {
        it('should emit events for nested bindings', () => {
            const result = emit('a = { b = { c = 1 } }');

            assert.strictEqual(result.errors.length, 0);
            const paths = result.events.map(e => formatPath(e.path));
            assert.ok(paths.includes('$.a'));
            assert.ok(paths.includes('$.a.b'));
            assert.ok(paths.includes('$.a.b.c'));
        });

        it('should emit events in document order', () => {
            const result = emit('outer = { first = 1, second = 2 }');

            const paths = result.events.map(e => formatPath(e.path));
            // outer comes first, then its children in order
            assert.strictEqual(paths[0], '$.outer');
            assert.strictEqual(paths[1], '$.outer.first');
            assert.strictEqual(paths[2], '$.outer.second');
        });
    });

    describe('list handling', () => {
        it('should emit event for binding with list value', () => {
            const result = emit('items = [1, 2, 3]');

            assert.strictEqual(result.errors.length, 0);
            assert.strictEqual(result.events.length, 4);
            assert.strictEqual(formatPath(result.events[0]!.path), '$.items');
            assert.strictEqual(result.events[0]!.value.type, 'ListNode');
            assert.strictEqual(formatPath(result.events[1]!.path), '$.items[0]');
            assert.strictEqual(formatPath(result.events[2]!.path), '$.items[1]');
            assert.strictEqual(formatPath(result.events[3]!.path), '$.items[2]');
        });

        it('should emit events for objects inside lists', () => {
            const result = emit('a = [ { b = 1 } ]');

            const paths = result.events.map(e => formatPath(e.path));
            assert.ok(paths.includes('$.a'));
            assert.ok(paths.includes('$.a[0].b'));
        });

        it('should normalize indexed element paths to wildcard form in core v1', () => {
            const result = emit('contacts = [ { email = "x" }, { email = "y" } ]', true);
            const event = result.events.find((e) => formatPath(e.path) === '$.contacts[0].email');
            assert.ok(event);
            assert.strictEqual(event.normalizedPath, 'contacts[*].email');
        });
    });

    // ============================================
    // EVENT ORDER
    // ============================================

    describe('event order', () => {
        it('should emit events in source document order', () => {
            const result = emit('b = 2\na = 1');

            // b appears first in source, so $.b should be first
            assert.strictEqual(formatPath(result.events[0]!.path), '$.b');
            assert.strictEqual(formatPath(result.events[1]!.path), '$.a');
        });

        it('should preserve order for deeply nested structures', () => {
            const result = emit('x = { y = 1 }\na = { b = 2 }');

            const paths = result.events.map(e => formatPath(e.path));
            assert.deepStrictEqual(paths, ['$.x', '$.x.y', '$.a', '$.a.b']);
        });
    });

    // ============================================
    // VALUE PRESERVATION
    // ============================================

    describe('value preservation', () => {
        it('should preserve string literal value', () => {
            const result = emit('msg = "hello"');

            const value = result.events[0]!.value;
            assert.strictEqual(value.type, 'StringLiteral');
            if (value.type === 'StringLiteral') {
                assert.strictEqual(value.value, 'hello');
            }
        });

        it('should preserve reference value without resolving', () => {
            const result = emit('a = 1\nb = ~a');

            const refEvent = result.events[1]!;
            assert.strictEqual(refEvent.value.type, 'CloneReference');
            // Reference is NOT resolved - just preserved
        });

        it('should preserve pointer reference without resolving', () => {
            const result = emit('a = 1\nb = ~>a');

            const refEvent = result.events[1]!;
            assert.strictEqual(refEvent.value.type, 'PointerReference');
        });

        it('should preserve object value as opaque node', () => {
            const result = emit('config = { x = 1 }');

            // The event for $.config has an ObjectNode value
            const configEvent = result.events.find(e => formatPath(e.path) === '$.config');
            assert.ok(configEvent);
            assert.strictEqual(configEvent.value.type, 'ObjectNode');
        });
    });

    // ============================================
    // TYPE HINTS AND ANNOTATIONS
    // ============================================

    describe('type hints', () => {
        it('should include datatype hint if present', () => {
            const result = emit('count:int32 = 42');

            assert.ok(result.events[0]!.datatype);
            assert.strictEqual(result.events[0]!.datatype, 'int32');
        });

        it('should not include datatype if not present', () => {
            const result = emit('count = 42');

            assert.strictEqual(result.events[0]!.datatype, undefined);
        });

        it('should include generic datatype signature in core v1', () => {
            const result = emit('coords:tuple<int32, int32> = (1, 2)', true);

            assert.strictEqual(result.errors.length, 0);
            assert.strictEqual(result.events[0]!.datatype, 'tuple<int32, int32>');
        });

        it('should include typed annotation signature for attributes in core v1', () => {
            const result = emit('value@{meta:pair<int32, string> = "ok"} = 1', true);

            assert.strictEqual(result.errors.length, 0);
            const ann = result.events[0]!.annotations;
            assert.ok(ann);
            assert.strictEqual(ann!.get('meta')!.datatype, 'pair<int32, string>');
        });

        it('should preserve nested attribute heads in emitted annotations', () => {
            const result = emit([
                'a@{',
                '  b@{',
                '    c@{',
                '      d = 4',
                '    } = 3',
                '  } = 2',
                '} = 1',
            ].join('\n'));

            assert.strictEqual(result.errors.length, 0);
            const b = result.events[0]!.annotations?.get('b');
            assert.ok(b);
            assert.strictEqual((b?.value as { value?: string }).value, '2');
            const c = b?.annotations?.get('c');
            assert.ok(c);
            assert.strictEqual((c?.value as { value?: string }).value, '3');
            const d = c?.annotations?.get('d');
            assert.ok(d);
            assert.strictEqual((d?.value as { value?: string }).value, '4');
        });
    });

    // ============================================
    // ONE-TO-ONE MAPPING
    // ============================================

    describe('one-to-one mapping', () => {
        it('should emit exactly one event per resolved binding', () => {
            const input = 'a = 1\nb = { c = 2, d = 3 }\ne = [1, 2]';
            const result = emit(input);
            const resolved = (() => {
                const tokens = tokenize(input).tokens;
                const ast = parse(tokens);
                return resolvePaths(ast.document!, { indexedPaths: true });
            })();

            // Same number of events as resolved bindings
            assert.strictEqual(result.events.length, resolved.bindings.length);
        });
    });

    describe('duplicates', () => {
        it('should fail-closed (emit 0 events) when duplicate canonical paths exist', () => {
            const result = emit('a = 1\na = 2');

            assert.strictEqual(result.events.length, 0);
            assert.ok(result.errors.length > 0);
            assert.ok(result.errors.some(e => e instanceof DuplicateCanonicalPathError));
        });

        it('fail-closed duplicate path example: nested duplicate binding', () => {
            const result = emit('a = { b = 1 }\na = { b = 2 }');

            assert.strictEqual(result.events.length, 0);
            assert.ok(result.errors.some(e => e instanceof DuplicateCanonicalPathError));
        });

        it('must be impossible to forget errors: emitEvents surfaces resolution errors', () => {
            const input = 'a = 1\na = 2';
            const tokens = tokenize(input).tokens;
            const ast = parse(tokens);
            const resolved = resolvePaths(ast.document!);

            // Sanity: resolution produced errors
            assert.ok(resolved.errors.length > 0);

            const emitted = emitEvents(resolved);
            assert.ok(emitted.errors.length > 0);
            assert.strictEqual(emitted.events.length, 0);
        });
    });
});
