import { TokenType } from '@aeon/lexer';

const DIGITS = '0123456789'.split('');
const HEX_DIGITS = '0123456789abcdefABCDEF'.split('');
const LETTERS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
const ALPHANUMERIC_UNDER = [...LETTERS, ...DIGITS, '_'];

const KEYWORDS: ReadonlyMap<string, TokenType> = new Map([
    ['true', TokenType.True],
    ['false', TokenType.False],
    ['yes', TokenType.Yes],
    ['no', TokenType.No],
    ['on', TokenType.On],
    ['off', TokenType.Off],
]);

const KEYWORD_STRINGS = Array.from(KEYWORDS.keys());

/**
 * The LexerOracle provides character-level predictions for AEON syntax.
 *
 * It answers two questions:
 *  1. "What characters can *continue* the token I'm currently inside?"
 *  2. "What characters can *start* a new token of a given type?"
 */
export class LexerOracle {

    // ─── Continue an existing token ─────────────────────────

    /**
     * Given a partial token value and its resolved type, return characters
     * that could legally extend it.
     */
    static continueToken(value: string, type: TokenType): string[] {
        switch (type) {
            // Keywords / identifiers share the same surface — keywords are
            // identifiers that happen to match a reserved word.  Once the
            // user has typed enough to disambiguate, we narrow to keyword
            // completion chars; otherwise we offer full alphanumeric.
            case TokenType.True:
            case TokenType.False:
            case TokenType.Yes:
            case TokenType.No:
            case TokenType.On:
            case TokenType.Off:
                return LexerOracle.keywordContinuation(value);

            case TokenType.Identifier:
                return LexerOracle.identifierContinuation(value);

            case TokenType.Number:
                return LexerOracle.numberContinuation(value);

            case TokenType.HexLiteral:
                return LexerOracle.hexContinuation(value);

            case TokenType.RadixLiteral:
                return LexerOracle.radixContinuation(value);

            case TokenType.EncodingLiteral:
                return LexerOracle.encodingContinuation(value);

            case TokenType.String:
                // Inside a string almost any character is valid.
                // We don't enumerate the full Unicode range — callers should
                // treat an empty return as "any printable char".
                return [];

            default:
                return [];
        }
    }

    // ─── Start a new token ──────────────────────────────────

    /**
     * Return the set of characters that can *begin* any of the given token
     * types.  This is used after the parser oracle determines which token
     * types are expected next.
     */
    static startingChars(types: readonly TokenType[]): string[] {
        const chars = new Set<string>();

        for (const type of types) {
            switch (type) {
                // Single-char structural tokens
                case TokenType.LeftBrace:    chars.add('{'); break;
                case TokenType.RightBrace:   chars.add('}'); break;
                case TokenType.LeftBracket:  chars.add('['); break;
                case TokenType.RightBracket: chars.add(']'); break;
                case TokenType.LeftParen:    chars.add('('); break;
                case TokenType.RightParen:   chars.add(')'); break;
                case TokenType.LeftAngle:    chars.add('<'); break;
                case TokenType.RightAngle:   chars.add('>'); break;
                case TokenType.Equals:       chars.add('='); break;
                case TokenType.Colon:        chars.add(':'); break;
                case TokenType.Comma:        chars.add(','); break;
                case TokenType.Dot:          chars.add('.'); break;
                case TokenType.At:           chars.add('@'); break;
                case TokenType.Ampersand:    chars.add('&'); break;
                case TokenType.Semicolon:    chars.add(';'); break;
                case TokenType.Tilde:        chars.add('~'); break;
                case TokenType.TildeArrow:   chars.add('~'); break;
                case TokenType.Caret:        chars.add('^'); break;
                case TokenType.Hash:         chars.add('#'); break;
                case TokenType.Dollar:       chars.add('$'); break;
                case TokenType.Percent:      chars.add('%'); break;

                // Identifiers & keywords all start with a letter
                case TokenType.Identifier:
                case TokenType.True:
                case TokenType.False:
                case TokenType.Yes:
                case TokenType.No:
                case TokenType.On:
                case TokenType.Off:
                    for (const c of LETTERS) chars.add(c);
                    break;

                // Numbers can start with digit, sign, or leading dot
                case TokenType.Number:
                    for (const c of DIGITS) chars.add(c);
                    chars.add('+'); chars.add('-'); chars.add('.');
                    break;

                // Date/Time tokens start with a digit (lexer promotes
                // numbers to date/time contextually)
                case TokenType.Date:
                case TokenType.DateTime:
                case TokenType.Time:
                    for (const c of DIGITS) chars.add(c);
                    break;

                // Hex literal starts with #
                case TokenType.HexLiteral:
                    chars.add('#');
                    break;

                // Radix starts with %
                case TokenType.RadixLiteral:
                    chars.add('%');
                    break;

                // Encoding starts with $
                case TokenType.EncodingLiteral:
                    chars.add('$');
                    break;

                // Separator starts with ^
                case TokenType.SeparatorLiteral:
                    chars.add('^');
                    break;

                // String literals
                case TokenType.String:
                    chars.add('"'); chars.add("'"); chars.add('`');
                    break;
            }
        }
        return Array.from(chars);
    }

    // ─── Private helpers ────────────────────────────────────

    private static keywordContinuation(prefix: string): string[] {
        const next = new Set<string>();
        for (const kw of KEYWORD_STRINGS) {
            if (kw.startsWith(prefix) && kw.length > prefix.length) {
                next.add(kw[prefix.length]!);
            }
        }
        // An identifier can always continue with alphanumeric — the token
        // just won't match a keyword any more.
        for (const c of ALPHANUMERIC_UNDER) next.add(c);
        return Array.from(next);
    }

    private static identifierContinuation(_prefix: string): string[] {
        return [...ALPHANUMERIC_UNDER];
    }

    private static numberContinuation(current: string): string[] {
        const last = current[current.length - 1]!;
        const result = new Set<string>();

        // After underscore, only a digit may follow
        if (last === '_') {
            for (const d of DIGITS) result.add(d);
            return Array.from(result);
        }

        // After sign, digit or dot
        if (last === '+' || last === '-') {
            for (const d of DIGITS) result.add(d);
            result.add('.');
            return Array.from(result);
        }

        // After 'e'/'E' or exponent sign
        if (last === 'e' || last === 'E') {
            for (const d of DIGITS) result.add(d);
            result.add('+'); result.add('-');
            return Array.from(result);
        }

        // General number body
        for (const d of DIGITS) result.add(d);
        result.add('_');

        if (!current.includes('.')) result.add('.');
        if (!current.includes('e') && !current.includes('E')) {
            result.add('e'); result.add('E');
        }

        return Array.from(result);
    }

    private static hexContinuation(current: string): string[] {
        const last = current[current.length - 1]!;
        if (last === '_') return [...HEX_DIGITS];
        return [...HEX_DIGITS, '_'];
    }

    private static radixContinuation(_current: string): string[] {
        return [...LETTERS, ...DIGITS, '+', '-', '.', '_', '&', '!'];
    }

    private static encodingContinuation(_current: string): string[] {
        return [...LETTERS, ...DIGITS, '+', '/', '=', '-', '_', '.'];
    }
}
