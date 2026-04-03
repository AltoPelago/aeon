import { UnifiedOracle } from './unified-oracle.js';

/**
 * A grammar-guided AEON fuzzer that builds syntactically valid
 * documents character-by-character using the Oracle.
 *
 * Intended for edge-case discovery in the lexer and parser.
 */
export class CharFuzzer {
    private readonly oracle: UnifiedOracle;
    private readonly rng: () => number;

    constructor(
        oracle: UnifiedOracle = new UnifiedOracle(),
        rng: () => number = Math.random,
    ) {
        this.oracle = oracle;
        this.rng = rng;
    }

    /**
     * Generate a syntactically valid AEON string.
     *
     * @param maxChars   Approximate upper bound on output length.
     * @param bindings   Target number of top-level bindings to generate
     *                   (the fuzzer will try to emit at least this many
     *                   `key = value\n` groups before stopping).
     */
    generate(maxChars: number = 200, bindings: number = 3): string {
        let result = '';
        let emittedBindings = 0;

        for (let i = 0; i < maxChars; i++) {
            const { chars, continuationChars, midToken } = this.oracle.suggest(result);

            if (chars.length === 0) break;

            // Strategy: bias towards completing tokens when mid-token,
            // and towards newlines between bindings.
            let pool: string[];

            if (midToken && continuationChars.length > 0) {
                // 80% chance to continue the current token
                pool = this.rng() < 0.8 ? continuationChars : chars;
            } else {
                pool = chars;
            }

            const next = pool[Math.floor(this.rng() * pool.length)]!;
            result += next;

            // Count newlines as binding separators
            if (next === '\n') {
                emittedBindings++;
                if (emittedBindings >= bindings && result.length > maxChars * 0.5) {
                    break;
                }
            }
        }

        return result;
    }
}
