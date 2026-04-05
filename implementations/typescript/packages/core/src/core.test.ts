import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
    compile,
    formatPath,
    inspectFilePreamble,
    VERSION,
    type CompileResult,
    type CompileOptions,
} from './index.js';

// =============================================================================
// API SURFACE SMOKE TEST
// =============================================================================

describe('API Surface', () => {
    it('should export compile function', () => {
        assert.strictEqual(typeof compile, 'function');
    });

    it('should export formatPath utility', () => {
        assert.strictEqual(typeof formatPath, 'function');
    });

    it('should export VERSION constant', () => {
        assert.strictEqual(typeof VERSION, 'string');
    });

    it('should return CompileResult from compile()', () => {
        const result: CompileResult = compile('a = 1');
        assert.ok(Array.isArray(result.events));
        assert.ok(Array.isArray(result.errors));
    });

    it('should accept CompileOptions', () => {
        const options: CompileOptions = { recovery: true };
        const result = compile('a = 1', options);
        assert.ok(result);
    });

    it('should accept maxInputBytes in CompileOptions', () => {
        const options: CompileOptions = { maxInputBytes: 16 };
        const result = compile('a = 1', options);
        assert.ok(result);
    });

    it('should inspect file preamble without parsing the full document', () => {
        const result = inspectFilePreamble('#!/usr/bin/env aeon\n//! format:aeon.test.v1\nvalue = {');

        assert.strictEqual(result.shebang, '#!/usr/bin/env aeon');
        assert.strictEqual(result.hostDirective?.raw, '//! format:aeon.test.v1');
        assert.strictEqual(result.hostDirective?.kind, 'format');
        assert.strictEqual(result.format, 'aeon.test.v1');
    });

    it('should keep late //! comments out of preamble inspection', () => {
        const result = inspectFilePreamble('value = 1\n//! format:aeon.test.v1');

        assert.strictEqual(result.shebang, null);
        assert.strictEqual(result.hostDirective, null);
        assert.strictEqual(result.format, null);
    });

    it('should ignore a leading BOM during preamble inspection', () => {
        const result = inspectFilePreamble('\uFEFF#!/usr/bin/env aeon\n//! format:aeon.test.v1\nvalue = {');

        assert.strictEqual(result.shebang, '#!/usr/bin/env aeon');
        assert.strictEqual(result.format, 'aeon.test.v1');
    });
});

