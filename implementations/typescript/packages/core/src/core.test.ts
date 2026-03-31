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
            const result = compile('a:grid[|][/] = ^1|2/3');
            assert.strictEqual(result.events.length, 0);
            assert.ok(result.errors.some((e) => (e as { code?: string }).code === 'SEPARATOR_DEPTH_EXCEEDED'));
        });

        it('should allow chained separator specs when max_separator_depth is raised', () => {
            const result = compile('a:grid[|][/] = ^1|2/3', { maxSeparatorDepth: 8 });
            assert.strictEqual(result.errors.length, 0);
            assert.strictEqual(result.events.length, 1);
        });

        it('should accept semicolon inside raw separator literal payload', () => {
            const result = compile('a:set[|] = ^0|0|0;0|0', { maxSeparatorDepth: 8 });
            assert.strictEqual(result.errors.length, 0);
            assert.strictEqual(result.events.length, 1);
        });

        it('should accept quoted semicolon inside separator literal payload', () => {
            const result = compile('a:set[|] = ^"0;0"', { maxSeparatorDepth: 8 });
            assert.strictEqual(result.errors.length, 0);
            assert.strictEqual(result.events.length, 1);
        });

        it('should accept supported raw separator escapes inside separator literal payload', () => {
            const result = compile('a:set[|] = ^0\\,0\\\\0\\ 0', { maxSeparatorDepth: 8 });
            assert.strictEqual(result.errors.length, 0);
            assert.strictEqual(result.events.length, 1);
        });

        it('should accept spaces-only separator payload inside node children', () => {
            const result = compile('r = <a(^    )>', { maxSeparatorDepth: 8 });
            assert.strictEqual(result.errors.length, 0);
            assert.strictEqual(result.events.length, 1);
        });

        it('should reject unescaped interior spaces inside raw separator payload in node children', () => {
            const result = compile('n = <b(^a\\ b c)>', { maxSeparatorDepth: 8, recovery: true });
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

    // ============================================
    // PHASE 7 — MODE ENFORCEMENT (end-to-end contract)
    // ============================================

    describe('mode enforcement (end-to-end)', () => {
        it('should fail-closed with HEADER_CONFLICT', () => {
            const result = compile('aeon:header = { profile = "core" }\naeon:mode = "strict"\na:int32 = 1');

            assert.strictEqual(result.events.length, 0);
            assert.ok(result.errors.some(e => (e as { code?: string }).code === 'HEADER_CONFLICT'));
        });

        it('should fail-closed with UNTYPED_SWITCH_LITERAL in strict mode', () => {
            const result = compile('aeon:mode = "strict"\ndebug = yes');

            assert.strictEqual(result.events.length, 0);
            assert.ok(result.errors.some(e => (e as { code?: string }).code === 'UNTYPED_SWITCH_LITERAL'));
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
            assert.ok(result.errors.some(e => (e as { code?: string }).code === 'DATATYPE_LITERAL_MISMATCH'));
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
            assert.ok(result.errors.some(e => (e as { code?: string }).code === 'CUSTOM_DATATYPE_NOT_ALLOWED'));
        });

        it('should allow custom datatypes in strict mode when datatypePolicy is allow_custom', () => {
            const result = compile('aeon:mode = "strict"\nstroke:myColor = #ff00ff', {
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

        it('should treat removed reserved aliases as custom datatypes in strict mode', () => {
            const result = compile('aeon:mode = "strict"\nvalue:duration = "P1D"');
            assert.strictEqual(result.events.length, 0);
            assert.ok(result.errors.some(e => (e as { code?: string }).code === 'CUSTOM_DATATYPE_NOT_ALLOWED'));
        });
    });
});
