import type {Token, TokenType, tokenize} from '@altopelago/aeon-lexer';
import {createAeonHighlighter, MAX_HIGHLIGHT_SOURCE_CODE_UNITS} from './aeon-token-highlight.mjs';
import {highlightJson as renderJson} from './presentation-highlight.mjs';

export {MAX_HIGHLIGHT_SOURCE_CODE_UNITS};
export interface HighlightOptions {
    readonly diagnosticLine?: number;
    readonly diagnosticColumn?: number;
}
/** Supply the implementation lexer selected by the host's own module graph. */
export interface LexerProvider {
    readonly TokenType: typeof TokenType;
    readonly tokenize: (source: string, options?: Parameters<typeof tokenize>[1]) => {readonly tokens: readonly Token[]};
}
export interface Highlighter {
    highlightAeon(source: string, options?: HighlightOptions): string;
    highlightJson(source: string): string;
}
/** Rendering only: no lexer, parser or DOM is loaded by this entry point. */
export function createHighlighter(provider: LexerProvider): Highlighter {
    const renderer = createAeonHighlighter(provider);
    return {
        highlightAeon(source, options = {}) {
            return renderer.highlightAeon(source, options.diagnosticLine ?? null, options.diagnosticColumn ?? 1);
        },
        highlightJson(source) { return renderJson(source); },
    };
}
