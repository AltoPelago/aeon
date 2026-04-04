import { describe, it } from 'node:test';
import assert from 'node:assert';
import { tokenize } from '@aeon/lexer';
import { parse } from './parser.js';

describe('Parser', () => {
    // ============================================
    // AST SHAPE TESTS
    // ============================================

    describe('simple bindings', () => {
        it('should parse a simple string binding', () => {
            const tokens = tokenize('name = "Patrik"').tokens;
            const result = parse(tokens);

            assert.strictEqual(result.errors.length, 0);
            assert.ok(result.document);
            assert.strictEqual(result.document.bindings.length, 1);
            assert.strictEqual(result.document.bindings[0]!.key, 'name');
            assert.strictEqual(result.document.bindings[0]!.value.type, 'StringLiteral');
        });

        it('should parse a numeric binding', () => {
            const tokens = tokenize('age = 49').tokens;
            const result = parse(tokens);

            assert.strictEqual(result.errors.length, 0);
            assert.ok(result.document);
            assert.strictEqual(result.document.bindings[0]!.key, 'age');
            assert.strictEqual(result.document.bindings[0]!.value.type, 'NumberLiteral');
        });

        it('should parse leading-dot decimal bindings', () => {
            const tokens = tokenize('ratio = .5\nnegative = -.5').tokens;
            const result = parse(tokens);

            assert.strictEqual(result.errors.length, 0);
            assert.strictEqual(result.document!.bindings[0]!.value.type, 'NumberLiteral');
            assert.strictEqual(result.document!.bindings[1]!.value.type, 'NumberLiteral');
        });

        it('should parse trimticks and trim semantic indentation', () => {
            const tokens = tokenize([
                'class = {',
                '  text = >>`',
                '           This policy applies when a request is retried.',
                '        The consumer must validate the signature again.',
                '           The cached response may be reused if it is still valid.',
                '         Otherwise, fetch a fresh copy.',
                '',
                '  `',
                '}',
            ].join('\n')).tokens;
            const result = parse(tokens);

            assert.strictEqual(result.errors.length, 0);
            const root = result.document!.bindings[0]!;
            assert.strictEqual(root.value.type, 'ObjectNode');
            if (root.value.type !== 'ObjectNode') assert.fail('Expected ObjectNode');
            const text = root.value.bindings[0]!.value;
            assert.strictEqual(text.type, 'StringLiteral');
            if (text.type !== 'StringLiteral') assert.fail('Expected StringLiteral');
            assert.strictEqual(text.trimticks?.markerWidth, 2);
            assert.strictEqual(text.value, [
                '   This policy applies when a request is retried.',
                'The consumer must validate the signature again.',
                '   The cached response may be reused if it is still valid.',
                ' Otherwise, fetch a fresh copy.',
            ].join('\n'));
        });

        it('should allow spaces between trimtick marker and backtick opener', () => {
            const tokens = tokenize('a = >> ``').tokens;
            const result = parse(tokens);

            assert.strictEqual(result.errors.length, 0);
            const value = result.document!.bindings[0]!.value;
            assert.strictEqual(value.type, 'StringLiteral');
            if (value.type !== 'StringLiteral') assert.fail('Expected StringLiteral');
            assert.strictEqual(value.trimticks?.markerWidth, 2);
            assert.strictEqual(value.value, '');
        });

        it('should reject split trimtick markers', () => {
            const tokens = tokenize('a = > > ``').tokens;
            const result = parse(tokens);

            assert.ok(result.errors.length > 0);
            assert.strictEqual(result.errors[0]!.code, 'SYNTAX_ERROR');
        });

        it('should reject trimtick markers before non-backtick strings', () => {
            const tokens = tokenize('a = >> ""').tokens;
            const result = parse(tokens);

            assert.ok(result.errors.length > 0);
            assert.strictEqual(result.errors[0]!.code, 'SYNTAX_ERROR');
        });

        it('should parse a boolean binding', () => {
            const tokens = tokenize('active = true').tokens;
            const result = parse(tokens);

            assert.strictEqual(result.errors.length, 0);
            assert.ok(result.document);
            assert.strictEqual(result.document.bindings[0]!.value.type, 'BooleanLiteral');
        });

        it('should parse switch literal as SwitchLiteral', () => {
            const tokens = tokenize('feature = yes').tokens;
            const result = parse(tokens);

            assert.strictEqual(result.errors.length, 0);
            assert.ok(result.document);
            const value = result.document.bindings[0]!.value;
            assert.strictEqual(value.type, 'SwitchLiteral');
            if (value.type === 'SwitchLiteral') {
                assert.strictEqual(value.value, 'yes');
                assert.strictEqual(value.raw, 'yes');
            }
        });

        it('should parse multiple bindings with newlines', () => {
            const tokens = tokenize('a = 1\nb = 2\nc = 3').tokens;
            const result = parse(tokens);

            assert.strictEqual(result.errors.length, 0);
            assert.ok(result.document);
            assert.strictEqual(result.document.bindings.length, 3);
        });

        it('should parse multiple bindings with commas at the top level', () => {
            const tokens = tokenize('a = 1, b = 2, c = 3').tokens;
            const result = parse(tokens);

            assert.strictEqual(result.errors.length, 0);
            assert.ok(result.document);
            assert.strictEqual(result.document.bindings.length, 3);
        });

        it('should reject space-only top-level binding separation', () => {
            const tokens = tokenize('a = 1 b = 2').tokens;
            const result = parse(tokens);

            assert.ok(result.errors.length > 0);
            assert.strictEqual(result.errors[0]!.code, 'SYNTAX_ERROR');
        });

        it('should parse typed binding', () => {
            const tokens = tokenize('count:int32 = 42').tokens;
            const result = parse(tokens);

            assert.strictEqual(result.errors.length, 0);
            assert.ok(result.document);
            assert.ok(result.document.bindings[0]!.datatype);
            assert.strictEqual(result.document.bindings[0]!.datatype!.name, 'int32');
            assert.deepStrictEqual(result.document.bindings[0]!.datatype!.genericArgs, []);
        });

        it('should parse quoted top-level key', () => {
            const tokens = tokenize('"a.b" = 2').tokens;
            const result = parse(tokens);

            assert.strictEqual(result.errors.length, 0);
            assert.strictEqual(result.document!.bindings[0]!.key, 'a.b');
        });

        it('should reject empty quoted top-level key', () => {
            const tokens = tokenize('"" = 2').tokens;
            const result = parse(tokens);

            assert.ok(result.errors.length > 0);
            assert.strictEqual(result.errors[0]!.code, 'SYNTAX_ERROR');
        });

        it('should preserve structured header bindings with quoted keys, datatypes, attributes, and nested values', () => {
            const tokens = tokenize([
                'aeon:header = {',
                '  \':\' = "hello"',
                '  mode:number = "strict"',
                '  a = { c:n = 0 }',
                '  b@{a:n = 2} = 2',
                '  n:node = <a(<a(<a@{g:string = "h"}()>)>)>',
                '}',
            ].join('\n')).tokens;
            const result = parse(tokens);

            assert.strictEqual(result.errors.length, 0);
            assert.ok(result.document?.header);

            const header = result.document!.header!;
            assert.strictEqual(header.bindings.length, 5);
            assert.strictEqual(header.bindings[0]!.key, ':');
            assert.strictEqual(header.bindings[1]!.key, 'mode');
            assert.strictEqual(header.bindings[1]!.datatype?.name, 'number');
            assert.strictEqual(header.bindings[2]!.value.type, 'ObjectNode');
            assert.strictEqual(header.bindings[3]!.attributes.length, 1);
            assert.strictEqual(header.bindings[4]!.value.type, 'NodeLiteral');
        });

        it('should parse contiguous shorthand header bindings before body bindings', () => {
            const tokens = tokenize([
                'aeon:mode = "strict"',
                'aeon:profile = "aeon.gp.profile.v1"',
                'app = 1',
            ].join('\n')).tokens;
            const result = parse(tokens);

            assert.strictEqual(result.errors.length, 0);
            assert.ok(result.document?.header);
            assert.strictEqual(result.document!.header!.bindings.length, 2);
            assert.strictEqual(result.document!.bindings[0]!.key, 'app');
        });

        it('should reject structured headers that appear after body bindings', () => {
            const tokens = tokenize([
                'app = 1',
                'aeon:header = {',
                '  mode = "strict"',
                '}',
            ].join('\n')).tokens;
            const result = parse(tokens);

            assert.ok(result.errors.length > 0);
            assert.strictEqual(result.errors[0]!.code, 'SYNTAX_ERROR');
            assert.match(result.errors[0]!.message, /Structured headers must precede body bindings/);
        });

        it('should reject backtick-quoted key', () => {
            const tokens = tokenize('`a` = 2').tokens;
            const result = parse(tokens);

            assert.ok(result.errors.length > 0);
            assert.strictEqual(result.errors[0]!.code, 'SYNTAX_ERROR');
        });

        it('should parse generic typed binding in core v1', () => {
            const tokens = tokenize('coords:tuple<int32, int32> = (1, 2)').tokens;
            const result = parse(tokens);

            assert.strictEqual(result.errors.length, 0);
            const datatype = result.document!.bindings[0]!.datatype;
            assert.ok(datatype);
            assert.strictEqual(datatype!.name, 'tuple');
            assert.deepStrictEqual(datatype!.genericArgs, ['int32', 'int32']);
        });

        it('should parse generic args on attribute type in core v1', () => {
            const tokens = tokenize('value@{meta:pair<int32, string> = "ok"} = 1').tokens;
            const result = parse(tokens);

            assert.strictEqual(result.errors.length, 0);
            const attr = result.document!.bindings[0]!.attributes[0]!;
            const entry = attr.entries.get('meta');
            assert.ok(entry);
            assert.ok(entry!.datatype);
            assert.strictEqual(entry!.datatype!.name, 'pair');
            assert.deepStrictEqual(entry!.datatype!.genericArgs, ['int32', 'string']);
        });

        it('should parse binding-attached attributes on list-valued bindings', () => {
            const tokens = tokenize('a@{b=1} = [0]').tokens;
            const result = parse(tokens);

            assert.strictEqual(result.errors.length, 0);
            assert.strictEqual(result.document!.bindings[0]!.attributes.length, 1);
        });

        it('should reject postfix literal attributes', () => {
            const tokens = tokenize('a = [0]@{b=2}').tokens;
            const result = parse(tokens);

            assert.ok(result.errors.length > 0);
        });

        it('should parse nested binding attributes inside containers', () => {
            const tokens = tokenize('a = [{x@{b=0}=1}]').tokens;
            const result = parse(tokens);

            assert.strictEqual(result.errors.length, 0);
            const list = result.document!.bindings[0]!.value;
            if (list.type !== 'ListNode') {
                assert.fail(`Expected ListNode, got ${list.type}`);
            }
            const obj = list.elements[0]!;
            if (obj.type !== 'ObjectNode') {
                assert.fail(`Expected ObjectNode, got ${obj.type}`);
            }
            assert.strictEqual(obj.bindings[0]!.attributes.length, 1);
        });

        it('should parse generic type syntax as baseline core v1', () => {
            const tokens = tokenize('coords:tuple<int32, int32> = [1, 2]').tokens;
            const result = parse(tokens);

            assert.strictEqual(result.errors.length, 0);
        });

        it('should parse nested generic type arguments', () => {
            const tokens = tokenize('t:tuple<tuple<n, n>, tuple<n, n>, tuple<n, n>> = ((1,2),(1,2),(1,2))').tokens;
            const result = parse(tokens, { maxGenericDepth: 8 });

            assert.strictEqual(result.errors.length, 0);
            assert.deepStrictEqual(
                result.document!.bindings[0]!.datatype!.genericArgs,
                ['tuple<n, n>', 'tuple<n, n>', 'tuple<n, n>']
            );
        });

        it('should enforce max_generic_depth for nested generic type arguments', () => {
            const tokens = tokenize('t:tuple<tuple<n, n>, tuple<n, n>> = ((1,2),(1,2))').tokens;
            const result = parse(tokens, { maxGenericDepth: 1 });

            assert.ok(result.errors.length > 0);
            assert.strictEqual(result.errors[0]!.code, 'GENERIC_DEPTH_EXCEEDED');
        });

        it('should allow nested generic type arguments when maxGenericDepth is raised', () => {
            const tokens = tokenize('t:tuple<tuple<n, n>, tuple<n, n>> = ((1,2),(1,2))').tokens;
            const result = parse(tokens, { maxGenericDepth: 8 });

            assert.strictEqual(result.errors.length, 0);
            assert.deepStrictEqual(result.document!.bindings[0]!.datatype!.genericArgs, ['tuple<n, n>', 'tuple<n, n>']);
        });

        it('should reject malformed generic argument lists in core v1', () => {
            const tokens = tokenize('coords:tuple<, int32> = [1, 2]').tokens;
            const result = parse(tokens);

            assert.ok(result.errors.length > 0);
            assert.strictEqual(result.errors[0]!.code, 'SYNTAX_ERROR');
        });

        it('should reject empty generic argument lists in core v1', () => {
            const tokens = tokenize('coords:tuple<> = [1, 2]').tokens;
            const result = parse(tokens);

            assert.ok(result.errors.length > 0);
            assert.strictEqual(result.errors[0]!.code, 'SYNTAX_ERROR');
        });

        it('should reject trailing commas in generic argument lists in core v1', () => {
            const tokens = tokenize('coords:tuple<int32,> = [1, 2]').tokens;
            const result = parse(tokens);

            assert.ok(result.errors.length > 0);
            assert.strictEqual(result.errors[0]!.code, 'SYNTAX_ERROR');
        });
    });

    describe('object bindings', () => {
        it('should parse empty object', () => {
            const tokens = tokenize('config = {}').tokens;
            const result = parse(tokens);

            assert.strictEqual(result.errors.length, 0);
            assert.ok(result.document);
            assert.strictEqual(result.document.bindings[0]!.value.type, 'ObjectNode');
        });

        it('should parse object with single key', () => {
            const tokens = tokenize('user = { name = "Pat" }').tokens;
            const result = parse(tokens);

            assert.strictEqual(result.errors.length, 0);
            assert.ok(result.document);
            const obj = result.document.bindings[0]!.value;
            assert.strictEqual(obj.type, 'ObjectNode');
            if (obj.type === 'ObjectNode') {
                assert.strictEqual(obj.bindings.length, 1);
                assert.strictEqual(obj.bindings[0]!.key, 'name');
            }
        });

        it('should parse object with multiple keys', () => {
            const tokens = tokenize('user = { name = "Pat", age = 49 }').tokens;
            const result = parse(tokens);

            assert.strictEqual(result.errors.length, 0);
            const obj = result.document!.bindings[0]!.value;
            if (obj.type === 'ObjectNode') {
                assert.strictEqual(obj.bindings.length, 2);
            }
        });

        it('should reject space-only object binding separation', () => {
            const tokens = tokenize('user = { name = "Pat" age = 49 }').tokens;
            const result = parse(tokens);

            assert.ok(result.errors.length > 0);
            assert.strictEqual(result.errors[0]!.code, 'SYNTAX_ERROR');
        });

        it('should parse quoted object key', () => {
            const tokens = tokenize('obj = { "a.b" = 1 }').tokens;
            const result = parse(tokens);

            assert.strictEqual(result.errors.length, 0);
            const obj = result.document!.bindings[0]!.value;
            assert.strictEqual(obj.type, 'ObjectNode');
            if (obj.type === 'ObjectNode') {
                assert.strictEqual(obj.bindings[0]!.key, 'a.b');
            }
        });

        it('should reject empty quoted object key', () => {
            const tokens = tokenize('obj = { "" = 1 }').tokens;
            const result = parse(tokens);

            assert.ok(result.errors.length > 0);
            assert.strictEqual(result.errors[0]!.code, 'SYNTAX_ERROR');
        });

        it('should parse nested objects', () => {
            const tokens = tokenize('config = { db = { host = "localhost" } }').tokens;
            const result = parse(tokens);

            assert.strictEqual(result.errors.length, 0);
            const outer = result.document!.bindings[0]!.value;
            assert.strictEqual(outer.type, 'ObjectNode');
            if (outer.type === 'ObjectNode') {
                const inner = outer.bindings[0]!.value;
                assert.strictEqual(inner.type, 'ObjectNode');
            }
        });
    });

    describe('list bindings', () => {
        it('should parse empty list', () => {
            const tokens = tokenize('items = []').tokens;
            const result = parse(tokens);

            assert.strictEqual(result.errors.length, 0);
            assert.strictEqual(result.document!.bindings[0]!.value.type, 'ListNode');
        });

        it('should parse list with elements', () => {
            const tokens = tokenize('numbers = [1, 2, 3]').tokens;
            const result = parse(tokens);

            assert.strictEqual(result.errors.length, 0);
            const list = result.document!.bindings[0]!.value;
            if (list.type === 'ListNode') {
                assert.strictEqual(list.elements.length, 3);
            }
        });

        it('should parse nested list', () => {
            const tokens = tokenize('matrix = [[1, 2], [3, 4]]').tokens;
            const result = parse(tokens);

            assert.strictEqual(result.errors.length, 0);
            const outer = result.document!.bindings[0]!.value;
            if (outer.type === 'ListNode') {
                assert.strictEqual(outer.elements.length, 2);
                assert.strictEqual(outer.elements[0]!.type, 'ListNode');
            }
        });

        it('should parse mixed list', () => {
            const tokens = tokenize('mixed = [1, "two", true]').tokens;
            const result = parse(tokens);

            assert.strictEqual(result.errors.length, 0);
            const list = result.document!.bindings[0]!.value;
            if (list.type === 'ListNode') {
                assert.strictEqual(list.elements[0]!.type, 'NumberLiteral');
                assert.strictEqual(list.elements[1]!.type, 'StringLiteral');
                assert.strictEqual(list.elements[2]!.type, 'BooleanLiteral');
            }
        });

        it('should parse tuple literal in core v1', () => {
            const tokens = tokenize('pair = (1, 2)').tokens;
            const result = parse(tokens);

            assert.strictEqual(result.errors.length, 0);
            const tuple = result.document!.bindings[0]!.value;
            assert.strictEqual(tuple.type, 'TupleLiteral');
            if (tuple.type === 'TupleLiteral') {
                assert.strictEqual(tuple.elements.length, 2);
            }
        });

        it('should parse tuple literal as baseline core v1', () => {
            const tokens = tokenize('pair = (1, 2)').tokens;
            const result = parse(tokens);

            assert.strictEqual(result.errors.length, 0);
        });
    });

    describe('reference bindings', () => {
        it('should parse clone reference', () => {
            const tokens = tokenize('a = 1\nb = ~a').tokens;
            const result = parse(tokens);

            assert.strictEqual(result.errors.length, 0);
            assert.strictEqual(result.document!.bindings[1]!.value.type, 'CloneReference');
        });

        it('should parse pointer reference', () => {
            const tokens = tokenize('a = 1\nb = ~>a').tokens;
            const result = parse(tokens);

            assert.strictEqual(result.errors.length, 0);
            assert.strictEqual(result.document!.bindings[1]!.value.type, 'PointerReference');
        });

        it('should parse dotted reference path', () => {
            const tokens = tokenize('config = { db = { host = "localhost" } }\ndbHost = ~config.db.host').tokens;
            const result = parse(tokens);

            assert.strictEqual(result.errors.length, 0);
            const ref = result.document!.bindings[1]!.value;
            if (ref.type === 'CloneReference') {
                assert.deepStrictEqual(ref.path, ['config', 'db', 'host']);
            }
        });

        it('should parse indexed reference path in core v1', () => {
            const tokens = tokenize('coords = [10, 20]\nsecond = ~coords[1]').tokens;
            const result = parse(tokens);

            assert.strictEqual(result.errors.length, 0);
            const ref = result.document!.bindings[1]!.value;
            if (ref.type === 'CloneReference') {
                assert.deepStrictEqual(ref.path, ['coords', 1]);
            } else {
                assert.fail(`Expected CloneReference, got ${ref.type}`);
            }
        });

        it('should parse root-qualified reference path in core v1', () => {
            const tokens = tokenize('a = { b = 1 }\nv = ~$.a.b').tokens;
            const result = parse(tokens);

            assert.strictEqual(result.errors.length, 0);
            const ref = result.document!.bindings[1]!.value;
            if (ref.type === 'CloneReference') {
                assert.deepStrictEqual(ref.path, ['a', 'b']);
            } else {
                assert.fail(`Expected CloneReference, got ${ref.type}`);
            }
        });

        it('should parse quoted bracket segment in reference path', () => {
            const tokens = tokenize('"a.b" = 2\nv = ~$.["a.b"]').tokens;
            const result = parse(tokens);

            assert.strictEqual(result.errors.length, 0);
            const ref = result.document!.bindings[1]!.value;
            if (ref.type === 'CloneReference') {
                assert.deepStrictEqual(ref.path, ['a.b']);
            } else {
                assert.fail(`Expected CloneReference, got ${ref.type}`);
            }
        });

        it('should reject quoted root-member traversal without an explicit dot after $', () => {
            const tokens = tokenize('"a.b" = 2\nv = ~$["a.b"]').tokens;
            const result = parse(tokens);

            assert.ok(result.errors.length > 0);
            assert.strictEqual(result.errors[0]!.code, 'SYNTAX_ERROR');
        });

        it('should parse quoted member traversal without an explicit root marker', () => {
            const tokens = tokenize('"a.b" = 2\nv = ~["a.b"]').tokens;
            const result = parse(tokens);

            assert.strictEqual(result.errors.length, 0);
            const ref = result.document!.bindings[1]!.value;
            if (ref.type === 'CloneReference') {
                assert.deepStrictEqual(ref.path, ['a.b']);
            } else {
                assert.fail(`Expected CloneReference, got ${ref.type}`);
            }
        });

        it('should parse quoted root-member traversal with an explicit dot after $', () => {
            const tokens = tokenize('"a.b" = 2\nv = ~$.["a.b"]').tokens;
            const result = parse(tokens);

            assert.strictEqual(result.errors.length, 0);
            const ref = result.document!.bindings[1]!.value;
            if (ref.type === 'CloneReference') {
                assert.deepStrictEqual(ref.path, ['a.b']);
            } else {
                assert.fail(`Expected CloneReference, got ${ref.type}`);
            }
        });

        it('should parse attribute segments in reference path', () => {
            const tokens = tokenize('a = 1\nv = ~a@meta@["x.y"]').tokens;
            const result = parse(tokens);

            assert.strictEqual(result.errors.length, 0);
            const ref = result.document!.bindings[1]!.value;
            if (ref.type === 'CloneReference') {
                assert.deepStrictEqual(ref.path, ['a', { type: 'attr', key: 'meta' }, { type: 'attr', key: 'x.y' }]);
            } else {
                assert.fail(`Expected CloneReference, got ${ref.type}`);
            }
        });

        it('should reject empty quoted bracket segment in reference path', () => {
            const tokens = tokenize('a = 1\nv = ~[""]').tokens;
            const result = parse(tokens);

            assert.ok(result.errors.length > 0);
            assert.strictEqual(result.errors[0]!.code, 'SYNTAX_ERROR');
        });

        it('should reject empty quoted attribute segment in reference path', () => {
            const tokens = tokenize('a@{meta = 1} = 0\nv = ~a@[""]').tokens;
            const result = parse(tokens);

            assert.ok(result.errors.length > 0);
            assert.strictEqual(result.errors[0]!.code, 'SYNTAX_ERROR');
        });

        it('should parse quoted bracket member segment after dot in reference path', () => {
            const tokens = tokenize('a = { "b.c" = 1 }\nv = ~a.["b.c"]').tokens;
            const result = parse(tokens);

            assert.strictEqual(result.errors.length, 0);
            const ref = result.document!.bindings[1]!.value;
            if (ref.type === 'CloneReference') {
                assert.deepStrictEqual(ref.path, ['a', 'b.c']);
            } else {
                assert.fail(`Expected CloneReference, got ${ref.type}`);
            }
        });

        it('should reject empty quoted bracket member segment after dot in reference path', () => {
            const tokens = tokenize('a = 1\nv = ~a.[""]').tokens;
            const result = parse(tokens);

            assert.ok(result.errors.length > 0);
            assert.strictEqual(result.errors[0]!.code, 'SYNTAX_ERROR');
        });

        it('should parse quoted bracket member segment after attribute selector in reference path', () => {
            const tokens = tokenize('a@{meta = { "x.y" = 1 }} = 0\nv = ~a@meta.["x.y"]').tokens;
            const result = parse(tokens);

            assert.strictEqual(result.errors.length, 0);
            const ref = result.document!.bindings[1]!.value;
            if (ref.type === 'CloneReference') {
                assert.deepStrictEqual(ref.path, ['a', { type: 'attr', key: 'meta' }, 'x.y']);
            } else {
                assert.fail(`Expected CloneReference, got ${ref.type}`);
            }
        });
    });

    describe('integrity envelope', () => {
        it('should parse close:envelope binding as a typed binding', () => {
            const tokens = tokenize('close:envelope = { canonical_hash_alg = "sha-256" }').tokens;
            const result = parse(tokens);

            assert.strictEqual(result.errors.length, 0);
            assert.strictEqual(result.document!.bindings[0]!.key, 'close');
            assert.strictEqual(result.document!.bindings[0]!.datatype?.name, 'envelope');
        });
    });

    describe('special literals', () => {
        it('should parse hex literal', () => {
            const tokens = tokenize('color = #FF00AA').tokens;
            const result = parse(tokens);

            assert.strictEqual(result.errors.length, 0);
            assert.strictEqual(result.document!.bindings[0]!.value.type, 'HexLiteral');
        });

        it('should parse date literal', () => {
            const tokens = tokenize('birthday = 2025-01-01').tokens;
            const result = parse(tokens);

            assert.strictEqual(result.errors.length, 0);
            assert.strictEqual(result.document!.bindings[0]!.value.type, 'DateLiteral');
        });

        it('should parse datetime literal', () => {
            const tokens = tokenize('created = 2025-01-01T10:00:00Z').tokens;
            const result = parse(tokens);

            assert.strictEqual(result.errors.length, 0);
            assert.strictEqual(result.document!.bindings[0]!.value.type, 'DateTimeLiteral');
        });

        it('should parse time literal', () => {
            const tokens = tokenize('opens = 09:30:00').tokens;
            const result = parse(tokens);

            assert.strictEqual(result.errors.length, 0);
            assert.strictEqual(result.document!.bindings[0]!.value.type, 'TimeLiteral');
        });

        it('should parse time literal with timezone offset', () => {
            const tokens = tokenize('opens = 09:30:00+02:40').tokens;
            const result = parse(tokens);

            assert.strictEqual(result.errors.length, 0);
            assert.strictEqual(result.document!.bindings[0]!.value.type, 'TimeLiteral');
        });

        it('should parse separator literal', () => {
            const tokens = tokenize('size:dim[x] = ^300x250').tokens;
            const result = parse(tokens);

            assert.strictEqual(result.errors.length, 0);
            assert.strictEqual(result.document!.bindings[0]!.value.type, 'SeparatorLiteral');
        });

        it('should reject bare caret when a separator literal payload is split by newline', () => {
            const tokens = tokenize('a =\n^\n0.0').tokens;
            const result = parse(tokens);

            assert.ok(result.errors.length > 0);
            assert.strictEqual(result.errors[0]!.code, 'SYNTAX_ERROR');
            assert.match(result.errors[0]!.message, /Separator literals must contain a payload/);
        });

        it('should parse infinity literals', () => {
            const tokens = tokenize('top = Infinity\nbottom = -Infinity').tokens;
            const result = parse(tokens);

            assert.strictEqual(result.errors.length, 0);
            assert.strictEqual(result.document!.bindings[0]!.value.type, 'InfinityLiteral');
            assert.strictEqual(result.document!.bindings[1]!.value.type, 'InfinityLiteral');
        });

        it('should parse nested attribute heads when maxAttributeDepth allows it', () => {
            const tokens = tokenize('f@{ns@{origin:string = "core"}:string = "aeon"}:string = "fractal"').tokens;
            const result = parse(tokens, { maxAttributeDepth: 8 });

            assert.strictEqual(result.errors.length, 0);
            const binding = result.document!.bindings[0]!;
            const attr = binding.attributes[0]!;
            const entry = attr.entries.get('ns');
            assert.ok(entry);
            assert.strictEqual(entry?.attributes.length, 1);
            assert.ok(entry?.attributes[0]?.entries.has('origin'));
        });

        it('should enforce max_attribute_depth for nested attribute heads', () => {
            const tokens = tokenize('f@{ns@{origin:string = "core"}:string = "aeon"}:string = "fractal"').tokens;
            const result = parse(tokens, { maxAttributeDepth: 1 });

            assert.ok(result.errors.length > 0);
            assert.strictEqual(result.errors[0]!.code, 'ATTRIBUTE_DEPTH_EXCEEDED');
        });

        it('should keep semicolon inside raw separator literal payload', () => {
            const tokens = tokenize('line:set[|] = ^0|0|0;0|0').tokens;
            const result = parse(tokens, { maxSeparatorDepth: 8 });

            assert.strictEqual(result.errors.length, 0);
            const value = result.document!.bindings[0]!.value;
            assert.strictEqual(value.type, 'SeparatorLiteral');
            if (value.type === 'SeparatorLiteral') {
                assert.strictEqual(value.value, '0|0|0;0|0');
            }
        });

        it('should allow semicolon inside quoted separator literal payload', () => {
            const tokens = tokenize('line:set[|] = ^"0;0"').tokens;
            const result = parse(tokens, { maxSeparatorDepth: 8 });

            assert.strictEqual(result.errors.length, 0);
            const value = result.document!.bindings[0]!.value;
            assert.strictEqual(value.type, 'SeparatorLiteral');
            if (value.type === 'SeparatorLiteral') {
                assert.strictEqual(value.value, '"0;0"');
            }
        });

        it('should parse chained separator specs', () => {
            const tokens = tokenize('matrix:grid[|][/] = 1').tokens;
            const result = parse(tokens, { maxSeparatorDepth: 8 });

            assert.strictEqual(result.errors.length, 0);
            assert.deepStrictEqual(result.document!.bindings[0]!.datatype!.separators, ['|', '/']);
        });

        it('should parse symbol separator chars', () => {
            const tokens = tokenize('matrix:grid[|][/] = 1').tokens;
            const result = parse(tokens, { maxSeparatorDepth: 8 });

            assert.strictEqual(result.errors.length, 0);
            assert.deepStrictEqual(result.document!.bindings[0]!.datatype!.separators, ['|', '/']);
        });

        it('should reject bracket separator chars', () => {
            const tokens = tokenize('x:set[[] = ^1').tokens;
            const result = parse(tokens);

            assert.ok(result.errors.length > 0);
            assert.strictEqual(result.errors[0]!.code, 'INVALID_SEPARATOR_CHAR');
        });

        it('should reject comma separator chars', () => {
            const tokens = tokenize('x:set[,] = ^1').tokens;
            const result = parse(tokens);

            assert.ok(result.errors.length > 0);
            assert.strictEqual(result.errors[0]!.code, 'INVALID_SEPARATOR_CHAR');
        });

        it('should allow semicolon separator chars', () => {
            const tokens = tokenize('x:t[;] = ^1').tokens;
            const result = parse(tokens);

            assert.strictEqual(result.errors.length, 0);
            assert.deepStrictEqual(result.document!.bindings[0]!.datatype!.separators, [';']);
        });

        it('should keep supported raw separator escapes inside payload', () => {
            const tokens = tokenize('x:t[|] = ^a\\,b\\\\c\\ f').tokens;
            const result = parse(tokens);

            assert.strictEqual(result.errors.length, 0);
            const value = result.document!.bindings[0]!.value;
            assert.strictEqual(value.type, 'SeparatorLiteral');
            if (value.type === 'SeparatorLiteral') {
                assert.strictEqual(value.value, 'a\\,b\\\\c\\ f');
            }
        });

        it('should reject multi-character separator specs', () => {
            const tokens = tokenize('x:set[ab] = ^1').tokens;
            const result = parse(tokens);

            assert.ok(result.errors.length > 0);
            assert.strictEqual(result.errors[0]!.code, 'SYNTAX_ERROR');
        });

        it('should accept single-digit separator specs', () => {
            const tokens = tokenize('x:t[2] = ^a2b').tokens;
            const result = parse(tokens);

            assert.strictEqual(result.errors.length, 0);
            assert.deepStrictEqual(result.document!.bindings[0]!.datatype!.separators, ['2']);
        });

        it('should enforce max_separator_depth policy', () => {
            const tokens = tokenize('matrix:grid[|][/] = 1').tokens;
            const result = parse(tokens, { maxSeparatorDepth: 1 });

            assert.ok(result.errors.length > 0);
            assert.strictEqual(result.errors[0]!.code, 'SEPARATOR_DEPTH_EXCEEDED');
        });

        it('should reject reserved boundary chars in custom bracket specs before depth checks', () => {
            const tokens = tokenize('badSepType1:matrix[,][;] = ^1,2,3;4,5,6').tokens;
            const result = parse(tokens, { maxSeparatorDepth: 1 });

            assert.ok(result.errors.length > 0);
            assert.strictEqual(result.errors[0]!.code, 'INVALID_SEPARATOR_CHAR');
        });

        it('should parse radix base brackets', () => {
            const tokens = tokenize('mask:radix[10] = %19').tokens;
            const result = parse(tokens, { maxSeparatorDepth: 8 });

            assert.strictEqual(result.errors.length, 0);
            assert.strictEqual(result.document!.bindings[0]!.datatype!.name, 'radix');
            assert.strictEqual(result.document!.bindings[0]!.datatype!.radixBase, 10);
            assert.deepStrictEqual(result.document!.bindings[0]!.datatype!.separators, []);
        });

        it('should treat uppercase Radix brackets as custom datatype specs', () => {
            const tokens = tokenize('mask:Radix[10] = %19').tokens;
            const result = parse(tokens, { maxSeparatorDepth: 8 });

            assert.strictEqual(result.errors.length, 0);
            assert.strictEqual(result.document!.bindings[0]!.datatype!.name, 'Radix');
            assert.strictEqual(result.document!.bindings[0]!.datatype!.radixBase, null);
            assert.deepStrictEqual(result.document!.bindings[0]!.datatype!.separators, ['10']);
        });

        it('should reject radix generic parameter syntax', () => {
            const tokens = tokenize('mask:radix<10> = %19').tokens;
            const result = parse(tokens);

            assert.ok(result.errors.length > 0);
            assert.strictEqual(result.errors[0]!.code, 'SYNTAX_ERROR');
        });

        it('should reject radix base values outside 2..64', () => {
            const tokens = tokenize('mask:radix[65] = %19').tokens;
            const result = parse(tokens);

            assert.ok(result.errors.length > 0);
            assert.strictEqual(result.errors[0]!.code, 'SYNTAX_ERROR');
        });

        it('should reject empty radix base brackets', () => {
            const tokens = tokenize('mask:radix[] = %19').tokens;
            const result = parse(tokens);

            assert.ok(result.errors.length > 0);
            assert.strictEqual(result.errors[0]!.code, 'SYNTAX_ERROR');
        });

        it('should reject radix base brackets with leading zeroes', () => {
            const tokens = tokenize('mask:radix[03] = %19').tokens;
            const result = parse(tokens);

            assert.ok(result.errors.length > 0);
            assert.strictEqual(result.errors[0]!.code, 'SYNTAX_ERROR');
        });

        it('should reject non-decimal radix base brackets', () => {
            const tokens = tokenize('mask:radix[a] = %19').tokens;
            const result = parse(tokens);

            assert.ok(result.errors.length > 0);
            assert.strictEqual(result.errors[0]!.code, 'SYNTAX_ERROR');
        });

        it('should reject extra radix brackets after the base specifier', () => {
            const tokens = tokenize('mask:radix[2][2] = %19').tokens;
            const result = parse(tokens);

            assert.ok(result.errors.length > 0);
            assert.strictEqual(result.errors[0]!.code, 'SYNTAX_ERROR');
        });

        it('should reject meaningless generics on reserved scalar datatypes', () => {
            const tokens = tokenize('a:n<string> = 3').tokens;
            const result = parse(tokens);

            assert.ok(result.errors.length > 0);
            assert.strictEqual(result.errors[0]!.code, 'SYNTAX_ERROR');
        });

        it('should reject meaningless generics on reserved boolean datatypes', () => {
            const tokens = tokenize('b:boolean<switch> = true').tokens;
            const result = parse(tokens);

            assert.ok(result.errors.length > 0);
            assert.strictEqual(result.errors[0]!.code, 'SYNTAX_ERROR');
        });

        it('should reject meaningless brackets on reserved scalar datatypes', () => {
            const tokens = tokenize('b:string[333] = "hello world"').tokens;
            const result = parse(tokens);

            assert.ok(result.errors.length > 0);
            assert.strictEqual(result.errors[0]!.code, 'SYNTAX_ERROR');
        });

        it('should reject brackets on fixed-base radix aliases', () => {
            const tokens = tokenize('r:radix2[4] = %111').tokens;
            const result = parse(tokens);

            assert.ok(result.errors.length > 0);
            assert.strictEqual(result.errors[0]!.code, 'SYNTAX_ERROR');
        });
    });

    // ============================================
    // ERROR CASE TESTS
    // ============================================

    describe('syntax errors', () => {
        it('should error on missing equals', () => {
            const tokens = tokenize('name "Patrik"').tokens;
            const result = parse(tokens);

            assert.ok(result.errors.length > 0);
            assert.strictEqual(result.errors[0]!.code, 'SYNTAX_ERROR');
        });

        it('should error on missing value', () => {
            const tokens = tokenize('name =').tokens;
            const result = parse(tokens);

            assert.ok(result.errors.length > 0);
        });

        it('should error on unterminated object', () => {
            const tokens = tokenize('config = { name = "test"').tokens;
            const result = parse(tokens);

            assert.ok(result.errors.length > 0);
            assert.strictEqual(result.errors[0]!.code, 'SYNTAX_ERROR');
        });

        it('should error on unterminated list', () => {
            const tokens = tokenize('items = [1, 2, 3').tokens;
            const result = parse(tokens);

            assert.ok(result.errors.length > 0);
        });
    });

    describe('duplicate key errors', () => {
        it('should error on duplicate key in object', () => {
            const tokens = tokenize('config = { a = 1, a = 2 }').tokens;
            const result = parse(tokens);

            assert.ok(result.errors.length > 0);
            assert.strictEqual(result.errors[0]!.code, 'DUPLICATE_KEY');
        });

        it('should allow same key in different objects', () => {
            const tokens = tokenize('a = { x = 1 }\nb = { x = 2 }').tokens;
            const result = parse(tokens);

            assert.strictEqual(result.errors.length, 0);
        });
    });

    describe('node syntax', () => {
        it('should reject invalid non-introducer node syntax', () => {
            const tokens = tokenize('item = tag < ("x")').tokens;
            const result = parse(tokens);

            assert.ok(result.errors.length > 0);
            assert.strictEqual(result.errors[0]!.code, 'SYNTAX_ERROR');
        });

        it('should parse introducer node syntax', () => {
            const tokens = tokenize('item = <tag("x", ~a)>').tokens;
            const result = parse(tokens);

            assert.strictEqual(result.errors.length, 0);
            const value = result.document!.bindings[0]!.value;
            assert.strictEqual(value.type, 'NodeLiteral');
            if (value.type === 'NodeLiteral') {
                assert.strictEqual(value.tag, 'tag');
                assert.strictEqual(value.children.length, 2);
            }
        });

        it('should reject same-line node children without comma separation', () => {
            const tokens = tokenize('item = <tag("x" ~a)>').tokens;
            const result = parse(tokens);

            assert.ok(result.errors.length > 0);
            assert.strictEqual(result.errors[0]!.code, 'SYNTAX_ERROR');
        });

        it('should parse empty node shorthand', () => {
            const tokens = tokenize('item = <tag>').tokens;
            const result = parse(tokens);

            assert.strictEqual(result.errors.length, 0);
            const value = result.document!.bindings[0]!.value;
            assert.strictEqual(value.type, 'NodeLiteral');
            if (value.type === 'NodeLiteral') {
                assert.strictEqual(value.tag, 'tag');
                assert.strictEqual(value.children.length, 0);
            }
        });

        it('should parse empty attributed node shorthand', () => {
            const tokens = tokenize('item = <span@{id="text"}:node>').tokens;
            const result = parse(tokens);

            assert.strictEqual(result.errors.length, 0);
            const value = result.document!.bindings[0]!.value;
            assert.strictEqual(value.type, 'NodeLiteral');
            if (value.type === 'NodeLiteral') {
                assert.strictEqual(value.attributes.length, 1);
                assert.strictEqual(value.datatype?.name, 'node');
                assert.strictEqual(value.children.length, 0);
            }
        });

        it('should reject node syntax without a trailing closing angle', () => {
            const tokens = tokenize('item = <tag("x")').tokens;
            const result = parse(tokens);

            assert.ok(result.errors.length > 0);
            assert.strictEqual(result.errors[0]!.code, 'SYNTAX_ERROR');
        });

        it('should parse node attributes and inline node datatype', () => {
            const tokens = tokenize('item = <span@{id="text"}:node("hello")>').tokens;
            const result = parse(tokens);

            assert.strictEqual(result.errors.length, 0);
            const value = result.document!.bindings[0]!.value;
            assert.strictEqual(value.type, 'NodeLiteral');
            if (value.type === 'NodeLiteral') {
                assert.strictEqual(value.attributes.length, 1);
                assert.strictEqual(value.datatype?.name, 'node');
            }
        });

        it('should reject generic inline node head datatypes', () => {
            const tokens = tokenize('item = <tag:pair<int32,string>("x")>').tokens;
            const result = parse(tokens);

            assert.ok(result.errors.length > 0);
            assert.match(result.errors[0]!.message, /Node head datatypes must be simple labels/);
        });

        it('should reject separator-spec inline node head datatypes', () => {
            const tokens = tokenize('item = <tag:contact[x]("x")>').tokens;
            const result = parse(tokens);

            assert.ok(result.errors.length > 0);
            assert.match(result.errors[0]!.message, /Node head datatypes must be simple labels/);
        });
    });

    describe('span tracking', () => {
        it('should include span on parse errors', () => {
            const tokens = tokenize('name "missing equals"').tokens;
            const result = parse(tokens);

            assert.ok(result.errors.length > 0);
            assert.ok(result.errors[0]!.span);
            assert.ok(result.errors[0]!.span.start.line >= 1);
        });

        it('should track spans on AST nodes', () => {
            const tokens = tokenize('name = "test"').tokens;
            const result = parse(tokens);

            assert.ok(result.document);
            assert.ok(result.document.bindings[0]!.span);
            assert.strictEqual(result.document.bindings[0]!.span.start.line, 1);
        });
    });
});

describe('Parser (contract)', () => {
    it('parser stub returns null document and empty errors', () => {
        const tokens = tokenize('').tokens;
        const result = parse(tokens);
        // Current parser returns an empty Document (no bindings) rather than null.
        // Assert the current contract: empty document and no errors.
        assert.ok(result.document);
        assert.strictEqual(result.document!.bindings.length, 0);
        assert.strictEqual(result.errors.length, 0);
    });
});
