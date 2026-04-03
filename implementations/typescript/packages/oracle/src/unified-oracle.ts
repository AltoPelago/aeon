import { Lexer, TokenType } from '@aeon/lexer';
import { LexerOracle } from './lexer-oracle.js';
import { ParserOracle } from './parser-oracle.js';

/**
 * Suggestion result returned by the oracle.
 */
export interface Suggestion {
    /** Characters that can appear at the cursor position. */
    readonly chars: string[];

    /** Token types expected at the cursor position (from parser). */
    readonly expectedTokenTypes: TokenType[];

    /**
     * If true, the cursor is at the boundary of a token that could still
     * grow (e.g. the user typed "tru" and might type "e" to complete
     * "true", or might type " " to finish an identifier "tru").
     */
    readonly midToken: boolean;

    /**
     * Characters that would *continue* the current token (only populated
     * when `midToken` is true).
     */
    readonly continuationChars: string[];

    /**
     * Characters that would *start the next* token (always populated).
     */
    readonly nextTokenChars: string[];
}

/**
 * Token types whose lexemes are "open-ended" — a token of this type
 * could still be extended with more characters.
 */
const CONTINUABLE_TYPES = new Set<TokenType>([
    TokenType.Identifier,
    TokenType.Number,
    TokenType.HexLiteral,
    TokenType.RadixLiteral,
    TokenType.EncodingLiteral,
    TokenType.True,
    TokenType.False,
    TokenType.Yes,
    TokenType.No,
    TokenType.On,
    TokenType.Off,
]);

/**
 * The UnifiedOracle coordinates the lexer oracle (character-level) and
 * the parser oracle (token-level) to produce context-aware suggestions
 * for a given AEON input prefix.
 */
export class UnifiedOracle {
    /**
     * Suggest valid continuations for `input`.
     */
    suggest(input: string): Suggestion {
        // Step 1: Lex what we have so far
        const lexer = new Lexer(input);
        const { tokens } = lexer.tokenize();
        const actualTokens = tokens.filter(t => t.type !== TokenType.EOF);
        const lastToken = actualTokens[actualTokens.length - 1];

        // Step 2: Determine whether the cursor is inside a token
        const cursorOffset = input.length;
        const lastTokenEnd = lastToken?.span.end.offset ?? 0;
        const midToken = !!(lastToken && cursorOffset === lastTokenEnd && CONTINUABLE_TYPES.has(lastToken.type));

        // Step 3: Ask the parser oracle what token types come next
        //  • If midToken, the parser should see the current token as
        //    "complete" to predict what follows it.
        //  • If NOT midToken (cursor is in whitespace after last token),
        //    we pass all tokens and predict from there.
        const parserOracle = new ParserOracle(actualTokens);
        const expectedTokenTypes = parserOracle.predict();

        // Step 4: Map expected token types → starting characters
        const nextTokenChars = LexerOracle.startingChars(expectedTokenTypes);

        // Step 5: If mid-token, also get continuation characters
        let continuationChars: string[] = [];
        if (midToken && lastToken) {
            continuationChars = LexerOracle.continueToken(lastToken.value, lastToken.type);
        }

        // Step 6: Merge both char sets
        const allChars = new Set<string>([
            ...continuationChars,
            ...nextTokenChars,
            ' ', '\t',  // whitespace is almost always valid between tokens
        ]);

        // Newlines are valid between bindings (top-level separators)
        allChars.add('\n');

        return {
            chars: Array.from(allChars),
            expectedTokenTypes,
            midToken,
            continuationChars,
            nextTokenChars,
        };
    }
}
