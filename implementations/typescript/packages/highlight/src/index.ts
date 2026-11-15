import * as lexer from '@altopelago/aeon-lexer';
import {createAeonHighlighter, MAX_HIGHLIGHT_SOURCE_CODE_UNITS} from './aeon-token-highlight.mjs';
import {highlightJson as renderJson} from './presentation-highlight.mjs';

export {MAX_HIGHLIGHT_SOURCE_CODE_UNITS};

export interface HighlightOptions {
    /** One-based source line to mark; invalid or absent values leave it unmarked. */
    readonly diagnosticLine?: number;
    /** One-based UTF-16 source column; defaults to one. */
    readonly diagnosticColumn?: number;
}

const renderer = createAeonHighlighter(lexer);

/** Render escaped original source slices using implementation lexer tokens. No DOM required. */
export function highlightAeon(source: string, options: HighlightOptions = {}): string {
    return renderer.highlightAeon(source, options.diagnosticLine ?? null, options.diagnosticColumn ?? 1);
}

/** Optional JSON presentation helper; it does not parse or validate AEON. */
export function highlightJson(source: string): string {
    return renderJson(source);
}
