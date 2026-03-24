import { describe, it } from 'node:test';
import assert from 'node:assert';
import { validateReferences, type ReferenceValidationResult } from './references.js';
import { tokenize } from '@aeon/lexer';
import { parse } from '@aeon/parser';
import { resolvePaths, emitEvents } from './index.js';

describe('Reference Validation', () => {
    // Helper to compile and validate references
    function validate(
        input: string,
        _legacySyntaxFlag: boolean = false,
        maxAttributeDepth: number = 1
    ): ReferenceValidationResult {
        const tokens = tokenize(input).tokens;
        const ast = parse(tokens, { maxSeparatorDepth: 8 });
        if (!ast.document) {
            throw new Error('Parse failed');
        }
        const resolved = resolvePaths(ast.document, { indexedPaths: true });
        const emitted = emitEvents(resolved, { recovery: true });
        return validateReferences(emitted.events, { maxAttributeDepth });
    }

    // ============================================
    // MISSING TARGET (Red Team test #1)
    // ============================================

    describe('missing target', () => {
        it('should error when reference target does not exist', () => {
            const result = validate('a = ~b');

            assert.ok(result.errors.length > 0);
            assert.strictEqual(result.errors[0]!.code, 'MISSING_REFERENCE_TARGET');
        });

        it('should error for nested missing reference', () => {
            const result = validate('config = { db = ~missing }');

            assert.ok(result.errors.length > 0);
            assert.strictEqual(result.errors[0]!.code, 'MISSING_REFERENCE_TARGET');
        });

        it('should error for pointer reference to missing target', () => {
            const result = validate('a = ~>nonexistent');

            assert.ok(result.errors.length > 0);
            assert.strictEqual(result.errors[0]!.code, 'MISSING_REFERENCE_TARGET');
        });

        it('should error for indexed missing target in core v1', () => {
            const result = validate('items = [1, 2]\nthird = ~items[2]', true);

            assert.ok(result.errors.length > 0);
            assert.strictEqual(result.errors[0]!.code, 'MISSING_REFERENCE_TARGET');
            assert.strictEqual(result.errors[0]!.targetPath, '$.items[2]');
            assert.strictEqual(result.errors[0]!.message, "Missing reference target: '$.items[2]'");
        });
    });

    // ============================================
    // FORWARD REFERENCE (Red Team test #2)
    // ============================================

    describe('forward reference', () => {
        it('should error when referencing a binding that appears later', () => {
            const result = validate('a = ~b\nb = 1');

            assert.ok(result.errors.length > 0);
            assert.strictEqual(result.errors[0]!.code, 'FORWARD_REFERENCE');
        });

        it('should error for pointer forward reference', () => {
            const result = validate('ptr = ~>later\nlater = 42');

            assert.ok(result.errors.length > 0);
            assert.strictEqual(result.errors[0]!.code, 'FORWARD_REFERENCE');
        });

        it('should error for nested forward reference', () => {
            const result = validate('config = { ref = ~data }\ndata = 1');

            assert.ok(result.errors.length > 0);
            assert.strictEqual(result.errors[0]!.code, 'FORWARD_REFERENCE');
        });

        it('should error for indexed forward reference in core v1', () => {
            const result = validate('second = ~items[1]\nitems = [10, 20]', true);

            assert.ok(result.errors.length > 0);
            assert.strictEqual(result.errors[0]!.code, 'FORWARD_REFERENCE');
            assert.strictEqual(result.errors[0]!.targetPath, '$.items[1]');
            assert.strictEqual(
                result.errors[0]!.message,
                "Forward reference: '$.second' references '$.items[1]' defined later"
            );
        });
    });

    // ============================================
    // VALID BACKWARD REFERENCE (Red Team test #3)
    // ============================================

    describe('valid backward reference', () => {
        it('should pass for valid backward clone reference', () => {
            const result = validate('b = 1\na = ~b');

            assert.strictEqual(result.errors.length, 0);
        });

        it('should pass for valid backward pointer reference', () => {
            const result = validate('original = "value"\nptr = ~>original');

            assert.strictEqual(result.errors.length, 0);
        });

        it('should pass for reference to nested path', () => {
            const result = validate('config = { db = { host = "localhost" } }\ndbHost = ~config.db.host');

            assert.strictEqual(result.errors.length, 0);
        });

        it('should pass for nested binding references inside the same object', () => {
            const result = validate('a:o = {\n  a:string = "hello"\n  b:string = ~a.a\n}');

            assert.strictEqual(result.errors.length, 0);
        });

        it('should pass for multiple valid references', () => {
            const result = validate('a = 1\nb = 2\nc = ~a\nd = ~b');

            assert.strictEqual(result.errors.length, 0);
        });

        it('should pass for indexed backward reference in core v1', () => {
            const result = validate('coords = [10, 20]\nsecond = ~coords[1]', true);

            assert.strictEqual(result.errors.length, 0);
        });
    });

    // ============================================
    // SELF REFERENCE (Red Team test #4)
    // ============================================

    describe('self reference', () => {
        it('should error when binding references itself', () => {
            const result = validate('a = ~a');

            assert.ok(result.errors.length > 0);
            assert.strictEqual(result.errors[0]!.code, 'SELF_REFERENCE');
        });

        it('should error for pointer self reference', () => {
            const result = validate('x = ~>x');

            assert.ok(result.errors.length > 0);
            assert.strictEqual(result.errors[0]!.code, 'SELF_REFERENCE');
        });

        it('should classify indexed intra-binding reference as missing target in core v1', () => {
            const result = validate('list = ~list[0]\nlist = [1]', true);

            assert.ok(result.errors.length > 0);
            assert.strictEqual(result.errors[0]!.code, 'MISSING_REFERENCE_TARGET');
            assert.strictEqual(result.errors[0]!.targetPath, '$.list[0]');
            assert.strictEqual(result.errors[0]!.message, "Missing reference target: '$.list[0]'");
        });
    });

    // ============================================
    // POINTER REF (~>) SAME VALIDATION (Red Team test #5)
    // ============================================

    describe('pointer reference validation', () => {
        it('should validate pointer refs with same rules as clone refs', () => {
            // Valid backward
            const valid = validate('source = 1\nptr = ~>source');
            assert.strictEqual(valid.errors.length, 0);

            // Forward (error)
            const forward = validate('ptr = ~>target\ntarget = 1');
            assert.ok(forward.errors.length > 0);

            // Self (error)
            const self = validate('loop = ~>loop');
            assert.ok(self.errors.length > 0);

            // Missing (error)
            const missing = validate('dangling = ~>nowhere');
            assert.ok(missing.errors.length > 0);
        });
    });

    describe('attribute depth policy', () => {
        it('should enforce max_attribute_depth by default (1)', () => {
            const result = validate('a = 1\nv = ~a@x@y', true);

            assert.ok(result.errors.length > 0);
            assert.strictEqual(result.errors[0]!.code, 'ATTRIBUTE_DEPTH_EXCEEDED');
        });

        it('should allow deeper attribute paths when explicitly raised', () => {
            const result = validate('a = 1\nv = ~a@x@y', true, 8);
            assert.ok(result.errors.length > 0);
            // Attribute depth is allowed at this policy level; remaining error is missing target.
            assert.strictEqual(result.errors[0]!.code, 'MISSING_REFERENCE_TARGET');
        });
    });

    describe('attribute reference targets', () => {
        it('should resolve clone reference to existing binding attribute', () => {
            const result = validate('a@{ ns = "alto.v1" } = 3\nv = ~a@ns', true);
            assert.strictEqual(result.errors.length, 0);
        });

        it('should resolve quoted attribute selector with dotted key', () => {
            const result = validate('a@{ "x.y" = 3 } = 1\nv = ~a@["x.y"]', true);
            assert.strictEqual(result.errors.length, 0);
        });

        it('should resolve nested quoted member under attribute path', () => {
            const result = validate('a@{ meta = { "x.y" = 3 } } = 1\nv = ~a@meta.["x.y"]', true);
            assert.strictEqual(result.errors.length, 0);
        });

        it('should resolve pointer reference to existing binding attribute', () => {
            const result = validate('a@{ ns = "alto.v1" } = 3\nv = ~>a@ns', true);
            assert.strictEqual(result.errors.length, 0);
        });

        it('should classify missing attribute target as missing reference', () => {
            const result = validate('a = 1\nv = ~a@ns', true);
            assert.ok(result.errors.length > 0);
            assert.strictEqual(result.errors[0]!.code, 'MISSING_REFERENCE_TARGET');
            assert.strictEqual(result.errors[0]!.targetPath, '$.a@ns');
        });

        it('should detect forward reference for attribute target on later binding', () => {
            const result = validate('v = ~a@ns\na@{ ns = 1 } = 3', true);
            assert.ok(result.errors.length > 0);
            assert.strictEqual(result.errors[0]!.code, 'FORWARD_REFERENCE');
            assert.strictEqual(result.errors[0]!.targetPath, '$.a@ns');
        });

        it('should classify missing quoted attribute target as missing reference', () => {
            const result = validate('a = 1\nv = ~a@["x.y"]', true);
            assert.ok(result.errors.length > 0);
            assert.strictEqual(result.errors[0]!.code, 'MISSING_REFERENCE_TARGET');
            assert.strictEqual(result.errors[0]!.targetPath, '$.a@["x.y"]');
        });
    });

    // ============================================
    // FAIL-CLOSED BEHAVIOR
    // ============================================

    describe('fail-closed behavior', () => {
        it('should return empty events when validation errors exist', () => {
            const result = validate('a = ~b');

            // Should fail closed
            assert.strictEqual(result.events.length, 0);
            assert.ok(result.errors.length > 0);
        });

        it('should return all events when no validation errors', () => {
            const result = validate('b = 1\na = ~b');

            assert.ok(result.events.length > 0);
            assert.strictEqual(result.errors.length, 0);
        });
    });

    // ============================================
    // SPAN TRACKING
    // ============================================

    describe('span tracking', () => {
        it('should include span on reference errors', () => {
            const result = validate('a = ~missing');

            assert.ok(result.errors[0]!.span);
        });
    });
});
