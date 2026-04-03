import { describe, it } from 'node:test';
import assert from 'node:assert';
import { tokenize } from '@aeon/lexer';
import { parse } from '@aeon/parser';
import { resolvePaths, emitEvents } from './index.js';
import { validateReferences } from './references.js';
import { enforceMode, type ModeEnforcementResult } from './modes.js';

describe('Mode Enforcement', () => {
    // Helper to compile and enforce mode
    function enforce(input: string, options: { datatypePolicy?: 'reserved_only' | 'allow_custom' } = {}): ModeEnforcementResult {
        const tokens = tokenize(input).tokens;
        const ast = parse(tokens);
        if (!ast.document) {
            throw new Error('Parse failed');
        }
        const resolved = resolvePaths(ast.document);
        const emitted = emitEvents(resolved, { recovery: true });
        const validated = validateReferences(emitted.events, { recovery: true });
        return enforceMode(validated.events, ast.document.header, options);
    }

    function enforceIndexed(input: string): ModeEnforcementResult {
        const tokens = tokenize(input).tokens;
        const ast = parse(tokens);
        if (!ast.document) {
            throw new Error('Parse failed');
        }
        const resolved = resolvePaths(ast.document, { indexedPaths: true });
        const emitted = emitEvents(resolved, { recovery: true });
        const validated = validateReferences(emitted.events, { recovery: true });
        return enforceMode(validated.events, ast.document.header);
    }

    // ============================================
    // STRICT MODE TYPING (Red Team required)
    // ============================================

    describe('strict mode typing', () => {
        it('should error on untyped value in strict mode', () => {
            const result = enforce('aeon:mode = "strict"\na = 1');

            assert.ok(result.errors.length > 0);
            assert.strictEqual(result.errors[0]!.code, 'UNTYPED_VALUE_IN_STRICT_MODE');
        });

        it('should pass typed value in strict mode', () => {
            const result = enforce('aeon:mode = "strict"\na:int32 = 1');

            assert.strictEqual(result.errors.length, 0);
        });

        it('should allow typed clone references when the target literal matches', () => {
            const result = enforce([
                'aeon:mode = "strict"',
                'ref_source_num:number = 99',
                'clone001:number = ~ref_source_num',
            ].join('\n'));

            assert.strictEqual(result.errors.length, 0);
        });

        it('should allow typed pointer references when the target literal matches', () => {
            const result = enforce([
                'aeon:mode = "strict"',
                'ref_source_num:number = 99',
                'pointer001:number = ~>ref_source_num',
            ].join('\n'));

            assert.strictEqual(result.errors.length, 0);
        });

        it('should still reject typed references when the target literal mismatches', () => {
            const result = enforce([
                'aeon:mode = "strict"',
                'ref_source_text:string = "alto"',
                'clone001:number = ~ref_source_text',
            ].join('\n'));

            assert.ok(result.errors.some((e) => e.code === 'DATATYPE_LITERAL_MISMATCH'));
        });

        it('should error on untyped nested value in strict mode', () => {
            const result = enforce('aeon:mode = "strict"\nconfig:object = { port = 8080 }');

            assert.ok(result.errors.length > 0);
            assert.strictEqual(result.errors[0]!.code, 'UNTYPED_VALUE_IN_STRICT_MODE');
        });

        it('should pass fully typed nested object in strict mode', () => {
            const result = enforce('aeon:mode = "strict"\nconfig:object = { port:int32 = 8080 }');

            assert.strictEqual(result.errors.length, 0);
        });

        it('should accept obj as an object alias in strict mode', () => {
            const result = enforce('aeon:mode = "strict"\nconfig:obj = { port:int32 = 8080 }');

            assert.strictEqual(result.errors.length, 0);
        });

        it('should accept envelope as an object alias in strict mode', () => {
            const result = enforce('aeon:mode = "strict"\nclose:envelope = { hash:string = "abc" }');

            assert.strictEqual(result.errors.length, 0);
        });

        it('should accept trimtick as a string alias in strict mode', () => {
            const result = enforce([
                'aeon:mode = "strict"',
                'note:trimtick = >>`',
                '    one',
                '  two',
                '`',
            ].join('\n'));

            assert.strictEqual(result.errors.length, 0);
        });

        it('should pass typed tuple literal in strict mode with indexed paths', () => {
            const result = enforceIndexed('aeon:mode = "strict"\npair:tuple<int32, int32> = (1, 2)');
            assert.strictEqual(result.errors.length, 0);
        });

        it('should pass typed list object items in strict mode with indexed paths', () => {
            const result = enforceIndexed('aeon:mode = "strict"\ncontacts:list = [{ email:string = "a@x.com" }]');
            assert.strictEqual(result.errors.length, 0);
        });

        it('should error when reserved numeric datatype is bound to hex literal', () => {
            const result = enforce('aeon:mode = "strict"\nstroke:number = #ff00ff');
            assert.ok(result.errors.some((e) => e.code === 'DATATYPE_LITERAL_MISMATCH'));
        });

        it('should reject custom datatype with hex literal by default in strict mode', () => {
            const result = enforce('aeon:mode = "strict"\nstroke:myColor = #ff00ff');
            assert.ok(result.errors.some((e) => e.code === 'CUSTOM_DATATYPE_NOT_ALLOWED'));
        });

        it('should allow custom datatype when datatype policy is allow_custom', () => {
            const result = enforce('aeon:mode = "strict"\nstroke:myColor = #ff00ff', {
                datatypePolicy: 'allow_custom',
            });
            assert.strictEqual(result.errors.length, 0);
        });

        it('should accept typed time literal in strict mode', () => {
            const result = enforce('aeon:mode = "strict"\nopens:time = 09:30:00Z');

            assert.strictEqual(result.errors.length, 0);
        });

        it('should accept typed infinity literal in strict mode', () => {
            const result = enforce('aeon:mode = "strict"\nlimit:infinity = Infinity');

            assert.strictEqual(result.errors.length, 0);
        });

        it('should accept embed and inline as reserved encoding aliases in strict mode', () => {
            for (const datatype of ['embed', 'inline']) {
                const result = enforce(`aeon:mode = "strict"\npayload:${datatype} = $QmFzZTY0IQ==`);
                assert.strictEqual(result.errors.length, 0, datatype);
            }
        });

        it('should reject infinity literal bound to number in strict mode', () => {
            const result = enforce('aeon:mode = "strict"\nlimit:number = Infinity');

            assert.ok(result.errors.some((e) => e.code === 'DATATYPE_LITERAL_MISMATCH'));
        });

        it('should treat removed reserved aliases as custom datatypes in strict mode', () => {
            const result = enforce('aeon:mode = "strict"\nvalue:duration = "P1D"');

            assert.ok(result.errors.some((e) => e.code === 'CUSTOM_DATATYPE_NOT_ALLOWED'));
        });

        it('should reject non-node inline node head datatypes in strict mode', () => {
            const result = enforce('aeon:mode = "strict"\nwidget:node = <tag:contact("x")>');

            assert.ok(result.errors.some((e) => e.code === 'INVALID_NODE_HEAD_DATATYPE'));
        });

        it('should allow :node inline node head datatype in strict mode', () => {
            const result = enforce('aeon:mode = "strict"\nwidget:node = <tag:node("x")>');

            assert.strictEqual(result.errors.length, 0);
        });
    });

    // ============================================
    // TRANSPORT MODE (Red Team required)
    // ============================================

    describe('transport mode', () => {
        it('should allow untyped value in transport mode', () => {
            const result = enforce('aeon:mode = "transport"\na = 1');

            assert.strictEqual(result.errors.length, 0);
        });

        it('should allow untyped nested values in transport mode', () => {
            const result = enforce('aeon:mode = "transport"\nconfig = { port = 8080 }');

            assert.strictEqual(result.errors.length, 0);
        });

        it('should default to transport mode when not specified', () => {
            const result = enforce('a = 1');

            assert.strictEqual(result.errors.length, 0);
        });

        it('should reject explicit reserved datatype mismatch in transport mode', () => {
            const result = enforce('aeon:mode = "transport"\nstate:switch = true');

            assert.ok(result.errors.length > 0);
            assert.ok(result.errors.some((e) => e.code === 'DATATYPE_LITERAL_MISMATCH'));
        });

        it('should allow explicit reserved datatype match in transport mode', () => {
            const result = enforce('aeon:mode = "transport"\nstate:switch = on');

            assert.strictEqual(result.errors.length, 0);
        });

        it('should allow custom datatype in transport mode', () => {
            const result = enforce('aeon:mode = "transport"\ncolor:stroke = #ff00ff');

            assert.strictEqual(result.errors.length, 0);
        });

        it('should treat uppercase reserved-looking names as custom datatypes in transport mode', () => {
            const result = enforce('aeon:mode = "transport"\na:N = #ff00ff\nb:Radix[10] = %1A');

            assert.strictEqual(result.errors.length, 0);
        });

        it('should allow custom inline node head datatypes in transport mode', () => {
            const result = enforce('aeon:mode = "transport"\nwidget:node = <tag:pair("x", "y")>');

            assert.strictEqual(result.errors.length, 0);
        });
    });

    describe('custom mode', () => {
        it('should require typed values in custom mode', () => {
            const result = enforce('aeon:mode = "custom"\na = 1');

            assert.ok(result.errors.some((e) => e.code === 'UNTYPED_VALUE_IN_STRICT_MODE'));
        });

        it('should allow custom datatype labels in custom mode by default', () => {
            const result = enforce('aeon:mode = "custom"\ncolor:stroke = #ff00ff');

            assert.strictEqual(result.errors.length, 0);
        });

        it('should allow custom inline node head datatypes in custom mode', () => {
            const result = enforce('aeon:mode = "custom"\nwidget:node = <tag:pair("x", "y")>');

            assert.strictEqual(result.errors.length, 0);
        });

        it('should treat untyped switch literals like other untyped bindings in custom mode', () => {
            const result = enforce('aeon:mode = "custom"\ndebug = yes');

            assert.ok(result.errors.some((e) => e.code === 'UNTYPED_VALUE_IN_STRICT_MODE'));
            assert.ok(!result.errors.some((e) => e.code === 'UNTYPED_SWITCH_LITERAL'));
        });

        it('should reject scalar values for generic custom datatypes in custom mode', () => {
            const result = enforce('aeon:mode = "custom"\na:custom<custom> = 0');

            assert.ok(result.errors.some((e) => e.code === 'DATATYPE_LITERAL_MISMATCH'));
        });

        it('should allow list and tuple values for generic custom datatypes in custom mode', () => {
            const listResult = enforce('aeon:mode = "custom"\nb:custom<custom> = [2]');
            assert.strictEqual(listResult.errors.length, 0);

            const tupleResult = enforce('aeon:mode = "custom"\nc:custom<custom> = (2)');
            assert.strictEqual(tupleResult.errors.length, 0);
        });

        it('should reject non separator and radix values for custom bracket specs in custom mode', () => {
            const radixLikeResult = enforce('aeon:mode = "custom"\nd:custom[3] = 3');
            assert.ok(radixLikeResult.errors.some((e) => e.code === 'DATATYPE_LITERAL_MISMATCH'));

            const separatorLikeResult = enforce('aeon:mode = "custom"\ne:custom[.] = 3');
            assert.ok(separatorLikeResult.errors.some((e) => e.code === 'DATATYPE_LITERAL_MISMATCH'));
        });

        it('should continue to allow valid custom bracket spec bindings in custom mode', () => {
            const radixResult = enforce('aeon:mode = "custom"\nf:custom[2] = %10101');
            assert.strictEqual(radixResult.errors.length, 0);

            const separatorResult = enforce('aeon:mode = "custom"\ng:custom[.] = ^1.1.1');
            assert.strictEqual(separatorResult.errors.length, 0);

            const ambiguousResult = enforce('aeon:mode = "custom"\nh:custom[1] = ^1.1.1');
            assert.strictEqual(ambiguousResult.errors.length, 0);
        });

        it('should report incompatible generic and bracket custom constraints clearly', () => {
            const result = enforce('aeon:mode = "custom"\na:custom<custom>[.] = [2]');
            assert.ok(result.errors.some((e) =>
                e.code === 'DATATYPE_LITERAL_MISMATCH'
                && e.message.includes('combines incompatible generic and bracket constraints')
            ));
        });
    });

    // ============================================
    // SWITCH TYPING RULE (Red Team required)
    // ============================================

    describe('switch typing rule', () => {
        it('should error on untyped switch literal in strict mode', () => {
            const result = enforce('aeon:mode = "strict"\ndebug = yes');

            assert.ok(result.errors.length > 0);
            assert.ok(result.errors.some(e => e.code === 'UNTYPED_SWITCH_LITERAL'));
        });

        it('should pass typed switch literal in strict mode', () => {
            const result = enforce('aeon:mode = "strict"\ndebug:switch = yes');

            assert.strictEqual(result.errors.length, 0);
        });

        it('should error if switch literal is typed as a non-switch', () => {
            const result = enforce('aeon:mode = "strict"\ndebug:int32 = yes');

            assert.ok(result.errors.length > 0);
            assert.ok(result.errors.some(e => e.code === 'DATATYPE_LITERAL_MISMATCH'));
        });

        it('should allow untyped switch in transport mode (stays raw)', () => {
            const result = enforce('aeon:mode = "transport"\ndebug = yes');

            // Transport mode allows untyped - value stays raw, no semantic switch
            assert.strictEqual(result.errors.length, 0);
            const debugEvent = result.events.find((event) => event.key === 'debug');
            assert.ok(debugEvent);
            assert.strictEqual(debugEvent!.value.type, 'SwitchLiteral');
            if (debugEvent!.value.type === 'SwitchLiteral') {
                assert.strictEqual(debugEvent!.value.raw, 'yes');
            }
        });
    });

    // ============================================
    // HEADER CORRECTNESS
    // ============================================

    describe('header correctness', () => {
        it('should allow shorthand header only', () => {
            const result = enforce('aeon:mode = "strict"\na:int32 = 1');

            assert.strictEqual(result.errors.length, 0);
        });

        it('should allow shorthand header metadata fields beyond mode', () => {
            const result = enforce([
                'aeon:mode = "strict"',
                'aeon:profile = "aeon.gp.profile.v1"',
                'aeon:schema = "aeon.gp.schema.v1"',
                'a:int32 = 1',
            ].join('\n'));

            assert.strictEqual(result.errors.length, 0);
        });

        it('should allow structured header only', () => {
            const result = enforce('aeon:header = { mode = "strict" }\na:int32 = 1');

            assert.strictEqual(result.errors.length, 0);
        });

        it('should enforce strict typing for structured header payload bindings', () => {
            const result = enforce([
                'aeon:header = {',
                '  mode = "strict"',
                '  meta = {',
                '    document:string = "public"',
                '  }',
                '}',
            ].join('\n'));

            assert.ok(result.errors.length > 0);
            assert.ok(result.errors.some((e) => e.code === 'UNTYPED_VALUE_IN_STRICT_MODE'));
            assert.ok(result.errors.some((e) => e.path.includes('aeon:meta')));
        });

        it('should allow typed structured header payload bindings in strict mode', () => {
            const result = enforce([
                'aeon:header = {',
                '  mode = "strict"',
                '  meta:object = {',
                '    document:string = "public"',
                '  }',
                '}',
            ].join('\n'));

            assert.strictEqual(result.errors.length, 0);
        });

        it('should error when structured header and shorthand header are both present', () => {
            const result = enforce('aeon:header = { mode = "strict" }\naeon:mode = "strict"\na:int32 = 1');

            assert.ok(result.errors.length > 0);
            assert.ok(result.errors.some(e => e.code === 'HEADER_CONFLICT'));
            assert.strictEqual(result.events.length, 0);
        });
    });

    // ============================================
    // FAIL-CLOSED BEHAVIOR
    // ============================================

    describe('fail-closed behavior', () => {
        it('should return empty events on mode errors', () => {
            const result = enforce('aeon:mode = "strict"\na = 1');

            assert.strictEqual(result.events.length, 0);
            assert.ok(result.errors.length > 0);
        });

        it('should return all events when no mode errors', () => {
            const result = enforce('aeon:mode = "strict"\na:int32 = 1');

            assert.ok(result.events.length > 0);
            assert.strictEqual(result.errors.length, 0);
        });
    });
});
