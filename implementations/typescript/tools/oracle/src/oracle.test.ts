import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { LexerOracle } from './lexer-oracle.js';
import { ParserOracle } from './parser-oracle.js';
import { UnifiedOracle } from './unified-oracle.js';
import { TokenType, Lexer } from '@aeon/lexer';

// ─── LexerOracle ────────────────────────────────────────

describe('LexerOracle', () => {
    describe('startingChars', () => {
        it('returns { for LeftBrace', () => {
            const chars = LexerOracle.startingChars([TokenType.LeftBrace]);
            assert.ok(chars.includes('{'));
        });

        it('returns letters for Identifier', () => {
            const chars = LexerOracle.startingChars([TokenType.Identifier]);
            assert.ok(chars.includes('a'));
            assert.ok(chars.includes('Z'));
            assert.ok(!chars.includes('1'));
        });

        it('returns digits and sign for Number', () => {
            const chars = LexerOracle.startingChars([TokenType.Number]);
            assert.ok(chars.includes('0'));
            assert.ok(chars.includes('+'));
            assert.ok(chars.includes('-'));
            assert.ok(chars.includes('.'));
        });

        it('returns quote chars for String', () => {
            const chars = LexerOracle.startingChars([TokenType.String]);
            assert.ok(chars.includes('"'));
            assert.ok(chars.includes("'"));
            assert.ok(chars.includes('`'));
        });

        it('returns # for HexLiteral', () => {
            const chars = LexerOracle.startingChars([TokenType.HexLiteral]);
            assert.deepStrictEqual(chars, ['#']);
        });

        it('returns ~ for both Tilde and TildeArrow', () => {
            const chars = LexerOracle.startingChars([TokenType.Tilde, TokenType.TildeArrow]);
            assert.deepStrictEqual(chars, ['~']);
        });
    });

    describe('continueToken', () => {
        it('offers "e" to complete "tru" as keyword', () => {
            const chars = LexerOracle.continueToken('tru', TokenType.True);
            assert.ok(chars.includes('e'));
        });

        it('offers alphanumeric for identifier continuation', () => {
            const chars = LexerOracle.continueToken('foo', TokenType.Identifier);
            assert.ok(chars.includes('_'));
            assert.ok(chars.includes('a'));
            assert.ok(chars.includes('0'));
        });

        it('offers digits and dot for number continuation', () => {
            const chars = LexerOracle.continueToken('12', TokenType.Number);
            assert.ok(chars.includes('3'));
            assert.ok(chars.includes('.'));
            assert.ok(chars.includes('_'));
            assert.ok(chars.includes('e'));
        });

        it('offers only digits after underscore in number', () => {
            const chars = LexerOracle.continueToken('1_', TokenType.Number);
            assert.ok(chars.includes('0'));
            assert.ok(!chars.includes('_'));
            assert.ok(!chars.includes('.'));
        });

        it('offers hex digits for hex literal', () => {
            const chars = LexerOracle.continueToken('#FF', TokenType.HexLiteral);
            assert.ok(chars.includes('0'));
            assert.ok(chars.includes('a'));
            assert.ok(chars.includes('_'));
        });
    });
});

// ─── ParserOracle ───────────────────────────────────────

describe('ParserOracle', () => {
    function lex(input: string) {
        const lexer = new Lexer(input);
        const { tokens } = lexer.tokenize();
        return tokens.filter(t => t.type !== TokenType.EOF);
    }

    it('predicts Identifier/String at empty input', () => {
        const oracle = new ParserOracle([]);
        const types = oracle.predict();
        assert.ok(types.includes(TokenType.Identifier));
        assert.ok(types.includes(TokenType.String));
    });

    it('predicts Colon/Equals/At after key', () => {
        const tokens = lex('myKey');
        const oracle = new ParserOracle(tokens);
        const types = oracle.predict();
        assert.ok(types.includes(TokenType.Colon) || types.includes(TokenType.Equals));
    });

    it('predicts value types after key =', () => {
        const tokens = lex('a = ');
        const oracle = new ParserOracle(tokens);
        const types = oracle.predict();
        // Should include containers and literals
        assert.ok(types.includes(TokenType.LeftBrace));
        assert.ok(types.includes(TokenType.LeftBracket));
        assert.ok(types.includes(TokenType.String));
        assert.ok(types.includes(TokenType.Number));
        assert.ok(types.includes(TokenType.True));
        assert.ok(types.includes(TokenType.False));
    });

    it('predicts type name after colon', () => {
        const tokens = lex('a:');
        const oracle = new ParserOracle(tokens);
        const types = oracle.predict();
        assert.ok(types.includes(TokenType.Identifier));
    });

    it('predicts Identifier after key = {', () => {
        const tokens = lex('a = {');
        const oracle = new ParserOracle(tokens);
        const types = oracle.predict();
        assert.ok(types.includes(TokenType.Identifier));
        assert.ok(types.includes(TokenType.RightBrace));
    });
});

// ─── UnifiedOracle ──────────────────────────────────────

describe('UnifiedOracle', () => {
    const oracle = new UnifiedOracle();

    it('suggests key-start chars for empty input', () => {
        const result = oracle.suggest('');
        assert.ok(result.chars.length > 0);
        assert.ok(result.chars.includes('a')); // can start an identifier
    });

    it('suggests = and : after a key', () => {
        const result = oracle.suggest('myKey');
        // midToken should be true since Identifier is continuable
        assert.strictEqual(result.midToken, true);
        // nextTokenChars should include = and :
        assert.ok(result.nextTokenChars.includes('='));
        assert.ok(result.nextTokenChars.includes(':'));
    });

    it('suggests value chars after key = ', () => {
        const result = oracle.suggest('a = ');
        assert.strictEqual(result.midToken, false);
        assert.ok(result.chars.includes('{')); // object
        assert.ok(result.chars.includes('[')); // list
        assert.ok(result.chars.includes('"')); // string
    });

    it('your example: a:bool = suggests t,f for true/false', () => {
        const result = oracle.suggest('a:bool = ');
        // Should suggest value-starting chars including letters for true/false
        assert.ok(result.chars.includes('t')); // true
        assert.ok(result.chars.includes('f')); // false
        assert.ok(result.chars.includes(' ')); // whitespace
        assert.ok(result.chars.includes('\n')); // newline
    });
});