describe('Core - compile()', () => {
    // ============================================
    // BASIC COMPILATION
    // ============================================

    describe('basic compilation', () => {
        it('should compile simple document to events', () => {
            const result = compile('a = 1\nb = 2');

            assert.strictEqual(result.errors.length, 0);
            assert.strictEqual(result.events.length, 2);
            assert.strictEqual(formatPath(result.events[0]!.path), '$.a');
            assert.strictEqual(formatPath(result.events[1]!.path), '$.b');
        });

        it('should compile nested objects', () => {
            const result = compile('config = { db = { host = "localhost" } }');

            assert.strictEqual(result.errors.length, 0);
            const paths = result.events.map(e => formatPath(e.path));
            assert.ok(paths.includes('$.config'));
            assert.ok(paths.includes('$.config.db'));
            assert.ok(paths.includes('$.config.db.host'));
        });

        it('should compile tuple syntax', () => {
            const result = compile('pair = (1, 2)');

            assert.strictEqual(result.errors.length, 0);
            const paths = result.events.map((e) => formatPath(e.path));
            assert.ok(paths.includes('$.pair'));
            assert.ok(paths.includes('$.pair[0]'));
            assert.ok(paths.includes('$.pair[1]'));
        });

        it('should compile tuple and indexed list paths', () => {
            const result = compile('pair = (1, 2)\nitems = [10, 20]');

            assert.strictEqual(result.errors.length, 0);
            const paths = result.events.map((e) => formatPath(e.path));
            assert.ok(paths.includes('$.pair'));
            assert.ok(paths.includes('$.pair[0]'));
            assert.ok(paths.includes('$.pair[1]'));
            assert.ok(paths.includes('$.items[0]'));
            assert.ok(paths.includes('$.items[1]'));
        });

        it('should compile time literals', () => {
            const result = compile('opens = 09:30:00+02:40');

            assert.strictEqual(result.errors.length, 0);
            const paths = result.events.map((e) => formatPath(e.path));
            assert.ok(paths.includes('$.opens'));
        });

        it('should fail closed when maxInputBytes is exceeded', () => {
            const result = compile('a = 12345', { maxInputBytes: 4 });

            assert.strictEqual(result.events.length, 0);
            assert.ok(result.errors.some((e) => (e as { code?: string }).code === 'INPUT_SIZE_EXCEEDED'));
        });

        it('should compile trimticks to trimmed string literal values', () => {
            const result = compile([
                'class = {',
                '  text = >>`',
                '           This policy applies when a request is retried.',
                '        The consumer must validate the signature again.',
                '           The cached response may be reused if it is still valid.',
                '         Otherwise, fetch a fresh copy.',
                '',
                '  `',
                '}',
            ].join('\n'));

            assert.strictEqual(result.errors.length, 0);
            const textEvent = result.events.find((event) => formatPath(event.path) === '$.class.text');
            assert.ok(textEvent);
            assert.strictEqual(textEvent!.value.type, 'StringLiteral');
            if (textEvent!.value.type !== 'StringLiteral') assert.fail('Expected StringLiteral');
            assert.strictEqual(textEvent!.value.value, [
                '   This policy applies when a request is retried.',
                'The consumer must validate the signature again.',
                '   The cached response may be reused if it is still valid.',
                ' Otherwise, fetch a fresh copy.',
            ].join('\n'));
        });

        it('should compile escaped backticks inside backtick strings', () => {
            const result = compile('string006:string = `\\``');

            assert.strictEqual(result.errors.length, 0);
            assert.strictEqual(result.events.length, 1);
            assert.strictEqual(result.events[0]!.value.type, 'StringLiteral');
            if (result.events[0]!.value.type !== 'StringLiteral') assert.fail('Expected StringLiteral');
            assert.strictEqual(result.events[0]!.value.value, '`');
        });

        it('should reject invalid non-introducer node syntax', () => {
            const result = compile('view = panel < ("hello")');
            assert.ok(result.errors.some((e) => e.code === 'SYNTAX_ERROR'));
        });

        it('should compile introducer node syntax', () => {
            const result = compile('view = <panel("hello", { x = 1 })>');
            assert.strictEqual(result.errors.length, 0);
            const paths = result.events.map((e) => formatPath(e.path));
            assert.ok(paths.includes('$.view'));
            assert.ok(!paths.includes('$.view.x'));
        });

        it('should compile empty node shorthand', () => {
            const result = compile('view = <panel>');
            assert.strictEqual(result.errors.length, 0);
            const paths = result.events.map((e) => formatPath(e.path));
            assert.ok(paths.includes('$.view'));
        });

        it('should emit annotation stream by default', () => {
            const result = compile('//# doc\na = 1 //? required');

            assert.strictEqual(result.errors.length, 0);
            assert.strictEqual(result.annotations?.length, 2);
            assert.strictEqual(result.annotations?.[0]?.kind, 'doc');
            assert.strictEqual(result.annotations?.[1]?.kind, 'hint');
            assert.deepStrictEqual(result.annotations?.[1]?.target, { kind: 'path', path: '$.a' });
        });

        it('should allow disabling annotation stream emission', () => {
            const result = compile('//# doc\na = 1', { emitAnnotations: false });
            assert.strictEqual(result.annotations, undefined);
        });

        it('should accept a leading shebang and second-line host directive', () => {
            const result = compile('#!/usr/bin/env aeon\n//! format:aeon.test.v1\nvalue:number = 1');

            assert.strictEqual(result.errors.length, 0);
            assert.deepStrictEqual(result.events.map((event) => formatPath(event.path)), ['$.value']);
            assert.deepStrictEqual(result.annotations, []);
        });

        it('should reject shebang syntax outside the first line', () => {
            const result = compile('value:number = 1\n#!/usr/bin/env aeon');

            assert.ok(result.errors.some((error) => error.code === 'SYNTAX_ERROR'));
            assert.strictEqual(result.events.length, 0);
        });

        it('should accept a leading BOM before normal source text', () => {
            const result = compile('\uFEFFvalue:number = 1');

            assert.strictEqual(result.errors.length, 0);
            assert.deepStrictEqual(result.events.map((event) => formatPath(event.path)), ['$.value']);
        });

        it('should accept a leading BOM before shebang and host directive', () => {
            const result = compile('\uFEFF#!/usr/bin/env aeon\n//! format:aeon.test.v1\nvalue:number = 1');

            assert.strictEqual(result.errors.length, 0);
            assert.deepStrictEqual(result.events.map((event) => formatPath(event.path)), ['$.value']);
        });

        it('should still reject a non-leading BOM', () => {
            const result = compile('value = "\uFEFFx"\nnext = \uFEFF1');

            assert.ok(result.errors.some((error) => error.code === 'UNEXPECTED_CHARACTER'));
            assert.strictEqual(result.events.length, 0);
        });
    });

    // ============================================
    // FAIL-CLOSED BEHAVIOR (Red Team Required)
    // ============================================

    describe('fail-closed behavior', () => {
        it('should return zero events on duplicate canonical path (Phase 4 error)', () => {
            // This is Red Team test #1: duplicate path must result in 0 events
            const result = compile('a = { b = 1 }\na = { b = 2 }');

            // MUST return 0 events
            assert.strictEqual(result.events.length, 0);
            // MUST include error
            assert.ok(result.errors.length > 0);
            assert.ok(result.errors.some(e => e.code === 'DUPLICATE_CANONICAL_PATH'));
        });

        it('should propagate errors through emit surface', () => {
            // This is Red Team test #2: emit must surface resolution errors
            const result = compile('a = 1\na = 2');

            // MUST return 0 events
            assert.strictEqual(result.events.length, 0);
            // MUST include error in result
            assert.ok(result.errors.length > 0);
        });

        it('should return zero events on lexer error', () => {
            const result = compile('a = "unterminated');

            assert.strictEqual(result.events.length, 0);
            assert.ok(result.errors.length > 0);
        });

        it('should return zero events on parser error', () => {
            const result = compile('a = { b = }');

            assert.strictEqual(result.events.length, 0);
            assert.ok(result.errors.length > 0);
        });
    });

    // ============================================
    // RECOVERY MODE
    // ============================================

    describe('recovery mode', () => {
        it('should emit partial events when recovery is enabled', () => {
            const result = compile('a = 1\na = 2', { recovery: true });

            // With recovery, first occurrence should be emitted
            assert.ok(result.events.length > 0);
            // But errors should still be present
            assert.ok(result.errors.length > 0);
        });

        it('should still collect all errors in recovery mode', () => {
            const result = compile('a = { b = 1 }\na = { b = 2 }', { recovery: true });

            // Errors are collected
            assert.ok(result.errors.some(e => e.code === 'DUPLICATE_CANONICAL_PATH'));
        });
    });

    // ============================================
    // PHASE 6 — REFERENCE VALIDATION (Red Team Required)
    // ============================================

    describe('reference validation', () => {
        it('should report missing target', () => {
            const result = compile('a = ~b');

            assert.strictEqual(result.events.length, 0);
            assert.ok(result.errors.some(e => (e as { code?: string }).code === 'MISSING_REFERENCE_TARGET'));
        });

        it('should report forward reference', () => {
            const result = compile('a = ~b\nb = 1');

            assert.strictEqual(result.events.length, 0);
            assert.ok(result.errors.some(e => (e as { code?: string }).code === 'FORWARD_REFERENCE'));
        });

        it('should allow valid backward reference', () => {
            const result = compile('b = 1\na = ~b');

            assert.strictEqual(result.errors.length, 0);
            assert.strictEqual(result.events.length, 2);
            assert.deepStrictEqual(result.events.map(e => formatPath(e.path)), ['$.b', '$.a']);
        });

        it('should allow quoted member traversal without an explicit root marker', () => {
            const result = compile('"a.b":string = "x"\nb:string = ~["a.b"]');

            assert.strictEqual(result.errors.length, 0);
            assert.ok(result.events.some((event) => formatPath(event.path) === '$.b'));
        });

        it('should allow typed clone references when the referenced value matches', () => {
            const result = compile([
                'aeon:mode = "strict"',
                'ref_source_num:number = 99',
                'clone001:number = ~ref_source_num',
            ].join('\n'));

            assert.strictEqual(result.errors.length, 0);
            assert.ok(result.events.some((event) => formatPath(event.path) === '$.clone001'));
        });

        it('should report self reference', () => {
            const result = compile('a = ~a');

            assert.strictEqual(result.events.length, 0);
            assert.ok(result.errors.some(e => (e as { code?: string }).code === 'SELF_REFERENCE'));
        });

        it('should report self reference for list elements that point at their owning binding', () => {
            const result = compile('a:list = [~a]');

            assert.strictEqual(result.events.length, 0);
            assert.ok(result.errors.some(e => (e as { code?: string }).code === 'SELF_REFERENCE'));
        });

        it('should allow backward references to earlier list items', () => {
            const result = compile('c:list = [1, 1, ~c[0]]');

            assert.strictEqual(result.errors.length, 0);
            assert.ok(result.events.some((event) => formatPath(event.path) === '$.c[2]'));
        });

        it('should allow backward references to earlier tuple items', () => {
            const result = compile('c:tuple = (1, 1, ~c[0])');

            assert.strictEqual(result.errors.length, 0);
            assert.ok(result.events.some((event) => formatPath(event.path) === '$.c[2]'));
        });

        it('should validate pointer references with same rules', () => {
            const result = compile('a = ~>b');

            assert.strictEqual(result.events.length, 0);
            assert.ok(result.errors.some(e => (e as { code?: string }).code === 'MISSING_REFERENCE_TARGET'));
        });

        it('should enforce max_attribute_depth policy', () => {
            const result = compile('a = 1\nv = ~a@x@y');
            assert.strictEqual(result.events.length, 0);
            assert.ok(result.errors.some((e) => (e as { code?: string }).code === 'ATTRIBUTE_DEPTH_EXCEEDED'));
        });

        it('should allow deeper attribute refs when max_attribute_depth is raised', () => {
            const result = compile('a = 1\nv = ~a@x@y', { maxAttributeDepth: 8 });
            assert.strictEqual(result.events.length, 0);
            assert.ok(result.errors.some((e) => (e as { code?: string }).code === 'MISSING_REFERENCE_TARGET'));
        });
    });

    describe('separator depth policy', () => {
        it('should enforce max_separator_depth by default', () => {
            const result = compile('a:grid[|][x] = ^1|2x3');
            assert.strictEqual(result.events.length, 0);
            assert.ok(result.errors.some((e) => (e as { code?: string }).code === 'SEPARATOR_DEPTH_EXCEEDED'));
        });

        it('should allow chained separator specs when max_separator_depth is raised', () => {
            const result = compile('a:grid[|][x] = ^1|2x3', { maxSeparatorDepth: 8 });
            assert.strictEqual(result.errors.length, 0);
            assert.strictEqual(result.events.length, 1);
        });

        it('should accept raw separator payloads that stay within the whitelist', () => {
            const result = compile('a:set[|] = ^0|0|0;0|0', { maxSeparatorDepth: 8 });
            assert.strictEqual(result.errors.length, 0);
            assert.strictEqual(result.events.length, 1);
        });

        it('should accept quoted separator segments with spaces and punctuation', () => {
            const result = compile('a:set[|] = ^"hello world"|"this, [is] fine"', { maxSeparatorDepth: 8 });
            assert.strictEqual(result.errors.length, 0);
            assert.strictEqual(result.events.length, 1);
        });

        it('should reject unterminated quoted sections inside separator literal payload', () => {
            const result = compile('a:set[|] = ^"0;0', { maxSeparatorDepth: 8 });
            assert.ok(result.errors.some((e) => e.code === 'UNTERMINATED_STRING'));
        });

        it('should terminate raw separator payloads before comment syntax resumes', () => {
            const result = compile('a:set[|] = ^aaa // d', { maxSeparatorDepth: 8 });
            assert.strictEqual(result.errors.length, 0);
            assert.strictEqual(result.events.length, 1);
        });

        it('should reject raw spaces inside separator payloads', () => {
            const result = compile('r = <a(^aaa bbb)>', { maxSeparatorDepth: 8, recovery: true });
            assert.ok(result.errors.some((e) => e.code === 'SYNTAX_ERROR'));
        });

        it('should reject raw slash characters inside separator payloads', () => {
            const result = compile('n = <b(^root/main)>', { maxSeparatorDepth: 8, recovery: true });
            assert.ok(result.errors.some((e) => e.code === 'SYNTAX_ERROR'));
        });
    });

    describe('generic depth policy', () => {
        it('should enforce max_generic_depth by default', () => {
            const result = compile('t:tuple<tuple<n, n>, tuple<n, n>> = ((1,2),(1,2))');
            assert.strictEqual(result.events.length, 0);
            assert.ok(result.errors.some((e) => (e as { code?: string }).code === 'GENERIC_DEPTH_EXCEEDED'));
        });

        it('should allow nested generic annotations when max_generic_depth is raised', () => {
            const result = compile('t:tuple<tuple<n, n>, tuple<n, n>> = ((1,2),(1,2))', { maxGenericDepth: 8 });
            assert.strictEqual(result.errors.length, 0);
            assert.ok(result.events.some((event) => formatPath(event.path) === '$.t'));
            assert.ok(result.events.some((event) => formatPath(event.path) === '$.t[0]'));
            assert.ok(result.events.some((event) => formatPath(event.path) === '$.t[1]'));
        });
    });

    // ============================================
    // ERROR PLUMBING
    // ============================================

    describe('error plumbing', () => {
        it('should collect errors from all phases', () => {
            // Multiple error sources
            const result = compile('a = 1\na = 2');

            // All errors accessible through single result.errors
            assert.ok(result.errors.length > 0);
            // No need to check resolved.errors separately
        });
    });

    describe('diagnostic contracts', () => {
        it('should report invalid radix literal details consistently', () => {
            const result = compile('a = 3e-3\nb = %3e-3');

            assert.strictEqual(result.events.length, 0);
            assert.strictEqual(result.errors.length, 1);
            assert.strictEqual(result.errors[0]!.code, 'INVALID_NUMBER');
            assert.strictEqual(result.errors[0]!.message, "Invalid number literal: '%3e-3'");
            assert.deepStrictEqual(result.errors[0]!.span, {
                start: { line: 2, column: 5, offset: 13 },
                end: { line: 2, column: 10, offset: 18 },
            });
        });

        it('should keep leading-zero reserved radix base brackets in the invalid-number bucket', () => {
            const result = compile('mask:radix[03] = %19');

            assert.strictEqual(result.events.length, 0);
            assert.strictEqual(result.errors.length, 1);
            assert.strictEqual(result.errors[0]!.code, 'INVALID_NUMBER');
        });

        it('should normalize invalid typed hex literals to syntax errors', () => {
            const result = compile('a:hex = #F__F');

            assert.strictEqual(result.events.length, 0);
            assert.strictEqual(result.errors.length, 1);
            assert.strictEqual(result.errors[0]!.code, 'SYNTAX_ERROR');
        });

        it('should normalize invalid untyped encoding literals to syntax errors', () => {
            const result = compile('e = $QmF.zZTY0IQ==');

            assert.strictEqual(result.events.length, 0);
            assert.strictEqual(result.errors.length, 1);
            assert.strictEqual(result.errors[0]!.code, 'SYNTAX_ERROR');
        });

        it('should report unterminated string spans on the correct line and column', () => {
            const result = compile('a = 1\nb = "unterminated');

            assert.strictEqual(result.events.length, 0);
            assert.strictEqual(result.errors.length, 1);
            assert.strictEqual(result.errors[0]!.code, 'UNTERMINATED_STRING');
            assert.strictEqual(result.errors[0]!.message, 'Unterminated string literal (started with ")');
            assert.deepStrictEqual(result.errors[0]!.span, {
                start: { line: 2, column: 5, offset: 10 },
                end: { line: 2, column: 18, offset: 23 },
            });
        });

        it('should report missing reference targets with path and span details', () => {
            const result = compile('a = ~missing');

            assert.strictEqual(result.events.length, 0);
            assert.strictEqual(result.errors.length, 1);
            assert.strictEqual(result.errors[0]!.code, 'MISSING_REFERENCE_TARGET');
            assert.strictEqual(result.errors[0]!.message, "Missing reference target: '$.missing'");
            assert.strictEqual((result.errors[0] as { sourcePath?: string }).sourcePath, '$.a');
            assert.strictEqual((result.errors[0] as { targetPath?: string }).targetPath, '$.missing');
            assert.deepStrictEqual(result.errors[0]!.span, {
                start: { line: 1, column: 5, offset: 4 },
                end: { line: 1, column: 13, offset: 12 },
            });
        });

        it('should report duplicate canonical paths with duplicate-site span details', () => {
            const result = compile('a = 1\na = 2');

            assert.strictEqual(result.events.length, 0);
            assert.strictEqual(result.errors.length, 1);
            assert.strictEqual(result.errors[0]!.code, 'DUPLICATE_CANONICAL_PATH');
            assert.strictEqual(result.errors[0]!.message, "Duplicate canonical path: '$.a'");
            assert.strictEqual((result.errors[0] as { path?: string }).path, '$.a');
            assert.deepStrictEqual(result.errors[0]!.span, {
                start: { line: 2, column: 1, offset: 6 },
                end: { line: 2, column: 6, offset: 11 },
            });
            assert.deepStrictEqual((result.errors[0] as { firstOccurrence?: unknown }).firstOccurrence, {
                start: { line: 1, column: 1, offset: 0 },
                end: { line: 1, column: 6, offset: 5 },
            });
        });

        it('should report temporal literal diagnostics with aligned messages and spans', () => {
            const cases = [
                {
                    source: 'a:date = 2024-13-13\n',
                    code: 'INVALID_DATE',
                    message: "Invalid date literal: '2024-13-13'",
                },
                {
                    source: 'a:time = 24:00\n',
                    code: 'INVALID_TIME',
                    message: "Invalid time literal: '24:00'",
                },
                {
                    source: 'a:datetime = 2024-13-13T09:30:00Z\n',
                    code: 'INVALID_DATETIME',
                    message: "Invalid datetime literal: '2024-13-13T09:30:00Z'",
                },
            ] as const;

            for (const testCase of cases) {
                const result = compile(testCase.source);

                assert.strictEqual(result.events.length, 0);
                assert.strictEqual(result.errors.length, 1);
                assert.strictEqual(result.errors[0]!.code, testCase.code);
                assert.strictEqual(result.errors[0]!.message, testCase.message);
                assert.ok(result.errors[0]!.span);
            }
        });
    });

    // ============================================
    // PHASE 7 — MODE ENFORCEMENT (end-to-end contract)
    // ============================================

    describe('mode enforcement (end-to-end)', () => {
        it('should fail-closed with HEADER_CONFLICT and structured header span details', () => {
            const result = compile('aeon:header = { profile = "core" }\naeon:mode = "strict"\na:int32 = 1');

            assert.strictEqual(result.events.length, 0);
            assert.strictEqual(result.errors.length, 1);
            assert.strictEqual(result.errors[0]!.code, 'HEADER_CONFLICT');
            assert.strictEqual(
                result.errors[0]!.message,
                'Header conflict: cannot use both structured header (aeon:header) and shorthand header fields'
            );
            assert.strictEqual((result.errors[0] as { path?: string }).path, '$');
            assert.deepStrictEqual(result.errors[0]!.span, {
                start: { line: 1, column: 1, offset: 0 },
                end: { line: 2, column: 21, offset: 55 },
            });
        });

        it('should fail-closed with UNTYPED_SWITCH_LITERAL in strict mode', () => {
            const result = compile('aeon:mode = "strict"\ndebug = yes');

            assert.strictEqual(result.events.length, 0);
            assert.strictEqual(result.errors.length, 1);
            assert.strictEqual(result.errors[0]!.code, 'UNTYPED_SWITCH_LITERAL');
            assert.strictEqual(
                result.errors[0]!.message,
                "Untyped switch literal in typed mode: '$.debug' requires ':switch' type annotation"
            );
            assert.strictEqual((result.errors[0] as { path?: string }).path, '$.debug');
            assert.ok(result.errors[0]!.span);
        });

        it('should accept typed tuple literal in strict mode', () => {
            const result = compile('aeon:mode = "strict"\npair:tuple<int32, int32> = (1, 2)');
            assert.strictEqual(result.errors.length, 0);
            assert.ok(result.events.length > 0);
        });

        it('should accept typed list object items in strict mode', () => {
            const result = compile('aeon:mode = "strict"\ncontacts:list = [{ email:string = "ava@example.com" }]');
            assert.strictEqual(result.errors.length, 0);
            assert.ok(result.events.length > 0);
        });

        it('should accept typed time literals in strict mode', () => {
            const result = compile('aeon:mode = "strict"\nopens:time = 09:30:00Z');
            assert.strictEqual(result.errors.length, 0);
            assert.ok(result.events.length > 0);
        });

        it('should fail-closed with DATATYPE_LITERAL_MISMATCH for reserved datatype mismatch', () => {
            const result = compile('aeon:mode = "strict"\nstroke:number = #ff00ff');
            assert.strictEqual(result.events.length, 0);
            assert.strictEqual(result.errors.length, 1);
            assert.strictEqual(result.errors[0]!.code, 'DATATYPE_LITERAL_MISMATCH');
            assert.strictEqual(
                result.errors[0]!.message,
                "Datatype/literal mismatch at '$.stroke': datatype ':number' expects NumberLiteral, got HexLiteral"
            );
            assert.strictEqual((result.errors[0] as { path?: string }).path, '$.stroke');
            assert.ok(result.errors[0]!.span);
        });

        it('should fail-closed with DATATYPE_LITERAL_MISMATCH for attribute datatype mismatch', () => {
            const result = compile('b@{n:string=3}:n = 3');
            assert.strictEqual(result.events.length, 0);
            assert.ok(result.errors.some(e => (e as { code?: string }).code === 'DATATYPE_LITERAL_MISMATCH'));
        });

        it('should accept singleton tuple literals', () => {
            const result = compile('aa:tuple<string> = (3)');
            assert.strictEqual(result.errors.length, 0);
            assert.ok(result.events.length > 0);
        });

        it('should accept singleton tuple literals with a trailing comma', () => {
            const result = compile('aa:tuple<string> = (3,)');
            assert.strictEqual(result.errors.length, 0);
            assert.ok(result.events.length > 0);
        });

        it('should reject empty separator literals', () => {
            const result = compile('blue:sep = ^');
            assert.strictEqual(result.events.length, 0);
            assert.ok(result.errors.length > 0);
        });

        it('should reject unparameterized reserved separator datatypes with caret literals', () => {
            const result = compile('blue:sep = ^200');
            assert.strictEqual(result.events.length, 0);
            assert.ok(result.errors.some(e => (e as { code?: string }).code === 'DATATYPE_LITERAL_MISMATCH'));
        });

        it('should reject separator literals whose payload is split onto the next line', () => {
            const result = compile('a =\n^\n0.0');
            assert.strictEqual(result.events.length, 0);
            assert.ok(result.errors.some(e => (e as { code?: string }).code === 'SYNTAX_ERROR'));
        });

        it('should reject hex literals with trailing underscores', () => {
            const result = compile('blue = #FF_FF_FF_');
            assert.strictEqual(result.events.length, 0);
            assert.ok(result.errors.length > 0);
        });

        it('should fail-closed with CUSTOM_DATATYPE_NOT_ALLOWED by default in strict mode', () => {
            const result = compile('aeon:mode = "strict"\nstroke:myColor = #ff00ff');
            assert.strictEqual(result.events.length, 0);
            assert.strictEqual(result.errors.length, 1);
            assert.strictEqual(result.errors[0]!.code, 'CUSTOM_DATATYPE_NOT_ALLOWED');
            assert.strictEqual(
                result.errors[0]!.message,
                "Custom datatype not allowed in typed mode at '$.stroke': ':myColor' requires --datatype-policy allow_custom"
            );
            assert.strictEqual((result.errors[0] as { path?: string }).path, '$.stroke');
            assert.ok(result.errors[0]!.span);
        });

        it('should allow custom datatypes in strict mode when datatypePolicy is allow_custom', () => {
            const result = compile('aeon:mode = "strict"\nstroke:myColor = #ff00ff', {
                datatypePolicy: 'allow_custom',
            });
            assert.strictEqual(result.errors.length, 0);
            assert.ok(result.events.length > 0);
        });

        it('should reject custom switch aliases in strict mode even when datatypePolicy is allow_custom', () => {
            const result = compile('aeon:mode = "strict"\ns:toggle = on', {
                datatypePolicy: 'allow_custom',
            });
            assert.strictEqual(result.events.length, 0);
            assert.ok(result.errors.some(e => (e as { code?: string }).code === 'CUSTOM_SWITCH_ALIAS_NOT_ALLOWED'));
        });

        it('should treat uppercase reserved-looking names as custom datatypes in strict mode', () => {
            const result = compile('aeon:mode = "strict"\na:N = 3\nb:Radix[10] = %1A', {
                datatypePolicy: 'allow_custom',
            });
            assert.strictEqual(result.errors.length, 0);
            assert.ok(result.events.length > 0);
        });

        it('should allow custom datatypes in transport mode by default', () => {
            const result = compile('aeon:mode = "transport"\nstroke:myColor = #ff00ff');
            assert.strictEqual(result.errors.length, 0);
            assert.ok(result.events.length > 0);
        });

        it('should require typed values in custom mode', () => {
            const result = compile('aeon:mode = "custom"\nstroke = #ff00ff');
            assert.strictEqual(result.events.length, 0);
            assert.ok(result.errors.some(e => (e as { code?: string }).code === 'UNTYPED_VALUE_IN_STRICT_MODE'));
        });

        it('should allow custom datatypes in custom mode by default', () => {
            const result = compile('aeon:mode = "custom"\nstroke:myColor = #ff00ff');
            assert.strictEqual(result.errors.length, 0);
            assert.ok(result.events.length > 0);
        });

        it('should allow custom switch aliases in custom mode', () => {
            const result = compile('aeon:mode = "custom"\ns:toggle = on');
            assert.strictEqual(result.errors.length, 0);
            assert.ok(result.events.length > 0);
        });

        it('should reject scalar values for generic custom datatypes in custom mode', () => {
            const result = compile('aeon:mode = "custom"\na:custom<custom> = 0');
            assert.ok(result.errors.some(e => (e as { code?: string }).code === 'DATATYPE_LITERAL_MISMATCH'));
        });

        it('should allow list and tuple values for generic custom datatypes in custom mode', () => {
            const listResult = compile('aeon:mode = "custom"\nb:custom<custom> = [2]');
            assert.strictEqual(listResult.errors.length, 0);
            assert.ok(listResult.events.length > 0);

            const tupleResult = compile('aeon:mode = "custom"\nc:custom<custom> = (2)');
            assert.strictEqual(tupleResult.errors.length, 0);
            assert.ok(tupleResult.events.length > 0);
        });

        it('should reject scalar values for custom bracket specs in custom mode', () => {
            const radixLikeResult = compile('aeon:mode = "custom"\nd:custom[3] = 3');
            assert.ok(radixLikeResult.errors.some(e => (e as { code?: string }).code === 'DATATYPE_LITERAL_MISMATCH'));

            const separatorLikeResult = compile('aeon:mode = "custom"\ne:custom[.] = 3');
            assert.ok(separatorLikeResult.errors.some(e => (e as { code?: string }).code === 'DATATYPE_LITERAL_MISMATCH'));
        });

        it('should allow valid custom separator and radix bindings in custom mode', () => {
            const radixResult = compile('aeon:mode = "custom"\nf:custom[2] = %10101');
            assert.strictEqual(radixResult.errors.length, 0);
            assert.ok(radixResult.events.length > 0);

            const separatorResult = compile('aeon:mode = "custom"\ng:custom[.] = ^1.1.1');
            assert.strictEqual(separatorResult.errors.length, 0);
            assert.ok(separatorResult.events.length > 0);

            const ambiguousResult = compile('aeon:mode = "custom"\nh:custom[1] = ^1.1.1');
            assert.strictEqual(ambiguousResult.errors.length, 0);
            assert.ok(ambiguousResult.events.length > 0);
        });

        it('should allow single-digit custom bracket specs for both separator and radix literals', () => {
            const separatorResult = compile('aeon:mode = "strict"\na:custom[2] = ^a2a', {
                datatypePolicy: 'allow_custom',
            });
            assert.strictEqual(separatorResult.errors.length, 0);
            assert.ok(separatorResult.events.length > 0);

            const radixResult = compile('aeon:mode = "strict"\nb:custom[2] = %0101', {
                datatypePolicy: 'allow_custom',
            });
            assert.strictEqual(radixResult.errors.length, 0);
            assert.ok(radixResult.events.length > 0);
        });

        it('should reject multi-digit custom bracket specs for separator literals while allowing radix literals', () => {
            const separatorResult = compile('aeon:mode = "strict"\na:test[22] = ^300x200', {
                datatypePolicy: 'allow_custom',
            });
            assert.ok(separatorResult.errors.some(e => (e as { code?: string }).code === 'DATATYPE_LITERAL_MISMATCH'));

            const radixResult = compile('aeon:mode = "strict"\nb:test[22] = %0101', {
                datatypePolicy: 'allow_custom',
            });
            assert.strictEqual(radixResult.errors.length, 0);
            assert.ok(radixResult.events.length > 0);
        });

        it('should allow separator-style custom bracket specs only for separator literals', () => {
            const separatorResult = compile('aeon:mode = "strict"\na:custom[.] = ^300x200', {
                datatypePolicy: 'allow_custom',
            });
            assert.strictEqual(separatorResult.errors.length, 0);
            assert.ok(separatorResult.events.length > 0);

            const radixResult = compile('aeon:mode = "strict"\nb:custom[.] = %0101', {
                datatypePolicy: 'allow_custom',
            });
            assert.ok(radixResult.errors.some(e => (e as { code?: string }).code === 'DATATYPE_LITERAL_MISMATCH'));
        });

        it('should report custom bracket specs that are invalid for both separator and radix literals', () => {
            const result = compile('aeon:mode = "strict"\na:custom[222] = %222', {
                datatypePolicy: 'allow_custom',
            });
            assert.strictEqual(result.errors.length, 1);
            assert.strictEqual(result.errors[0]!.code, 'DATATYPE_LITERAL_MISMATCH');
            assert.strictEqual(
                result.errors[0]!.message,
                "Datatype/literal mismatch at '$.a': datatype ':custom[222]' has bracket specs incompatible with both SeparatorLiteral and RadixLiteral, got RadixLiteral"
            );
        });

        it('should treat removed reserved aliases as custom datatypes in strict mode', () => {
            const result = compile('aeon:mode = "strict"\nvalue:duration = "P1D"');
            assert.strictEqual(result.events.length, 0);
            assert.ok(result.errors.some(e => (e as { code?: string }).code === 'CUSTOM_DATATYPE_NOT_ALLOWED'));
        });

        it('should fail-closed with INVALID_NODE_HEAD_DATATYPE and aligned messaging', () => {
            const result = compile('aeon:mode = "strict"\nwidget:node = <tag:contact("x")>');

            assert.strictEqual(result.events.length, 0);
            assert.strictEqual(result.errors.length, 1);
            assert.strictEqual(result.errors[0]!.code, 'INVALID_NODE_HEAD_DATATYPE');
            assert.strictEqual(
                result.errors[0]!.message,
                "Invalid node head datatype in strict mode at '$.widget': node heads must use ':node', got ':contact'"
            );
            assert.strictEqual((result.errors[0] as { path?: string }).path, '$.widget');
            assert.ok(result.errors[0]!.span);
        });
    });
});
