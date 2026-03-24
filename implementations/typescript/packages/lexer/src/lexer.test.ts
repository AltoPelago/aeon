import { describe, it } from 'node:test';
import assert from 'node:assert';
import { tokenize, TokenType } from './index.js';

describe('Lexer', () => {
    describe('basic tokens', () => {
        it('should tokenize empty input', () => {
            const result = tokenize('');
            assert.strictEqual(result.tokens.length, 1);
            assert.strictEqual(result.tokens[0]!.type, TokenType.EOF);
            assert.strictEqual(result.errors.length, 0);
        });

        it('should tokenize structural tokens', () => {
            const result = tokenize('{}[]()');
            const types = result.tokens.map(t => t.type);
            assert.deepStrictEqual(types, [
                TokenType.LeftBrace,
                TokenType.RightBrace,
                TokenType.LeftBracket,
                TokenType.RightBracket,
                TokenType.LeftParen,
                TokenType.RightParen,
                TokenType.EOF,
            ]);
        });

        it('should tokenize operators', () => {
            const result = tokenize('= : , . @ ~ ~>');
            const types = result.tokens.map(t => t.type);
            assert.deepStrictEqual(types, [
                TokenType.Equals,
                TokenType.Colon,
                TokenType.Comma,
                TokenType.Dot,
                TokenType.At,
                TokenType.Tilde,
                TokenType.TildeArrow,
                TokenType.EOF,
            ]);
        });

        it('should tokenize printable symbols not reserved as core tokens', () => {
            const result = tokenize('| / +');
            const tokens = result.tokens.filter(t => t.type !== TokenType.EOF);
            assert.deepStrictEqual(tokens.map(t => t.type), [
                TokenType.Symbol,
                TokenType.Symbol,
                TokenType.Symbol,
            ]);
            assert.deepStrictEqual(tokens.map(t => t.value), ['|', '/', '+']);
        });
    });

    describe('identifiers and keywords', () => {
        it('should tokenize identifiers', () => {
            const result = tokenize('foo bar_baz test123');
            const tokens = result.tokens.filter(t => t.type === TokenType.Identifier);
            assert.strictEqual(tokens.length, 3);
            assert.strictEqual(tokens[0]!.value, 'foo');
            assert.strictEqual(tokens[1]!.value, 'bar_baz');
            assert.strictEqual(tokens[2]!.value, 'test123');
        });

        it('should tokenize boolean keywords', () => {
            const result = tokenize('true false');
            assert.strictEqual(result.tokens[0]!.type, TokenType.True);
            assert.strictEqual(result.tokens[1]!.type, TokenType.False);
        });

        it('should tokenize switch keywords', () => {
            const result = tokenize('yes no on off');
            const types = result.tokens.slice(0, 4).map(t => t.type);
            assert.deepStrictEqual(types, [
                TokenType.Yes,
                TokenType.No,
                TokenType.On,
                TokenType.Off,
            ]);
        });
    });

    describe('string literals', () => {
        it('should tokenize double-quoted strings', () => {
            const result = tokenize('"hello world"');
            assert.strictEqual(result.tokens[0]!.type, TokenType.String);
            assert.strictEqual(result.tokens[0]!.value, 'hello world');
        });

        it('should tokenize single-quoted strings', () => {
            const result = tokenize("'hello'");
            assert.strictEqual(result.tokens[0]!.type, TokenType.String);
            assert.strictEqual(result.tokens[0]!.value, 'hello');
        });

        it('should tokenize backtick strings with newlines', () => {
            const result = tokenize('`line1\nline2`');
            assert.strictEqual(result.tokens[0]!.type, TokenType.String);
            assert.strictEqual(result.tokens[0]!.value, 'line1\nline2');
        });

        it('should handle escapes inside backtick strings', () => {
            const result = tokenize('`\\``');
            assert.strictEqual(result.tokens[0]!.type, TokenType.String);
            assert.strictEqual(result.tokens[0]!.value, '`');
        });

        it('should handle escape sequences', () => {
            const result = tokenize('"hello\\nworld\\t!"');
            assert.strictEqual(result.tokens[0]!.value, 'hello\nworld\t!');
        });

        it('should handle unicode escapes', () => {
            const result = tokenize('"\\u0041"');
            assert.strictEqual(result.tokens[0]!.value, 'A');
        });

        it('should handle extended unicode escapes', () => {
            const result = tokenize('"\\u{1F600}"');
            assert.strictEqual(result.tokens[0]!.value, '😀');
        });
    });

    describe('numeric literals', () => {
        it('should tokenize integers', () => {
            const result = tokenize('42 0 123');
            const tokens = result.tokens.filter(t => t.type === TokenType.Number);
            assert.strictEqual(tokens.length, 3);
            assert.strictEqual(tokens[0]!.value, '42');
            assert.strictEqual(tokens[1]!.value, '0');
            assert.strictEqual(tokens[2]!.value, '123');
        });

        it('should tokenize decimals', () => {
            const result = tokenize('3.14 0.5 .5');
            const tokens = result.tokens.filter(t => t.type === TokenType.Number);
            assert.strictEqual(tokens[0]!.value, '3.14');
            assert.strictEqual(tokens[1]!.value, '0.5');
            assert.strictEqual(tokens[2]!.value, '.5');
        });

        it('should tokenize exponents', () => {
            const result = tokenize('1e10 3.14e-2');
            const tokens = result.tokens.filter(t => t.type === TokenType.Number);
            assert.strictEqual(tokens[0]!.value, '1e10');
            assert.strictEqual(tokens[1]!.value, '3.14e-2');
        });

        it('should allow underscore separators', () => {
            const result = tokenize('1_000_000');
            assert.strictEqual(result.tokens[0]!.value, '1_000_000');
        });

        it('should tokenize negative numbers', () => {
            const result = tokenize('-42 -3.14 -.5 +.5');
            const tokens = result.tokens.filter(t => t.type === TokenType.Number);
            assert.strictEqual(tokens[0]!.value, '-42');
            assert.strictEqual(tokens[1]!.value, '-3.14');
            assert.strictEqual(tokens[2]!.value, '-.5');
            assert.strictEqual(tokens[3]!.value, '+.5');
        });
    });

    describe('special literals', () => {
        it('should tokenize hex literals', () => {
            const result = tokenize('#FF00AA');
            assert.strictEqual(result.tokens[0]!.type, TokenType.HexLiteral);
            assert.strictEqual(result.tokens[0]!.value, '#FF00AA');
        });

        it('should tokenize radix literals', () => {
            const result = tokenize('%1011');
            assert.strictEqual(result.tokens[0]!.type, TokenType.RadixLiteral);
            assert.strictEqual(result.tokens[0]!.value, '%1011');
        });

        it('should tokenize radix literals with sign, decimal, underscores, and extended digits', () => {
            const result = tokenize('%+9&.!');
            assert.strictEqual(result.tokens[0]!.type, TokenType.RadixLiteral);
            assert.strictEqual(result.tokens[0]!.value, '%+9&.!');
        });

        it('should terminate radix literals at non-radix boundary characters', () => {
            for (const source of ['%1/2', '%1=2']) {
                const result = tokenize(source);
                assert.strictEqual(result.errors.length, 0, source);
                assert.strictEqual(result.tokens[0]!.type, TokenType.RadixLiteral, source);
                assert.strictEqual(result.tokens[0]!.value, '%1', source);
            }
        });

        it('should reject invalid radix underscore and decimal placement', () => {
            for (const source of ['%1_', '%1__1', '%1.']) {
                const result = tokenize(source);
                assert.strictEqual(result.errors.length, 1, source);
            }
        });

        it('should treat invalid radix starts as ordinary tokens', () => {
            for (const source of ['%_1', '%.1']) {
                const result = tokenize(source);
                assert.strictEqual(result.errors.length, 0, source);
                assert.strictEqual(result.tokens[0]!.type, TokenType.Percent, source);
            }
        });

        it('should tokenize encoding literals', () => {
            const result = tokenize('$QmFzZTY0IQ==');
            assert.strictEqual(result.tokens[0]!.type, TokenType.EncodingLiteral);
            assert.strictEqual(result.tokens[0]!.value, '$QmFzZTY0IQ==');
        });

        it('should tokenize encoding literals in standard and url-safe base64 alphabets', () => {
            const result = tokenize('$abc-_+/==');
            assert.strictEqual(result.tokens[0]!.type, TokenType.EncodingLiteral);
            assert.strictEqual(result.tokens[0]!.value, '$abc-_+/==');
        });

        it('should tokenize encoding literals with the shared lexical-envelope characters', () => {
            const result = tokenize('$abc-._==');
            assert.strictEqual(result.tokens[0]!.type, TokenType.EncodingLiteral);
            assert.strictEqual(result.tokens[0]!.value, '$abc-._==');
        });

        it('should terminate encoding literals at non-encoding boundary characters', () => {
            const result = tokenize('$abc,');
            assert.strictEqual(result.errors.length, 0);
            assert.strictEqual(result.tokens[0]!.type, TokenType.EncodingLiteral);
            assert.strictEqual(result.tokens[0]!.value, '$abc');
        });

        it('should reject invalid encoding start and padding placement', () => {
            const badPadding = tokenize('$abc=a=');
            assert.strictEqual(badPadding.errors.length, 1);

            const badStart = tokenize('$=abc');
            assert.strictEqual(badStart.errors.length, 0);
            assert.strictEqual(badStart.tokens[0]!.type, TokenType.Dollar);
        });

        it('should tokenize standalone $ as Dollar', () => {
            const result = tokenize('$');
            assert.strictEqual(result.tokens[0]!.type, TokenType.Dollar);
        });

        it('should keep root-qualified paths distinct from encoding literals', () => {
            const result = tokenize('~$.a.b');
            assert.strictEqual(result.tokens[0]!.type, TokenType.Tilde);
            assert.strictEqual(result.tokens[1]!.type, TokenType.Dollar);
            assert.strictEqual(result.tokens[2]!.type, TokenType.Dot);
            assert.strictEqual(result.tokens[3]!.type, TokenType.Identifier);
            assert.strictEqual(result.tokens[3]!.value, 'a');
        });

        it('should tokenize separator literals', () => {
            const result = tokenize('^300x250');
            assert.strictEqual(result.tokens[0]!.type, TokenType.SeparatorLiteral);
            assert.strictEqual(result.tokens[0]!.value, '^300x250');
        });

        it('should terminate separator literal on structural comma', () => {
            const result = tokenize('^one,two');
            assert.strictEqual(result.tokens[0]!.type, TokenType.SeparatorLiteral);
            assert.strictEqual(result.tokens[0]!.value, '^one');
            assert.strictEqual(result.tokens[1]!.type, TokenType.Comma);
            assert.strictEqual(result.tokens[2]!.type, TokenType.Identifier);
            assert.strictEqual(result.tokens[2]!.value, 'two');
        });

        it('should keep semicolon inside raw separator payload', () => {
            const result = tokenize('^one;two');
            assert.strictEqual(result.tokens[0]!.type, TokenType.SeparatorLiteral);
            assert.strictEqual(result.tokens[0]!.value, '^one;two');
            assert.strictEqual(result.tokens[1]!.type, TokenType.EOF);
        });

        it('should keep semicolon inside quoted separator payload', () => {
            const result = tokenize("^'one;two'");
            assert.strictEqual(result.tokens[0]!.type, TokenType.SeparatorLiteral);
            assert.strictEqual(result.tokens[0]!.value, "^'one;two'");
            assert.strictEqual(result.tokens[1]!.type, TokenType.EOF);
        });
    });

    describe('date/time literals', () => {
        it('should tokenize date literals', () => {
            const result = tokenize('2025-01-01');
            assert.strictEqual(result.tokens[0]!.type, TokenType.Date);
            assert.strictEqual(result.tokens[0]!.value, '2025-01-01');
        });

        it('should tokenize datetime literals', () => {
            const result = tokenize('2025-01-01T10:00:00Z');
            assert.strictEqual(result.tokens[0]!.type, TokenType.DateTime);
            assert.strictEqual(result.tokens[0]!.value, '2025-01-01T10:00:00Z');
        });

        it('should tokenize time literals', () => {
            const result = tokenize('09:30:00');
            assert.strictEqual(result.tokens[0]!.type, TokenType.Time);
            assert.strictEqual(result.tokens[0]!.value, '09:30:00');
        });

        it('should tokenize time literals with timezone offsets', () => {
            const result = tokenize('09:30:00+02:40');
            assert.strictEqual(result.tokens[0]!.type, TokenType.Time);
            assert.strictEqual(result.tokens[0]!.value, '09:30:00+02:40');
        });

        it('should tokenize reduced-precision zoned time literals', () => {
            for (const source of ['09:30Z', '09:+02:00', '09:30+02:00']) {
                const result = tokenize(source);
                assert.strictEqual(result.errors.length, 0, source);
                assert.strictEqual(result.tokens[0]!.type, TokenType.Time, source);
                assert.strictEqual(result.tokens[0]!.value, source, source);
            }
        });

        it('should tokenize reduced-precision zoned datetime literals', () => {
            for (const source of [
                '2025-01-01T09Z',
                '2025-01-01T09+02:00',
                '2025-01-01T09:30Z',
                '2025-01-01T09:30+02:00',
                '2025-01-01T09:+02:00',
            ]) {
                const result = tokenize(source);
                assert.strictEqual(result.errors.length, 0, source);
                assert.strictEqual(result.tokens[0]!.type, TokenType.DateTime, source);
                assert.strictEqual(result.tokens[0]!.value, source, source);
            }
        });

        it('should tokenize reduced-precision zrut datetime literals', () => {
            for (const source of [
                '2025-01-01T09&Europe/Belgium/Brussels',
                '2025-01-01T09Z&Europe/Belgium/Brussels',
                '2025-01-01T09+02:00&Europe/Belgium/Brussels',
                '2025-01-01T09:30&Europe/Belgium/Brussels',
                '2025-01-01T09:30Z&Europe/Belgium/Brussels',
                '2025-01-01T09:30+02:00&Europe/Belgium/Brussels',
                '2025-01-01T09:+02:00&Europe/Belgium/Brussels',
                '2025-01-01T09:30Z&Local',
            ]) {
                const result = tokenize(source);
                assert.strictEqual(result.errors.length, 0, source);
                assert.strictEqual(result.tokens[0]!.type, TokenType.DateTime, source);
                assert.strictEqual(result.tokens[0]!.value, source, source);
            }
        });

        it('should accept valid leap-day and bounded temporal literals', () => {
            for (const source of ['09:', '09:30', '23:59:59', '2024-02-29', '2024-02-29T09:30:00']) {
                const result = tokenize(source);
                assert.strictEqual(result.errors.length, 0, source);
                assert.notStrictEqual(result.tokens[0]!.type, TokenType.EOF, source);
            }
        });

        it('should reject temporal literals with invalid ranges', () => {
            for (const source of [
                '24:00',
                '99:99',
                '23:59:60',
                '09:+24:99',
                '2025-01-01T09:+24:99',
                '2025-13-40',
                '2025-02-29',
                '2025-13-40T99:99:99',
                '2025-02-29T09:30:00',
                '2025-01-01T09:30Z&/',
                '2025-01-01T09:30Z&Europe//Brussels',
                '2025-01-01T09:30Z&Europe/Belgium/',
            ]) {
                const result = tokenize(source);
                assert.strictEqual(result.errors.length, 1, source);
                assert.strictEqual(result.tokens[0]!.type, TokenType.EOF, source);
            }
        });

        it('should report temporal-specific codes for invalid temporal literals', () => {
            const cases: Array<[string, string]> = [
                ['2025-13-40', 'INVALID_DATE'],
                ['2025-02-29', 'INVALID_DATE'],
                ['24:00', 'INVALID_TIME'],
                ['2025-13-40T99:99:99', 'INVALID_DATETIME'],
                ['2025-01-01T09:30Z&/', 'INVALID_DATETIME'],
            ];
            for (const [source, expectedCode] of cases) {
                const result = tokenize(source);
                assert.strictEqual(result.errors.length, 1, source);
                assert.strictEqual(result.errors[0]!.code, expectedCode, source);
            }
        });

        it('should not treat lowercase z as a timezone marker', () => {
            for (const source of ['09:30z', '2025-01-01T09z', '2025-01-01T09:30z']) {
                const result = tokenize(source);
                assert.strictEqual(result.errors.length, 0, source);
                assert.notStrictEqual(result.tokens[0]!.type, TokenType.EOF, source);
                assert.strictEqual(result.tokens.at(-2)!.type, TokenType.Identifier, source);
                assert.strictEqual(result.tokens.at(-2)!.value, 'z', source);
            }
        });

        it('should tokenize ZRUT literals', () => {
            const result = tokenize('2025-12-02T02:00:00Z&Asia/Tokyo');
            assert.strictEqual(result.tokens[0]!.type, TokenType.DateTime);
            assert.strictEqual(result.tokens[0]!.value, '2025-12-02T02:00:00Z&Asia/Tokyo');
        });

        it('accepts ZRUT zones with slash-separated non-empty segments', () => {
            const result = tokenize('2025-01-01T00:00:00Z&Europe/Belgium/Brussels');
            assert.strictEqual(result.errors.length, 0);
            assert.strictEqual(result.tokens[0]!.type, TokenType.DateTime);
            assert.strictEqual(result.tokens[0]!.value, '2025-01-01T00:00:00Z&Europe/Belgium/Brussels');
        });

        it('rejects ZRUT zones that start with a slash', () => {
            const result = tokenize('2025-01-01T00:00:00Z&/Belgium/Brussels');
            assert.strictEqual(result.errors.length, 1);
            assert.strictEqual(result.tokens[0]!.type, TokenType.EOF);
        });

        it('rejects ZRUT zones that end with a slash', () => {
            const result = tokenize('2025-01-01T00:00:00Z&Europe/Belgium/');
            assert.strictEqual(result.errors.length, 1);
            assert.strictEqual(result.tokens[0]!.type, TokenType.EOF);
        });

        it('rejects ZRUT zones with double slashes', () => {
            const result = tokenize('2025-01-01T00:00:00Z&Belgium//Brussels');
            assert.strictEqual(result.errors.length, 1);
            assert.strictEqual(result.tokens[0]!.type, TokenType.EOF);
        });
    });

    describe('comments', () => {
        it('should skip line comments by default', () => {
            const result = tokenize('foo // comment\nbar');
            const identifiers = result.tokens.filter(t => t.type === TokenType.Identifier);
            assert.strictEqual(identifiers.length, 2);
        });

        it('should include comments when option is set', () => {
            const result = tokenize('foo // comment', { includeComments: true });
            assert.ok(result.tokens.some(t => t.type === TokenType.LineComment));
        });

        it('should handle block comments', () => {
            const result = tokenize('foo /* block */ bar');
            const identifiers = result.tokens.filter(t => t.type === TokenType.Identifier);
            assert.strictEqual(identifiers.length, 2);
        });

        it('should classify structured line comment channels', () => {
            const result = tokenize('//! host\n//# doc\n//@ ann\n//? hint\n//{ structure\n//[ profile\n//( instructions\n// plain', {
                includeComments: true,
            });
            const comments = result.tokens.filter(t => t.type === TokenType.LineComment);
            const channels = comments.map(t => t.comment?.channel);
            assert.deepStrictEqual(channels, [
                'host',
                'doc',
                'annotation',
                'hint',
                'reserved',
                'reserved',
                'reserved',
                'plain',
            ]);
            assert.strictEqual(comments[4]?.comment?.subtype, 'structure');
            assert.strictEqual(comments[5]?.comment?.subtype, 'profile');
            assert.strictEqual(comments[6]?.comment?.subtype, 'instructions');
        });

        it('should accept a leading shebang as a plain first-line comment', () => {
            const result = tokenize('#!/usr/bin/env aeon\nvalue = 1', { includeComments: true });
            const comments = result.tokens.filter(t => t.type === TokenType.LineComment);
            const identifiers = result.tokens.filter(t => t.type === TokenType.Identifier);

            assert.strictEqual(result.errors.length, 0);
            assert.strictEqual(comments.length, 1);
            assert.strictEqual(comments[0]?.value, '#!/usr/bin/env aeon');
            assert.strictEqual(comments[0]?.comment?.channel, 'plain');
            assert.deepStrictEqual(identifiers.map(token => token.value), ['value']);
        });

        it('should classify //! as host on the second line when preceded by a leading shebang', () => {
            const result = tokenize('#!/usr/bin/env aeon\n//! format:aeon.test.v1\nvalue = 1', {
                includeComments: true,
            });
            const comments = result.tokens.filter(t => t.type === TokenType.LineComment);

            assert.strictEqual(result.errors.length, 0);
            assert.strictEqual(comments[0]?.comment?.channel, 'plain');
            assert.strictEqual(comments[1]?.comment?.channel, 'host');
        });

        it('should treat //! as plain when it appears after the allowed file-header slot', () => {
            const result = tokenize('a = 1\n//! late host', { includeComments: true });
            const comments = result.tokens.filter(t => t.type === TokenType.LineComment);

            assert.strictEqual(result.errors.length, 0);
            assert.strictEqual(comments.length, 1);
            assert.strictEqual(comments[0]?.comment?.channel, 'plain');
        });

        it('should classify slash-channel structured block comment channels', () => {
            const result = tokenize('/# doc #/ /@ ann @/ /? hint ?/ /{ s }/ /[ p ]/ /( f )/ /* plain */', {
                includeComments: true,
            });
            const comments = result.tokens.filter(t => t.type === TokenType.BlockComment);
            const channels = comments.map(t => t.comment?.channel);
            assert.deepStrictEqual(channels, [
                'doc',
                'annotation',
                'hint',
                'reserved',
                'reserved',
                'reserved',
                'plain',
            ]);
            assert.strictEqual(comments[3]?.comment?.subtype, 'structure');
            assert.strictEqual(comments[4]?.comment?.subtype, 'profile');
            assert.strictEqual(comments[5]?.comment?.subtype, 'instructions');
        });

        it('should treat plain block comments as plain', () => {
            const result = tokenize('/* doc */ /* ann */ /* hint */', { includeComments: true });
            const comments = result.tokens.filter(t => t.type === TokenType.BlockComment);
            assert.deepStrictEqual(comments.map((t) => t.comment?.channel), ['plain', 'plain', 'plain']);
        });
    });

    describe('span tracking', () => {
        it('should track correct line and column', () => {
            const result = tokenize('foo\nbar');
            const tokens = result.tokens.filter(t => t.type === TokenType.Identifier);

            assert.strictEqual(tokens[0]!.span.start.line, 1);
            assert.strictEqual(tokens[0]!.span.start.column, 1);

            assert.strictEqual(tokens[1]!.span.start.line, 2);
            assert.strictEqual(tokens[1]!.span.start.column, 1);
        });
    });

    describe('complete binding', () => {
        it('should tokenize a complete binding', () => {
            const result = tokenize('name = "Patrik"');
            const types = result.tokens.map(t => t.type);
            assert.deepStrictEqual(types, [
                TokenType.Identifier,
                TokenType.Equals,
                TokenType.String,
                TokenType.EOF,
            ]);
        });

        it('should tokenize typed binding', () => {
            const result = tokenize('age:int32 = 49');
            const types = result.tokens.map(t => t.type);
            assert.deepStrictEqual(types, [
                TokenType.Identifier,
                TokenType.Colon,
                TokenType.Identifier,
                TokenType.Equals,
                TokenType.Number,
                TokenType.EOF,
            ]);
        });

        it('should tokenize reference', () => {
            const result = tokenize('b = ~a');
            const types = result.tokens.map(t => t.type);
            assert.deepStrictEqual(types, [
                TokenType.Identifier,
                TokenType.Equals,
                TokenType.Tilde,
                TokenType.Identifier,
                TokenType.EOF,
            ]);
        });

        it('should tokenize pointer reference', () => {
            const result = tokenize('b = ~>a');
            const types = result.tokens.map(t => t.type);
            assert.deepStrictEqual(types, [
                TokenType.Identifier,
                TokenType.Equals,
                TokenType.TildeArrow,
                TokenType.Identifier,
                TokenType.EOF,
            ]);
        });
    });

    // ============================================
    // SPEC CONFORMANCE TESTS (Red Team Review)
    // ============================================

    describe('numeric underscore validation', () => {
        it('should accept valid underscore separators', () => {
            const result = tokenize('1_000_000');
            assert.strictEqual(result.errors.length, 0);
            assert.strictEqual(result.tokens[0]!.value, '1_000_000');
        });

        it('should accept underscores in decimal part', () => {
            const result = tokenize('3.14_15_92');
            assert.strictEqual(result.errors.length, 0);
            assert.strictEqual(result.tokens[0]!.value, '3.14_15_92');
        });

        it('should accept underscores in exponent digits', () => {
            const result = tokenize('1e1_0');
            assert.strictEqual(result.errors.length, 0);
            assert.strictEqual(result.tokens[0]!.value, '1e1_0');
        });

        it('should accept underscores across mantissa and exponent digits', () => {
            const result = tokenize('1_1_1.2_2e3_3');
            assert.strictEqual(result.errors.length, 0);
            assert.strictEqual(result.tokens[0]!.value, '1_1_1.2_2e3_3');
        });

        it('should reject trailing underscore: 1_', () => {
            const result = tokenize('1_');
            assert.strictEqual(result.errors.length, 1);
            assert.strictEqual(result.errors[0]!.code, 'INVALID_NUMBER');
        });

        it('should reject underscore before decimal: 1_.2', () => {
            const result = tokenize('1_.2');
            assert.strictEqual(result.errors.length, 1);
            assert.strictEqual(result.errors[0]!.code, 'INVALID_NUMBER');
        });

        it('should reject underscore after decimal: 1._2', () => {
            const result = tokenize('1._2');
            assert.strictEqual(result.errors.length, 1);
            assert.strictEqual(result.errors[0]!.code, 'INVALID_NUMBER');
        });

        it('should reject underscore after exponent: 1e_10', () => {
            const result = tokenize('1e_10');
            assert.strictEqual(result.errors.length, 1);
            assert.strictEqual(result.errors[0]!.code, 'INVALID_NUMBER');
        });

        it('should reject underscore after exponent sign: 1e+_10', () => {
            const result = tokenize('1e+_10');
            assert.strictEqual(result.errors.length, 1);
            assert.strictEqual(result.errors[0]!.code, 'INVALID_NUMBER');
        });

        it('should reject consecutive underscores: 1__0', () => {
            const result = tokenize('1__0');
            assert.strictEqual(result.errors.length, 1);
            assert.strictEqual(result.errors[0]!.code, 'INVALID_NUMBER');
        });

        it('should reject signed leading-zero decimals: +00.5', () => {
            const result = tokenize('+00.5');
            assert.strictEqual(result.errors.length, 1);
            assert.strictEqual(result.errors[0]!.code, 'INVALID_NUMBER');
        });

        it('should reject signed leading-zero decimals: -00.5', () => {
            const result = tokenize('-00.5');
            assert.strictEqual(result.errors.length, 1);
            assert.strictEqual(result.errors[0]!.code, 'INVALID_NUMBER');
        });
    });

    describe('separator literal quote-aware termination', () => {
        it('should terminate at newline outside quotes', () => {
            const result = tokenize('^content\nmore');
            assert.strictEqual(result.tokens[0]!.type, TokenType.SeparatorLiteral);
            assert.strictEqual(result.tokens[0]!.value, '^content');
        });

        it('should terminate at comma outside quotes', () => {
            const result = tokenize('^content,more');
            assert.strictEqual(result.tokens[0]!.type, TokenType.SeparatorLiteral);
            assert.strictEqual(result.tokens[0]!.value, '^content');
        });

        it('should terminate at closing bracket outside quotes', () => {
            const result = tokenize('^content]');
            assert.strictEqual(result.tokens[0]!.type, TokenType.SeparatorLiteral);
            assert.strictEqual(result.tokens[0]!.value, '^content');
            assert.strictEqual(result.tokens[1]!.type, TokenType.RightBracket);
        });

        it('should preserve semicolon inside double quotes', () => {
            const result = tokenize('^"a;b",end');
            assert.strictEqual(result.tokens[0]!.type, TokenType.SeparatorLiteral);
            assert.strictEqual(result.tokens[0]!.value, '^"a;b"');
        });

        it('should preserve semicolon inside single quotes', () => {
            const result = tokenize("^'a;b',end");
            assert.strictEqual(result.tokens[0]!.type, TokenType.SeparatorLiteral);
            assert.strictEqual(result.tokens[0]!.value, "^'a;b'");
        });

        it('should handle escaped quotes inside quoted section', () => {
            const result = tokenize('^"a\\"b;c",end');
            assert.strictEqual(result.tokens[0]!.type, TokenType.SeparatorLiteral);
            assert.strictEqual(result.tokens[0]!.value, '^"a\\"b;c"');
        });

        it('should handle nested quote types', () => {
            const result = tokenize('^"a\'b;c\'d",end');
            assert.strictEqual(result.tokens[0]!.type, TokenType.SeparatorLiteral);
            assert.strictEqual(result.tokens[0]!.value, '^"a\'b;c\'d"');
        });

        it('should keep escaped comma inside raw payload', () => {
            const result = tokenize('^first\\,second,done');
            assert.strictEqual(result.tokens[0]!.type, TokenType.SeparatorLiteral);
            assert.strictEqual(result.tokens[0]!.value, '^first\\,second');
        });

        it('should keep escaped spaces inside raw payload', () => {
            const result = tokenize('^one\\ five]');
            assert.strictEqual(result.tokens[0]!.type, TokenType.SeparatorLiteral);
            assert.strictEqual(result.tokens[0]!.value, '^one\\ five');
        });

        it('should preserve spaces-only separator payload before a closing boundary', () => {
            const result = tokenize('^    )');
            assert.strictEqual(result.tokens[0]!.type, TokenType.SeparatorLiteral);
            assert.strictEqual(result.tokens[0]!.value, '^    ');
            assert.strictEqual(result.tokens[1]!.type, TokenType.RightParen);
        });

        it('should terminate raw separator literal at the first unescaped interior space', () => {
            const result = tokenize('^a\\ b c)');
            assert.strictEqual(result.tokens[0]!.type, TokenType.SeparatorLiteral);
            assert.strictEqual(result.tokens[0]!.value, '^a\\ b');
            assert.strictEqual(result.tokens[1]!.type, TokenType.Identifier);
            assert.strictEqual(result.tokens[1]!.value, 'c');
        });

        it('should allow comment-like text inside raw separator payloads', () => {
            const result = tokenize('^http://www.aeonite.org/*hello*/file.aeon');
            assert.strictEqual(result.errors.length, 0);
            assert.strictEqual(result.tokens[0]!.type, TokenType.SeparatorLiteral);
            assert.strictEqual(result.tokens[0]!.value, '^http://www.aeonite.org/*hello*/file.aeon');
        });

        it('should reject bracket, brace, and paren characters inside raw separator payloads', () => {
            const cases = [
                '^http://www.aeonite.org/[...]/',
                '^http://www.aeonite.org/{...}/',
                '^http://www.aeonite.org/(...)/',
                '^http://www.aeonite.org//[hello',
            ];

            for (const source of cases) {
                const result = tokenize(source);
                assert.strictEqual(result.errors.length, 1, source);
            }
        });
    });

    describe('unterminated block comment error', () => {
        it('should produce error for unterminated block comment', () => {
            const result = tokenize('foo /* unterminated');
            assert.strictEqual(result.errors.length, 1);
            assert.strictEqual(result.errors[0]!.code, 'UNTERMINATED_BLOCK_COMMENT');
        });

        it('should have correct span for unterminated block comment', () => {
            const result = tokenize('x /* oops');
            assert.strictEqual(result.errors.length, 1);
            // Span should start at the /* position
            assert.strictEqual(result.errors[0]!.span.start.column, 3);
        });

        it('should still include token when includeComments is true', () => {
            const result = tokenize('/* unterminated', { includeComments: true });
            assert.strictEqual(result.errors.length, 1);
            assert.ok(result.tokens.some(t => t.type === TokenType.BlockComment));
        });
    });

    describe('header token patterns', () => {
        it('should tokenize aeon:version = 2.0', () => {
            const result = tokenize('aeon:version = 2.0');
            const types = result.tokens.map(t => t.type);
            assert.deepStrictEqual(types, [
                TokenType.Identifier,  // aeon
                TokenType.Colon,
                TokenType.Identifier,  // version
                TokenType.Equals,
                TokenType.Number,      // 2.0
                TokenType.EOF,
            ]);
            assert.strictEqual(result.tokens[0]!.value, 'aeon');
            assert.strictEqual(result.tokens[2]!.value, 'version');
        });

        it('should tokenize aeon:header = {}', () => {
            const result = tokenize('aeon:header = {}');
            const types = result.tokens.map(t => t.type);
            assert.deepStrictEqual(types, [
                TokenType.Identifier,  // aeon
                TokenType.Colon,
                TokenType.Identifier,  // header
                TokenType.Equals,
                TokenType.LeftBrace,
                TokenType.RightBrace,
                TokenType.EOF,
            ]);
        });

        it('should tokenize aeon:mode = "strict"', () => {
            const result = tokenize('aeon:mode = "strict"');
            const types = result.tokens.map(t => t.type);
            assert.deepStrictEqual(types, [
                TokenType.Identifier,  // aeon
                TokenType.Colon,
                TokenType.Identifier,  // mode
                TokenType.Equals,
                TokenType.String,      // "strict"
                TokenType.EOF,
            ]);
        });

        it('should tokenize aeon:profile = "core"', () => {
            const result = tokenize('aeon:profile = "core"');
            assert.strictEqual(result.errors.length, 0);
            assert.strictEqual(result.tokens[2]!.value, 'profile');
            assert.strictEqual(result.tokens[4]!.value, 'core');
        });
    });

    describe('CRLF span handling', () => {
        it('should track correct line after CRLF', () => {
            const result = tokenize('foo\r\nbar');
            const tokens = result.tokens.filter(t => t.type === TokenType.Identifier);

            assert.strictEqual(tokens[0]!.span.start.line, 1);
            assert.strictEqual(tokens[0]!.span.start.column, 1);

            // After \r\n, bar should be on line 2
            assert.strictEqual(tokens[1]!.span.start.line, 2);
            assert.strictEqual(tokens[1]!.span.start.column, 1);
        });

        it('should handle mixed LF and CRLF', () => {
            const result = tokenize('a\r\nb\nc');
            const tokens = result.tokens.filter(t => t.type === TokenType.Identifier);

            assert.strictEqual(tokens[0]!.span.start.line, 1);
            assert.strictEqual(tokens[1]!.span.start.line, 2);
            assert.strictEqual(tokens[2]!.span.start.line, 3);
        });

        it('should not produce weird column values with CRLF', () => {
            const result = tokenize('xx\r\nyy');
            const tokens = result.tokens.filter(t => t.type === TokenType.Identifier);

            // Column should always be positive and reasonable
            assert.ok(tokens[1]!.span.start.column >= 1);
            assert.strictEqual(tokens[1]!.span.start.column, 1);
        });
    });
});
